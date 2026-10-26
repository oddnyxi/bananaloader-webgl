// IntelliSense for the consoles and the Banan editor.
//
// Purely static: the text before the caret is tokenized, the member-access chain under the caret is
// parsed (`Camera.main.transform.position.` → Camera ▸ main ▸ transform ▸ position) and each step is
// resolved through the IL2CPP metadata — field types, property getter return types, method return
// types, generic arguments substituted. Nothing is called and no getter runs while you type; the
// only live values used are the plain JS objects in scope (Il2Cpp, il, unity, …) and interop proxies
// held directly in them, whose type is read without touching managed code.

import { T, FIELD, METHOD, PRIM_NAME } from './types.js';

// ------------------------------------------------------------------------------------ tokenizer

const ID_START = /[\p{L}\p{Nl}$_]/u;
const ID_PART = /[\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}$]/u;

/**
 * Tokens of `src` (the text before the caret). The last token may be an unterminated string
 * (`open: true`) — that is how "the caret is inside a string" is detected. `comment` is set when the
 * text ends inside a comment.
 */
export function tokenize(src) {
  const out = [];
  let i = 0;
  const n = src.length;
  let comment = false;
  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
    if (c === '\n') { out.push({ t: 'nl', v: '\n', s: i, e: i + 1 }); i++; continue; }
    if (c === '/' && src[i + 1] === '/') { const j = src.indexOf('\n', i); if (j < 0) { comment = true; break; } i = j; continue; }
    if (c === '/' && src[i + 1] === '*') { const j = src.indexOf('*/', i + 2); if (j < 0) { comment = true; break; } i = j + 2; continue; }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      let v = '';
      let closed = false;
      while (j < n) {
        const d = src[j];
        if (d === '\\') { v += src[j + 1] || ''; j += 2; continue; }
        if (d === c) { closed = true; j++; break; }
        if (d === '\n' && c !== '`') break;
        v += d;
        j++;
      }
      out.push({ t: 'str', v, q: c, s: i, e: j, open: !closed });
      i = j;
      continue;
    }
    if (ID_START.test(c)) {
      let j = i + 1;
      while (j < n && ID_PART.test(src[j])) j++;
      out.push({ t: 'id', v: src.slice(i, j), s: i, e: j });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || ''))) {
      let j = i + 1;
      while (j < n && /[\w.]/.test(src[j])) j++;
      out.push({ t: 'num', v: src.slice(i, j), s: i, e: j });
      i = j;
      continue;
    }
    if (c === '?' && src[i + 1] === '.' && !/[0-9]/.test(src[i + 2] || '')) { out.push({ t: 'p', v: '.', s: i, e: i + 2 }); i += 2; continue; }
    if (c === '=' && src[i + 1] === '>') { out.push({ t: 'p', v: '=>', s: i, e: i + 2 }); i += 2; continue; }
    out.push({ t: 'p', v: c, s: i, e: i + 1 });
    i++;
  }
  return { toks: out, comment };
}

const OPEN = { ')': '(', ']': '[', '}': '{' };
const CLOSE = { '(': ')', '[': ']', '{': '}' };

function matchBack(toks, i) {
  const close = toks[i].v;
  const open = OPEN[close];
  let depth = 0;
  for (let j = i; j >= 0; j--) {
    const t = toks[j];
    if (t.t !== 'p') continue;
    if (t.v === close) depth++;
    else if (t.v === open && --depth === 0) return j;
  }
  return -1;
}

/** Split call argument tokens at top-level commas. */
function splitArgs(toks) {
  const out = [];
  let cur = [];
  let depth = 0;
  for (const t of toks) {
    if (t.t === 'nl') continue;
    if (t.t === 'p' && CLOSE[t.v]) depth++;
    else if (t.t === 'p' && OPEN[t.v]) depth--;
    if (t.t === 'p' && t.v === ',' && depth === 0) { out.push(cur); cur = []; continue; }
    cur.push(t);
  }
  if (cur.length || out.length) out.push(cur);
  return out;
}

/**
 * The member-access chain ending just before token index `end`:
 *   Il2Cpp.type('X').main  →  [{name:'Il2Cpp'}, {name:'type'}, {call:[[str X]]}, {name:'main'}]
 * Returns null when the expression there isn't a chain we can follow.
 */
export function chainBefore(toks, end) {
  const segs = [];
  let i = end - 1;
  while (i >= 0 && toks[i].t === 'nl') i--;
  for (let guard = 0; i >= 0 && guard < 200; guard++) {
    const t = toks[i];
    if (t.t === 'id') {
      segs.unshift({ name: t.v });
      i--;
      while (i >= 0 && toks[i].t === 'nl') i--;
      if (i >= 0 && toks[i].t === 'p' && toks[i].v === '.') { i--; while (i >= 0 && toks[i].t === 'nl') i--; continue; }
      if (i >= 0 && toks[i].t === 'id' && toks[i].v === 'new') segs[0].isNew = true;
      return segs;
    }
    if (t.t === 'p' && (t.v === ')' || t.v === ']')) {
      const j = matchBack(toks, i);
      if (j < 0) return null;
      const inner = toks.slice(j + 1, i);
      const prev = toks[j - 1];
      const callee = prev && (prev.t === 'id' || (prev.t === 'p' && (prev.v === ')' || prev.v === ']')));
      if (t.v === ']' && !callee) { segs.unshift({ lit: 'array' }); return segs; }
      if (t.v === ')' && !callee) {
        // parenthesised expression: (expr).foo
        const sub = chainBefore(inner, inner.length);
        if (!sub) return null;
        return [...sub, ...segs];
      }
      if (t.v === ')') segs.unshift({ call: splitArgs(inner) });
      else segs.unshift({ index: inner });
      i = j - 1;
      continue;
    }
    if (t.t === 'str' && !t.open) { segs.unshift({ lit: 'string' }); return segs; }
    if (t.t === 'num') { segs.unshift({ lit: 'number' }); return segs; }
    return null;
  }
  return null;
}

const TYPE_ALIAS = { int: 'System.Int32', uint: 'System.UInt32', long: 'System.Int64', ulong: 'System.UInt64', short: 'System.Int16', ushort: 'System.UInt16', byte: 'System.Byte', sbyte: 'System.SByte', float: 'System.Single', double: 'System.Double', bool: 'System.Boolean', char: 'System.Char', string: 'System.String', object: 'System.Object' };

/** Same parameter types (an override, or a re-declaration hiding the base one)? */
function sameParams(il, a, b) {
  if (a.parameterCount !== b.parameterCount) return false;
  const pa = il.params(a); const pb = il.params(b);
  return pa.every((p, i) => il.typeName(p.type, true) === il.typeName(pb[i].type, true));
}

const strArg = (args, n = 0) => {
  const a = args && args[n];
  return a && a.length === 1 && a[0].t === 'str' ? a[0].v : null;
};

