// Turning raw IL2CPP values into something the inspector can show and edit, and parsing
// what the user typed back into values the bridge can write or pass to a method.

import { T, FIELD, PRIM_NAME } from './types.js';

const INTS = new Set([T.I1, T.U1, T.I2, T.U2, T.I4, T.U4, T.I8, T.U8, T.I, T.U]);
const FLOATS = new Set([T.R4, T.R8]);

export const hexAddr = (n) => '0x' + (n >>> 0).toString(16).toUpperCase().padStart(8, '0');

export function fmtNumber(v, kind) {
  if (typeof v === 'bigint') return v.toString();
  if (kind === T.R4 || kind === T.R8) {
    if (!Number.isFinite(v)) return String(v);
    if (Number.isInteger(v)) return v.toString();
    const r = Math.abs(v) >= 1e6 || (Math.abs(v) < 1e-4 && v !== 0) ? v.toExponential(4) : (+v.toFixed(kind === T.R4 ? 4 : 6)).toString();
    return r;
  }
  return String(v);
}

export class ValueFormatter {
  constructor(il, unity) {
    this.il = il;
    this.unity = unity;
  }

  /**
   * Describe the value of type `p` stored at `addr` (or the raw value `raw` when addr is null).
   * Returns { kind, text, ref?, td?, editable, enumTd?, structTd?, raw }
   */
  describe(p, addr, raw) {
    const il = this.il;
    const t = il.typeInfo(p);
    const v = addr != null ? il.readValue(addr, p) : raw;
    if (t.kind === T.BOOLEAN) return { kind: 'bool', text: v ? 'true' : 'false', raw: !!v, editable: true };
    if (t.kind === T.CHAR) return { kind: 'char', text: `'${v}'`, raw: v, editable: true };
    if (t.kind === T.I || t.kind === T.U) return { kind: 'number', text: v ? hexAddr(v) : '0', raw: v, editable: true, numKind: t.kind };
    if (INTS.has(t.kind) || FLOATS.has(t.kind)) return { kind: 'number', text: fmtNumber(v, t.kind), raw: v, editable: true, numKind: t.kind };
    if (t.kind === T.PTR || t.kind === T.FNPTR) return { kind: 'number', text: hexAddr(v), raw: v, editable: true, numKind: T.U4 };
    if (t.kind === T.VALUETYPE) {
      const td = il._tdFromData(t.data);
      const d = il.md.typeDef(td);
      if (d.isEnum) {
        const name = il.enumName(td, v);
        return { kind: 'enum', text: name != null ? name : String(v), raw: v, editable: true, enumTd: td };
      }
      if (addr == null) {
        // returned struct as a JS object
        return { kind: 'struct', text: this.structSummaryObj(p, raw), raw, structType: p, editable: false };
      }
      return { kind: 'struct', text: this.structSummary(p, addr), raw: addr, structType: p, addr, editable: true };
    }
    if (t.kind === T.GENERICINST) {
      const base = il.tdOfType(p);
      if (base >= 0 && il.md.typeDef(base).isValueType) {
        if (addr == null || !il.fieldsOfStructType(p)) return { kind: 'unsupported', text: `{${il.typeName(p)}}`, editable: false };
        return { kind: 'struct', text: this.structSummary(p, addr), raw: addr, structType: p, addr, editable: true };
      }
    }
    if (t.kind === T.VAR || t.kind === T.MVAR) return { kind: 'unsupported', text: '?', editable: false };
    if (t.kind === T.STRING && typeof v === 'string') return { kind: 'string', text: v, raw: v, editable: true, isRef: true, refKind: T.STRING };
    if (v === null && addr == null) return { kind: 'null', text: 'null', raw: 0, editable: true, isRef: true, refKind: t.kind };
    // reference
    const ptr = v >>> 0;
    if (!ptr) return { kind: 'null', text: 'null', raw: 0, editable: t.kind === T.STRING || true, isRef: true, refKind: t.kind };
    if (!il.mem.valid(ptr) || !il.mem.valid(il.klassOf(ptr))) return { kind: 'bad', text: `invalid ${hexAddr(ptr)}`, raw: ptr, editable: true, isRef: true };
    if (il.isString(ptr)) {
      const s = il.readString(ptr);
      return { kind: 'string', text: s, raw: ptr, ref: ptr, editable: true, isRef: true, refKind: T.STRING };
    }
    return { kind: 'object', text: this.objectSummary(ptr), raw: ptr, ref: ptr, editable: true, isRef: true, refKind: t.kind };
  }

