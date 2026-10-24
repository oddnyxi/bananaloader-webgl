// IL2CPP dumper for Unity WebGL builds.
//
// Works on any Il2Cpp bridge instance: a live one in the game (Odium UE / BananaLoader), or a
// static one built from the .wasm data segments + global-metadata.dat (staticIl2Cpp below).
// Only static data is used: metadata, Il2CppCodeRegistration and Il2CppMetadataRegistration.

import { Il2Cpp } from '../il2cpp/runtime.js';
import { Memory } from '../il2cpp/memory.js';
import { Metadata } from '../il2cpp/metadata.js';
import { findRegistrations } from '../il2cpp/registration.js';
import { T, ACCESS_NAME } from '../il2cpp/types.js';
import { Reader } from './wasm.js';

const hex = (n) => '0x' + (n >>> 0).toString(16).toUpperCase();

/**
 * An Il2Cpp bridge over a static memory image: the wasm data segments with global-metadata
 * appended above them. Nothing is executed, so only static queries work.
 */
export function staticIl2Cpp(image, metadata, log = () => {}) {
  const align = (n) => (n + 0xfff) & ~0xfff;
  const metaAt = align(image.length + 0x1000);
  const buf = new ArrayBuffer(align(metaAt + metadata.length + 0x1000));
  const u8 = new Uint8Array(buf);
  u8.set(image, 0);
  u8.set(metadata, metaAt);

  const il = Object.create(Il2Cpp.prototype);
  il.Module = null;
  il.log = log;
  il.table = null;
  il._fn = new Map();
  il.mem = new Memory({ buffer: buf });
  il.md = new Metadata(il.mem, metaAt);
  il.md._declTd = (typeIndex) => il.tdOfTypeIndex(typeIndex);
  log(`metadata v${il.md.version}: ${il.md.images.length} assemblies, ${il.md.typeCount} types, ${il.md.methodCount} methods`);
  const reg = findRegistrations(il.mem, il.md, metaAt);
  if (!reg.meta) throw new Error('Il2CppMetadataRegistration not found in the data segments');
  if (!reg.modules.size) throw new Error('Il2CppCodeRegistration not found in the data segments');
  il.reg = reg;
  il.moduleOfImage = il.md.images.map((img) => reg.modules.get(img.name) || null);
  il._indexTypes();
  il.ready = true;
  il.static = true;
  log(`registrations: ${reg.meta.typesCount} types, ${reg.modules.size} code modules`);
  return il;
}

export class Dumper {
  /**
   * @param {Il2Cpp} il
   * @param {{ wasm?: import('./wasm.js').WasmModule, log?: Function }} o
   */
  constructor(il, { wasm = null, log = () => {} } = {}) {
    this.il = il;
    this.md = il.md;
    this.mem = il.mem;
    this.wasm = wasm;
    this.log = log;
    this.table = wasm ? wasm.table() : null;
    this._codeReg();
  }

  // ------------------------------------------------------------------ registrations

  /** Il2CppCodeRegistration fields we need: generic method pointers and invokers. */
  _codeReg() {
    const il = this.il; const m = this.mem; const md = this.md; const meta = il.reg.meta;
    this.gmEntry = md.version >= 27 ? 16 : 12;
    this.generic = { pointers: 0, count: 0 };
    // highest methodIndex in the generic method table = number of generic method pointers
    let maxIdx = -1;
    for (let i = 0; i < meta.genericMethodTableCount; i++) {
      const v = m.i32At(meta.genericMethodTable + i * this.gmEntry + 4);
      if (v > maxIdx) maxIdx = v;
    }
    const at = il.reg.code && il.reg.code.regAddr;
    if (!at) return;
    // codeGenModules sits 56 bytes into the struct (v24.2 – v29.0), 64 from v29.1
    // (unresolvedInstanceCallPointers / unresolvedStaticCallPointers were added)
    for (const back of [64, 56, 48]) {
      const start = at - back;
      const count = m.u32At(start + 8);
      const ptr = m.u32At(start + 12);
      if (count >= maxIdx + 1 && count < maxIdx + 64 && ptr > 0x400 && ptr < m.size) {
        this.generic = { pointers: ptr, count, start, invokers: m.u32At(start + 24), invokerCount: m.u32At(start + 20) };
        return;
      }
    }
  }

  slotFunc(slot) { return this.table && slot ? (this.table.get(slot) ?? -1) : -1; }

  // ------------------------------------------------------------------ names

  typeName(p) { return this.il.typeName(p, false); }
  fullTypeName(p) { return this.il.typeName(p, true); }