// ------------------------------------------------------------------------------------ type refs

// A TRef is the engine's view of a type with generic arguments substituted:
//   { td, args?: TRef[] } | { prim: 'string'|'number'|'bool'|'void', name } | { array: TRef } | { gp: 'T' }

export class Completer {
  /**
   * @param {object} o
   * @param {object} o.il          the Il2Cpp bridge
   * @param {TypeIndex} o.index    type name index
   * @param {object} [o.api]       the interop api object (Il2Cpp), recognised by identity
   * @param {object} [o.isProxy]   interop's proxy test
   */
  constructor({ il, index, api = null }) {
    this.il = il;
    this.index = index;
    this.api = api;
    this._typeTd = new Map();
  }

  tdOf(full) {
    if (!this._typeTd.has(full)) this._typeTd.set(full, this.il.findType(full));
    return this._typeTd.get(full);
  }

  toRef(p, cargs = [], margs = [], depth = 0) {
    const il = this.il;
    if (!p || depth > 12) return null;
    const t = il.typeInfo(p);
    switch (t.kind) {
      case T.STRING: return { prim: 'string', name: 'string' };
      case T.BOOLEAN: return { prim: 'bool', name: 'bool' };
      case T.VOID: return { prim: 'void', name: 'void' };
      case T.I8: case T.U8: return { prim: 'bigint', name: PRIM_NAME[t.kind] }; // long/ulong arrive as BigInts
      case T.CHAR: case T.I1: case T.U1: case T.I2: case T.U2: case T.I4: case T.U4:
      case T.R4: case T.R8: case T.I: case T.U: case T.PTR: case T.FNPTR:
        return { prim: 'number', name: PRIM_NAME[t.kind] || 'nint' };
      case T.OBJECT: { const td = this.tdOf('System.Object'); return td >= 0 ? { td } : null; }
      case T.CLASS: case T.VALUETYPE: { const td = il._tdFromData(t.data); return td >= 0 ? { td } : null; }
      case T.SZARRAY: return { array: this.toRef(t.data, cargs, margs, depth + 1) };
      case T.ARRAY: return { array: this.toRef(il.mem.u32At(t.data), cargs, margs, depth + 1) };
      case T.VAR: { const k = il.md.genericParamNum(t.data); return cargs[k] || { gp: il.md.genericParamName(t.data) }; }
      case T.MVAR: { const k = il.md.genericParamNum(t.data); return margs[k] || { gp: il.md.genericParamName(t.data) }; }
      case T.GENERICINST: {
        const td = il.tdOfType(il._genericBase(t.data));
        if (td < 0) return null;
        const args = il._genericArgs(il.mem.u32At(t.data + 4)).map((a) => this.toRef(a, cargs, margs, depth + 1));
        return { td, args };
      }
      default: return null;
    }
  }

  refName(r, depth = 0) {
    if (!r) return '?';
    if (r.prim) return r.name;
    if (r.gp) return r.gp;
    if (r.array) return `${this.refName(r.array, depth + 1)}[]`;
    const n = this.il.md.typeDef(r.td).name.replace(/`\d+$/, '');
    if (r.args && r.args.length && depth < 4) return `${n}<${r.args.map((a) => this.refName(a, depth + 1)).join(', ')}>`;
    if (this.il.md.typeDef(r.td).isGeneric) return `${n}<${this.il.md.genericParamNames(this.il.md.typeDef(r.td).genericContainerIndex).join(', ')}>`;
    return n;
  }

  /** Static parse of a type-name string as Il2Cpp.type() would accept it. */
  parseTypeName(s, depth = 0) {
    s = String(s).trim();
    if (!s || depth > 8) return null;
    const PRIM = TYPE_ALIAS;
    if (s === 'string' || s === 'System.String') return { prim: 'string', name: 'string' };
    if (s.endsWith('[]')) { const e = this.parseTypeName(s.slice(0, -2), depth + 1); return e ? { array: e } : null; }
    if (PRIM[s]) s = PRIM[s];
    // values of these types arrive as JS numbers / booleans / BigInts, like toRef() types them
    if (/^System\.(Int32|UInt32|Int16|UInt16|Byte|SByte|Single|Double|Char|IntPtr|UIntPtr)$/.test(s)) return { prim: 'number', name: s.slice(7) };
    if (/^System\.(Int64|UInt64)$/.test(s)) return { prim: 'bigint', name: s.slice(7) };
    if (s === 'System.Boolean') return { prim: 'bool', name: 'bool' };
    const lt = s.indexOf('<');
    if (lt < 0) { const td = this.tdOf(s); return td >= 0 ? { td } : null; }
    if (s.lastIndexOf('>') < lt) return null; // unbalanced: Il2Cpp.type() rejects it too
    const base = s.slice(0, lt);
    const inner = s.slice(lt + 1, s.lastIndexOf('>'));
    const parts = [];
    let d = 0;
    let cur = '';
    for (const ch of inner) {
      if (ch === '<') d++;
      if (ch === '>') d--;
      if (ch === ',' && d === 0) { parts.push(cur); cur = ''; continue; }
      cur += ch;
    }
    parts.push(cur);
    let td = this.tdOf(`${base}\`${parts.length}`);
    if (td < 0) td = this.tdOf(base);
    if (td < 0) return null;
    return { td, args: parts.map((p) => this.parseTypeName(p, depth + 1)) };
  }

  /** The ref of the base type of `r`, generic arguments carried through. */
  parentRef(r) {
    const d = this.il.md.typeDef(r.td);
    if (d.parentIndex < 0) return null;
    return this.toRef(this.il.typePtr(d.parentIndex), r.args || []);
  }

  hierarchy(r) {
    const out = [];
    for (let c = r, g = 0; c && c.td !== undefined && g < 48; c = this.parentRef(c), g++) out.push(c);
    return out;
  }

  // ------------------------------------------------------------------------------------ members