  /** Short label for a managed object. */
  objectSummary(obj) {
    const il = this.il;
    const k = il.klassOf(obj);
    const tn = il.klassName(k, false);
    const td = il.tdOfKlass(k);
    if (this.unity && this.unity.td.Object >= 0 && il.isInstanceOf(obj, this.unity.td.Object)) {
      if (!this.unity.alive(obj)) return `null (destroyed ${tn})`;
      const n = this.unity.name(obj);
      return n != null ? `${n} (${tn})` : tn;
    }
    const bt = il.typeInfo(k + il.layout.byval);
    if (bt.kind === T.SZARRAY || bt.kind === T.ARRAY) {
      const a = il.arrayInfo(obj);
      return `${il.typeName(a.elemType)}[${a.length}]`;
    }
    const count = this.collectionCount(obj);
    if (count != null) return `${tn} (Count = ${count})`;
    if (td >= 0 && il.md.typeDef(td).isValueType) {
      // boxed value
      return `${tn} ${this.boxedText(obj)}`;
    }
    return tn;
  }

  boxedText(obj) {
    const il = this.il;
    const k = il.klassOf(obj);
    const td = il.tdOfKlass(k);
    const d = il.md.typeDef(td);
    const p = k + il.layout.byval;
    if (d.isEnum || ['Boolean', 'Char', 'SByte', 'Byte', 'Int16', 'UInt16', 'Int32', 'UInt32', 'Int64', 'UInt64', 'Single', 'Double', 'IntPtr', 'UIntPtr'].includes(d.name) && d.namespace === 'System') {
      const kindByName = { Boolean: T.BOOLEAN, Char: T.CHAR, SByte: T.I1, Byte: T.U1, Int16: T.I2, UInt16: T.U2, Int32: T.I4, UInt32: T.U4, Int64: T.I8, UInt64: T.U8, Single: T.R4, Double: T.R8, IntPtr: T.I, UIntPtr: T.U };
      if (d.isEnum) return this.describe(p, obj + 8).text;
      const kind = kindByName[d.name];
      const v = il.readValue(obj + 8, this.primType(kind));
      return kind === T.BOOLEAN ? String(!!v) : fmtNumber(v, kind);
    }
    return this.structSummary(p, obj + 8);
  }

  /** A synthetic Il2CppType* for a primitive kind (taken from System.* type definitions). */
  primType(kind) {
    this._prim ||= new Map();
    if (this._prim.has(kind)) return this._prim.get(kind);
    const names = { [T.BOOLEAN]: 'Boolean', [T.CHAR]: 'Char', [T.I1]: 'SByte', [T.U1]: 'Byte', [T.I2]: 'Int16', [T.U2]: 'UInt16', [T.I4]: 'Int32', [T.U4]: 'UInt32', [T.I8]: 'Int64', [T.U8]: 'UInt64', [T.R4]: 'Single', [T.R8]: 'Double', [T.I]: 'IntPtr', [T.U]: 'UIntPtr', [T.STRING]: 'String', [T.OBJECT]: 'Object' };
    const td = this.il.findType('System.' + names[kind]);
    const p = td >= 0 ? this.il.typePtr(this.il.md.typeDef(td).byvalTypeIndex) : 0;
    this._prim.set(kind, p);
    return p;
  }

  /** Count of List<T>, HashSet<T>, Dictionary<K,V>, Queue<T>, Stack<T> by their private fields. */
  collectionCount(obj) {
    const il = this.il;
    const k = il.klassOf(obj);
    const td = il.tdOfKlass(k);
    if (td < 0) return null;
    const d = il.md.typeDef(td);
    if (d.namespace !== 'System.Collections.Generic' && d.namespace !== 'System.Collections') return null;
    const fields = il.runtimeFields(k);
    const f = fields.find((x) => !x.isStatic && (x.name === '_size' || x.name === 'count' || x.name === '_count' || x.name === 'size'));
    if (!f) return null;
    const c = il.mem.i32At(obj + f.offset);
    const fr = fields.find((x) => !x.isStatic && (x.name === 'freeCount' || x.name === '_freeCount'));
    return fr ? c - il.mem.i32At(obj + fr.offset) : c;
  }

