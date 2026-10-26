// Finds Il2CppCodeRegistration (method pointers per assembly) and Il2CppMetadataRegistration
// (types, field offsets, type sizes) inside the wasm data segment. Both are static data,
// so they live at fixed low addresses and can be found by shape.
//
// Metadata v24.0/24.1 (Unity 2018.x – 2019.1) predates per-assembly code modules: the code
// registration starts with one flat [methodPointersCount, methodPointers] array that every
// method indexes with its methodIndex. That case is returned as `flat`.

export function findRegistrations(mem, md, limit) {
  const m = mem.views();
  const u32 = m.u32;
  const end = Math.min(limit, m.size) >>> 2;
  const N = md.typeCount;
  const out = { code: null, meta: null, modules: new Map(), flat: null };

  // ---- Il2CppMetadataRegistration:
  //  [genericClassesCount, genericClasses, genericInstsCount, genericInsts, genericMethodTableCount,
  //   genericMethodTable, typesCount, types, methodSpecsCount, methodSpecs, fieldOffsetsCount,
  //   fieldOffsets, typeDefinitionsSizesCount, typeDefinitionsSizes, metadataUsagesCount, metadataUsages]
  const ptr = (v) => v > 0x400 && v < limit;
  for (let i = 10; i < end - 6; i++) {
    if (u32[i] !== N || u32[i + 2] !== N) continue;
    if (!ptr(u32[i + 1]) || !ptr(u32[i + 3])) continue;
    const typesCount = u32[i - 4];
    const types = u32[i - 3];
    if (typesCount < N || typesCount > N * 20 || !ptr(types)) continue;
    out.meta = {
      addr: (i - 10) * 4,
      genericClassesCount: u32[i - 10], genericClasses: u32[i - 9],
      genericInstsCount: u32[i - 8], genericInsts: u32[i - 7],
      genericMethodTableCount: u32[i - 6], genericMethodTable: u32[i - 5],
      typesCount, types,
      methodSpecsCount: u32[i - 2], methodSpecs: u32[i - 1],
      fieldOffsets: u32[i + 1],
      typeDefinitionsSizes: u32[i + 3],
    };
    break;
  }

  if (md.legacy && md.legacy.rgctx) {
    out.flat = findFlatCodeRegistration(m, md, limit);
    if (out.flat) {
      out.code = { regAddr: out.flat.regAddr, modulesAddr: 0, modulesCount: 0, flat: true };
      out.invokers = { pointers: out.flat.invokerPointers, count: out.flat.invokerCount };
      out.generic = { pointers: out.flat.genericPointers, count: out.flat.genericCount };
    }
    return out;
  }

  // ---- Il2CppCodeGenModule[] via the module named after the first image (normally mscorlib.dll)
  const enc = new TextEncoder();
  // module names are the image names (spaces, '+', non-ASCII… included), so check against those
  const imageNames = new Set(md.images.map((x) => x.name));
  const isName = (p) => ptr(p) && imageNames.has(m.cstr(p, 512));
  let best = null;
  for (const img of md.images) {
    const sAddr = m.find([...enc.encode(img.name), 0], 0, limit);
    if (sAddr < 0) continue;
    // module structs whose first field points at the name
    for (const modAddr of m.refs(sAddr, 0, limit)) {
      const count = u32[(modAddr >>> 2) + 1];
      if (count > 2000000 || !ptr(u32[(modAddr >>> 2) + 2]) && count) continue;
      // the module array holds a pointer to this struct
      for (const slot of m.refs(modAddr, 0, limit)) {
        // walk the array both ways
        let a = slot >>> 2;
        let b = a;
        const looksMod = (k) => ptr(u32[k]) && isName(u32[u32[k] >>> 2]);
        while (looksMod(a - 1)) a--;
        while (looksMod(b + 1)) b++;
        const arr = a * 4;
        const n = b - a + 1;
        // Il2CppCodeRegistration has [codeGenModulesCount, codeGenModules] somewhere
        const regs = m.refs(arr, 0, limit).filter((r) => u32[(r >>> 2) - 1] >= n - 2 && u32[(r >>> 2) - 1] <= n + 2);
        const count2 = regs.length ? u32[(regs[0] >>> 2) - 1] : n;
        // each candidate array is judged on its own (stale modules from a failed one don't count)
        const modules = new Map();
        for (let k = 0; k < count2; k++) {
          const mp = u32[a + k];
          if (!ptr(mp)) continue;
          const name = m.cstr(u32[mp >>> 2], 512);
          if (!imageNames.has(name)) continue;
          modules.set(name, { addr: mp, methodPointerCount: u32[(mp >>> 2) + 1], methodPointers: u32[(mp >>> 2) + 2] });
        }
        const code = { modulesAddr: arr, modulesCount: count2, regAddr: regs[0] || 0 };
        if (modules.size > 1) { out.modules = modules; out.code = code; findAdjustorThunks(m, out, limit); findInvokers(m, md, out, limit); return out; }
        if (!best || modules.size > best.modules.size) best = { modules, code };
      }
    }
  }
  if (best) { out.modules = best.modules; out.code = best.code; findAdjustorThunks(m, out, limit); }
  return out;
}