  /**
   * Members of a type: { name → member } where a member is
   *   { kind: 'field'|'prop'|'method'|'const'|'type', isStatic, ref (result type), metas (methods), owner, detail }
   */
  members(r, wantStatic) {
    const key = `${wantStatic ? 's' : 'i'}:${this.refKey(r)}`;
    this._mcache ||= new Map();
    if (this._mcache.has(key)) return this._mcache.get(key);
    const il = this.il;
    const out = new Map();
    const levels = this.hierarchy(r);
    const isStruct = il.md.typeDef(r.td).isValueType;
    for (const lv of levels) {
      const cargs = lv.args || [];
      for (const f of il.fieldsOf(lv.td)) {
        const st = (f.attrs & FIELD.STATIC) !== 0;
        const lit = (f.attrs & FIELD.LITERAL) !== 0;
        if ((st || lit) !== !!wantStatic) continue;
        let name = f.name;
        const bf = /^<(.+)>k__BackingField$/.exec(name);
        if (bf) { if (!isStruct) continue; name = bf[1]; }
        if (name.includes('<') || name === 'value__' || out.has(name)) continue;
        const ref = this.toRef(f.type, cargs);
        out.set(name, { kind: lit ? (il.md.typeDef(lv.td).isEnum ? 'enum' : 'const') : 'field', name, isStatic: st || lit, ref, owner: lv, pub: (f.attrs & FIELD.ACCESS) === FIELD.PUBLIC, readonly: lit || (f.attrs & FIELD.INIT_ONLY) !== 0 });
      }
      if (isStruct && !wantStatic) continue; // struct values are plain objects of their fields
      for (const p of il.propertiesOf(lv.td)) {
        const acc = p.getter || p.setter;
        if (!acc || (p.getter && p.getter.parameterCount)) continue;
        const st = (acc.flags & METHOD.STATIC) !== 0;
        if (st !== !!wantStatic) continue;
        const cur = out.get(p.name);
        if (cur) { if (cur.kind === 'prop') { cur.get ||= !!p.getter; cur.set ||= !!p.setter; } continue; }
        const ref = p.getter ? this.toRef(il.typePtr(p.getter.returnType), cargs) : (p.setter ? this.toRef(il.params(p.setter)[0]?.type, cargs) : null);
        out.set(p.name, { kind: 'prop', name: p.name, isStatic: st, ref, owner: lv, get: !!p.getter, set: !!p.setter, pub: ((acc.flags & METHOD.ACCESS) === METHOD.PUBLIC) });
      }
      for (const m of il.methodsOf(lv.td)) {
        const st = (m.flags & METHOD.STATIC) !== 0;
        if (st !== !!wantStatic) continue;
        if (m.name === '.ctor' || m.name === '.cctor' || m.name.includes('<') || m.name.endsWith('_Injected')) continue;
        if ((m.flags & METHOD.SPECIAL) && /^(get_|set_|add_|remove_|op_)/.test(m.name)) {
          if (!m.name.startsWith('op_')) continue;
        }
        const cur = out.get(m.name);
        if (cur && cur.kind !== 'method') continue;
        if (cur) {
          // an override of a method already listed from a derived type isn't another overload
          if (cur.metas.some((x) => sameParams(il, x, m))) continue;
          cur.metas.push(m); cur.levels.push(lv); continue;
        }
        out.set(m.name, { kind: 'method', name: m.name, isStatic: st, metas: [m], levels: [lv], owner: lv, pub: (m.flags & METHOD.ACCESS) === METHOD.PUBLIC });
      }
      if (wantStatic) break; // statics are reachable through the derived type, but listing the type's own reads better
    }
    if (wantStatic) {
      // inherited statics after own ones (Il2Cpp.type('X').Y finds them too)
      for (const lv of levels.slice(1)) {
        for (const [n, m] of this.members(lv, true)) if (!out.has(n) && m.kind !== 'type') out.set(n, { ...m, inherited: true });
      }
      const d = il.md.typeDef(r.td);
      for (let i = 0; i < d.nestedCount; i++) {
        const n = il.md.nestedType(d.nestedTypesStart + i);
        const nd = il.md.typeDef(n);
        if (nd.name.includes('<') || out.has(nd.name)) continue;
        out.set(nd.name, { kind: 'type', name: nd.name, isStatic: true, td: n, pub: (nd.flags & 0x7) === 2 });
      }
    }
    this._mcache.set(key, out);
    return out;
  }

  refKey(r) {
    if (!r) return '?';
    if (r.prim) return r.prim;
    if (r.gp) return `!${r.gp}`;
    if (r.array) return `${this.refKey(r.array)}[]`;
    return r.args && r.args.length ? `${r.td}<${r.args.map((a) => this.refKey(a)).join(',')}>` : String(r.td);
  }

  methodReturn(m, owner, margs = []) {
    return this.toRef(this.il.typePtr(m.returnType), owner.args || [], margs);
  }

  sig(m, owner, margs = []) {
    const ps = this.il.params(m).map((p) => `${this.refName(this.toRef(p.type, owner.args || [], margs))} ${p.name}`);
    const gp = m.genericContainerIndex !== -1 ? `<${this.il.md.genericParamNames(m.genericContainerIndex).join(', ')}>` : '';
    return { ret: this.refName(this.methodReturn(m, owner, margs)), text: `${m.name}${gp}(${ps.join(', ')})`, params: ps, generic: !!gp };
  }

  // ------------------------------------------------------------------------------------ shapes

  // A shape is what an expression evaluates to, as far as completion is concerned:
  //   { k: 'js', v }                 a live JS value (scope objects, plain helpers)
  //   { k: 'static', ref }           Il2Cpp.type('X') / bare X: static members
  //   { k: 'ns', ns }                a namespace: UnityEngine.
  //   { k: 'inst', ref }             a value of that type: instance members / struct fields / string methods
  //   { k: 'method', m, margs }      a method group (call it, or .of('T') for generics)
  //   { k: 'fnret', ref, array }     a JS helper whose call returns that type
  //   { k: 'this' }                  `this` inside a Banan class

  shapeOfValue(v) {
    if (v === null || v === undefined) return null;
    const api = this.api;
    if (api && (typeof v === 'object' || typeof v === 'function') && api.isProxy(v)) {
      try {
        if (typeof v === 'function') { const td = v.$td; return td >= 0 ? { k: 'static', ref: { td } } : null; }
        const il = this.il;
        const k = v.$klass;
        if (k) {
          const p = k + il.layout.byval;
          return { k: 'inst', ref: this.toRef(p) };
        }
        const ptr = v.$ptr;
        if (ptr && Array.isArray(v)) { const a = il.arrayInfo(ptr); return { k: 'inst', ref: { array: this.toRef(a.elemType) } }; }
      } catch (_) { return null; }
      return null;
    }
    if (typeof v === 'string') return { k: 'inst', ref: { prim: 'string', name: 'string' } };
    return { k: 'js', v };
  }

  /** Resolve a chain to a shape. ctx: { roots, locals, thisMembers, bare, unityFirst } */
  resolve(chain, ctx, depth = 0) {
    if (!chain || !chain.length || depth > 6) return null;
    let s = this.root(chain[0], ctx, depth);
    let isNew = !!chain[0].isNew;
    for (let i = 1; i < chain.length && s; i++) {
      const seg = chain[i];
      if (seg.name !== undefined) s = this.member(s, seg.name, ctx, depth);
      else if (seg.call) {
        if (isNew && s.k === 'static') s = { k: 'inst', ref: s.ref };
        else s = this.call(s, seg.call);
        isNew = false;
      } else if (seg.index) s = this.elementOf(s, !!seg.iter);
      else s = null;
    }
    return s;
  }

