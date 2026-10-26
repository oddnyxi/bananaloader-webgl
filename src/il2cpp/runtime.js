// IL2CPP runtime bridge for Unity WebGL builds.
//
// Nothing here relies on exported il2cpp_* functions (WebGL builds strip them). Instead:
//  * names and structure come from global-metadata (already in the heap),
//  * method entry points come from Il2CppCodeGenModule.methodPointers (wasm table indices),
//  * object layouts come from Il2CppMetadataRegistration.fieldOffsets and the runtime
//    Il2CppClass/FieldInfo structs, whose offsets are calibrated against System.String.
// Managed methods are called directly through the wasm function table with IL2CPP's calling
// convention: (sret?, this?, ...args, MethodInfo*).

import { Memory } from './memory.js';
import { Metadata, metadataEra } from './metadata.js';
import { findRegistrations } from './registration.js';
import { T, PRIM_NAME, PRIM_SIZE, REF_KINDS, FIELD, METHOD } from './types.js';

const hex = (n) => '0x' + (n >>> 0).toString(16);
const WASM_OF = { i32: 'i32', ptr: 'i32', i64: 'i64', f32: 'f32', f64: 'f64' };

// CLR names -> the C# keywords typeName() prints for primitives
export const ALIAS = {
  'System.Void': 'void', 'System.Boolean': 'bool', 'System.Char': 'char', 'System.SByte': 'sbyte', 'System.Byte': 'byte',
  'System.Int16': 'short', 'System.UInt16': 'ushort', 'System.Int32': 'int', 'System.UInt32': 'uint', 'System.Int64': 'long',
  'System.UInt64': 'ulong', 'System.Single': 'float', 'System.Double': 'double', 'System.String': 'string', 'System.Object': 'object',
  'System.IntPtr': 'IntPtr', 'System.UIntPtr': 'UIntPtr',
};

/** Struct values use the property name for auto-property backing fields: <Count>k__BackingField → Count. */
export function fieldKey(n) { const m = /^<(.+)>k__BackingField$/.exec(n); return m ? m[1] : n; }
/** A struct field's value from a JS object, under its raw name or its property name. */
const fieldOf = (obj, name) => (obj[name] !== undefined ? obj[name] : obj[fieldKey(name)]);
/** One truthiness rule for bool parameters and fields ('false' and '0' are false). */
const toBool = (v) => (typeof v === 'string' ? /^(true|1)$/i.test(v.trim()) : !!v);

export class ManagedError extends Error {
  constructor(message, info = {}) { super(message); Object.assign(this, info); }
}

export class Il2Cpp {
  /**
   * @param {object} Module  the Emscripten Module (unityInstance.Module)
   * @param {(msg:string)=>void} log
   * @param {object} hints   what the bootstrap captured while the wasm was instantiated:
   *   { exports, memory, table, signatures: { of(slot), count }, flavor: 'fastcomp' | 'upstream' }.
   *   Old (fastcomp) builds import their memory and table instead of exporting them.
   */
  constructor(Module, log = () => {}, hints = {}) {
    this.Module = Module;
    this.log = log;
    const asm = Module.asm && typeof Module.asm === 'object' ? Module.asm : null;
    const exp = asm || Module.wasmExports || hints.exports || {};
    const vals = Object.values(exp);
    const heapView = Module.HEAPU8 ? { get buffer() { return Module.HEAPU8.buffer; } } : null;
    const memory = Module.wasmMemory || vals.find((v) => v instanceof WebAssembly.Memory) || hints.memory || heapView;
    this.table = Module.wasmTable || vals.find((v) => v instanceof WebAssembly.Table) || hints.table;
    if (!memory) throw new Error('wasm memory not found on Module');
    if (!this.table) throw new Error('wasm function table not found (for this Unity version the bootstrap has to run at document-start)');
    this.mem = new Memory(memory);
    const pick = (...names) => {
      for (const n of names) {
        for (const src of [Module, exp, hints.exports || {}]) { const f = src[n]; if (typeof f === 'function') return f; }
      }
      return undefined;
    };
    this.malloc = pick('_malloc', 'malloc');
    this.free = pick('_free', 'free');
    if (typeof this.malloc !== 'function' || typeof this.free !== 'function') throw new Error('malloc/free not found on Module');
    this.stackSave = pick('stackSave');
    this.stackRestore = pick('stackRestore');
    // fastcomp (Unity 2018 – 2021.1) may return the high half of a legalized i64 in tempRet0
    this.getTempRet0 = pick('getTempRet0', '_getTempRet0');
    this.setTempRet0 = pick('setTempRet0', '_setTempRet0');
    // native wasm exception handling (a Unity 6 option): C++ exceptions carry this tag
    this.cppTag = [exp, hints.exports || {}].map((x) => x.__cpp_exception).find((x) => x && typeof x === 'object') || null;
    const names = Object.keys(exp);
    this.flavor = hints.flavor || (names.includes('_malloc') || names.includes('_free') ? 'fastcomp' : 'upstream');
    this.sigs = hints.signatures || null;
    // fastcomp: per-signature function tables inside the one wasm table (see WasmModule.fnTables)
    this.fnTables = hints.fnTables || null;
    this.i64Mode = this.flavor === 'upstream' ? 'native' : 'unknown';
    this.byrefBit = 29;
    this.staticThis = false; // Unity <= 2018.2: static methods take an unused leading `this`
    this.splitI64 = false;   // Unity <= 2018.2: long parameters arrive as two i32 halves
    this._fn = new Map();
    this.ready = false;
  }

  // ------------------------------------------------------------------ init

  /**
   * @param trace optional step reporter (a bootstrap client): { run(id, label, fn(note)) }.
   *   Each stage is timed and shows up on the loading screen with what it found.
   */
  init(trace = null) {
    const t0 = performance.now();
    for (const [id, label, fn] of this._initSteps()) this._runStep(trace, id, label, fn);
    this.ready = true;
    this.log(`ready in ${Math.round(performance.now() - t0)} ms`);
    return this;
  }

  /** Same as init(), but lets the page paint between stages (so a loading screen can show them). */
  async initAsync(trace = null) {
    const t0 = performance.now();
    const frame = () => new Promise((r) => { let done = false; const go = () => { if (!done) { done = true; r(); } }; requestAnimationFrame(() => setTimeout(go, 0)); setTimeout(go, 60); });
    for (const [id, label, fn] of this._initSteps()) {
      await frame();
      this._runStep(trace, id, label, fn);
    }
    this.ready = true;
    this.log(`ready in ${Math.round(performance.now() - t0)} ms`);
    return this;
  }

  _runStep(trace, id, label, fn) {
    return trace && trace.run ? trace.run(id, label, fn) : fn(() => {});
  }

  _initSteps() {
    return [
      ['metadata', 'Locate global-metadata.dat', (note) => {
        const base = Metadata.locate(this.mem);
        if (base < 0) throw new Error('global-metadata not found in memory (is the game fully loaded?)');
        this.md = new Metadata(this.mem, base);
        this.md._declTd = (typeIndex) => this.tdOfTypeIndex(typeIndex);
        const era = metadataEra(this.md.subVersion);
        this.log(`metadata v${this.md.versionLabel} at ${hex(base)}: ${this.md.images.length} assemblies, ${this.md.typeCount} types, ${this.md.methodCount} methods`);
        note(`v${this.md.versionLabel}${era ? ` (${era})` : ''} at ${hex(base)} · ${this.md.images.length} assemblies · ${this.md.typeCount.toLocaleString()} types · ${this.md.methodCount.toLocaleString()} methods`);
      }],
      ['registrations', 'Find code & metadata registrations', (note) => {
        const limit = Math.min(this.md.base, 512 << 20);
        const reg = findRegistrations(this.mem, this.md, limit);
        if (!reg.meta) throw new Error('Il2CppMetadataRegistration not found');
        if (!reg.modules.size && !reg.flat) throw new Error('Il2CppCodeRegistration not found');
        this.reg = reg;
        const code = reg.flat ? `flat method table (${reg.flat.count.toLocaleString()} pointers)` : `${reg.modules.size} code modules`;
        this.log(`registrations: ${reg.meta.typesCount} types, ${code}`);
        note(`metadata registration @ ${hex(reg.meta.addr)} · ${reg.meta.typesCount.toLocaleString()} types · ${code}`);
        // image index -> code module
        this.moduleOfImage = this.md.images.map((img) => reg.modules.get(img.name) || null);
      }],
      ['types', 'Index type names', (note) => {
        this._indexTypes();
        this._detectTypeBits();
        this._detectStaticThis();
        note(`${this.byFullName.size.toLocaleString()} names · Il2CppType.byref at bit ${this.byrefBit}${this.staticThis ? ' · static methods take a leading __this' : ''}${this.splitI64 ? ' · long parameters split in two' : ''}`);
      }],
      ['layout', 'Calibrate runtime structs', (note) => {
        this._calibrate();
        const L = this.layout;
        note(`Il2CppClass name@${L.name} parent@${L.parent} fields@${L.fields} methods@${L.methods ?? '–'} · MethodInfo ${L.mi.vptr < 0 ? 'pre-2021.2' : '2021.2+'} layout${this.classTable ? ' · class table found' : ''}`);
      }],
      ['abi', 'Probe calling convention', (note) => {
        this._probeAbi();
        const fc = this.flavor === 'fastcomp';
        note(`${fc ? 'fastcomp / asm2wasm' : 'LLVM wasm backend'}${this.fnTables ? ` · ${this.fnTables.size} per-signature function tables` : ''} · i64 ${this.i64Mode}${this.sigs ? ` · ${this.sigs.count.toLocaleString()} typed table slots` : ''}`);
      }],
    ];
  }

  /**
   * Il2CppType bitfield: before metadata v27.2 it was attrs:16 type:8 num_mods:6 byref:1 pinned:1;
   * 27.2 shrank num_mods to 5 bits and added valuetype, moving byref from bit 30 to 29.
   * v27 doesn't say which, so look at the types: only the new layout sets bit 31 (valuetype).
   */
  _detectTypeBits() {
    const v = this.md.version;
    if (v >= 29) { this.byrefBit = 29; return; }
    if (v < 27) { this.byrefBit = 30; return; }
    const meta = this.reg.meta;
    const n = Math.min(meta.typesCount, 20000);
    let top = 0;
    for (let i = 0; i < n; i++) {
      const p = this.mem.u32At(meta.types + i * 4);
      if (p && (this.mem.u32At(p + 4) >>> 31)) top++;
    }
    this.byrefBit = top > n * 0.02 ? 29 : 30;
  }

  /**
   * Are 64-bit integers real wasm i64s, or split into two i32s (fastcomp's legalization)?
   * Checked on a few always-present mscorlib methods that take a long.
   */
  _probeAbi() {
    if (this.i64Mode === 'native' && !this.sigs) return;
    const probes = [
      ['System.Math', 'Abs', ['System.Int64']], ['System.Math', 'Max', ['System.Int64', 'System.Int64']],
      ['System.BitConverter', 'GetBytes', ['System.Int64']], ['System.Convert', 'ToInt32', ['System.Int64']],
      ['System.Int64', 'Equals', ['System.Int64']], ['System.TimeSpan', 'FromTicks', ['System.Int64']],
    ];
    for (const [t, n, sig] of probes) {
      let m = null;
      try { m = this.findMethod(t, n, sig); } catch (_) { /* ignore */ }
      if (!m) continue;
      const d = this.desc(m);
      const { il } = this._ilSig(d);
      const nI64 = il.filter((x) => x === 'i64').length;
      let len;
      const slot = this.slotOf(d); // sets d._dropMI, so read that after
      if (slot <= 0) continue;
      const kept = il.length - (d._dropMI ? 1 : 0);
      const exact = this.sigs && this.sigs.of(slot);
      if (exact) len = exact.params.length;
      else { try { len = this.fn(slot).length; } catch (_) { continue; } }
      if (len === kept) { this.i64Mode = 'native'; return; }
      if (len === kept + nI64) { this.i64Mode = 'legalized'; return; }
    }
  }