/**
 * v24.5 / v27.1+ code modules keep struct methods' adjustor thunks in their own table
 * (adjustorThunkCount, adjustorThunks of { token, method }) right after methodPointers; before
 * that, methodPointers itself holds the thunks for struct instance methods. Sets
 * out.adjustorThunks = true/false (false: methodPointers are thunks).
 */
function findAdjustorThunks(m, out, limit) {
  let seen = 0; let tables = 0;
  for (const mod of out.modules.values()) {
    const c = m.u32At(mod.addr + 12);
    const p = m.u32At(mod.addr + 16);
    if (!mod.methodPointerCount) continue;
    seen++;
    if (c > 0 && c <= mod.methodPointerCount && p > 0x400 && p < limit && (m.u32At(p) >>> 24) === 0x06 && (m.u32At(p + 8 * Math.min(c - 1, 4)) >>> 24) === 0x06) {
      mod.adjustorThunks = { count: c, pointers: p };
      tables++;
    }
  }
  out.adjustorThunks = seen ? tables > 0 : null;
}

/**
 * v24.0/24.1 Il2CppCodeRegistration (32-bit):
 *   methodPointersCount, methodPointers, reversePInvokeWrapperCount, reversePInvokeWrappers,
 *   genericMethodPointersCount, genericMethodPointers, invokerPointersCount, invokerPointers,
 *   customAttributeCount, customAttributeGenerators, unresolvedVirtualCallCount, ...
 * methodPointersCount is one past the highest methodIndex in the metadata.
 */
function findFlatCodeRegistration(m, md, limit) {
  const u32 = m.u32;
  let maxIdx = -1;
  const f = md.L.method.fields.find((x) => x[0] === 'methodIndex');
  if (!f) return null;
  for (let i = 0, p = md.sec.methods.off + f[1]; i < md.methodCount; i++, p += md.mdSize) {
    const v = m.i32At(p);
    if (v > maxIdx) maxIdx = v;
  }
  if (maxIdx < 0) return null;
  const want = maxIdx + 1;
  const ptr = (v) => v > 0x400 && v < limit;
  const end = Math.min(limit, m.size) >>> 2;
  // the custom attribute generator count equals the attributesInfo record count
  const ai = md.sec.attributesInfo;
  const attrCounts = ai ? new Set([ai.size / 8, ai.size / 12].filter(Number.isInteger)) : new Set();
  let best = null;
  for (let i = 0; i < end - 12; i++) {
    const count = u32[i];
    if (count < want || count > want + 64 || !ptr(u32[i + 1])) continue;
    // the table entries are function table slots: small numbers, mostly non-zero
    const arr = u32[i + 1] >>> 2;
    let ok = 0; let zero = 0;
    for (let k = 0; k < Math.min(count, 256); k++) {
      const v = u32[arr + k];
      if (v === 0) zero++;
      else if (v < 1 << 24) ok++;
      else { ok = -1; break; }
    }
    if (ok < 0 || ok < zero) continue;
    let score = 1;
    if (attrCounts.has(u32[i + 8]) && ptr(u32[i + 9])) score += 4;
    if (u32[i + 4] && ptr(u32[i + 5])) score += 1;
    if (u32[i + 6] && ptr(u32[i + 7])) score += 1;
    if (count === want) score += 1;
    if (!best || score > best.score) best = { score, i };
    if (score >= 7) break;
  }
  if (!best) return null;
  const i = best.i;
  return {
    regAddr: i * 4,
    count: u32[i], pointers: u32[i + 1],
    genericCount: u32[i + 4], genericPointers: u32[i + 5],
    invokerCount: u32[i + 6], invokerPointers: u32[i + 7],
  };
}