  root(seg, ctx, depth) {
    if (seg.lit === 'string') return { k: 'inst', ref: { prim: 'string', name: 'string' } };
    if (seg.lit === 'number') return { k: 'js', v: 0 };
    if (seg.lit === 'array') return { k: 'js', v: [] };
    const name = seg.name;
    if (name === undefined) return null;
    if (name === 'this') return ctx.thisMembers ? { k: 'this' } : null;
    if (ctx.locals && ctx.locals.has(name)) return this.resolve(ctx.locals.get(name), ctx, depth + 1);
    if (ctx.roots && Object.prototype.hasOwnProperty.call(ctx.roots, name)) return this.shapeOfValue(ctx.roots[name]);
    if (ctx.bare) {
      const kind = this.index.bareKind(name, ctx.unityFirst);
      if (kind === 'type') return { k: 'static', ref: { td: this.index.byShort.get(name) } };
      if (kind === 'ns') return { k: 'ns', ns: name };
    }
    if (name in globalThis && !ctx.noGlobals) { try { return this.shapeOfValue(globalThis[name]); } catch (_) { return null; } }
    return null;
  }

  member(s, name, ctx, depth) {
    const il = this.il;
    switch (s.k) {
      case 'this': {
        const c = ctx.thisMembers && ctx.thisMembers.get(name);
        if (c) return this.resolve(c, { ...ctx, thisMembers: null }, depth + 1);
        if (ctx.thisValues && Object.prototype.hasOwnProperty.call(ctx.thisValues, name)) return this.shapeOfValue(ctx.thisValues[name]);
        const d = ctx.thisProto && findDesc(ctx.thisProto, name);
        if (d && typeof d.value === 'function') return { k: 'jsfn', v: d.value, owner: ctx.thisProto, name };
        return null;
      }
      case 'js': {
        const v = s.v;
        if (v === null || v === undefined) return null;
        // known Il2Cpp helpers are resolved at call time
        if (this.api && v === this.api && API_FNS.has(name)) return { k: 'apifn', name };
        const desc = findDesc(Object(v), name);
        if (!desc) return null;
        if ('value' in desc) {
          if (typeof desc.value === 'function') return { k: 'jsfn', v: desc.value, owner: v, name };
          return this.shapeOfValue(desc.value);
        }
        return null; // a getter: don't run it
      }
      case 'ns': {
        const full = `${s.ns}.${name}`;
        const td = this.tdOf(full);
        if (td >= 0) return { k: 'static', ref: { td } };
        if (this.index.isNamespace(full)) return { k: 'ns', ns: full };
        return null;
      }
      case 'static': {
        if (name === '$type') return { k: 'inst', ref: { td: this.tdOf('System.Type') } };
        if (name === '$new' || name === '$find') return { k: 'fnret', ref: s.ref };
        if (name === '$findAll') return { k: 'fnret', ref: { array: s.ref, js: true } };
        if (name === '$name') return { k: 'inst', ref: { prim: 'string', name: 'string' } };
        const m = this.members(s.ref, true).get(name);
        if (!m) return null;
        if (m.kind === 'type') return { k: 'static', ref: { td: m.td } };
        if (m.kind === 'method') return { k: 'method', mem: m, margs: [] };
        return m.ref ? { k: 'inst', ref: m.ref } : null;
      }
      case 'inst': {
        const r = s.ref;
        if (!r) return null;
        if (r.prim === 'string') return protoMember(String.prototype, name, 'string');
        if (r.prim === 'number') return protoMember(Number.prototype, name);
        if (r.prim === 'bigint') return protoMember(BigInt.prototype, name);
        if (r.prim) return null;
        if (r.array) {
          if (name === 'length') return { k: 'js', v: 0 };
          // a managed array proxy has $toArray(); a plain JS array (findAll, gameObjects, $toArray()) doesn't
          if (!r.js && (name === '$toArray' || name === 'toArray')) return { k: 'fnret', ref: { array: r.array, js: true } };
          if (/^\d+$/.test(name)) return { k: 'inst', ref: r.array };
          if (['find', 'at', 'pop', 'shift', 'findLast'].includes(name)) return { k: 'fnret', ref: r.array };
          if (['filter', 'slice', 'reverse', 'sort', 'concat', 'toReversed', 'toSorted'].includes(name)) return { k: 'fnret', ref: { array: r.array, js: true } };
          return null;
        }
        if (r.gp || r.td === undefined) return null;
        const d = il.md.typeDef(r.td);
        if (d.isEnum) return protoMember(Number.prototype, name);
        if (name === '$static') return { k: 'static', ref: r };
        if (name === '$component') return { k: 'apifn', name: 'find' };
        if (name === '$toArray') return { k: 'fnret', ref: { array: this.collectionElement(r) || { td: this.tdOf('System.Object') }, js: true } };
        if (name === '$type') return { k: 'inst', ref: { prim: 'string', name: 'string' } };
        const m = this.members(r, false).get(name);
        if (m) {
          if (m.kind === 'method') return { k: 'method', mem: m, margs: [] };
          return m.ref ? { k: 'inst', ref: m.ref } : null;
        }
        // statics are reachable from instances too
        const sm = this.members(r, true).get(name);
        if (sm && sm.kind !== 'type') return sm.kind === 'method' ? { k: 'method', mem: sm, margs: [] } : (sm.ref ? { k: 'inst', ref: sm.ref } : null);
        return null;
      }
      case 'method':
        if (name === 'of') return { k: 'of', method: s };
        return null;
      case 'fnret':
        return null;
      default:
        return null;
    }
  }

  call(s, args) {
    const nargs = args.length;
    switch (s.k) {
      case 'apifn': {
        const str = strArg(args);
        const r = str !== null ? this.parseTypeName(str) : null;
        switch (s.name) {
          case 'type': {
            // Il2Cpp.type('string') is System.String's type proxy; Il2Cpp.type('X[]') has no statics to list
            if (r && r.prim && r.prim !== 'void') { const td = this.tdOf(TYPE_ALIAS[str.trim()] || str.trim()); return td >= 0 ? { k: 'static', ref: { td } } : null; }
            return r && !r.prim && !r.array ? { k: 'static', ref: r } : null;
          }
          case 'find': case 'new': return r ? { k: 'inst', ref: r } : null;
          case 'findAll': return r ? { k: 'inst', ref: { array: r, js: true } } : null;
          case 'gameObject': { const td = this.tdOf('UnityEngine.GameObject'); return td >= 0 ? { k: 'inst', ref: { td } } : null; }
          case 'gameObjects': { const td = this.tdOf('UnityEngine.GameObject'); return td >= 0 ? { k: 'inst', ref: { array: { td }, js: true } } : null; }
          case 'typeOf': { const td = this.tdOf('System.Type'); return td >= 0 ? { k: 'inst', ref: { td } } : null; }
          case 'string': return str !== null ? { k: 'inst', ref: { td: this.tdOf('System.String') } } : { k: 'inst', ref: { prim: 'string', name: 'string' } };
          default: return null;
        }
      }
      case 'fnret': return { k: 'inst', ref: s.ref };
      case 'of': {
        const margs = args.map((a) => (a.length === 1 && a[0].t === 'str' ? this.parseTypeName(a[0].v) : null));
        return { ...s.method, margs };
      }
      case 'method': {
        const m = s.mem;
        const pick = m.metas.findIndex((x) => x.parameterCount === nargs);
        const i = pick >= 0 ? pick : 0;
        const ret = this.methodReturn(m.metas[i], m.levels[i], s.margs);
        if (!ret || ret.prim === 'void') return null;
        return { k: 'inst', ref: ret };
      }
      case 'jsfn': {
        // a few plain JS helpers with a known result
        if (s.name === 'toString' || s.name === 'toFixed' || s.name === 'join') return { k: 'inst', ref: { prim: 'string', name: 'string' } };
        return null;
      }
      default: return null;
    }
  }