  _methodGenericParams(m) { return this.md.genericParamNames(m.genericContainerIndex); }

  methodSignature(m, { full = false } = {}) {
    const il = this.il;
    const tn = (p) => (full ? il.typeName(p, true) : il.typeName(p, false));
    const ret = tn(il.typePtr(m.returnType));
    const gp = this._methodGenericParams(m);
    const params = il.params(m).map((p) => {
      const t = il.typeInfo(p.type);
      let mod = '';
      if (t.byref) mod = (t.attrs & 0x2) && !(t.attrs & 0x1) ? 'out ' : (t.attrs & 0x1) && !(t.attrs & 0x2) ? 'in ' : 'ref ';
      return mod + tn(p.type).replace(/&$/, '') + ' ' + (p.name || 'arg');
    });
    return `${ret} ${m.name}${gp.length ? '<' + gp.join(', ') + '>' : ''}(${params.join(', ')})`;
  }

  // ------------------------------------------------------------------ method table

  /** Every compiled method: [{ name, type, method, signature, slot, func, sig, token, generic }] */
  methods() {
    if (this._methods) return this._methods;
    const il = this.il; const md = this.md;
    const out = [];
    for (let td = 0; td < md.typeCount; td++) {
      const tname = il.tdFullName(td);
      for (const m of il.methodsOf(td)) {
        const slot = il.methodPointer(m);
        if (!slot) continue;
        const func = this.slotFunc(slot);
        out.push({
          name: `${tname}$$${m.name}`, type: tname, method: m.name, signature: this.methodSignature(m),
          slot, func, sig: func >= 0 && this.wasm ? this.wasm.sigOf(func) : null, token: m.token, index: m.index,
        });
      }
    }
    for (const g of this.genericInstances()) out.push(g);
    this._methods = out;
    this.log(`methods: ${out.length} with code (${out.filter((x) => x.generic).length} generic instances)`);
    return out;
  }

  /** Concrete generic method instantiations that have code: List<int>.Add etc. */
  genericInstances() {
    const il = this.il; const m = this.mem; const md = this.md; const meta = il.reg.meta;
    const g = this.generic;
    const out = [];
    if (!g.pointers) return out;
    const inst = (idx) => (idx >= 0 && idx < meta.genericInstsCount ? m.u32At(meta.genericInsts + idx * 4) : 0);
    const args = (p) => (p ? il._genericArgs(p).map((a) => il.typeName(a, false)) : []);
    for (let i = 0; i < meta.genericMethodTableCount; i++) {
      const e = meta.genericMethodTable + i * this.gmEntry;
      const specIdx = m.i32At(e);
      const methodIndex = m.i32At(e + 4);
      if (methodIndex < 0 || methodIndex >= g.count) continue;
      const slot = m.u32At(g.pointers + methodIndex * 4);
      if (!slot) continue;
      if (specIdx < 0 || specIdx >= meta.methodSpecsCount) continue;
      const s = meta.methodSpecs + specIdx * 12;
      const defIdx = m.i32At(s);
      if (defIdx < 0 || defIdx >= md.methodCount) continue;
      const def = md.method(defIdx);
      const cls = args(inst(m.i32At(s + 4)));
      const mth = args(inst(m.i32At(s + 8)));
      const base = il.tdFullName(def.declaringType);
      const tname = cls.length ? `${base}<${cls.join(', ')}>` : base;
      const mname = mth.length ? `${def.name}<${mth.join(', ')}>` : def.name;
      const func = this.slotFunc(slot);
      out.push({
        name: `${tname}$$${mname}`, type: tname, method: mname, signature: this.methodSignature(def), slot, func,
        sig: func >= 0 && this.wasm ? this.wasm.sigOf(func) : null, token: def.token, index: def.index, generic: true,
      });
    }
    return out;
  }

