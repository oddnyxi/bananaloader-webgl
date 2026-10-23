// Finds Il2CppCodeRegistration (method pointers per assembly) and Il2CppMetadataRegistration
// (types, field offsets, type sizes) inside the wasm data segment. Both are static data,
// so they live at fixed low addresses and can be found by shape.

export function findRegistrations(mem, md, limit) {
  const m = mem.views();
  const u32 = m.u32;
  const end = Math.min(limit, m.size) >>> 2;
  const N = md.typeCount;
  const out = { code: null, meta: null, modules: new Map() };

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

  // ---- Il2CppCodeGenModule[] via the module named after the first image (normally mscorlib.dll)
  const enc = new TextEncoder();
  const isName = (p) => {
    if (!ptr(p)) return false;
    const s = m.cstr(p, 128);
    return s.length > 2 && /^[\w.\-]+$/.test(s);
  };
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
        for (let k = 0; k < count2; k++) {
          const mp = u32[a + k];
          if (!ptr(mp)) continue;
          const name = m.cstr(u32[mp >>> 2], 256);
          out.modules.set(name, { addr: mp, methodPointerCount: u32[(mp >>> 2) + 1], methodPointers: u32[(mp >>> 2) + 2] });
        }
        out.code = { modulesAddr: arr, modulesCount: count2, regAddr: regs[0] || 0 };
        if (out.modules.size > 1) return out;
      }
    }
  }
  return out;
}