  /**
   * Before code modules got their own adjustor-thunk table (v24.0 – 24.4, v27.0: Unity 2018 –
   * 2020.1), instance methods of structs are listed by their adjustor thunk, which takes the
   * *boxed* object and adds 8 itself. Callers pass the address of the struct data, so the bridge
   * passes 8 less. Runtime MethodInfos (generic instances, overloads from a class) without a
   * virtualMethodPointer (before 2021.2) point struct methods at the thunk too.
   */
  boxedThis(d) {
    if (!this.reg || d.isStatic) return false;
    // flat table (v24.0/24.1), or code modules without their own adjustor-thunk table (v24.2 – 24.4, v27.0)
    if (d._boxedThis !== undefined) return d._boxedThis;
    if (this._thunkedStructs === undefined) this._thunkedStructs = !!this.reg.flat || (this.reg.adjustorThunks === false) || (this.reg.adjustorThunks == null && this.md.version < 29);
    // runtime MethodInfos before 2021.2 (no virtualMethodPointer) always point struct methods at the thunk
    const thunked = d.mi ? this.layout.mi.vptr < 0 : this._thunkedStructs;
    d._boxedThis = thunked && d.declTd >= 0 && this.md.typeDef(d.declTd).isValueType;
    return d._boxedThis;
  }

  /** Does the compiled function take a `this` argument? (static ones did too, until Unity 2018.3) */
  hasThis(d, staticThis = this.staticThis) { return !d.isStatic || staticThis; }

  /** IL-level wasm signature of a descriptor: [sret?] [this?] args... MethodInfo* */
  _ilSig(d, staticThis = this.staticThis) {
    const ret = this.abi(d.retType, true);
    const il = [];
    if (ret.wasm === 'ptr') il.push('i32');
    if (this.hasThis(d, staticThis)) il.push('i32');
    for (const p of d.params) { const a = this.abi(p.type); il.push(WASM_OF[a.wasm] || 'i32'); }
    il.push('i32');
    return { il, ilResult: ret.wasm === 'void' || ret.wasm === 'ptr' ? null : WASM_OF[ret.wasm] || 'i32', ret };
  }

  /** Emscripten signature string ("viii", "fif", "jij") of a descriptor, as dynCall_* names it. */
  dynSig(d, staticThis = this.staticThis, splitI64 = this.splitI64) {
    const L = { i32: 'i', i64: splitI64 ? 'ii' : 'j', f32: 'f', f64: 'd' };
    const { il, ilResult } = this._ilSig(d, staticThis);
    return (ilResult ? (ilResult === 'i64' ? 'j' : L[ilResult]) : 'v') + il.map((x) => L[x] || 'i').join('');
  }

  /**
   * The wasm table index that holds a method's code. On LLVM-backend builds (Unity 2021.2+)
   * that is the method pointer itself. fastcomp builds (Unity 2018 – 2021.1) keep a separate
   * table per signature inside the wasm table, so the pointer is relative to its signature's
   * table: index = offset[sig] + (ptr & mask[sig]). Returns 0 when it can't be resolved.
   */
  slotOf(d) {
    if (!d) return 0;
    if (!d.__desc) d = this.desc(d);
    if (d._slot !== undefined) return d._slot;
    let slot = d.ptr >>> 0;
    if (this.fnTables && slot) {
      const r = this._resolveSlot(d, this.staticThis);
      slot = r ? r.slot : 0;
      d._dropMI = !!(r && r.dropMI);
      if (r) d._wasmSig = r.sig;
      else d._noSlot = `pointer ${d.ptr} isn't in this build's ${this.dynSig(d)} function table`;
    } else if (slot && this.flavor === 'fastcomp') {
      // the raw pointer would land on an unrelated function: refuse rather than guess
      slot = 0;
      d._noSlot = 'fastcomp build: function tables unknown (reload the page with the bootstrap active)';
    }
    d._slot = slot;
    return slot;
  }

  /**
   * fastcomp: the exact wasm signature of a method, read from its IL2CPP invoker. Invokers call
   * the method pointer through call_indirect, typed with the method's real signature (leading
   * `this` on old static methods, split longs, f32 vs f64 and all). Returns "viii"-style or null.
   */
  _invokerSig(d) {
    const inv = this.reg && this.reg.invokers;
    if (!inv || !this.sigs || !this.sigs.callTypeAt || !this.fnTables) return null;
    const meta = d.meta;
    if (!meta || meta.genericContainerIndex !== -1) return null;
    let idx;
    if (this.reg.flat) idx = meta.invokerIndex;
    else {
      const mod = this.moduleOfImage[this.md.imageOfType[meta.declaringType]];
      if (!mod || !mod.invokerIndices) return null;
      const rid = meta.token & 0x00ffffff;
      if (rid < 1 || rid > mod.methodPointerCount) return null;
      idx = this.mem.i32At(mod.invokerIndices + (rid - 1) * 4);
    }
    if (!(idx >= 0 && idx < inv.count)) return null;
    const p = this.mem.u32At(inv.pointers + idx * 4);
    const t = this.fnTables.get('iiiii') || this.fnTables.get('viiiii');
    if (!p || !t || (t.mask !== null && p > t.mask)) return null;
    const type = this.sigs.callTypeAt(t.offset + (t.mask === null ? p : p & t.mask));
    if (!type) return null;
    const L = { i32: 'i', i64: 'j', f32: 'f', f64: 'd' };
    return (type.result ? L[type.result] : 'v') + type.params.map((x) => L[x]).join('');
  }

  /**
   * fastcomp: find a method's function in its signature's table. Candidates, in order: the
   * invoker's exact signature, then the one computed from the IL types; each also without the
   * trailing MethodInfo*, which the optimizer drops from some methods that never read it
   * (Math.Sqrt becomes double(double)). A candidate counts only if the pointer fits that table
   * and doesn't land on an abort stub.
   */
  _resolveSlot(d, staticThis, splitI64 = this.splitI64) {
    const full = this.dynSig(d, staticThis, splitI64);
    const inv = this._invokerSig(d);
    const cands = inv && inv !== full ? [inv, inv.slice(0, -1), full, full.slice(0, -1)] : [full, full.slice(0, -1)];
    for (const sig of cands) {
      const t = this.fnTables.get(sig);
      if (!t) continue;
      if (t.mask !== null && d.ptr > t.mask) continue;
      const at = t.offset + (t.mask === null ? d.ptr : d.ptr & t.mask);
      if (this.sigs && this.sigs.isStub && this.sigs.isStub(at)) continue;
      return { slot: at, dropMI: sig === full.slice(0, -1) || (!!inv && sig === inv.slice(0, -1)), sig, fromInvoker: sig === inv };
    }
    return null;
  }

  /**
   * Conventions old fastcomp builds don't record anywhere: did static methods take an unused
   * leading `this` (IL2CPP before Unity 2018.3)? Are long parameters split into two i32s? The
   * invokers say exactly, so let them vote; without them, see which reading makes more methods
   * land on real functions.
   */
  _detectStaticThis() {
    this.staticThis = false;
    this.splitI64 = false;
    if (!this.fnTables) return;
    const votes = { st: 0, noSt: 0, split: 0, native: 0 };
    let n = 0;
    for (let td = 0; td < this.md.typeCount && n < 1500; td++) {
      if (this.md.typeDef(td).isGeneric) continue;
      for (const m of this.methodsOf(td)) {
        if (m.genericContainerIndex !== -1 || !this.methodPointer(m)) continue;
        const d = this.desc(m);
        const inv = this._invokerSig(d);
        if (!inv) continue;
        n++;
        const hasLong = this._ilSig(d, false).il.includes('i64');
        for (const [st, sp] of [[false, false], [true, false], [false, true], [true, true]]) {
          if (this.dynSig(d, st, sp) !== inv) continue;
          if (d.isStatic) votes[st ? 'st' : 'noSt']++;
          if (hasLong) votes[sp ? 'split' : 'native']++;
          break;
        }
      }
    }
    if (votes.st + votes.noSt + votes.split + votes.native > 0) {
      this.staticThis = votes.st > votes.noSt;
      this.splitI64 = votes.split > votes.native;
      this.log(`invoker signatures (${n}): static this ${votes.st}/${votes.st + votes.noSt}, split longs ${votes.split}/${votes.split + votes.native}`);
      return;
    }
    // no invokers: count which reading lands on real functions
    let without = 0; let withThis = 0;
    n = 0;
    for (let td = 0; td < this.md.typeCount && n < 800; td++) {
      if (this.md.typeDef(td).isGeneric) continue;
      for (const m of this.methodsOf(td)) {
        if (!(m.flags & METHOD.STATIC) || m.genericContainerIndex !== -1 || !this.methodPointer(m)) continue;
        const d = this.desc(m);
        n++;
        if (this._resolveSlot(d, false, false)) without++;
        if (this._resolveSlot(d, true, false)) withThis++;
      }
    }
    this.staticThis = withThis > without && withThis > n * 0.6;
    this.log(`static methods: ${without}/${n} resolve without __this, ${withThis}/${n} with it`);
  }