  /**
   * Engine bindings ("internal calls"). Unity registers each one at startup with
   * add_internal_call("UnityEngine.Transform::get_position_Injected", fn), which compiles to
   *   i32.const <name>  i32.const <table slot>  call <add_internal_call>
   * so the pairs can be read straight out of the code. Returns [{ name, slot, func }].
   */
  internalCalls() {
    if (this._icalls) return this._icalls;
    const out = [];
    this._icalls = out;
    if (!this.wasm) return out;
    const w = this.wasm; const b = w.bytes; const code = w.section(10); const mem = this.mem;
    if (!code) return out;
    const re = /^[\w.<>`+,[\]]+::[\w.<>`+,[\]$|]+$/;
    const name = (a) => {
      if (a < 0x400 || a >= mem.size - 4) return null;
      const s = mem.cstr(a, 300);
      return re.test(s) ? s : null;
    };
    const hits = [];
    const byCallee = new Map();
    for (let p = code.start; p < code.end - 8; p++) {
      if (b[p] !== 0x41) continue;
      const r = new Reader(b, p + 1); const a = r.sleb() >>> 0;
      if (b[r.p] !== 0x41) continue;
      const r2 = new Reader(b, r.p + 1); const slot = r2.sleb() >>> 0;
      if (b[r2.p] !== 0x10) continue;
      if (!this.table.has(slot)) continue;
      const n = name(a);
      if (!n) continue;
      const callee = new Reader(b, r2.p + 1).leb();
      hits.push({ name: n, slot, callee });
      byCallee.set(callee, (byCallee.get(callee) || 0) + 1);
    }
    // keep the registration function(s): the callees that take most of the pairs
    const keep = new Set([...byCallee].filter(([, c]) => c >= 20).map(([f]) => f));
    const seen = new Set();
    for (const h of hits) {
      if (!keep.has(h.callee) || seen.has(h.name)) continue;
      seen.add(h.name);
      out.push({ name: h.name, slot: h.slot, func: this.slotFunc(h.slot) });
    }
    this.log(`internal calls: ${out.length}`);
    return out;
  }

  /** funcIndex -> name, for the wasm name section. Managed methods win; exports fill the rest. */
  functionNames() {
    if (!this.wasm) throw new Error('function names need the .wasm file');
    const names = new Map();
    const used = new Map();
    const unique = (n) => {
      const k = used.get(n) || 0;
      used.set(n, k + 1);
      return k ? `${n}_${k + 1}` : n;
    };
    // keep whatever names the build already has (development builds)
    for (const [i, n] of this.wasm.names()) names.set(i, n);
    for (const imp of this.wasm.imports) if (imp.kind === 0 && !names.has(imp.func)) names.set(imp.func, unique(`${imp.module}.${imp.field}`));
    for (const ex of this.wasm.exports) if (ex.kind === 0 && !names.has(ex.index)) names.set(ex.index, unique(ex.name));
    // non-generic first, so shared generic bodies keep a plain name when one exists
    const ms = this.methods().slice().sort((a, b) => (a.generic ? 1 : 0) - (b.generic ? 1 : 0));
    let named = 0;
    for (const x of ms) {
      if (x.func < 0 || names.has(x.func)) continue;
      names.set(x.func, unique(x.name));
      named++;
    }
    for (const ic of this.internalCalls()) if (ic.func >= 0 && !names.has(ic.func)) names.set(ic.func, unique(ic.name));
    // invokers: RuntimeInvoker_<index>
    const g = this.generic;
    if (g.invokers && g.invokerCount < 1e6) {
      for (let i = 0; i < g.invokerCount; i++) {
        const f = this.slotFunc(this.mem.u32At(g.invokers + i * 4));
        if (f >= 0 && !names.has(f)) names.set(f, `RuntimeInvoker_${i}`);
      }
    }
    this.log(`names: ${names.size} functions named (${named} managed methods)`);
    return names;
  }

  // ------------------------------------------------------------------ dump.cs

  _typeKeyword(t) {
    if (t.isInterface) return 'interface';
    if (t.isEnum) return 'enum';
    if (t.isValueType) return 'struct';
    return 'class';
  }

  _typeModifiers(t) {
    const vis = t.flags & 7;
    const out = [];
    out.push(['internal', 'public', 'public', 'private', 'protected', 'internal', 'private protected', 'protected internal'][vis]);
    if (!t.isInterface && !t.isValueType) {
      if (t.isAbstract && t.isSealed) out.push('static');
      else if (t.isAbstract) out.push('abstract');
      else if (t.isSealed) out.push('sealed');
    }
    return out.join(' ');
  }

  _fieldLine(td, f, t) {
    const il = this.il;
    const a = f.attrs;
    const mods = [ACCESS_NAME[a & 7] || 'private'];
    const literal = (a & 0x40) !== 0;
    if (literal) mods.push('const');
    else {
      if (a & 0x10) mods.push('static');
      if (a & 0x20) mods.push('readonly');
    }
    let line = `\t${mods.join(' ')} ${this.typeName(f.type)} ${f.name}`;
    if (literal) {
      let v = null;
      try { v = il.constValue(f.index); } catch (_) { /* unreadable */ }
      if (v !== null && v !== undefined) line += ` = ${this._literal(v, f.type)}`;
      return line + ';';
    }
    line += ';';
    if (t.isGeneric) return line; // generic definitions have no layout; their instances do
    const off = il.metaFieldOffset(td, f.local);
    if (off >= 0) line += ` // ${hex(t.isValueType && !(a & 0x10) ? Math.max(0, off - 8) : off)}`;
    return line;
  }