  /** Elements of arrays and List<T> as [{ label, type, addr }] (first `max`). */
  elements(obj, max = 200, start = 0) {
    const il = this.il;
    const k = il.klassOf(obj);
    const bt = il.typeInfo(k + il.layout.byval);
    if (bt.kind === T.SZARRAY || bt.kind === T.ARRAY) {
      const a = il.arrayInfo(obj);
      const out = [];
      for (let i = start; i < a.length && i < start + max; i++) out.push({ label: `[${i}]`, type: a.elemType, addr: a.data + i * a.elemSize });
      return { total: a.length, items: out };
    }
    const td = il.tdOfKlass(k);
    const d = td >= 0 ? il.md.typeDef(td) : null;
    if (d && d.namespace === 'System.Collections.Generic' && /^(List|Queue|Stack)`1$/.test(d.name)) {
      const fields = il.runtimeFields(k);
      const items = fields.find((x) => x.name === '_items' || x.name === '_array');
      const size = fields.find((x) => x.name === '_size');
      if (items && size) {
        const arr = il.mem.u32At(obj + items.offset);
        const n = il.mem.i32At(obj + size.offset);
        if (!arr) return { total: 0, items: [] };
        const a = il.arrayInfo(arr);
        const out = [];
        for (let i = start; i < n && i < start + max; i++) out.push({ label: `[${i}]`, type: a.elemType, addr: a.data + i * a.elemSize });
        return { total: n, items: out };
      }
    }
    if (d && d.namespace === 'System.Collections.Generic' && d.name === 'Dictionary`2') {
      const fields = il.runtimeFields(k);
      const ef = fields.find((x) => x.name === '_entries' || x.name === 'entries');
      const cf = fields.find((x) => x.name === '_count' || x.name === 'count');
      if (ef && cf) {
        const arr = il.mem.u32At(obj + ef.offset);
        if (!arr) return { total: 0, items: [] };
        const a = il.arrayInfo(arr);
        // Entry<K,V> is a generic struct: use the runtime element class's fields
        const ek = il.mem.u32At(il.klassOf(arr) + il.layout.elementClass);
        const efs = ek ? il.runtimeFields(ek) : [];
        const keyF = efs.find((x) => x.name === 'key');
        const valF = efs.find((x) => x.name === 'value');
        const hashF = efs.find((x) => x.name === 'hashCode');
        const n = il.mem.i32At(obj + cf.offset);
        const out = [];
        if (keyF && valF) {
          for (let i = 0; i < n && out.length < max; i++) {
            const e = a.data + i * a.elemSize;
            if (hashF && il.mem.i32At(e + hashF.offset - 8) < 0) continue; // free slot
            if (out.length < start) continue;
            const kd = this.describe(keyF.type, e + keyF.offset - 8);
            out.push({ label: `[${kd.kind === 'string' ? JSON.stringify(kd.text) : kd.text}]`, type: valF.type, addr: e + valF.offset - 8 });
          }
        }
        return { total: this.collectionCount(obj) ?? n, items: out };
      }
    }
    return null;
  }

  structSummary(p, addr) {
    const il = this.il;
    const fs = il.fieldsOfStructType(p) || [];
    if (!fs.length) return '{}';
    if (fs.length <= 4 && fs.every((f) => { const k = il.typeInfo(f.type).kind; return INTS.has(k) || FLOATS.has(k) || k === T.BOOLEAN; })) {
      return '(' + fs.map((f) => { const v = il.readValue(addr + f.offset, f.type); const k = il.typeInfo(f.type).kind; return k === T.BOOLEAN ? String(v) : fmtNumber(v, k); }).join(', ') + ')';
    }
    return `{${il.typeName(p)}}`;
  }