  /** x[i], or (with `iter`) the variable of for (const v of x): arrays, and the common generic collections. */
  elementOf(s, iter = false) {
    if (s.k === 'inst' && s.ref && s.ref.array) return { k: 'inst', ref: s.ref.array };
    if (iter && s.k === 'inst' && s.ref) { const e = this.collectionElement(s.ref); if (e) return { k: 'inst', ref: e }; }
    return null;
  }

  /** What iterating a collection proxy yields (as the proxy's iterator does: a dictionary gives its values). */
  collectionElement(r) {
    if (!r || r.td === undefined || !r.args) return null;
    const d = this.il.md.typeDef(r.td);
    const n = `${d.namespace}.${d.name}`;
    if (/^System\.Collections\.Generic\.(List|HashSet|Queue|Stack|LinkedList|SortedSet|IEnumerable|ICollection|IList|IReadOnlyList|IReadOnlyCollection|ISet)`1$/.test(n)) return r.args[0] || null;
    if (/^System\.Collections\.Generic\.(Dictionary|SortedDictionary|SortedList|IDictionary|IReadOnlyDictionary)`2$/.test(n)) return r.args[1] || null;
    return null;
  }

  // ------------------------------------------------------------------------------------ items

  /** Completion items for the members of a shape. */
  items(s, ctx) {
    const il = this.il;
    const out = [];
    switch (s.k) {
      case 'this':
        for (const [n, ch] of ctx.thisMembers || []) {
          const sh = this.resolve(ch, { ...ctx, thisMembers: null });
          out.push({ label: n, kind: 'field', detail: describeShape(this, sh) || 'assigned in this Banan', sort: 0 });
        }
        for (const [n, v] of Object.entries(ctx.thisValues || {})) out.push({ label: n, kind: 'field', detail: describeValue(v), sort: 1 });
        if (ctx.thisProto) out.push(...jsItems(ctx.thisProto, true));
        break;
      case 'js':
        out.push(...jsItems(s.v, false, s.v === this.api ? API_DOCS : null));
        break;
      case 'ns': {
        const m = this.index.namespaceMembers(s.ns);
        for (const n of m.namespaces) out.push({ label: n, kind: 'ns', detail: `namespace ${s.ns}.${n}` });
        for (const e of m.types) if (!e.generic) out.push(this.typeItem(e));
        break;
      }
      case 'static': {
        const ms = this.members(s.ref, true);
        for (const m of ms.values()) out.push(this.memberItem(m));
        for (const [n, d] of Object.entries(STATIC_HELPERS)) out.push({ label: n, kind: 'helper', detail: d, sort: 9 });
        break;
      }
      case 'inst': {
        const r = s.ref;
        if (!r) break;
        if (r.prim === 'string') { out.push(...jsItems(String.prototype, true)); out.push({ label: 'length', kind: 'field', detail: 'number' }); break; }
        if (r.prim === 'number') { out.push(...jsItems(Number.prototype, true)); break; }
        if (r.prim === 'bigint') { out.push(...jsItems(BigInt.prototype, true)); break; }
        if (r.prim || r.gp) break;
        if (r.array) {
          out.push({ label: 'length', kind: 'field', detail: `${r.js ? 'number' : 'int'} — ${this.refName(r)}` });
          if (!r.js) out.push({ label: '$toArray', kind: 'helper', detail: `${this.refName(r.array)}[] as a JS array`, insert: '$toArray()' });
          for (const n of ['map', 'filter', 'find', 'forEach', 'some', 'every', 'indexOf', 'includes', 'slice', 'join', 'reduce']) out.push({ label: n, kind: 'method', detail: 'Array method (on a copy)', sort: 5 });
          break;
        }
        const d = il.md.typeDef(r.td);
        if (d.isEnum) { out.push(...jsItems(Number.prototype, true)); break; }
        if (d.isValueType) {
          for (const m of this.members(r, false).values()) out.push(this.memberItem(m, true));
          break;
        }
        for (const m of this.members(r, false).values()) out.push(this.memberItem(m));
        for (const [n, x] of Object.entries(INSTANCE_HELPERS)) out.push({ label: n, kind: 'helper', detail: x, sort: 9 });
        break;
      }
      case 'method':
        out.push({ label: 'of', kind: 'helper', detail: 'of(...typeNames) — pick generic arguments', insert: "of('", sort: 0 });
        break;
      default:
        break;
    }
    return out;
  }

  typeItem(e) {
    const d = this.il.md.typeDef(e.td);
    const what = d.isEnum ? 'enum' : d.isInterface ? 'interface' : d.isValueType ? 'struct' : 'class';
    return { label: e.short, kind: d.isEnum ? 'enumtype' : d.isValueType ? 'struct' : d.isInterface ? 'interface' : 'class', detail: `${what} ${e.full}`, rank: e.rank };
  }

  memberItem(m, struct = false) {
    const pre = m.isStatic && m.kind !== 'enum' && m.kind !== 'const' && m.kind !== 'type' ? 'static ' : '';
    switch (m.kind) {
      case 'field': return { label: m.name, kind: 'field', detail: `${pre}${this.refName(m.ref)}${m.readonly ? ' (readonly)' : ''}`, sort: struct ? 0 : 2, dim: !m.pub && !struct, inherited: m.inherited };
      case 'const': return { label: m.name, kind: 'const', detail: `const ${this.refName(m.ref)}`, sort: 1, dim: !m.pub };
      case 'enum': return { label: m.name, kind: 'enum', detail: `${this.refName(m.ref)} = ${this.enumValue(m)}`, sort: 0 };
      case 'prop': return { label: m.name, kind: 'prop', detail: `${pre}${this.refName(m.ref)} { ${m.get ? 'get; ' : ''}${m.set ? 'set; ' : ''}}`, sort: 1, dim: !m.pub, inherited: m.inherited };
      case 'type': {
        const d = this.il.md.typeDef(m.td);
        const kind = d.isEnum ? 'enumtype' : d.isValueType ? 'struct' : d.isInterface ? 'interface' : 'class';
        return { label: m.name, kind, detail: `nested ${d.isInterface ? 'interface ' : ''}${this.il.tdFullName(m.td)}`, sort: 4 };
      }
      case 'method': {
        const sigs = m.metas.map((x, i) => this.sig(x, m.levels[i]));
        const noArgs = m.metas.every((x) => x.parameterCount === 0);
        const generic = sigs.some((x) => x.generic) && m.metas.every((x) => x.genericContainerIndex !== -1);
        const more = sigs.length > 1 ? `  (+${sigs.length - 1} overload${sigs.length > 2 ? 's' : ''})` : '';
        const op = m.name.startsWith('op_');
        return {
          label: m.name, kind: 'method', detail: `${pre}${sigs[0].ret} ${sigs[0].text}${more}`, sort: op ? 8 : 3, dim: !m.pub || op, inherited: m.inherited,
          insert: generic ? `${m.name}.of('` : noArgs ? `${m.name}()` : `${m.name}(`, close: generic ? "')" : noArgs ? '' : ')',
        };
      }
      default: return { label: m.name, kind: m.kind, detail: '' };
    }
  }