  /**
   * How a method's IL-level arguments map onto the actual wasm function in its table slot.
   * Upstream (LLVM) builds match one to one. fastcomp builds may split each i64 into (lo, hi)
   * i32s and return the high half in tempRet0, and may pass floats as f64; the exact types come
   * from the game's wasm binary when the bootstrap saw it.
   * Returns { params, result, exact, legal, split(args), join(raw), retIn(v), retOut(v), error? }
   */
  callSig(d) {
    if (d._cs) return d._cs;
    const { il, ilResult } = this._ilSig(d);
    const slot = this.slotOf(d);
    const exact = this.sigs && slot > 0 ? this.sigs.of(slot) : null;
    const last = il.length - 1;
    const drop = (i) => d._dropMI && i === last; // MethodInfo* not passed (see slotOf)
    let params; let result; const map = [];
    if (exact) {
      params = exact.params; result = exact.result;
      // line the IL arguments up with the wasm parameters: a long may be two i32s, and the
      // trailing MethodInfo* may be missing (the optimizer drops it where it's never read)
      const align = (dropLast) => {
        const mp = []; let j = 0;
        il.forEach((t, i) => {
          if (dropLast && i === last) mp.push(0);
          else if (t === 'i64' && params[j] === 'i32' && params[j + 1] === 'i32') { mp.push(2); j += 2; } else { mp.push(1); j += 1; }
        });
        return j === params.length ? mp : null;
      };
      const mp = align(false) || align(true);
      if (!mp) return { error: `signature mismatch (IL ${il.length} params, wasm ${params.length})`, params, result, exact: true, il, ilResult };
      map.push(...mp);
      d._dropMI = mp[last] === 0;
    } else {
      let len = il.length;
      try { len = this.fn(slot).length; } catch (_) { /* no table entry */ }
      const nI64 = il.filter((x) => x === 'i64').length;
      const kept = il.length - (d._dropMI ? 1 : 0);
      const legal = this.i64Mode === 'legalized' || (nI64 > 0 && len === kept + nI64);
      il.forEach((t, i) => map.push(drop(i) ? 0 : t === 'i64' && legal ? 2 : 1));
      params = il.flatMap((t, i) => (drop(i) ? [] : t === 'i64' && legal ? ['i32', 'i32'] : [t]));
      result = ilResult === 'i64' && legal ? 'i32' : ilResult;
      if (len !== params.length) return { error: `signature mismatch (expected ${params.length} wasm params, function takes ${len})`, params, result, exact: false, il, ilResult };
    }
    const retLegal = ilResult === 'i64' && result === 'i32';
    const legal = map.some((x) => x !== 1) || retLegal;
    const self = this;
    const cs = {
      params, result, il, ilResult, exact: !!exact, legal, dropMI: !!d._dropMI,
      split(args) {
        if (!legal) return args;
        const out = [];
        for (let i = 0; i < args.length; i++) {
          if (map[i] === 0) continue;
          if (map[i] === 2) { const b = BigInt.asUintN(64, BigInt(args[i] ?? 0)); out.push(Number(b & 0xffffffffn) | 0, Number(b >> 32n) | 0); } else out.push(args[i]);
        }
        return out;
      },
      join(raw) {
        if (!legal) return raw;
        const out = [];
        for (let i = 0, j = 0; i < map.length; i++) {
          if (map[i] === 0) out.push(0);
          else if (map[i] === 2) { out.push(BigInt.asIntN(64, (BigInt(raw[j + 1] >>> 0) << 32n) | BigInt(raw[j] >>> 0))); j += 2; } else out.push(raw[j++]);
        }
        return out;
      },
      retIn(v) {
        if (!retLegal) return v;
        const hi = self.getTempRet0 ? self.getTempRet0() : 0;
        return BigInt.asIntN(64, (BigInt(hi >>> 0) << 32n) | BigInt(v >>> 0));
      },
      retOut(v) {
        if (!retLegal) return v;
        const b = BigInt.asIntN(64, BigInt(v ?? 0));
        if (self.setTempRet0) self.setTempRet0(Number(BigInt.asIntN(32, b >> 32n)));
        return Number(BigInt.asIntN(32, b));
      },
    };
    if (retLegal && !this.getTempRet0) cs.error = 'returns a split 64-bit value but getTempRet0 is not exported';
    d._cs = cs;
    return cs;
  }

  _indexTypes() {
    const md = this.md;
    this.byFullName = new Map();
    for (let i = 0; i < md.typeCount; i++) {
      const fn = this.tdFullName(i, true);
      if (!this.byFullName.has(fn)) this.byFullName.set(fn, i);
    }
  }

  // ------------------------------------------------------------------ types

  typePtr(typeIndex) {
    if (typeIndex < 0 || typeIndex >= this.reg.meta.typesCount) return 0;
    return this.mem.u32At(this.reg.meta.types + typeIndex * 4);
  }

  typeInfo(p) {
    const m = this.mem;
    const bits = m.u32At(p + 4);
    return { ptr: p, data: m.u32At(p), attrs: bits & 0xffff, kind: (bits >>> 16) & 0xff, byref: ((bits >>> this.byrefBit) & 1) === 1 };
  }

  /** Il2CppType.data for CLASS/VALUETYPE is a typedef index (static data) or a typedef handle (runtime). */
  _tdFromData(d) {
    if (d < this.md.typeCount) return d;
    return this.md.typeDefFromAddr(d);
  }

  /** Type definition index of a CLASS/VALUETYPE/GENERICINST type, or -1. */
  tdOfType(p) {
    if (!p) return -1;
    const t = this.typeInfo(p);
    if (t.kind === T.CLASS || t.kind === T.VALUETYPE) return this._tdFromData(t.data);
    if (t.kind === T.GENERICINST) return this.tdOfType(this._genericBase(t.data));
    return -1;
  }

  tdOfTypeIndex(typeIndex) { return this.tdOfType(this.typePtr(typeIndex)); }

  /** Il2CppGenericClass -> Il2CppType* of the generic definition (v27+) */
  _genericBase(gc) {
    const first = this.mem.u32At(gc);
    if (first < this.md.typeCount) return this.typePtr(this.md.typeDef(first).byvalTypeIndex);
    return first;
  }

  _genericArgs(inst) {
    if (!inst) return [];
    const m = this.mem;
    const n = m.u32At(inst);
    const argv = m.u32At(inst + 4);
    const out = [];
    for (let i = 0; i < n && i < 32; i++) out.push(m.u32At(argv + i * 4));
    return out;
  }

  _genericParamName(d) { return this.md.genericParamName(d); }

  tdFullName(i, arity = false) {
    const t = this.md.typeDef(i);
    const n = arity ? t.name : t.name.replace(/`\d+$/, '');
    if (t.declaringTypeIndex >= 0) {
      const d = this.tdOfTypeIndex(t.declaringTypeIndex);
      if (d >= 0 && d !== i) return this.tdFullName(d, arity) + '+' + n;
    }
    return t.namespace ? t.namespace + '.' + n : n;
  }

  tdShortName(i) {
    const t = this.md.typeDef(i);
    let n = t.name.replace(/`\d+$/, '');
    if (t.isGeneric) n += '<' + this.md.genericParamNames(t.genericContainerIndex).join(', ') + '>';
    return n;
  }