  structSummaryObj(p, obj) {
    const il = this.il;
    if (!obj || typeof obj !== 'object') return String(obj);
    const fs = il.fieldsOfStructType(p) || [];
    const vals = fs.map((f) => {
      const v = obj[f.name];
      const k = il.typeInfo(f.type).kind;
      if (typeof v === 'number' || typeof v === 'bigint') return fmtNumber(v, k);
      if (typeof v === 'boolean') return String(v);
      return v && typeof v === 'object' ? '{…}' : String(v);
    });
    return fs.length && fs.length <= 4 ? '(' + vals.join(', ') + ')' : `{${il.typeName(p)}}`;
  }

  /**
   * Parse user input for type p.
   * Returns a value accepted by Il2Cpp.writeValue / marshal (numbers, bigint, booleans,
   * JS strings, struct objects, or pointers).
   */
  parse(p, text) {
    const il = this.il;
    const t = il.typeInfo(p);
    const s = String(text).trim();
    const ptrIn = /^@?0x[0-9a-f]+$/i.test(s) ? parseInt(s.replace('@', ''), 16) : null;
    switch (t.kind) {
      case T.BOOLEAN:
        if (/^(true|1|yes|on)$/i.test(s)) return true;
        if (/^(false|0|no|off)$/i.test(s)) return false;
        throw new Error('expected true or false');
      case T.CHAR: return s.replace(/^'(.*)'$/, '$1') || '\0';
      case T.I8: case T.U8: return BigInt(s);
      case T.R4: case T.R8: { const v = Number(s); if (Number.isNaN(v) && s !== 'NaN') throw new Error('expected a number'); return v; }
      case T.STRING: {
        if (s === 'null') return 0;
        if (ptrIn != null && s.startsWith('@')) return ptrIn;
        const m = /^"([\s\S]*)"$/.exec(String(text));
        return m ? JSON.parse(`"${m[1].replace(/\\?"/g, '\\"')}"`) : String(text);
      }
      case T.VALUETYPE: {
        const td = il._tdFromData(t.data);
        const d = il.md.typeDef(td);
        if (d.isEnum) {
          if (/^-?\d+$/.test(s) || /^0x[0-9a-f]+$/i.test(s)) return Number(s);
          const members = il.enumMembers(td);
          let v = 0;
          for (const part of s.split(/[|,]/).map((x) => x.trim()).filter(Boolean)) {
            const m = members.find(([n]) => n.toLowerCase() === part.toLowerCase());
            if (!m) throw new Error(`${d.name} has no member ${part}`);
            v |= Number(m[1]);
          }
          return v;
        }
        if (ptrIn != null) return ptrIn;
        const fs = il.structFields(td);
        if (s.startsWith('{')) return JSON.parse(s);
        const parts = s.replace(/^\(|\)$/g, '').split(/[,\s]+/).filter(Boolean);
        if (parts.length !== fs.length) throw new Error(`expected ${fs.length} values: ${fs.map((f) => f.name).join(', ')}`);
        const out = {};
        fs.forEach((f, i) => { out[f.name] = this.parse(f.type, parts[i]); });
        return out;
      }
      default:
        if (INTS.has(t.kind) || t.kind === T.PTR) {
          const v = /^-?0x/i.test(s) ? parseInt(s, 16) : Number(s);
          if (!Number.isFinite(v)) throw new Error('expected a number');
          return v;
        }
        // references
        if (s === '' || s === 'null' || s === '0') return 0;
        if (ptrIn != null) return ptrIn;
        // System.Type parameters accept a type name
        const tn = il.typeName(p, true);
        if (tn === 'System.Type') {
          const td = il.findType(s);
          if (td < 0) throw new Error(`type ${s} not found`);
          return il.typeObjectOfTd(td);
        }
        if (tn === 'System.Object' || tn === 'object') {
          // boxed primitives are not supported; strings are
          const m = /^"([\s\S]*)"$/.exec(s);
          if (m) return il.newString(m[1]);
        }
        throw new Error('enter null or an object address like @0x1A2B3C');
    }
  }

  /** Name shown for a type in member lists. */
  typeLabel(p) { return this.il.typeName(p, false); }

  /** Is a field (from runtime FieldInfo) writable from the inspector? */
  fieldWritable(f) { return !(f.attrs & FIELD.LITERAL); }

  primName(kind) { return PRIM_NAME[kind]; }
}