/**
 * Il2CppCodeRegistration's generic method pointers and invoker pointers, and each code module's
 * invokerIndices. The struct grew over the versions, so fields are found relative to
 * codeGenModules and checked by content:
 *   codeGenModules is 52 (v24.2, v27.0), 56 (v27.1 – v29.0), 60 (v24.3/24.4) or 64 (v24.5, v29.1+)
 *   bytes into the struct; genericMethodPointers(Count) is at +8; invokerPointers(Count) follows,
 *   after genericAdjustorThunks when that exists.
 */
function findInvokers(m, md, out, limit) {
  const meta = out.meta;
  const at = out.code && out.code.regAddr;
  if (!meta || !at) return;
  const valid = (p) => p > 0x400 && p < limit;
  // number of generic method pointers = 1 + highest methodIndex in the generic method table
  let maxIdx = -1;
  for (const size of md.version >= 29 ? [16, 12] : [12, 16]) {
    let ok = true; let mx = -1;
    for (let i = 0; i < Math.min(meta.genericMethodTableCount, 256); i++) {
      const e = meta.genericMethodTable + i * size;
      const spec = m.i32At(e); const idx = m.i32At(e + 4);
      if (spec < 0 || spec >= meta.methodSpecsCount || idx < -1 || idx > 4e6) { ok = false; break; }
    }
    if (!ok) continue;
    for (let i = 0; i < meta.genericMethodTableCount; i++) mx = Math.max(mx, m.i32At(meta.genericMethodTable + i * size + 4));
    maxIdx = mx;
    break;
  }
  const looksPointers = (p, c, not) => {
    if (!(c > 0 && c < 200000 && valid(p) && p !== not)) return false;
    let nz = 0;
    for (let k = 0; k < Math.min(c, 32); k++) { const v = m.u32At(p + k * 4); if (v >= 1 << 22) return false; if (v) nz++; }
    return nz >= Math.min(c, 32) / 2;
  };
  for (const back of [64, 56, 60, 52, 48]) {
    const start = at - back;
    const count = m.u32At(start + 8); const ptr = m.u32At(start + 12);
    if (!(count >= maxIdx + 1 && count < maxIdx + 64 && valid(ptr))) continue;
    out.generic = { pointers: ptr, count, start };
    for (const o of [20, 16]) {
      const c = m.u32At(start + o); const p = m.u32At(start + o + 4);
      if (looksPointers(p, c, ptr)) { out.invokers = { pointers: p, count: c }; break; }
    }
    break;
  }
  if (!out.invokers) return;
  // per module: invokerIndices sits after methodPointers, or after adjustorThunks (v24.5, v27.1+)
  for (const mod of out.modules.values()) {
    for (const off of [12, 20]) {
      const arr = m.u32At(mod.addr + off);
      if (!valid(arr) || !mod.methodPointerCount) continue;
      let ok = true;
      for (let k = 0; k < Math.min(mod.methodPointerCount, 64); k++) { const v = m.i32At(arr + k * 4); if (v < -1 || v >= out.invokers.count) { ok = false; break; } }
      if (ok) { mod.invokerIndices = arr; break; }
    }
  }
}