  /** C#-style name for an Il2CppType*. */
  typeName(p, full = false) {
    if (!p) return '?';
    const t = this.typeInfo(p);
    const suffix = t.byref ? '&' : '';
    if (PRIM_NAME[t.kind]) return PRIM_NAME[t.kind] + suffix;
    switch (t.kind) {
      case T.CLASS:
      case T.VALUETYPE: {
        const td = this._tdFromData(t.data);
        if (td < 0) return '?';
        return (full ? this.tdFullName(td) : this.md.typeDef(td).name.replace(/`\d+$/, '')) + suffix;
      }
      case T.SZARRAY: return this.typeName(t.data, full) + '[]' + suffix;
      case T.ARRAY: return this.typeName(this.mem.u32At(t.data), full) + '[' + ','.repeat(Math.max(0, this.mem.u8At(t.data + 4) - 1)) + ']' + suffix;
      case T.PTR: return this.typeName(t.data, full) + '*' + suffix;
      case T.VAR:
      case T.MVAR: return this._genericParamName(t.data) + suffix;
      case T.GENERICINST: {
        const base = this.typeName(this._genericBase(t.data), full);
        const args = this._genericArgs(this.mem.u32At(t.data + 4)).map((a) => this.typeName(a, full));
        return base + '<' + args.join(', ') + '>' + suffix;
      }
      case T.FNPTR: return 'fnptr';
      default: return `?${t.kind}`;
    }
  }

  // ------------------------------------------------------------------ lookup

  findType(fullName) {
    let i = this.byFullName.get(fullName);
    if (i === undefined && fullName.includes('.') && !fullName.includes('+')) {
      // nested types written with dots: try each split between namespace and the nesting chain
      const parts = fullName.split('.');
      for (let s = parts.length - 1; s >= 0 && i === undefined; s--) {
        const head = parts.slice(0, s).join('.');
        const tail = parts.slice(s).join('+');
        if (s === parts.length - 1 && !head) continue;
        i = this.byFullName.get(head ? `${head}.${tail}` : tail);
      }
    }
    return i === undefined ? -1 : i;
  }

  /** Methods of a type definition (metadata records with their global index). */
  methodsOf(td) {
    const t = this.md.typeDef(td);
    const out = [];
    for (let k = 0; k < t.methodCount; k++) out.push(this.md.method(t.methodStart + k));
    return out;
  }

  fieldsOf(td) {
    const t = this.md.typeDef(td);
    const out = [];
    for (let k = 0; k < t.fieldCount; k++) {
      const f = this.md.field(t.fieldStart + k);
      f.local = k;
      f.type = this.typePtr(f.typeIndex);
      f.attrs = f.type ? this.typeInfo(f.type).attrs : 0;
      out.push(f);
    }
    return out;
  }

  propertiesOf(td) {
    const t = this.md.typeDef(td);
    const out = [];
    for (let k = 0; k < t.propertyCount; k++) {
      const p = this.md.property(t.propertyStart + k);
      p.getter = p.get >= 0 ? this.md.method(t.methodStart + p.get) : null;
      p.setter = p.set >= 0 ? this.md.method(t.methodStart + p.set) : null;
      out.push(p);
    }
    return out;
  }

  params(method) {
    if (method && method.__desc) return method.params;
    const out = [];
    for (let k = 0; k < method.parameterCount; k++) {
      const p = this.md.param(method.parameterStart + k);
      p.type = this.typePtr(p.typeIndex);
      out.push(p);
    }
    return out;
  }

  parentTd(td) {
    const t = this.md.typeDef(td);
    return t.parentIndex >= 0 ? this.tdOfTypeIndex(t.parentIndex) : -1;
  }

  /** td and all its base types, most derived first. */
  hierarchy(td) {
    const out = [];
    for (let i = td, g = 0; i >= 0 && g < 64; i = this.parentTd(i), g++) out.push(i);
    return out;
  }

  isSubclassOf(td, baseTd) {
    for (let i = td, g = 0; i >= 0 && g < 64; i = this.parentTd(i), g++) if (i === baseTd) return true;
    return false;
  }

  /**
   * Find a method by type full name, name and optional parameter type names / count.
   * Searches base types too, so `findMethod('UnityEngine.Transform', 'get_name')` works.
   */
  findMethod(typeName, name, sig) {
    const td = typeof typeName === 'number' ? typeName : this.findType(typeName);
    if (td < 0) return null;
    for (const t of this.hierarchy(td)) {
      for (const m of this.methodsOf(t)) {
        if (m.name !== name) continue;
        if (sig !== undefined) {
          if (typeof sig === 'number') { if (m.parameterCount !== sig) continue; }
          else {
            if (m.parameterCount !== sig.length) continue;
            const ps = this.params(m);
            if (!sig.every((s, k) => { const a = ALIAS[s] || s; return s === '*' || this.typeName(ps[k].type, true) === a || this.typeName(ps[k].type) === a; })) continue;
          }
        }
        if (!this.methodPointer(m)) continue;
        return m;
      }
    }
    return null;
  }

  // ------------------------------------------------------------------ callable descriptors
  //
  // Everything that calls or patches a method goes through a descriptor:
  //   { __desc, name, label, ptr, isStatic, flags, params: [{ name, type }], retType, mi, meta, declTd, generic }
  // Metadata methods get one with mi = 0; runtime MethodInfo* (generic instances) carry real types and mi.

  desc(m) {
    if (!m) return null;
    if (m.__desc) return m;
    if (m._desc) return m._desc;
    const declTd = m.declaringType;
    const generic = m.genericContainerIndex !== -1 || this.md.typeDef(declTd).isGeneric;
    const d = {
      __desc: true,
      name: m.name,
      label: `${this.tdFullName(declTd)}::${m.name}`,
      ptr: this.methodPointer(m),
      isStatic: (m.flags & METHOD.STATIC) !== 0,
      flags: m.flags,
      params: this.params(m),
      retType: this.typePtr(m.returnType),
      mi: 0,
      meta: m,
      declTd,
      generic,
      parameterCount: m.parameterCount,
    };
    m._desc = d;
    return d;
  }

  /** Descriptor for a runtime MethodInfo* (works for generic instances: types are inflated). */
  miDesc(mi, meta) {
    const m = this.mem;
    const L = this.layout.mi;
    const k = m.u32At(mi + L.klass);
    const n = m.u8At(mi + L.count);
    const pp = m.u32At(mi + L.params);
    const params = [];
    const metaParams = meta ? this.params(meta) : [];
    for (let i = 0; i < n; i++) params.push({ name: metaParams[i] ? metaParams[i].name : `arg${i}`, type: m.u32At(pp + i * L.paramStride + L.paramType) });
    const flags = m.u16At(mi + L.flags);
    const name = m.cstr(m.u32At(mi + L.name), 512);
    return {
      __desc: true,
      name,
      label: `${this.klassName(k)}::${name}`,
      ptr: m.u32At(mi + L.ptr),
      isStatic: (flags & METHOD.STATIC) !== 0,
      flags,
      params,
      retType: m.u32At(mi + L.ret),
      mi,
      meta: meta || null,
      klass: k,
      declTd: this.tdOfKlass(k),
      generic: false,
      parameterCount: n,
    };
  }

  // ------------------------------------------------------------------ generics

  /** Managed System.Type[] from Il2CppType*s. */
  typeArray(types) {
    if (!this._arrCreate) {
      this._arrCreate = this.findMethod('System.Array', 'CreateInstance', ['System.Type', 'System.Int32']);
      if (!this._arrCreate) throw new Error('Array.CreateInstance(Type, int) is not available in this build');
    }
    const arr = this.call(this._arrCreate, 0, this.typeObjectOfTd(this.findType('System.Type')), types.length);
    for (let i = 0; i < types.length; i++) this.mem.setU32(arr + 16 + i * 4, this.typeObject(types[i]));
    return arr;
  }

  /** Il2CppType* for a type name, supporting generic syntax: "System.Collections.Generic.List<System.Int32>". */
  resolveTypeName(name) {
    name = name.trim();
    const PRIM = { int: 'System.Int32', uint: 'System.UInt32', long: 'System.Int64', ulong: 'System.UInt64', short: 'System.Int16', ushort: 'System.UInt16', byte: 'System.Byte', sbyte: 'System.SByte', float: 'System.Single', double: 'System.Double', bool: 'System.Boolean', char: 'System.Char', string: 'System.String', object: 'System.Object', IntPtr: 'System.IntPtr', UIntPtr: 'System.UIntPtr', void: 'System.Void' };
    if (PRIM[name]) name = PRIM[name];
    if (name.endsWith('[]')) {
      const el = this.resolveTypeName(name.slice(0, -2));
      const mk = this.findMethod('System.RuntimeType', 'MakeArrayType', 0) || this.findMethod('System.MonoType', 'MakeArrayType', 0) || this.findMethod('System.Type', 'MakeArrayType', 0);
      if (!mk || this.whyNotCallable(mk)) throw new Error(`can't make the array type ${name}: Type.MakeArrayType isn't available in this build`);
      const t = this.call(mk, this.typeObject(el));
      return this._typeOfTypeObject(t);
    }
    const lt = name.indexOf('<');
    if (lt >= 0 && name.lastIndexOf('>') < lt) throw new Error(`type name ${name}: missing closing '>'`);
    if (lt < 0) {
      const td = this.findType(name);
      if (td < 0) throw new Error(`type ${name} not found`);
      return this.typePtr(this.md.typeDef(td).byvalTypeIndex);
    }
    const base = name.slice(0, lt);
    const args = splitGenericArgs(name.slice(lt + 1, name.lastIndexOf('>')));
    let td = this.findType(`${base}\`${args.length}`);
    if (td < 0) td = this.findType(base);
    if (td < 0) throw new Error(`generic type ${base} not found`);
    return this.makeGenericType(td, args.map((a) => this.resolveTypeName(a)));
  }

  _typeOfTypeObject(t) {
    // RuntimeType._impl (RuntimeTypeHandle { IntPtr value }) -> Il2CppType*
    const f = this.allFields(this.klassOf(t)).find((x) => x.name === '_impl' || x.name === 'm_handle');
    if (!f) throw new Error('RuntimeType has no _impl field');
    return this.mem.u32At(t + f.offset);
  }

  /** Il2CppType* of Def<args...> (creates the runtime class). */
  makeGenericType(td, argTypes) {
    const key = td + ':' + argTypes.join(',');
    this._gtypes ||= new Map();
    if (this._gtypes.has(key)) return this._gtypes.get(key);
    const mk = this.findMethod('System.RuntimeType', 'MakeGenericType', 1) || this.findMethod('System.MonoType', 'MakeGenericType', 1) || this.findMethod('System.Type', 'MakeGenericType', 1);
    if (!mk) throw new Error('Type.MakeGenericType is not available in this build');
    const t = this.call(mk, this.typeObjectOfTd(td), this.typeArray(argTypes));
    const p = this._typeOfTypeObject(t);
    this._gtypes.set(key, p);
    return p;
  }

  /** Il2CppClass* for any Il2CppType* (generic instances included). */
  klassOfType(p) {
    const t = this.typeInfo(p);
    if (t.kind === T.GENERICINST) {
      let k = this.cachedClass(p);
      if (!k) { this.typeObject(p); k = this.cachedClass(p); }
      if (!k) {
        // force class creation through RuntimeHelpers.RunClassConstructor
        const rc = this.findMethod('System.Runtime.CompilerServices.RuntimeHelpers', 'RunClassConstructor', 1);
        if (rc) { try { this.call(rc, 0, p); } catch (_) { /* ignore */ } }
        k = this.cachedClass(p);
      }
      return k;
    }
    const td = this.tdOfType(p);
    return td >= 0 ? this.ensureClass(td) : 0;
  }

  /**
   * Inflate a generic method definition: GetComponent<T> -> GetComponent<Rigidbody>.
   * Goes through reflection (MethodInfo.MakeGenericMethod), which hands back a runtime
   * MethodInfo* with resolved code and the context shared generic code needs.
   */
  inflateMethod(meta, argTypes, klass = 0) {
    const declTd = meta.declaringType;
    const onGeneric = this.md.typeDef(declTd).isGeneric;
    // a generic method of a generic type needs the instantiated class (List<int>), i.e. the instance's
    let k = 0;
    if (onGeneric) {
      for (let c = klass, g = 0; c && g < 64; c = this.parentKlass(c), g++) if (this.tdOfKlass(c) === declTd) { k = c; break; }
      if (!k) throw new Error(`${meta.name}<…> is declared on the generic type ${this.tdFullName(declTd)}: call it on an instance (or on Il2Cpp.type('${this.tdFullName(declTd)}<…>'))`);
    }
    const key = meta.index + ':' + (k || '') + ':' + argTypes.join(',');
    this._ginfl ||= new Map();
    if (this._ginfl.has(key)) return this._ginfl.get(key);
    if (!k) k = this.ensureClass(declTd);
    const local = meta.index - this.md.typeDef(declTd).methodStart;
    const arr = k && this.layout.methods !== undefined ? this.mem.u32At(k + this.layout.methods) : 0;
    const defMi = arr ? this.mem.u32At(arr + local * 4) : 0;
    if (!this.mem.valid(defMi)) throw new Error(`no runtime MethodInfo for ${meta.name} (class not set up)`);
    const fromHandle = onGeneric
      ? this.findMethod('System.Reflection.MethodBase', 'GetMethodFromHandle', 2)
      : this.findMethod('System.Reflection.MethodBase', 'GetMethodFromHandle', 1);
    const make = this.findMethod('System.Reflection.RuntimeMethodInfo', 'MakeGenericMethod', 1) || this.findMethod('System.Reflection.MonoMethod', 'MakeGenericMethod', 1);
    if (!fromHandle || !make) throw new Error('reflection (MethodBase.GetMethodFromHandle / MakeGenericMethod) is not available in this build');
    const rmi = onGeneric ? this.call(fromHandle, 0, defMi, k + this.layout.byval) : this.call(fromHandle, 0, defMi);
    const inst = this.call(make, rmi, this.typeArray(argTypes));
    const f = this.allFields(this.klassOf(inst)).find((x) => x.name === 'mhandle');
    if (!f) throw new Error('RuntimeMethodInfo.mhandle not found');
    const mi = this.mem.u32At(inst + f.offset);
    const d = this.miDesc(mi, meta);
    d.label = `${onGeneric ? this.klassName(k) : this.tdFullName(declTd)}::${meta.name}<${argTypes.map((t) => this.typeName(t)).join(', ')}>`;
    if (!d.ptr) throw new Error(`${d.label} has no code in this build (that instantiation was never compiled)`);
    this._ginfl.set(key, d);
    return d;
  }

  /** Runtime methods of a class (index i matches metadata method i of its definition). */
  runtimeMethods(k) {
    const L = this.layout;
    if (L.methods === undefined || !k) return [];
    const arr = this.mem.u32At(k + L.methods);
    if (!this.mem.valid(arr)) return [];
    const td = this.tdOfKlass(k);
    const metas = td >= 0 ? this.methodsOf(td) : [];
    const out = [];
    for (let i = 0; i < metas.length; i++) {
      const mi = this.mem.u32At(arr + i * 4);
      if (!this.mem.valid(mi)) continue;
      out.push(this.miDesc(mi, metas[i]));
    }
    return out;
  }

  /** wasm table index of a method's code, or 0 (abstract, stripped, generic). */
  methodPointer(m) {
    if (m.genericContainerIndex !== -1) return 0;
    const flat = this.reg.flat;
    if (flat) {
      // v24.0/24.1: one flat array, indexed by the method definition's methodIndex
      const i = m.methodIndex;
      return i >= 0 && i < flat.count ? this.mem.u32At(flat.pointers + i * 4) : 0;
    }
    const img = this.md.imageOfType[m.declaringType];
    const mod = this.moduleOfImage[img];
    if (!mod) return 0;
    const rid = m.token & 0x00ffffff;
    if (rid < 1 || rid > mod.methodPointerCount) return 0;
    return this.mem.u32At(mod.methodPointers + (rid - 1) * 4);
  }

  fn(ptr) {
    let f = this._fn.get(ptr);
    if (!f) {
      f = this.table.get(ptr);
      this._fn.set(ptr, f);
    }
    return f;
  }

  // ------------------------------------------------------------------ runtime structs

  /**
   * Work out Il2CppClass field offsets by inspecting System.String, whose layout we know
   * from metadata. This keeps us independent of the exact Unity version.
   */
  _calibrate() {
    const m = this.mem;
    const md = this.md;
    const L = {};
    this.layout = L;
    const strTd = this.findType('System.String');
    const objTd = this.findType('System.Object');
    if (strTd < 0 || objTd < 0) throw new Error('System.String not in metadata');
    this.td = { String: strTd, Object: objTd };

    // .NET 4.x profile: FastAllocateString; the legacy .NET 3.5 profile (Unity 2018): InternalAllocateStr
    const fast = this.findMethod(strTd, 'FastAllocateString', 1) || this.findMethod(strTd, 'InternalAllocateStr', 1);
    if (!fast) throw new Error('String.FastAllocateString not found');
    this._fastAlloc = fast;
    const fastSlot = this.slotOf(fast);
    if (!fastSlot) throw new Error(`can't call String.FastAllocateString: ${this.desc(fast)._noSlot || 'no code'}`);
    const fastD = this.desc(fast);
    const s = this._rawCall(fastSlot, [...(this.staticThis ? [0] : []), 1, ...(fastD._dropMI ? [] : [0])]) >>> 0;
    if (!m.valid(s)) throw new Error('FastAllocateString returned ' + hex(s));
    const K = m.u32At(s);
    this.klass = { String: K };

    // name / namespace
    const nameAddr = md.strAddr(md.typeDef(strTd).nameIndex);
    const nsAddr = md.strAddr(md.typeDef(strTd).namespaceIndex);
    for (let o = 0; o < 64; o += 4) if (m.u32At(K + o) === nameAddr && m.u32At(K + o + 4) === nsAddr) { L.name = o; L.namespace = o + 4; break; }
    if (L.name === undefined) throw new Error('Il2CppClass.name not found');
    // byval_arg follows namespaze; this_arg follows byval_arg
    L.byval = L.namespace + 4;
    // typeMetadataHandle -> our typedef record
    const tdAddr = md.typeDefAddr(strTd);
    for (let o = L.byval + 16; o < 160; o += 4) if (m.u32At(K + o) === tdAddr) { L.handle = o; break; }
    // parent -> System.Object's class
    const objName = md.strAddr(md.typeDef(objTd).nameIndex);
    for (let o = L.byval; o < 160; o += 4) {
      const p = m.u32At(K + o);
      if (m.valid(p) && m.u32At(p + L.name) === objName && p !== K) { L.parent = o; break; }
    }
    if (L.parent === undefined) throw new Error('Il2CppClass.parent not found');
    this.klass.Object = m.u32At(K + L.parent);
    L.declaring = L.parent - 4;
    L.elementClass = L.parent - 12;
    L.genericClass = L.parent + 4;
    // fields -> FieldInfo[] { name, type, parent, offset, token }
    const strFields = this.fieldsOf(strTd);
    const f0 = md.strAddr(strFields[0].nameIndex);
    for (let o = L.parent; o < 200; o += 4) {
      const p = m.u32At(K + o);
      if (m.valid(p) && m.u32At(p) === f0 && m.u32At(p + 8) === K) { L.fields = o; break; }
    }
    if (L.fields === undefined) throw new Error('Il2CppClass.fields not found');
    // FieldInfo { name, type, parent, offset, [customAttributeIndex (v24.0)], token }: find the stride from field 1's name
    L.fieldInfoSize = 20;
    if (strFields.length > 1) {
      const arr = m.u32At(K + L.fields);
      const n1 = md.strAddr(strFields[1].nameIndex);
      for (const size of [20, 24, 16]) if (m.u32At(arr + size) === n1) { L.fieldInfoSize = size; break; }
    }
    // static_fields -> String.Empty is a zero-length string
    const empty = this.runtimeFields(K).find((f) => f.name === 'Empty' && f.isStatic);
    for (let o = L.fields; o < 260 && empty; o += 4) {
      const p = m.u32At(K + o);
      if (!m.valid(p)) continue;
      const v = m.u32At(p + empty.offset);
      if (m.valid(v) && m.u32At(v) === K && m.i32At(v + 8) === 0) { L.staticFields = o; break; }
    }
    // methods -> MethodInfo*[] { methodPointer, virtualMethodPointer, invoker, name, klass, return_type, parameters, ... }
    // Unity 2021.2+ (v29): { methodPointer, virtualMethodPointer, invoker, name, klass, ... }
    // before that there is no virtualMethodPointer, so name sits at 8 instead of 12
    const strMethods = this.methodsOf(strTd);
    const firstMethod = strMethods[0];
    const mName = md.strAddr(firstMethod.nameIndex);
    let nameOff = md.version >= 29 ? 12 : 8;
    for (let o = L.fields; o < 200 && L.methods === undefined; o += 4) {
      const arr = m.u32At(K + o);
      if (!m.valid(arr)) continue;
      const mi = m.u32At(arr);
      if (!m.valid(mi)) continue;
      for (const n of [12, 8]) if (m.u32At(mi + n) === mName && m.u32At(mi + n + 4) === K) { L.methods = o; nameOff = n; break; }
    }
    if (nameOff === 12) {
      L.mi = { ptr: 0, vptr: 4, invoker: 8, name: 12, klass: 16, ret: 20, params: 24, token: 36, flags: 40, slot: 44, count: 46, paramStride: 4, paramType: 0 };
    } else {
      // pre-2021.2: no virtualMethodPointer; parameters is a ParameterInfo[] { name, position, token, parameter_type }
      L.mi = { ptr: 0, vptr: -1, invoker: 4, name: 8, klass: 12, ret: 16, params: 20, token: 32, flags: 36, slot: 40, count: 42, paramStride: 16, paramType: 12 };
    }
    if (L.methods !== undefined) {
      const arr = m.u32At(K + L.methods);
      const mi = m.u32At(arr);
      // the token follows two unions (v24.0 had a customAttributeIndex in between)
      for (let o = L.mi.ret + 8; o <= L.mi.ret + 24; o += 4) {
        if (m.u32At(mi + o) === firstMethod.token && m.u16At(mi + o + 4) === firstMethod.flags) { Object.assign(L.mi, { token: o, flags: o + 4, slot: o + 8, count: o + 10 }); break; }
      }
      // parameters: Il2CppType*[] (2021.2+) or ParameterInfo[]; check on a String method that has one
      for (let i = 0; i < strMethods.length && i < 64; i++) {
        const meta = strMethods[i];
        if (meta.parameterCount < 1) continue;
        const mi2 = m.u32At(arr + i * 4);
        if (!m.valid(mi2)) continue;
        const pp = m.u32At(mi2 + L.mi.params);
        if (!m.valid(pp)) continue;
        const p0 = this.params(meta)[0];
        if (m.u32At(pp) === p0.type) { L.mi.paramStride = 4; L.mi.paramType = 0; break; }
        // v24.0 (Unity 2018.1/2018.2): ParameterInfo still has a customAttributeIndex before the type
        if (m.u32At(pp) === md.strAddr(p0.nameIndex) && m.u32At(pp + 16) === p0.type && m.u32At(pp + 12) !== p0.type) { L.mi.paramStride = 20; L.mi.paramType = 16; break; }
        if (m.u32At(pp + 12) === p0.type || m.u32At(pp) === md.strAddr(p0.nameIndex)) { L.mi.paramStride = 16; L.mi.paramType = 12; break; }
      }
    }
    // Class table: Il2CppClass*[typeCount] indexed by type definition. Every String object also
    // starts with K, so a candidate only counts if a sample of its entries all name their typedef.
    m.views();
    const u32 = m.u32;
    for (let i = 0; i < u32.length && !this.classTable; i++) {
      if (u32[i] !== K) continue;
      const base = i * 4 - strTd * 4;
      if (base <= 0 || m.u32At(base + objTd * 4) !== this.klass.Object) continue;
      let ok = 0;
      let bad = 0;
      for (let j = 0; j < md.typeCount && bad < 2; j += 3) {
        const c = m.u32At(base + j * 4);
        if (!c) continue;
        if (m.valid(c) && m.u32At(c + L.name) === md.strAddr(md.typeDef(j).nameIndex)) ok++;
        else bad++;
      }
      if (!bad && ok > 3) this.classTable = base;
    }
    this.log(`Il2CppClass: name@${L.name} parent@${L.parent} fields@${L.fields} static@${L.staticFields} handle@${L.handle}` +
      (this.classTable ? `, class table ${hex(this.classTable)}` : ', no class table'));
  }

  klassOf(obj) { return obj ? this.mem.u32At(obj) : 0; }

  /** Type definition of a runtime class (generic instances map to their definition). */
  tdOfKlass(k) {
    const m = this.mem;
    const L = this.layout;
    if (!k) return -1;
    if (L.handle !== undefined) {
      const i = this.md.typeDefFromAddr(m.u32At(k + L.handle));
      if (i >= 0) return i;
    }
    // generic instance: the byval type is GENERICINST -> definition
    const td = this.tdOfType(k + L.byval);
    if (td >= 0 || L.name === undefined) return td;
    // String, Object, int…: their byval type is a primitive kind; go by the class's name
    this._tdByName ||= new Map();
    if (this._tdByName.has(k)) return this._tdByName.get(k);
    let r = -1;
    try {
      const n = m.cstr(m.u32At(k + L.name), 256);
      const ns = m.cstr(m.u32At(k + L.namespace), 256);
      r = this.findType(ns ? `${ns}.${n}` : n);
    } catch (_) { /* not a class */ }
    this._tdByName.set(k, r);
    return r;
  }

  /** Il2CppClass* for a type definition if the runtime has created it, else 0. */
  klassOfTd(td) {
    if (this.classTable && td >= 0 && td < this.md.typeCount) return this.mem.u32At(this.classTable + td * 4);
    return 0;
  }

  klassName(k, full = true) {
    if (!k || !this.mem.valid(k)) return '?';
    const L = this.layout;
    return this.typeName(k + L.byval, full);
  }

  parentKlass(k) { return k ? this.mem.u32At(k + this.layout.parent) : 0; }

  isInstanceOf(obj, td) {
    for (let k = this.klassOf(obj), g = 0; k && g < 64; k = this.parentKlass(k), g++) if (this.tdOfKlass(k) === td) return true;
    return false;
  }

  /** FieldInfo records of exactly this class (not its parents). */
  runtimeFields(k) {
    const m = this.mem;
    const L = this.layout;
    const td = this.tdOfKlass(k);
    if (td < 0) return [];
    const n = this.md.typeDef(td).fieldCount;
    const arr = m.u32At(k + L.fields);
    const out = [];
    if (!m.valid(arr)) return out;
    for (let i = 0; i < n; i++) {
      const p = arr + i * L.fieldInfoSize;
      const type = m.u32At(p + 4);
      const attrs = type ? this.typeInfo(type).attrs : 0;
      out.push({
        name: m.cstr(m.u32At(p), 512),
        type,
        attrs,
        offset: m.i32At(p + 12),
        token: m.u32At(p + L.fieldInfoSize - 4),
        isStatic: (attrs & FIELD.STATIC) !== 0,
        isConst: (attrs & FIELD.LITERAL) !== 0,
        klass: k,
        td,
        metaIndex: this.md.typeDef(td).fieldStart + i,
      });
    }
    return out;
  }

  staticFieldsBase(k) {
    if (this.layout.staticFields === undefined || !k) return 0;
    return this.mem.u32At(k + this.layout.staticFields);
  }

  /** Field offset from metadata registration (works without a runtime class). */
  metaFieldOffset(td, local) {
    const p = this.mem.u32At(this.reg.meta.fieldOffsets + td * 4);
    if (!p) return -1;
    return this.mem.i32At(p + local * 4);
  }

  /** Unboxed size of a value type definition. */
  valueSize(td) {
    const p = this.mem.u32At(this.reg.meta.typeDefinitionsSizes + td * 4);
    if (!p) return 0;
    return this.mem.u32At(p) - 8; // instance_size includes the object header
  }

  // ------------------------------------------------------------------ calling

  _rawCall(ptr, args) {
    const f = this.fn(ptr);
    const sp = this.stackSave ? this.stackSave() : 0;
    try {
      return f(...args);
    } catch (e) {
      if (this.stackRestore) this.stackRestore(sp);
      throw this._wrapError(e);
    }
  }

  _wrapError(e) {
    let ptr = null;
    if (typeof e === 'number') ptr = e;
    else if (e && typeof e.excPtr === 'number') ptr = e.excPtr;
    if (ptr !== null && this.ready) {
      const ex = this.mem.u32At(ptr);
      if (this.mem.valid(ex)) {
        const k = this.klassOf(ex);
        let msg = '';
        try {
          const f = this.allFields(k).find((x) => x.name === '_message' || x.name === 'message');
          if (f) msg = this.readString(this.mem.u32At(ex + f.offset)) || '';
        } catch (_) { /* ignore */ }
        const type = this.klassName(k);
        return new ManagedError(`${type}${msg ? ': ' + msg : ''}`, { exception: ex, managedType: type });
      }
    }
    if (ptr !== null) return new ManagedError('native exception ' + hex(ptr));
    // native wasm exception handling: the thrown C++ object is the tag's payload
    if (typeof WebAssembly.Exception === 'function' && e instanceof WebAssembly.Exception && this.cppTag) {
      let p = null;
      try { if (e.is(this.cppTag)) p = e.getArg(this.cppTag, 0); } catch (_) { /* other tag */ }
      if (typeof p === 'number') return this._wrapError(p);
    }
    if (e instanceof WebAssembly.RuntimeError) return new ManagedError('wasm trap: ' + e.message, { trap: true });
    return e instanceof Error ? e : new Error(String(e));
  }

  /** Fields of a class and all of its parents, base class first. */
  allFields(k) {
    const chain = [];
    for (let c = k, g = 0; c && g < 64; c = this.parentKlass(c), g++) chain.unshift(c);
    return chain.flatMap((c) => this.runtimeFields(c));
  }

  /**
   * How a value of Il2CppType* `p` crosses the wasm boundary.
   * Returns { wasm: 'i32'|'i64'|'f32'|'f64'|'ptr'|'void', size, kind, td, struct? }
   *  - 'ptr' means "pass the address of a copy" (C ABI: aggregates by reference)
   */
  abi(p, isReturn = false) {
    const t = this.typeInfo(p);
    if (t.byref) return { wasm: 'i32', byref: true, kind: t.kind, size: 4 };
    switch (t.kind) {
      case T.VOID: return { wasm: 'void', size: 0, kind: t.kind };
      case T.I8: case T.U8: return { wasm: 'i64', size: 8, kind: t.kind };
      case T.R4: return { wasm: 'f32', size: 4, kind: t.kind };
      case T.R8: return { wasm: 'f64', size: 8, kind: t.kind };
      case T.VALUETYPE: {
        const td = this._tdFromData(t.data);
        const d = this.md.typeDef(td);
        if (d.isEnum) {
          const u = this.abi(this.typePtr(d.elementTypeIndex));
          return { ...u, kind: t.kind, td, enumOf: u.kind };
        }
        const size = this.valueSize(td);
        // LLVM wasm C ABI: a struct whose only member is a scalar travels as that scalar.
        // fastcomp's asm.js ABI (Unity 2018 – 2021.1) passes structs by pointer, but still
        // returns a one-scalar struct (TimeSpan, DateTime…) by value.
        const single = this._singleElement(td, 0);
        if (single && this.flavor === 'fastcomp' && !isReturn) return { wasm: 'ptr', size, kind: t.kind, td, struct: true, singleByPtr: single };
        if (single) return { wasm: single.wasm, size, kind: t.kind, td, single };
        return { wasm: 'ptr', size, kind: t.kind, td, struct: true };
      }
      case T.GENERICINST: {
        const base = this.tdOfType(p);
        if (base >= 0 && this.md.typeDef(base).isValueType) return { wasm: 'unsupported', size: 0, kind: t.kind, td: base, why: 'generic struct' };
        return { wasm: 'i32', size: 4, kind: t.kind };
      }
      case T.VAR: case T.MVAR: return { wasm: 'unsupported', size: 0, kind: t.kind, why: 'generic parameter' };
      case T.TYPEDBYREF: return { wasm: 'unsupported', size: 0, kind: t.kind, why: 'TypedReference' };
      default: return { wasm: 'i32', size: PRIM_SIZE[t.kind] || 4, kind: t.kind };
    }
  }

  /** clang wasm32 C ABI: a struct whose only (recursive) member is a scalar is passed as that scalar. */
  _singleElement(td, depth) {
    if (depth > 8) return null;
    const inst = this.fieldsOf(td).filter((f) => !(f.attrs & FIELD.STATIC) && !(f.attrs & FIELD.LITERAL));
    if (inst.length !== 1) return null;
    // explicit Size / fixed buffers: the struct is bigger than its one field, so it's an aggregate
    const vs = this.valueSize(td);
    const fsz = this.sizeOfType(inst[0].type);
    if (vs && fsz && vs > fsz) return null;
    const ft = this.typeInfo(inst[0].type);
    if (ft.kind === T.VALUETYPE) {
      const ftd = this._tdFromData(ft.data);
      const d = this.md.typeDef(ftd);
      if (d.isEnum) return this._singleElement(ftd, depth + 1) || { wasm: this.abi(this.typePtr(d.elementTypeIndex)).wasm };
      return this._singleElement(ftd, depth + 1);
    }
    if (ft.kind === T.I8 || ft.kind === T.U8) return { wasm: 'i64' };
    if (ft.kind === T.R4) return { wasm: 'f32' };
    if (ft.kind === T.R8) return { wasm: 'f64' };
    if (ft.kind === T.GENERICINST || ft.kind === T.VAR) return null;
    return ft.kind === T.BOOLEAN ? { wasm: 'i32', bool: true } : { wasm: 'i32' };
  }

  /** Can this method be called directly? Returns null or a reason string. */
  whyNotCallable(m) {
    if (m.__desc) {
      if (m.generic) return m.meta && m.meta.genericContainerIndex !== -1 ? 'generic method (use .of(...types))' : 'method of a generic type (call it on an instance)';
      if (!m.ptr) return 'no code in this build';
      for (const [t, r] of [[m.retType, true], ...m.params.map((p) => [p.type, false])]) { const a = this.abi(t, r); if (a.wasm === 'unsupported') return a.why; }
      if (!this.slotOf(m)) return m._noSlot || 'no code in this build';
      return null;
    }
    if (m.genericContainerIndex !== -1) return 'generic method';
    const td = this.md.typeDef(m.declaringType);
    if (td.isGeneric) return 'method of a generic type';
    if (!this.methodPointer(m)) return (m.flags & METHOD.ABSTRACT) ? 'abstract' : 'stripped from the build';
    const ret = this.abi(this.typePtr(m.returnType), true);
    if (ret.wasm === 'unsupported') return 'returns ' + ret.why;
    for (const p of this.params(m)) {
      const a = this.abi(p.type);
      if (a.wasm === 'unsupported') return `parameter ${p.name}: ${a.why}`;
    }
    { const d = this.desc(m); if (!this.slotOf(d)) return d._noSlot || 'stripped from the build'; }
    return null;
  }

  /**
   * Call a managed method.
   * @param m       method record (from methodsOf / findMethod)
   * @param self    `this`: object pointer (reference types) or address of the unboxed data (value types)
   * @param args    raw values already converted for the wasm boundary (see marshal())
   * @returns       { value, retAddr } — retAddr is set for struct returns (caller frees with free())
   */
  invokeRaw(m, self, args) {
    const d = this.desc(m);
    const ptr = this.slotOf(d);
    if (!ptr) throw new Error(`${d.name}: no code (${this.whyNotCallable(d)})`);
    const isStatic = d.isStatic;
    const ret = this.abi(d.retType, true);
    const f = this.fn(ptr);
    if (typeof f !== 'function') throw new Error(`${d.name}: table slot ${ptr} holds no function`);
    const list = [];
    let retAddr = 0;
    if (ret.wasm === 'ptr') {
      retAddr = this.malloc(Math.max(ret.size, 4));
      this.mem.fill(retAddr, 0, ret.size);
      list.push(retAddr);
    }
    if (this.hasThis(d)) list.push(isStatic ? 0 : (this.boxedThis(d) ? self - 8 : self) >>> 0);
    list.push(...args);
    list.push(d.mi >>> 0); // const MethodInfo* (needed by shared generic code)
    let cs = null;
    if (f.length !== list.length || this.i64Mode !== 'native') {
      // fastcomp builds: 64-bit values may be split in two (see callSig)
      cs = this.callSig(d);
      if (cs.error || f.length !== cs.params.length) {
        if (retAddr) this.free(retAddr);
        throw new Error(`${m.name}: ${cs.error || `signature mismatch (expected ${cs.params.length} wasm params, function takes ${f.length})`}`);
      }
    }
    let value;
    try {
      value = cs ? cs.retIn(this._rawCall(ptr, cs.split(list))) : this._rawCall(ptr, list);
    } catch (e) {
      if (retAddr) this.free(retAddr);
      throw e;
    }
    return { value, retAddr, ret, retType: d.retType };
  }

  /** Convenience: call with plain JS values (numbers, booleans, strings, pointers). */
  call(m, self, ...vals) {
    if (typeof m === 'string') throw new Error('pass a method record');
    const ps = this.params(m);
    const temps = [];
    try {
      const args = ps.map((p, i) => this.marshal(p.type, vals[i], temps));
      const r = this.invokeRaw(m, self, args);
      return this.unmarshalReturn(r);
    } finally {
      for (const t of temps) this.free(t);
    }
  }

  /**
   * Call with JS values and get back the return value plus ref/out parameters.
   * @returns {{ value: any, outs: Array<{ name, type, value }> }}
   */
  invoke(m, self, vals) {
    const ps = this.params(m);
    const temps = [];
    try {
      const args = ps.map((p, i) => this.marshal(p.type, vals[i], temps));
      const value = this.unmarshalReturn(this.invokeRaw(m, self, args));
      const outs = [];
      ps.forEach((p, i) => {
        if (!this.typeInfo(p.type).byref) return;
        const buf = args[i];
        const t = this.typeInfo(p.type);
        outs.push({ name: p.name, type: p.type, value: this.readDeep(buf, p.type) });
      });
      return { value, outs };
    } finally {
      for (const t of temps) this.free(t);
    }
  }

  /** JS value -> wasm argument for Il2CppType* p. Allocations are pushed to `temps`. */
  marshal(p, v, temps) {
    const a = this.abi(p);
    const m = this.mem;
    if (a.byref) {
      // big enough for the pointee, generic structs (KeyValuePair<long,long>, Nullable<Vector3>…) included
      const size = Math.max(8, this.sizeOfType(p, true));
      const buf = this.malloc(size);
      temps.push(buf);
      m.fill(buf, 0, size);
      if (v != null) this.writeValue(buf, p, v, true);
      return buf;
    }
    if (a.enumOf !== undefined && typeof v === 'string') v = this.enumValue(a.td, v);
    if (a.single && v && typeof v === 'object') { // one-scalar struct given as {field: x}
      const f = this.fieldsOf(a.td).find((x) => !(x.attrs & FIELD.STATIC) && !(x.attrs & FIELD.LITERAL));
      if (f) {
        const x = fieldOf(v, f.name);
        // nested one-field structs ({ _ticks: { … } }) unwrap recursively through the field's own type
        v = x && typeof x === 'object' ? this._unwrapSingle(f.type, x) : x;
      }
    }
    switch (a.wasm) {
      case 'i64': return BigInt.asIntN(64, BigInt(typeof v === 'boolean' ? +v : v ?? 0));
      case 'f32': case 'f64': return Number(v ?? 0);
      case 'ptr': {
        const buf = this.malloc(Math.max(a.size, 8));
        temps.push(buf);
        m.fill(buf, 0, Math.max(a.size, 8));
        if (a.singleByPtr && (typeof v === 'number' || typeof v === 'bigint' || typeof v === 'boolean')) {
          // a one-scalar struct (RuntimeTypeHandle, TimeSpan…) given as its value: same meaning as
          // on LLVM builds, where it travels as that scalar; fastcomp wants it in memory
          const w = a.singleByPtr.wasm;
          if (w === 'i64') m.setI64(buf, BigInt(v)); else if (w === 'f32') m.setF32(buf, Number(v)); else if (w === 'f64') m.setF64(buf, Number(v)); else m.setU32(buf, typeof v === 'boolean' ? +v : Number(v));
        } else if (typeof v === 'number') m.copy(buf, v, a.size); // address of existing struct data
        else if (v && typeof v === 'object') this.writeStruct(buf, a.td, v);
        return buf;
      }
      case 'i32':
      default: {
        if (a.kind === T.STRING && typeof v === 'string') return this.newString(v);
        if (a.kind === T.BOOLEAN || (a.single && a.single.bool)) return toBool(v) ? 1 : 0;
        if (typeof v === 'boolean') return v ? 1 : 0;
        if (typeof v === 'string' && a.kind === T.CHAR) return v.charCodeAt(0) || 0;
        if (typeof v === 'bigint') return Number(BigInt.asIntN(32, v));
        return Number(v ?? 0) | 0;
      }
    }
  }

  /** The scalar inside a (nested) one-field struct value given as an object. */
  _unwrapSingle(p, v, depth = 0) {
    const t = this.typeInfo(p);
    if (depth > 8 || t.kind !== T.VALUETYPE || !v || typeof v !== 'object') return v;
    const td = this._tdFromData(t.data);
    if (this.md.typeDef(td).isEnum) return v;
    const f = this.fieldsOf(td).find((x) => !(x.attrs & FIELD.STATIC) && !(x.attrs & FIELD.LITERAL));
    return f ? this._unwrapSingle(f.type, fieldOf(v, f.name), depth + 1) : v;
  }

  /** Enum member value from a name: 'Space', 'KeyCode.Space', 'A | B' (flags). */
  enumValue(td, name) {
    const parts = String(name).split('|').map((x) => x.trim().replace(/^.*\./, '')).filter(Boolean);
    const members = this.enumMembers(td);
    let acc = null;
    for (const part of parts) {
      const hit = members.find(([n]) => n === part) || members.find(([n]) => n.toLowerCase() === part.toLowerCase());
      if (!hit) throw new TypeError(`${this.tdFullName(td)} has no member ${part}`);
      const v = hit[1];
      if (acc === null) acc = v;
      else acc = typeof acc === 'bigint' || typeof v === 'bigint' ? BigInt(acc) | BigInt(v) : (acc | v);
    }
    if (acc === null) throw new TypeError(`${this.tdFullName(td)}: no member name given`);
    return acc;
  }

  unmarshalReturn({ value, retAddr, ret, retType }) {
    if (ret.wasm === 'void') return undefined;
    if (ret.wasm === 'ptr') {
      const out = retType ? this.readDeep(retAddr, retType) : this.readStruct(retAddr, ret.td);
      this.free(retAddr);
      return out;
    }
    // enums come back like their underlying type (a uint enum with bit 31 set stays positive)
    if (ret.enumOf !== undefined) return this.unmarshalReturn({ value, ret: { ...ret, kind: ret.enumOf, enumOf: undefined } });
    switch (ret.kind) {
      case T.BOOLEAN: return (value & 0xff) !== 0;
      case T.U1: return value & 0xff;
      case T.I1: return (value << 24) >> 24;
      case T.CHAR: return String.fromCharCode(value & 0xffff);
      case T.U2: return value & 0xffff;
      case T.I2: return (value << 16) >> 16;
      case T.U4: case T.U: case T.I: case T.PTR: case T.FNPTR: return value >>> 0; // same as field reads
      case T.I8: return typeof value === 'bigint' ? BigInt.asIntN(64, value) : value;
      case T.U8: return typeof value === 'bigint' ? BigInt.asUintN(64, value) : value;
      case T.STRING: return this.readString(value >>> 0);
      case T.VALUETYPE:
        if (ret.single) {
          const f = this.fieldsOf(ret.td).find((x) => !(x.attrs & FIELD.STATIC) && !(x.attrs & FIELD.LITERAL));
          return { [f.name]: ret.wasm === 'i32' && f && this.typeInfo(f.type).kind === T.BOOLEAN ? !!value : value };
        }
        return value;
      default:
        if (REF_KINDS.has(ret.kind) || ret.kind === T.GENERICINST) return value >>> 0;
        return value;
    }
  }

  // ------------------------------------------------------------------ values

  readString(s) {
    if (!s || !this.mem.valid(s)) return null;
    const len = this.mem.i32At(s + 8);
    if (len < 0 || len > 1 << 24) return null;
    return this.mem.utf16(s + 12, len);
  }

  newString(str) {
    str = String(str);
    const fd = this.desc(this._fastAlloc);
    const s = this._rawCall(this.slotOf(fd), [...(this.staticThis ? [0] : []), str.length, ...(fd._dropMI ? [] : [0])]) >>> 0;
    const m = this.mem.views();
    for (let i = 0; i < str.length; i++) m.setU16(s + 12 + i * 2, str.charCodeAt(i));
    return s;
  }

  isString(obj) { return obj && this.klassOf(obj) === this.klass.String; }

  /** Array object: { length, elemType, elemSize, data } */
  arrayInfo(arr) {
    const m = this.mem;
    const k = this.klassOf(arr);
    const t = this.typeInfo(k + this.layout.byval);
    let elemType = 0;
    if (t.kind === T.SZARRAY) elemType = t.data;
    else if (t.kind === T.ARRAY) elemType = m.u32At(t.data);
    let elemSize = elemType ? this.sizeOfType(elemType) : 4;
    if (!elemSize) {
      const ek = m.u32At(k + this.layout.elementClass);
      elemSize = ek ? this.klassValueSize(ek) : 4;
    }
    return { length: m.u32At(arr + 12), elemType, elemSize, data: arr + 16 };
  }

  /** Read a value of Il2CppType* p stored at addr into a JS value (objects stay as pointers). */
  readValue(addr, p) {
    const m = this.mem;
    const t = this.typeInfo(p);
    switch (t.kind) {
      case T.BOOLEAN: return m.u8At(addr) !== 0;
      case T.CHAR: return String.fromCharCode(m.u16At(addr));
      case T.I1: return m.i8At(addr);
      case T.U1: return m.u8At(addr);
      case T.I2: return m.i16At(addr);
      case T.U2: return m.u16At(addr);
      case T.I4: return m.i32At(addr);
      case T.U4: return m.u32At(addr);
      case T.I8: return m.i64At(addr);
      case T.U8: return m.u64At(addr);
      case T.R4: return m.f32At(addr);
      case T.R8: return m.f64At(addr);
      case T.I: case T.U: case T.PTR: case T.FNPTR: return m.u32At(addr);
      case T.VALUETYPE: {
        const td = this._tdFromData(t.data);
        const d = this.md.typeDef(td);
        if (d.isEnum) return this.readValue(addr, this.typePtr(d.elementTypeIndex));
        return addr; // inline struct: caller expands with readStruct
      }
      case T.GENERICINST: {
        const b = this.tdOfType(p);
        if (b >= 0 && this.md.typeDef(b).isValueType) return addr;
        return m.u32At(addr);
      }
      default: return m.u32At(addr); // references
    }
  }

  writeValue(addr, p, v, raw = false) {
    const m = this.mem;
    const t = this.typeInfo(p);
    const kind = t.kind;
    switch (kind) {
      case T.BOOLEAN: return m.setU8(addr, toBool(v) ? 1 : 0);
      case T.CHAR: return m.setU16(addr, typeof v === 'string' ? v.charCodeAt(0) || 0 : Number(v ?? 0));
      case T.I1: return m.setI8(addr, Number(v));
      case T.U1: return m.setU8(addr, Number(v));
      case T.I2: return m.setI16(addr, Number(v));
      case T.U2: return m.setU16(addr, Number(v));
      case T.I4: return m.setI32(addr, Number(v));
      case T.U4: case T.I: case T.U: case T.PTR: return m.setU32(addr, Number(v));
      case T.I8: return m.setI64(addr, v ?? 0);
      case T.U8: return m.setU64(addr, v ?? 0);
      case T.R4: return m.setF32(addr, Number(v ?? 0));
      case T.R8: return m.setF64(addr, Number(v ?? 0));
      case T.STRING: return m.setU32(addr, typeof v === 'string' ? this.newString(v) : Number(v ?? 0));
      case T.VALUETYPE: {
        const td = this._tdFromData(t.data);
        const d = this.md.typeDef(td);
        if (d.isEnum) return this.writeValue(addr, this.typePtr(d.elementTypeIndex), typeof v === 'string' ? this.enumValue(td, v) : v, raw);
        if (typeof v === 'number') return m.copy(addr, v, this.valueSize(td));
        if (v == null) return m.fill(addr, 0, this.valueSize(td));
        return this.writeStruct(addr, td, v);
      }
      case T.GENERICINST: {
        if (this._isValueGeneric(p)) {
          const fs = this.fieldsOfStructType(p);
          if (!fs) throw new Error(`can't write ${this.typeName(p)}: its runtime class isn't set up`);
          if (typeof v === 'number') return m.copy(addr, v, this.sizeOfType(p));
          for (const f of fs) { const x = v ? fieldOf(v, f.name) : undefined; if (x !== undefined) this.writeValue(addr + f.offset, f.type, x); }
          return undefined;
        }
        return m.setU32(addr, Number(v ?? 0)); // a reference: an object pointer (or 0)
      }
      default: return m.setU32(addr, Number(v ?? 0));
    }
  }

  /** Runtime class of a GENERICINST type, if the runtime has created it. */
  cachedClass(p) {
    const t = this.typeInfo(p);
    if (t.kind !== T.GENERICINST) return 0;
    return this.mem.u32At(t.data + 12); // { type, context { class_inst, method_inst }, cached_class }
  }

  /** Is this GENERICINST a struct (KeyValuePair<,>, Nullable<>…) rather than a class? */
  _isValueGeneric(p) {
    const b = this.tdOfType(p);
    return b >= 0 && this.md.typeDef(b).isValueType;
  }

  /** Inline size of a value of type p (references are 4). With `deref`, a byref type's pointee size. */
  sizeOfType(p, deref = false) {
    const t = this.typeInfo(p);
    if (t.byref && !deref) return 4;
    if (t.kind === T.VALUETYPE) {
      const td = this._tdFromData(t.data);
      const d = this.md.typeDef(td);
      if (d.isEnum) return this.sizeOfType(this.typePtr(d.elementTypeIndex));
      return this.valueSize(td);
    }
    if (t.kind === T.GENERICINST) {
      if (this._isValueGeneric(p)) { const k = this.cachedClass(p) || (deref ? this.klassOfType(p) : 0); return k ? this.klassValueSize(k) : 0; }
      return 4;
    }
    return PRIM_SIZE[t.kind] || 4;
  }

  alignOfType(p) {
    const t = this.typeInfo(p);
    if (t.kind === T.I8 || t.kind === T.U8 || t.kind === T.R8) return 8;
    if (t.kind === T.VALUETYPE || t.kind === T.GENERICINST) {
      const fs = this.fieldsOfStructType(p);
      if (fs) return fs.reduce((a, f) => Math.max(a, this.alignOfType(f.type)), 1);
    }
    return Math.min(4, this.sizeOfType(p) || 4);
  }

  /** Unboxed size of a (possibly generic) value type from its runtime fields. */
  klassValueSize(k) {
    const fs = this.allFields(k).filter((f) => !f.isStatic && !f.isConst);
    let end = 0;
    let align = 1;
    for (const f of fs) {
      end = Math.max(end, f.offset - 8 + this.sizeOfType(f.type));
      align = Math.max(align, this.alignOfType(f.type));
    }
    return Math.ceil(end / align) * align;
  }

  /** Instance fields of any value type (incl. generic instances), offsets relative to the unboxed data. */
  fieldsOfStructType(p) {
    const t = this.typeInfo(p);
    if (t.kind === T.VALUETYPE) return this.structFields(this._tdFromData(t.data));
    if (t.kind === T.GENERICINST) {
      // only generic *structs* have inline fields; List<T>, Action<T>… are references
      if (!this._isValueGeneric(p)) return null;
      const k = this.cachedClass(p);
      if (!k) return null;
      return this.allFields(k).filter((f) => !f.isStatic && !f.isConst).map((f) => ({ ...f, offset: f.offset - 8 }));
    }
    return null;
  }

  /** Read a value as plain JS: structs (nested too) become objects, strings JS strings, references stay addresses. */
  readDeep(addr, p, depth = 0) {
    const t = this.typeInfo(p);
    if (t.kind === T.STRING) return this.readString(this.mem.u32At(addr));
    if (t.kind === T.VALUETYPE || t.kind === T.GENERICINST) {
      if (t.kind === T.VALUETYPE && this.md.typeDef(this._tdFromData(t.data)).isEnum) return this.readValue(addr, p);
      if (t.kind === T.GENERICINST) { const b = this.tdOfType(p); if (!(b >= 0 && this.md.typeDef(b).isValueType)) return this.mem.u32At(addr); }
      const fs = this.fieldsOfStructType(p);
      if (fs && depth < 8) {
        const o = {};
        for (const f of fs) o[f.name] = this.readDeep(addr + f.offset, f.type, depth + 1);
        return o;
      }
      if (t.kind === T.GENERICINST) return this.mem.u32At(addr);
    }
    return this.readValue(addr, p);
  }

  /** Instance fields of a value type definition with offsets relative to the unboxed data. */
  structFields(td) {
    return this.fieldsOf(td)
      .filter((f) => !(f.attrs & FIELD.STATIC) && !(f.attrs & FIELD.LITERAL))
      .map((f) => ({ ...f, offset: this.metaFieldOffset(td, f.local) - 8 }));
  }

  readStruct(addr, td) {
    const out = {};
    for (const f of this.structFields(td)) out[f.name] = this.readValue(addr + f.offset, f.type);
    return out;
  }

  writeStruct(addr, td, obj) {
    for (const f of this.structFields(td)) { const x = fieldOf(obj, f.name); if (x !== undefined) this.writeValue(addr + f.offset, f.type, x); }
  }

  /** Literal (const / enum member) value from metadata. */
  constValue(metaFieldIndex) {
    const d = this.md.fieldDefault(metaFieldIndex);
    if (!d || !d.dataAddr) return null;
    const p = this.typePtr(d.typeIndex);
    const t = this.typeInfo(p);
    const m = this.mem;
    if (t.kind === T.STRING) {
      // v29+: compressed signed length (zigzag, -1 = null), as Il2CppDumper and il2cpp read it; before: int32
      let a = d.dataAddr;
      let len;
      if (this.md.version >= 29) {
        const n = this._compressedSize(a);
        len = this._readCompressed(a, T.I4);
        a += n;
      } else { len = m.i32At(a); a += 4; }
      if (len < 0) return null;
      len = Math.min(len, Math.max(0, m.size - a));
      return new TextDecoder().decode(m.bytes(a, len));
    }
    // v29+ compresses only 32-bit integers (zigzag for signed); 8/16-bit and 64-bit values are stored plainly
    if (this.md.version >= 29 && (t.kind === T.I4 || t.kind === T.U4)) return this._readCompressed(d.dataAddr, t.kind);
    return this.readValue(d.dataAddr, p);
  }

  /** Bytes taken by a compressed integer starting at a. */
  _compressedSize(a) {
    const b = this.mem.u8At(a);
    if ((b & 0x80) === 0) return 1;
    if ((b & 0xc0) === 0x80) return 2;
    if ((b & 0xe0) === 0xc0) return 4;
    if (b === 0xf0) return 5;
    return 1; // 0xfe / 0xff
  }

  _readCompressed(a, kind) {
    const m = this.mem;
    if (kind === T.I8 || kind === T.U8) return kind === T.I8 ? m.i64At(a) : m.u64At(a);
    const b = m.u8At(a);
    let v;
    if ((b & 0x80) === 0) v = b;
    else if ((b & 0xc0) === 0x80) v = ((b & 0x3f) << 8) | m.u8At(a + 1);
    else if ((b & 0xe0) === 0xc0) v = ((b & 0x1f) << 24) | (m.u8At(a + 1) << 16) | (m.u8At(a + 2) << 8) | m.u8At(a + 3);
    else if (b === 0xf0) v = m.u32At(a + 1);
    else if (b === 0xfe) v = 0xffffffff - 1;
    else if (b === 0xff) v = 0xffffffff;
    else v = 0;
    v >>>= 0;
    if (kind === T.I4) {
      // zigzag
      if (v === 0xffffffff) return -2147483648;
      return (v & 1) ? -((v >>> 1) + 1) : (v >>> 1);
    }
    return v;
  }

  /** Enum member name for a value, if any. */
  enumName(td, value) {
    const names = [];
    const all = [];
    for (const f of this.fieldsOf(td)) {
      if (!(f.attrs & FIELD.LITERAL)) continue;
      const v = this.constValue(f.index);
      all.push([f.name, v]);
      if (v == value || (typeof v === 'bigint' && BigInt(value) === v)) return f.name;
    }
    // flags: BigInt maths, so bit 31 and 64-bit enums decompose too
    let n;
    try { n = BigInt.asUintN(64, BigInt(value)); } catch (_) { return null; }
    if (n > 0n) {
      let rest = n;
      for (const [name, v] of all) {
        let x;
        try { x = BigInt.asUintN(64, BigInt(v)); } catch (_) { continue; }
        if (x && (rest & x) === x && (x & (x - 1n)) === 0n) { names.push(name); rest &= ~x; }
      }
      if (names.length && rest === 0n) return names.join(' | ');
    }
    return null;
  }

  enumMembers(td) {
    return this.fieldsOf(td).filter((f) => f.attrs & FIELD.LITERAL).map((f) => [f.name, this.constValue(f.index)]);
  }

  // ------------------------------------------------------------------ reflection helpers

  /** System.Type object for an Il2CppType* (creates the runtime class if needed). */
  typeObject(p) {
    if (!this._getTypeFromHandle) {
      this._getTypeFromHandle = this.findMethod('System.Type', 'GetTypeFromHandle', 1);
      if (!this._getTypeFromHandle) throw new Error('Type.GetTypeFromHandle not found');
    }
    // RuntimeTypeHandle is a one-field struct: call() passes it the right way for the toolchain
    return this.call(this._getTypeFromHandle, 0, p) >>> 0;
  }

  typeObjectOfTd(td) { return this.typeObject(this.typePtr(this.md.typeDef(td).byvalTypeIndex)); }

  /** Make sure the runtime class for td exists (and optionally run its static constructor). */
  ensureClass(td, runCctor = false) {
    let k = this.klassOfTd(td);
    if (!k) {
      const t = this.typeObjectOfTd(td); // Type objects are created from the class
      k = this.klassOfTd(td);
      if (!k && t) {
        // RuntimeType._impl (RuntimeTypeHandle) -> Il2CppType* -> class not directly reachable; fall through
      }
    }
    if (runCctor) {
      const rc = this.findMethod('System.Runtime.CompilerServices.RuntimeHelpers', 'RunClassConstructor', 1);
      if (rc) this.call(rc, 0, this.typePtr(this.md.typeDef(td).byvalTypeIndex));
    }
    return k || this.klassOfTd(td);
  }

  /**
   * Scan the heap for live objects whose class is `k`, or (with `klasses`, a Set) any of those classes.
   * See subKlasses() for "this class and everything derived from it".
   */
  findInstances(k, { limit = 5000, validate, klasses = null } = {}) {
    limit = Number(limit);
    if (Number.isNaN(limit)) limit = 5000;
    if (limit <= 0) return [];
    const m = this.mem.views();
    const u32 = m.u32;
    const out = [];
    const one = !klasses || klasses.size <= 1;
    const want = one ? (klasses ? [...klasses][0] : k) : 0;
    const start = Math.floor((this.reg.meta.addr + 0x100000) / 4);
    for (let i = start; i < u32.length - 2; i++) {
      const c = u32[i];
      if (one ? c !== want : !klasses.has(c)) continue;
      const mon = u32[i + 1];
      if (mon !== 0 && (mon < 0x1000 || mon >= m.size)) continue;
      const a = i * 4; // i << 2 goes negative above 2 GiB
      if (validate && !validate(a)) continue;
      out.push(a);
      if (out.length >= limit) break;
    }
    return out;
  }

  /**
   * Runtime classes that are `td` or derive from / implement it (classes the runtime has created).
   * Generic instances aren't in the class table, so pass `extra` classes (e.g. the exact k) too.
   */
  subKlasses(td, extra = []) {
    const out = new Set(extra.filter(Boolean));
    if (!this.classTable || td < 0) return out;
    const iface = this.md.typeDef(td).isInterface;
    for (let i = 0; i < this.md.typeCount; i++) {
      const k = this.klassOfTd(i);
      if (!k) continue;
      if (iface ? this.implementsTd(i, td) : this.isSubclassOf(i, td)) out.add(k);
    }
    return out;
  }

  /** Does type definition `td` (or a base) list interface `ifaceTd`? (metadata only; generic interfaces by definition) */
  implementsTd(td, ifaceTd) {
    for (const t of this.hierarchy(td)) {
      if (t === ifaceTd) return true;
      const d = this.md.typeDef(t);
      for (let j = 0; j < d.interfacesCount; j++) {
        const it = this.tdOfTypeIndex(this.md.interfaceType(d.interfacesStart + j));
        if (it === ifaceTd) return true;
      }
    }
    return false;
  }

  /** Il2CppObject boxed value -> address of its data. */
  unbox(obj) { return obj + 8; }
}

/** "A, B<C, D>, E" -> ["A", "B<C, D>", "E"] */
export function splitGenericArgs(s) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '<') depth++;
    if (ch === '>') depth--;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