  /** A constant as C# source: shortest round-tripping floats, quoted strings and chars. */
  _literal(v, typePtr) {
    if (typeof v === 'string') {
      const esc = JSON.stringify(v).slice(1, -1).replace(/[\u007f-\u009f\u2028\u2029\ud800-\udfff\ufff0-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
      return typePtr && this.il.typeInfo(typePtr).kind === T.CHAR ? `'${esc.replace(/'/g, "\\'").replace(/\\"/g, '"')}'` : `"${esc}"`;
    }
    if (typeof v === 'number' && !Number.isInteger(v) && Number.isFinite(v)) {
      const kind = typePtr ? this.il.typeInfo(typePtr).kind : 0;
      if (kind === T.R4) {
        for (let p = 1; p <= 9; p++) { const s = Number(v.toPrecision(p)); if (Math.fround(s) === Math.fround(v)) return `${s}f`; }
        return `${v}f`;
      }
      return String(v);
    }
    if (typeof v === 'number' && !Number.isFinite(v)) return Number.isNaN(v) ? 'NaN' : v > 0 ? 'Infinity' : '-Infinity';
    return String(v);
  }

  _methodLines(m, byIndex) {
    const flags = m.flags;
    const mods = [ACCESS_NAME[flags & 7] || 'private'];
    if (flags & 0x10) mods.push('static');
    const virt = (flags & 0x40) !== 0; const final = (flags & 0x20) !== 0; const newslot = (flags & 0x100) !== 0;
    if (flags & 0x400) mods.push('abstract');
    else if (virt && final && newslot) { /* implicit interface implementation: not virtual in C# */ }
    else if (virt) mods.push(newslot ? 'virtual' : final ? 'sealed override' : 'override');
    if (m.iflags & 0x1000) mods.push('extern');
    const entries = byIndex.get(m.index) || [];
    const lines = [];
    if (m.iflags & 0x1000 && this._icallByName) {
      const ic = this._icallByName.get(`${this.il.tdFullName(m.declaringType)}::${m.name}`);
      if (ic) lines.push(`\t// Internal call: Slot: ${hex(ic.slot)}${ic.func >= 0 ? `  Func: ${ic.func}` : ''}`);
    }
    const plain = entries.find((e) => !e.generic);
    if (plain) lines.push(`\t// Slot: ${hex(plain.slot)}${plain.func >= 0 ? `  Func: ${plain.func}  Sig: ${plain.sig}` : ''}`);
    else if (!entries.length) lines.push('\t// Slot: -');
    lines.push(`\t${mods.join(' ')} ${this.methodSignature(m)} { }`);
    const gen = entries.filter((e) => e.generic);
    if (gen.length) {
      lines.push('\t/* GenericInstMethod :');
      for (const g of gen.slice(0, 200)) lines.push(`\t|-${g.type}.${g.method}  Slot: ${hex(g.slot)}${g.func >= 0 ? `  Func: ${g.func}` : ''}`);
      if (gen.length > 200) lines.push(`\t|-… ${gen.length - 200} more`);
      lines.push('\t*/');
    }
    return lines;
  }

  /** dump.cs as a string (can be large: tens of MB for big games). */
  dumpCs({ images = null } = {}) {
    const il = this.il; const md = this.md;
    this._icallByName = new Map(this.internalCalls().map((x) => [x.name, x]));
    const byIndex = new Map();
    for (const x of this.methods()) { const a = byIndex.get(x.index); if (a) a.push(x); else byIndex.set(x.index, [x]); }
    const parts = [];
    const head = [`// Odium Dumper · IL2CPP metadata v${md.version}`, `// ${md.images.length} assemblies · ${md.typeCount} types · ${md.methodCount} methods`];
    if (this.wasm) head.push('// Slot = index in the wasm function table (methodPointer). Func = wasm function index.');
    for (const img of md.images) head.push(`// Image ${img.index}: ${img.name} - ${img.typeStart}`);
    parts.push(head.join('\n') + '\n');

    for (const img of md.images) {
      if (images && !images.includes(img.name)) continue;
      for (let td = img.typeStart; td < img.typeStart + img.typeCount; td++) {
        const t = md.typeDef(td);
        if (t.name === '<Module>') continue;
        const out = [];
        out.push(`// Namespace: ${t.namespace}`);
        let decl = `${this._typeModifiers(t)} ${this._typeKeyword(t)} ${il.tdFullName(td).split('.').pop().replace(/^.*\+/, '')}`;
        const short = il.tdShortName(td);
        if (short.includes('<')) decl += short.slice(short.indexOf('<'));
        const bases = [];
        if (t.parentIndex >= 0 && !t.isValueType && !t.isEnum) {
          const p = il.typePtr(t.parentIndex);
          const pn = this.typeName(p);
          if (pn !== 'object') bases.push(pn);
        }
        if (t.isEnum) {
          const vf = il.fieldsOf(td).find((f) => !(f.attrs & 0x10));
          if (vf) { const n = this.typeName(vf.type); if (n !== 'int') bases.push(n); }
        }
        for (let k = 0; k < t.interfacesCount; k++) {
          const ti = md.interfaceType(t.interfacesStart + k);
          bases.push(this.typeName(il.typePtr(ti)));
        }
        if (bases.length) decl += ' : ' + bases.join(', ');
        if (t.declaringTypeIndex >= 0) decl += ` // TypeDefIndex: ${td} · nested in ${il.typeName(il.typePtr(t.declaringTypeIndex), true)}`;
        else decl += ` // TypeDefIndex: ${td}`;
        out.push(decl);
        out.push('{');

        const fields = il.fieldsOf(td);
        if (fields.length) {
          out.push('\t// Fields');
          if (t.isEnum) {
            for (const f of fields) {
              if (!(f.attrs & 0x40)) continue;
              let v = null; try { v = il.constValue(f.index); } catch (_) { /* */ }
              out.push(`\t${f.name} = ${this._literal(v, null)},`);
            }
          } else for (const f of fields) out.push(this._fieldLine(td, f, t));
          out.push('');
        }
        const props = il.propertiesOf(td);
        if (props.length) {
          out.push('\t// Properties');
          for (const p of props) {
            const acc = p.getter || p.setter;
            if (!acc) continue;
            const mods = [ACCESS_NAME[acc.flags & 7] || 'private'];
            if (acc.flags & 0x10) mods.push('static');
            const type = p.getter ? this.typeName(il.typePtr(p.getter.returnType)) : this.typeName(il.params(p.setter).slice(-1)[0]?.type);
            out.push(`\t${mods.join(' ')} ${type} ${p.name} { ${p.getter ? 'get; ' : ''}${p.setter ? 'set; ' : ''}}`);
          }
          out.push('');
        }
        const methods = il.methodsOf(td);
        if (methods.length) {
          out.push('\t// Methods');
          for (const m of methods) { out.push(...this._methodLines(m, byIndex)); out.push(''); }
        }
        if (out[out.length - 1] === '') out.pop();
        out.push('}');
        parts.push(out.join('\n') + '\n');
      }
    }
    return parts.join('\n');
  }

  // ------------------------------------------------------------------ other outputs

  /** Il2CppDumper-compatible script.json (Address = function table slot, as its ghidra_wasm.py expects). */
  scriptJson() {
    const ms = this.methods();
    const seen = new Set();
    const ScriptMethod = [];
    for (const x of ms) {
      if (seen.has(x.slot)) continue;
      seen.add(x.slot);
      ScriptMethod.push({ Address: x.slot, Name: x.name, Signature: x.signature, TypeSignature: x.sig || 'v' });
    }
    return { ScriptMethod, ScriptString: [], ScriptMetadata: [], ScriptMetadataMethod: [], Addresses: [] };
  }

  methodsJson() {
    return this.methods().map((x) => ({
      name: x.name, signature: x.signature, slot: x.slot, func: x.func >= 0 ? x.func : null, wasmSig: x.sig, token: hex(x.token), generic: !!x.generic,
    }));
  }

  stringLiterals() {
    const md = this.md;
    const n = md.stringLiteralCount;
    const out = [];
    for (let i = 0; i < n; i++) { try { out.push(md.stringLiteral(i)); } catch (_) { out.push(''); } }
    return out;
  }

  summary() {
    const ms = this.methods();
    return {
      metadataVersion: this.md.version,
      assemblies: this.md.images.length,
      types: this.md.typeCount,
      methods: this.md.methodCount,
      compiledMethods: ms.filter((x) => !x.generic).length,
      genericInstances: ms.filter((x) => x.generic).length,
      mappedToFunctions: ms.filter((x) => x.func >= 0).length,
      stringLiterals: this.md.stringLiteralCount,
      internalCalls: this.internalCalls().length,
    };
  }
}