  enumValue(m) {
    try {
      const f = this.il.fieldsOf(m.owner.td).find((x) => x.name === m.name);
      const v = f ? this.il.constValue(f.index) : '?';
      return typeof v === 'bigint' ? `${v}` : v;
    } catch (_) { return '?'; }
  }

  /** Overload signatures for a method shape (signature help). */
  signatures(s) {
    if (!s || s.k !== 'method') return null;
    const m = s.mem;
    return m.metas.map((x, i) => this.sig(x, m.levels[i], s.margs));
  }

  // ------------------------------------------------------------------------------------ entry point

  /**
   * Completions at `caret` in `text`.
   * ctx: { roots: {name: value}, bare: bool, unityFirst: bool, thisProto?: object, keywords?: bool }
   * Returns { from, to, prefix, items, hint } or null.
   */
  complete(text, caret, ctx = {}, manual = false) {
    const before = text.slice(0, caret);
    const { toks, comment } = tokenize(before);
    if (comment) return null;
    let after = caret;
    while (after < text.length && ID_PART.test(text[after])) after++;
    const last = toks[toks.length - 1];
    const env = { ...ctx, ...this.scan(toks, ctx) };

    // inside a string: type names for Il2Cpp.type('…') and friends
    if (last && last.t === 'str' && last.open) {
      if (last.q === '`') return null;
      return this.completeString(toks, last, caret, text, env);
    }

    let prefix = '';
    let end = toks.length;
    if (last && last.t === 'id' && last.e === caret) { prefix = last.v; end--; }
    else if (last && (last.t === 'num' || (last.t === 'str' && !last.open)) && last.e === caret) return null;
    const dot = toks[end - 1];
    const hint = this.hintAt(toks, env);

    if (dot && dot.t === 'p' && dot.v === '.') {
      const chain = chainBefore(toks, end - 1);
      const s = chain ? this.resolve(chain, env) : null;
      if (!s) return hint ? { from: caret, to: caret, prefix: '', items: [], hint } : null;
      const items = this.items(s, env);
      if (!items.length && !hint) return null;
      return { from: caret - prefix.length, to: after, prefix, items: rank(items, prefix), hint, owner: describeShape(this, s) };
    }

    if (!manual && prefix.length < (ctx.minPrefix || 1)) return hint ? { from: caret, to: caret, prefix: '', items: [], hint } : null;
    if (dot && dot.t === 'id' && /^(const|let|var|function|class)$/.test(dot.v)) return null; // naming something
    const items = this.scopeItems(env, prefix);
    return { from: caret - prefix.length, to: after, prefix, items: rank(items, prefix), hint };
  }

  /** Declarations in the text before the caret: `const cam = Camera.main` and `this.cam = …`. */
  scan(toks, ctx) {
    const locals = new Map(ctx.locals || []);
    const thisMembers = ctx.thisProto ? new Map() : null;
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      let name = null;
      let start = -1;
      if (t.t === 'id' && (t.v === 'const' || t.v === 'let' || t.v === 'var') && toks[i + 1] && toks[i + 1].t === 'id' && toks[i + 2] && toks[i + 2].v === '=') { name = toks[i + 1].v; start = i + 3; }
      else if (thisMembers && t.t === 'id' && t.v === 'this' && toks[i + 1] && toks[i + 1].v === '.' && toks[i + 2] && toks[i + 2].t === 'id' && toks[i + 3] && toks[i + 3].v === '=' && toks[i + 4] && toks[i + 4].v !== '=') { name = `this.${toks[i + 2].v}`; start = i + 4; }
      else if (t.t === 'id' && t.v === 'for' && toks[i + 1] && toks[i + 1].v === '(') {
        // for (const go of <chain>)
        const k = toks[i + 2];
        if (k && /^(const|let|var)$/.test(k.v) && toks[i + 3] && toks[i + 3].t === 'id' && toks[i + 4] && toks[i + 4].v === 'of') {
          let depth = 0;
          let j = i + 5;
          for (; j < toks.length; j++) {
            const x = toks[j];
            if (x.t === 'p' && CLOSE[x.v]) depth++;
            else if (x.t === 'p' && OPEN[x.v]) { if (depth === 0) break; depth--; }
          }
          const ch = chainBefore(toks.slice(i + 5, j), j - i - 5);
          if (ch) locals.set(toks[i + 3].v, [...ch, { index: [], iter: true }]);
        }
        continue;
      }
      if (!name) continue;
      // the initializer runs to the first top-level ; or , or a new statement
      let depth = 0;
      let j = start;
      for (; j < toks.length; j++) {
        const x = toks[j];
        if (x.t === 'p' && CLOSE[x.v]) depth++;
        else if (x.t === 'p' && OPEN[x.v]) { if (depth === 0) break; depth--; }
        else if (depth === 0 && x.t === 'p' && (x.v === ';' || x.v === ',')) break;
        else if (depth === 0 && x.t === 'nl') {
          const nx = toks.slice(j + 1).find((y) => y.t !== 'nl');
          if (!nx || !(nx.t === 'p' && nx.v === '.')) break;
        }
      }
      const sub = toks.slice(start, j).filter((x) => x.t !== 'nl');
      const ch = sub.length ? chainBefore(sub, sub.length) : null;
      if (!ch) continue;
      // only if the chain covers the whole initializer (a + b isn't a chain)
      if (thisMembers && name.startsWith('this.')) thisMembers.set(name.slice(5), ch);
      else locals.set(name, ch);
    }
    return { locals, thisMembers };
  }

  scopeItems(env, prefix) {
    const out = [];
    for (const n of env.locals.keys()) out.push({ label: n, kind: 'var', detail: 'local', sort: 0 });
    for (const [n, v] of Object.entries(env.roots || {})) out.push({ label: n, kind: typeof v === 'function' ? 'fn' : 'var', detail: (env.rootDocs && env.rootDocs[n]) || describeValue(v), sort: 0 });
    if (env.thisProto) out.push({ label: 'this', kind: 'kw', detail: 'this Banan', sort: 1 });
    if (env.bare && prefix) {
      const ix = this.index.build();
      const p = prefix.toLowerCase();
      for (const [n, td] of ix.byShort) {
        if (!n.toLowerCase().startsWith(p) && !(p.length > 2 && n.toLowerCase().includes(p))) continue;
        if (!this.index.bareKind(n, env.unityFirst)) continue;
        const e = ix.byTd.get(td);
        if (e) out.push({ ...this.typeItem(e), sort: 2 });
      }
      for (const n of ix.roots) if (n.toLowerCase().startsWith(p) && this.index.bareKind(n, env.unityFirst) === 'ns') out.push({ label: n, kind: 'ns', detail: `namespace ${n}`, sort: 2 });
    }
    for (const k of KEYWORDS) out.push({ label: k, kind: 'kw', detail: 'keyword', sort: 8 });
    for (const g of GLOBALS) out.push({ label: g, kind: 'var', detail: 'global', sort: 7 });
    return out;
  }

  completeString(toks, str, caret, text, env) {
    const k = toks.length - 1;
    const open = toks[k - 1];
    if (!open || open.t !== 'p' || (open.v !== '(' && open.v !== ',')) return null;
    // find the call this string is an argument of
    let j = k - 1;
    let depth = 0;
    for (; j >= 0; j--) {
      const x = toks[j];
      if (x.t !== 'p') continue;
      if (x.v === ')' || x.v === ']') depth++;
      else if (x.v === '(' || x.v === '[') { if (depth === 0) break; depth--; }
    }
    if (j < 1 || toks[j].v !== '(') return null;
    const callee = toks[j - 1];
    if (!callee || callee.t !== 'id' || !TYPE_ARG_FNS.has(callee.v)) return null;
    const v = str.v;
    let quoteEnd = caret;
    while (quoteEnd < text.length && text[quoteEnd] !== str.q && text[quoteEnd] !== '\n') quoteEnd++;
    // 'Type::Member' for Il2Cpp.method / il.findMethod style specs
    const cc = v.indexOf('::');
    if (cc >= 0) {
      const r = this.parseTypeName(v.slice(0, cc));
      if (!r || r.td === undefined) return null;
      const pre = v.slice(cc + 2);
      const items = [];
      for (const st of [false, true]) {
        for (const m of this.members(r, st).values()) {
          if (m.kind === 'type') continue;
          items.push(this.memberItem(m));
          if (m.kind === 'prop') { if (m.get) items.push({ label: `get_${m.name}`, kind: 'method', detail: `getter of ${m.name}` }); if (m.set) items.push({ label: `set_${m.name}`, kind: 'method', detail: `setter of ${m.name}` }); }
        }
      }
      for (const it of items) { delete it.insert; it.close = str.q; it.caretAfterClose = true; }
      return { from: caret - pre.length, to: quoteEnd, prefix: pre, items: rank(items, pre), string: true, owner: `${this.refName(r)} members` };
    }
    // generic arguments: complete the innermost name
    const m = /[^<>,\s]*$/.exec(v);
    const pre = m ? m[0] : '';
    const items = this.typeNameItems(pre);
    // replacing the whole string: close it too and put the caret after the quote
    const whole = v.length === pre.length;
    if (whole) for (const it of items) if (!it.insert.endsWith('<')) { it.close = str.q; it.caretAfterClose = true; }
    return { from: caret - pre.length, to: whole ? quoteEnd : caret, prefix: pre, items, string: true };
  }

  /** Full type names matching what was typed (by short name or full-name prefix). */
  typeNameItems(pre) {
    const ix = this.index.build();
    const p = pre.toLowerCase();
    const out = [];
    for (const e of ix.types) {
      const full = e.full;
      const fl = full.toLowerCase();
      const sl = e.short.toLowerCase();
      let score;
      if (!p) score = 3;
      else if (full.startsWith(pre)) score = 0;
      else if (sl.startsWith(p)) score = sl === p ? 0 : 1;
      else if (fl.startsWith(p)) score = 1;
      else if (p.length >= 2 && sl.includes(p)) score = 2;
      else if (p.length >= 3 && fl.includes(p)) score = 3;
      else continue;
      const it = this.typeItem(e);
      it.label = e.generic ? `${full}<${',' .repeat(Math.max(0, e.arity - 1))}>` : full;
      it.insert = e.generic ? `${full}<` : full;
      it.close = '';
      it.score = score;
      out.push(it);
    }
    out.sort((a, b) => a.score - b.score || a.rank - b.rank || a.label.length - b.label.length || (a.label < b.label ? -1 : 1));
    return out.slice(0, 300);
  }

  /** Signature help: the innermost open call before the caret, if it's a method we know. */
  hintAt(toks, env) {
    let depth = 0;
    let commas = 0;
    for (let j = toks.length - 1; j >= 0; j--) {
      const x = toks[j];
      if (x.t !== 'p') continue;
      if (x.v === ')' || x.v === ']' || x.v === '}') depth++;
      else if (x.v === '[' || x.v === '{') { if (depth === 0) return null; depth--; }
      else if (x.v === ',' && depth === 0) commas++;
      else if (x.v === '(') {
        if (depth > 0) { depth--; continue; }
        const ch = chainBefore(toks, j);
        if (!ch || (ch.length < 2 && !ch[0].isNew)) return null;
        const s = this.resolve(ch, env);
        let sigs = this.signatures(s);
        if (!sigs && s && s.k === 'static' && ch[0].isNew) sigs = this.ctorSignatures(s.ref);
        if (!sigs) return null;
        const fit = sigs.filter((g) => g.params.length > commas);
        return { sigs: fit.length ? fit : sigs, active: commas };
      }
    }
    return null;
  }

  ctorSignatures(r) {
    const ms = this.il.methodsOf(r.td).filter((m) => m.name === '.ctor');
    return ms.map((m) => { const g = this.sig(m, r); g.text = g.text.replace('.ctor', this.refName(r)); g.ret = 'new'; return g; });
  }
}

// ------------------------------------------------------------------------------------ helpers

const TYPE_ARG_FNS = new Set(['type', 'find', 'findAll', 'new', 'typeOf', '$is', '$component', 'of', 'objects', 'findType', 'findMethod', 'method', 'resolveTypeName', 'GetComponent', 'AddComponent', 'FindObjectOfType', 'FindObjectsOfType']);

const API_FNS = new Set(['type', 'find', 'findAll', 'new', 'gameObject', 'gameObjects', 'typeOf', 'string']);

const KEYWORDS = ['const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'of', 'while', 'new', 'typeof', 'instanceof', 'true', 'false', 'null', 'undefined', 'async', 'await', 'class', 'extends', 'this', 'try', 'catch', 'throw'];
const GLOBALS = ['Math', 'JSON', 'console', 'Object', 'Array', 'Number', 'String', 'Promise', 'Date', 'setTimeout', 'setInterval', 'parseInt', 'parseFloat'];

const STATIC_HELPERS = {
  $new: '$new(...args) — construct an instance',
  $find: '$find() — first live instance (UnityEngine.Object types)',
  $findAll: '$findAll(limit?) — live instances',
  $type: 'System.Type object',
  $name: 'full type name',
  $method: '$method(name, sig?) — method descriptor (for patches)',
  $td: 'type definition index',
  $klass: 'Il2CppClass* (0 until set up)',
};

const INSTANCE_HELPERS = {
  $ptr: 'object address',
  $type: 'runtime class name',
  $is: "$is('Type') — instanceof",
  $component: "$component('Type') — first component of that type on this GameObject",
  $alive: 'false once a UnityEngine.Object is destroyed',
  $static: 'static side of the runtime type',
  $get: '$get(name) — member by name',
  $set: '$set(name, value)',
  $call: '$call(name, ...args)',
  $method: '$method(name, sig?) — method descriptor',
  $toArray: 'elements of a collection (List, array, …) as a JS array',
};

export const API_DOCS = {
  type: "type(name) — static side of a type: Il2Cpp.type('UnityEngine.Time').timeScale",
  find: "find(name) — first live object of a type: Il2Cpp.find('UnityEngine.Camera')",
  findAll: 'findAll(name, limit?) — every live object of a type',
  new: "new(name, ...args) — construct: Il2Cpp.new('System.Collections.Generic.List<int>')",
  gameObject: 'gameObject(name) — first GameObject with that name',
  gameObjects: 'gameObjects(name) — every GameObject with that name',
  wrap: 'wrap(ptr) — proxy for an object address',
  ptr: 'ptr(proxy) — address of a proxy',
  ref: 'ref(value) — box for out/ref parameters',
  string: 'string(x) — JS string ⇄ System.String',
  typeOf: 'typeOf(name) — System.Type object',
  isProxy: 'isProxy(x) — true for Il2Cpp proxies',
  method: "method('Type::Name', sig?) — method descriptor (for patches)",
  il: 'the low-level IL2CPP bridge',
  unity: 'UnityEngine helpers',
};

function findDesc(o, name) {
  for (let p = o, g = 0; p && g < 32; p = Object.getPrototypeOf(p), g++) {
    const d = Object.getOwnPropertyDescriptor(p, name);
    if (d) return d;
  }
  return null;
}

function protoMember(proto, name, ret) {
  const d = findDesc(proto, name);
  if (!d) return null;
  if (typeof d.value === 'function') return { k: 'jsfn', v: d.value, owner: proto, name, ret };
  return null;
}

function fnSig(f) {
  try {
    const s = Function.prototype.toString.call(f).slice(0, 300);
    const m = /^(?:async\s*)?(?:function\s*\*?\s*[\w$]*\s*)?\(([^)]*)\)/.exec(s) || /^(?:async\s*)?([\w$]+)\s*=>/.exec(s) || /^(?:async\s*)?[\w$]+\s*\(([^)]*)\)/.exec(s);
    if (m) return `(${m[1].replace(/\s+/g, ' ').trim()})`;
  } catch (_) { /* native */ }
  return `(${f.length ? Array.from({ length: f.length }, (_, i) => `a${i}`).join(', ') : ''})`;
}

function describeValue(v) {
  if (v === null) return 'null';
  if (typeof v === 'function') return `function${fnSig(v)}`;
  if (Array.isArray(v)) return `array[${v.length}]`;
  if (typeof v === 'object') return v.constructor && v.constructor.name && v.constructor.name !== 'Object' ? v.constructor.name : 'object';
  return typeof v;
}

/** Items for the properties of a live JS value (own and inherited, without calling getters). */
function jsItems(v, protoOnly, docs = null) {
  const out = [];
  if (v === null || v === undefined) return out;
  const seen = new Set();
  const o = Object(v);
  const stop = new Set([Object.prototype, Function.prototype]);
  let depth = 0;
  for (let p = o; p && !stop.has(p) && depth < 16; p = Object.getPrototypeOf(p), depth++) {
    let names;
    try { names = Object.getOwnPropertyNames(p); } catch (_) { break; }
    for (const n of names) {
      if (seen.has(n) || n === 'constructor' || n === '__proto__' || /^\d+$/.test(n)) continue;
      seen.add(n);
      const d = Object.getOwnPropertyDescriptor(p, n);
      if (!d) continue;
      const isFn = 'value' in d && typeof d.value === 'function';
      const detail = docs && docs[n] ? docs[n] : isFn ? `${n}${fnSig(d.value)}` : 'value' in d ? describeValue(d.value) : 'getter';
      out.push({ label: n, kind: isFn ? 'fn' : 'var', detail, sort: n.startsWith('_') ? 6 : depth ? 2 : 1, insert: isFn ? `${n}(` : undefined, close: isFn ? ')' : undefined });
    }
  }
  return out;
}

function describeShape(c, s) {
  if (!s) return '';
  switch (s.k) {
    case 'static': return `static ${c.refName(s.ref)}`;
    case 'inst': return c.refName(s.ref);
    case 'ns': return `namespace ${s.ns}`;
    case 'js': return describeValue(s.v);
    default: return '';
  }
}

const KIND_ORDER = { var: 0, field: 1, prop: 1, enum: 1, const: 1, method: 2, fn: 2, helper: 4 };

/** Filter by prefix and order: exact-case prefix, prefix, word-start, substring; then kind and rank. */
export function rank(items, prefix) {
  const p = prefix.toLowerCase();
  const out = [];
  const seen = new Set();
  for (const it of items) {
    if (seen.has(it.label)) continue;
    const l = it.label.toLowerCase();
    let score;
    if (!p) score = 0;
    else if (it.label.startsWith(prefix)) score = 0;
    else if (l.startsWith(p)) score = 1;
    else if (humps(it.label, prefix)) score = 2;
    else if (p.length >= 2 && l.includes(p)) score = 3;
    else continue;
    if (p && it.label === prefix && items.length > 1) score = -1;
    seen.add(it.label);
    out.push({ ...it, score });
  }
  out.sort((a, b) => a.score - b.score || (a.dim ? 1 : 0) - (b.dim ? 1 : 0) || (a.sort ?? 5) - (b.sort ?? 5)
    || (a.rank ?? 0) - (b.rank ?? 0) || (KIND_ORDER[a.kind] ?? 3) - (KIND_ORDER[b.kind] ?? 3) || a.label.localeCompare(b.label));
  return out.slice(0, 400);
}

/** gO → gameObject, lP → localPosition */
function humps(label, prefix) {
  if (prefix.length < 2) return false;
  const caps = label[0] + label.slice(1).replace(/[^A-Z0-9_]/g, '');
  return caps.toLowerCase().startsWith(prefix.toLowerCase());
}
