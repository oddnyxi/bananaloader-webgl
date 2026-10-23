// Il2Cpp interop for Banans: managed objects and types as JS proxies, so mods read like C#.
//
//   const Time = Il2Cpp.type('UnityEngine.Time');
//   Time.timeScale = 0.5;                       // static property setter
//   const cam = Il2Cpp.find('UnityEngine.Camera');
//   cam.fieldOfView = 90;                       // instance property
//   cam.transform.position = { x: 0, y: 10, z: 0 };
//   const p = Il2Cpp.find('PlayerController');
//   p.health = 100;                             // instance field
//   p.Respawn();                                // instance method (overloads picked by arguments)

import { T, FIELD, METHOD } from '../il2cpp/types.js';

const PTR = Symbol('il2cpp.ptr');
const KIND = Symbol('il2cpp.kind');

export class Ref {
  constructor(value) { this.value = value; }
}

const REF = new Set([T.STRING, T.CLASS, T.OBJECT, T.SZARRAY, T.ARRAY]);

export class Interop {
  constructor(il, unity, fmt) {
    this.il = il;
    this.unity = unity;
    this.fmt = fmt;
    this._members = new Map();
    this._kfields = new Map();
    this._types = new Map();
  }

  // ------------------------------------------------------------------ public API (exposed as Il2Cpp)

  api() {
    const self = this;
    const api = {
      /** Static side of a type: Il2Cpp.type('UnityEngine.Time').timeScale */
      type: (name) => self.typeProxy(name),
      /** Wrap an object address. */
      wrap: (ptr) => self.wrap(ptr),
      /** Address of a proxy (or the number itself). */
      ptr: (x) => self.unwrap(x),
      /** First live object of a type (UnityEngine.Object types use FindObjectsOfType, others scan the heap). */
      find: (name) => self.findAll(name, 1)[0] || null,
      findAll: (name, limit) => self.findAll(name, limit),
      /** First GameObject whose name equals (or matches the RegExp). */
      gameObject: (name) => self.gameObjects(name)[0] || null,
      gameObjects: (name) => self.gameObjects(name),
      /** new T(...args) */
      new: (name, ...args) => self.construct(name, args),
      /** Box for ref / out parameters: const v = Il2Cpp.ref(0); dict.TryGetValue(key, v); v.value */
      ref: (v) => new Ref(v),
      /** Managed string from a JS string, or a JS string from a managed one. */
      string: (x) => (typeof x === 'string' ? self.wrap(self.il.newString(x)) : self.il.readString(self.unwrap(x))),
      isProxy: (x) => !!(x && x[PTR] !== undefined),
      typeOf: (x) => (x && x[PTR] ? self.il.klassName(self.il.klassOf(x[PTR])) : typeof x),
      /** Raw bridges, for anything the proxies don't cover. */
      il: self.il,
      unity: self.unity,
    };
    return api;
  }

  unwrap(v) {
    if (v && typeof v === 'object' && v[PTR] !== undefined) return v[PTR];
    return v;
  }

  // ------------------------------------------------------------------ members

  _resolveTd(name) {
    if (typeof name === 'number') return name;
    const td = this.il.findType(name);
    if (td < 0) throw new Error(`Il2Cpp: type ${name} not found`);
    return td;
  }

  /** Metadata members of td and its bases: { fields, props, methods } (derived first). */
  members(td) {
    let m = this._members.get(td);
    if (m) return m;
    const il = this.il;
    m = { fields: new Map(), props: new Map(), methods: new Map() };
    for (const t of il.hierarchy(td)) {
      for (const f of il.fieldsOf(t)) if (!m.fields.has(f.name)) m.fields.set(f.name, { ...f, td: t });
      for (const p of il.propertiesOf(t)) {
        if (p.getter && p.getter.parameterCount) continue;
        const cur = m.props.get(p.name);
        if (!cur) m.props.set(p.name, { getter: p.getter, setter: p.setter, td: t });
        else { cur.getter ||= p.getter; cur.setter ||= p.setter; }
      }
      for (const mm of il.methodsOf(t)) {
        if (!m.methods.has(mm.name)) m.methods.set(mm.name, []);
        m.methods.get(mm.name).push(mm);
      }
    }
    this._members.set(td, m);
    return m;
  }

  /** Runtime instance fields of a class by name (handles generic instances). */
  klassFields(k) {
    let f = this._kfields.get(k);
    if (f) return f;
    f = new Map();
    for (const x of this.il.allFields(k)) if (!x.isStatic && !x.isConst) f.set(x.name, x);
    // auto-properties: <Name>k__BackingField is reachable as Name too
    for (const [n, x] of [...f]) { const mm = /^<(.+)>k__BackingField$/.exec(n); if (mm && !f.has(mm[1])) f.set(mm[1], x); }
    this._kfields.set(k, f);
    return f;
  }

  // ------------------------------------------------------------------ values

  isRefType(p) {
    const t = this.il.typeInfo(p);
    if (REF.has(t.kind)) return true;
    if (t.kind === T.GENERICINST) { const b = this.il.tdOfType(p); return !(b >= 0 && this.il.md.typeDef(b).isValueType); }
    return false;
  }

  /** Read a value of type p at addr as a JS value (objects become proxies, structs plain objects). */
  read(addr, p, depth = 0) {
    const il = this.il;
    const t = il.typeInfo(p);
    if (t.kind === T.STRING) return il.readString(il.mem.u32At(addr));
    if (this.isRefType(p)) return this.wrap(il.mem.u32At(addr));
    if (t.kind === T.VALUETYPE || t.kind === T.GENERICINST) {
      if (t.kind === T.VALUETYPE) {
        const td = il._tdFromData(t.data);
        if (il.md.typeDef(td).isEnum) return il.readValue(addr, p);
      }
      const fs = il.fieldsOfStructType(p);
      if (!fs || depth > 6) return null;
      const o = {};
      for (const f of fs) o[f.name] = this.read(addr + f.offset, f.type, depth + 1);
      return o;
    }
    return il.readValue(addr, p);
  }

  write(addr, p, v) {
    const il = this.il;
    v = this.unwrap(v);
    const t = il.typeInfo(p);
    if ((t.kind === T.VALUETYPE || t.kind === T.GENERICINST) && v && typeof v === 'object') {
      const fs = il.fieldsOfStructType(p);
      if (fs) { for (const f of fs) if (v[f.name] !== undefined) this.write(addr + f.offset, f.type, v[f.name]); return; }
    }
    if (v === null || v === undefined) { if (this.isRefType(p)) { il.mem.setU32(addr, 0); return; } }
    if (t.kind === T.OBJECT && typeof v === 'string') { il.mem.setU32(addr, il.newString(v)); return; }
    il.writeValue(addr, p, v);
  }

  /** Convert a return value from invokeRaw into JS. */
  _ret(r, p) {
    const il = this.il;
    if (r.ret.wasm === 'void') return undefined;
    if (r.ret.wasm === 'ptr') {
      try { return this.read(r.retAddr, p); } finally { il.free(r.retAddr); }
    }
    if (this.isRefType(p)) {
      const t = il.typeInfo(p);
      const ptr = r.value >>> 0;
      if (t.kind === T.STRING) return il.readString(ptr);
      return this.wrap(ptr);
    }
    return il.unmarshalReturn(r);
  }

  /** Call a method record with JS arguments (proxies, strings, numbers, structs, Refs). */
  invoke(m, self, args) {
    const il = this.il;
    const ps = il.params(m);
    const temps = [];
    const refs = [];
    try {
      const raw = ps.map((p, i) => {
        let v = args[i];
        const byref = il.typeInfo(p.type).byref;
        if (v instanceof Ref) { if (byref) refs.push([i, v]); v = v.value; }
        v = this.unwrap(v);
        if (!byref && il.typeInfo(p.type).kind === T.OBJECT && typeof v === 'string') return il.newString(v);
        if (!byref && this.isRefType(p.type) && (v === null || v === undefined)) return 0;
        return il.marshal(p.type, v, temps);
      });
      const r = il.invokeRaw(m, self, raw);
      const out = this._ret(r, il.typePtr(m.returnType));
      for (const [i, ref] of refs) ref.value = this.read(raw[i], ps[i].type);
      return out;
    } finally {
      for (const t of temps) il.free(t);
    }
  }

  /** Pick the overload that best fits the JS arguments. */
  overload(list, args, isStatic) {
    const il = this.il;
    let best = null;
    let bestScore = -Infinity;
    for (const m of list) {
      if (((m.flags & METHOD.STATIC) !== 0) !== isStatic) continue;
      if (m.parameterCount !== args.length) continue;
      if (il.whyNotCallable(m)) continue;
      let score = 0;
      const ps = il.params(m);
      for (let i = 0; i < ps.length && score > -Infinity; i++) score += this._fit(ps[i].type, args[i]);
      if (score > bestScore) { best = m; bestScore = score; }
    }
    if (!best || bestScore === -Infinity) return null;
    return best;
  }

  _fit(p, v) {
    const il = this.il;
    const t = il.typeInfo(p);
    if (v instanceof Ref) return t.byref ? 3 : -Infinity;
    const k = t.kind;
    const isRef = this.isRefType(p);
    if (v === null || v === undefined) return isRef ? 1 : -Infinity;
    if (v && typeof v === 'object' && v[PTR] !== undefined) {
      if (!isRef) return -Infinity;
      const ptd = il.tdOfType(p);
      if (ptd >= 0 && v[PTR] && il.isInstanceOf(v[PTR], ptd)) return 4;
      return k === T.OBJECT ? 2 : 1;
    }
    let isEnum = false;
    if (k === T.VALUETYPE) isEnum = il.md.typeDef(il._tdFromData(t.data)).isEnum;
    switch (typeof v) {
      case 'string': return k === T.STRING ? 4 : k === T.OBJECT ? 1 : (k === T.CHAR && v.length === 1) ? 2 : isEnum ? 1 : -Infinity;
      case 'boolean': return k === T.BOOLEAN ? 4 : -Infinity;
      case 'bigint': return k === T.I8 || k === T.U8 ? 4 : -Infinity;
      case 'number':
        if (k === T.R4 || k === T.R8) return 3;
        if (isEnum) return 2;
        if ((k >= T.I1 && k <= T.U8) || k === T.I || k === T.U || k === T.CHAR) return Number.isInteger(v) ? 3 : 1;
        if (k === T.BOOLEAN) return 0;
        return -Infinity;
      case 'object':
        if (k === T.VALUETYPE && !isEnum) {
          const fs = il.fieldsOfStructType(p) || [];
          return 2 + fs.filter((f) => f.name in v).length / Math.max(1, fs.length);
        }
        return -Infinity;
      default: return -Infinity;
    }
  }

  // ------------------------------------------------------------------ static side

  staticAddr(td, f) {
    const il = this.il;
    let k = il.klassOfTd(td);
    let base = k ? il.staticFieldsBase(k) : 0;
    if (!base) { il.ensureClass(td, true); k = il.klassOfTd(td); base = k ? il.staticFieldsBase(k) : 0; }
    if (!base) throw new Error(`Il2Cpp: static fields of ${il.tdFullName(td)} are not initialized`);
    const off = il.metaFieldOffset(f.td, f.local);
    return base + off;
  }

  typeProxy(name) {
    const td = this._resolveTd(name);
    if (this._types.has(td)) return this._types.get(td);
    const self = this;
    const il = this.il;
    const fullName = il.tdFullName(td);
    const target = function Il2CppType() {};
    const proxy = new Proxy(target, {
      get(_, key) {
        if (key === PTR) return 0;
        if (key === KIND) return 'type';
        if (typeof key === 'symbol') return undefined;
        switch (key) {
          case '$td': return td;
          case '$name': return fullName;
          case '$type': return self.wrap(il.typeObjectOfTd(td));
          case '$new': return (...a) => self.construct(td, a);
          case '$find': return () => self.findAll(td, 1)[0] || null;
          case '$findAll': return (limit) => self.findAll(td, limit);
          case '$method': return (n, sig) => il.findMethod(td, n, sig);
          case 'toString': return () => `[Il2Cpp type ${fullName}]`;
          case 'then': return undefined;
          default: break;
        }
        const m = self.members(td);
        const f = m.fields.get(key);
        if (f && (f.attrs & FIELD.LITERAL)) return il.constValue(f.index);
        if (f && (f.attrs & FIELD.STATIC)) return self.read(self.staticAddr(td, f), f.type);
        const p = m.props.get(key);
        if (p && p.getter && (p.getter.flags & METHOD.STATIC)) return self.invoke(p.getter, 0, []);
        const ms = m.methods.get(key);
        if (ms) return (...a) => {
          const mm = self.overload(ms, a, true);
          if (!mm) throw new TypeError(`Il2Cpp: no static ${fullName}.${key} overload takes (${a.map((x) => typeof x).join(', ')})`);
          return self.invoke(mm, 0, a);
        };
        // nested type
        const d = il.md.typeDef(td);
        for (let i = 0; i < d.nestedCount; i++) {
          const n = il.md.nestedType(d.nestedTypesStart + i);
          if (il.md.typeDef(n).name === key) return self.typeProxy(n);
        }
        return undefined;
      },
      set(_, key, v) {
        const m = self.members(td);
        const f = m.fields.get(key);
        if (f && (f.attrs & FIELD.STATIC) && !(f.attrs & FIELD.LITERAL)) { self.write(self.staticAddr(td, f), f.type, v); return true; }
        const p = m.props.get(key);
        if (p && p.setter && (p.setter.flags & METHOD.STATIC)) { self.invoke(p.setter, 0, [v]); return true; }
        throw new TypeError(`Il2Cpp: ${fullName}.${String(key)} is not a writable static member`);
      },
      construct(_, a) { return self.construct(td, a); },
      ownKeys() {
        const m = self.members(td);
        return [...new Set([...[...m.fields].filter(([, f]) => f.attrs & FIELD.STATIC).map(([n]) => n), ...[...m.props].filter(([, p]) => (p.getter || p.setter).flags & METHOD.STATIC).map(([n]) => n), 'prototype'])];
      },
      getOwnPropertyDescriptor(_, key) {
        if (key === 'prototype') return Object.getOwnPropertyDescriptor(target, 'prototype');
        return { configurable: true, enumerable: true, writable: true, value: undefined };
      },
    });
    this._types.set(td, proxy);
    return proxy;
  }

  // ------------------------------------------------------------------ objects

  wrap(ptr) {
    ptr >>>= 0;
    if (!ptr) return null;
    const il = this.il;
    const k = il.klassOf(ptr);
    if (!il.mem.valid(k)) return null;
    const bt = il.typeInfo(k + il.layout.byval);
    if (bt.kind === T.SZARRAY || bt.kind === T.ARRAY) return this._arrayProxy(ptr);
    return this._objectProxy(ptr, k);
  }

  _objectProxy(ptr, k) {
    const self = this;
    const il = this.il;
    const td = il.tdOfKlass(k);
    const isValue = td >= 0 && il.md.typeDef(td).isValueType;
    const thisPtr = isValue ? ptr + 8 : ptr; // methods on boxed structs take the unboxed data
    const target = {};
    return new Proxy(target, {
      get(_, key) {
        if (key === PTR) return ptr;
        if (key === KIND) return 'object';
        if (key === Symbol.toPrimitive) return (hint) => (hint === 'number' ? ptr : self._label(ptr));
        if (key === Symbol.iterator) {
          const el = self.fmt.elements(ptr, 1e6);
          if (!el) return undefined;
          return function* it() { for (const e of el.items) yield self.read(e.addr, e.type); };
        }
        if (typeof key === 'symbol') return undefined;
        switch (key) {
          case '$ptr': return ptr;
          case '$type': return il.klassName(k);
          case '$td': return td;
          case '$klass': return k;
          case '$alive': return !self.unity.isUnityObject(ptr) || self.unity.alive(ptr);
          case '$is': return (name) => { const t = typeof name === 'number' ? name : il.findType(name); return t >= 0 && il.isInstanceOf(ptr, t); };
          case '$as': return () => self.wrap(ptr);
          case '$toArray': return () => { const el = self.fmt.elements(ptr, 1e6); return el ? el.items.map((e) => self.read(e.addr, e.type)) : null; };
          case '$static': return self.typeProxy(td);
          case '$get': return (name) => self._getMember(ptr, thisPtr, k, td, name);
          case '$set': return (name, v) => self._setMember(ptr, thisPtr, k, td, name, v);
          case '$call': return (name, ...a) => self._callMember(thisPtr, td, name, a);
          case '$component': return (name) => self._component(ptr, name);
          case 'toString': return () => self._label(ptr);
          case 'toJSON': return () => ({ $ptr: ptr, $type: il.klassName(k) });
          case 'then': return undefined;
          default: return self._getMember(ptr, thisPtr, k, td, key);
        }
      },
      set(_, key, v) { self._setMember(ptr, thisPtr, k, td, key, v); return true; },
      has(_, key) {
        if (typeof key === 'symbol') return false;
        const m = self.members(td);
        return self.klassFields(k).has(key) || m.props.has(key) || m.methods.has(key);
      },
      ownKeys() {
        const m = self.members(td);
        return [...new Set([...self.klassFields(k).keys(), ...[...m.props].filter(([, p]) => p.getter && !(p.getter.flags & METHOD.STATIC)).map(([n]) => n)])];
      },
      getOwnPropertyDescriptor() { return { configurable: true, enumerable: true, writable: true, value: undefined }; },
    });
  }

  _label(ptr) {
    try { return this.fmt.objectSummary(ptr); } catch (_) { return 'Il2Cpp object'; }
  }

  _getMember(ptr, thisPtr, k, td, key) {
    const il = this.il;
    const f = this.klassFields(k).get(key);
    if (f) return this.read(ptr + f.offset, f.type);
    const m = this.members(td);
    const p = m.props.get(key);
    if (p && p.getter) {
      if (p.getter.flags & METHOD.STATIC) return this.invoke(p.getter, 0, []);
      return this.invoke(this._virtual(td, p.getter), thisPtr, []);
    }
    if (m.methods.has(key)) return (...a) => this._callMember(thisPtr, td, key, a);
    const sf = m.fields.get(key);
    if (sf && (sf.attrs & FIELD.LITERAL)) return il.constValue(sf.index);
    if (sf && (sf.attrs & FIELD.STATIC)) return this.read(this.staticAddr(td, sf), sf.type);
    return undefined;
  }

  _setMember(ptr, thisPtr, k, td, key, v) {
    const f = this.klassFields(k).get(key);
    if (f) { this.write(ptr + f.offset, f.type, v); return; }
    const m = this.members(td);
    const p = m.props.get(key);
    if (p && p.setter) {
      if (p.setter.flags & METHOD.STATIC) this.invoke(p.setter, 0, [v]);
      else this.invoke(this._virtual(td, p.setter), thisPtr, [v]);
      return;
    }
    const sf = m.fields.get(key);
    if (sf && (sf.attrs & FIELD.STATIC) && !(sf.attrs & FIELD.LITERAL)) { this.write(this.staticAddr(td, sf), sf.type, v); return; }
    throw new TypeError(`Il2Cpp: ${this.il.tdFullName(td)}.${String(key)} is not writable`);
  }

  /** Most-derived callable override of m for objects of type td. */
  _virtual(td, m) {
    const il = this.il;
    if (il.methodPointer(m) && !(m.flags & METHOD.VIRTUAL)) return m;
    const ms = this.members(td).methods.get(m.name) || [];
    for (const x of ms) if (x.parameterCount === m.parameterCount && !il.whyNotCallable(x)) return x;
    return m;
  }

  _callMember(thisPtr, td, name, args) {
    const ms = this.members(td).methods.get(name);
    if (!ms) throw new TypeError(`Il2Cpp: ${this.il.tdFullName(td)} has no method ${name}`);
    let m = this.overload(ms, args, false);
    if (m) return this.invoke(m, thisPtr, args);
    m = this.overload(ms, args, true);
    if (m) return this.invoke(m, 0, args);
    throw new TypeError(`Il2Cpp: no ${this.il.tdFullName(td)}.${name} overload takes (${args.map((x) => (x && x[PTR] ? 'object' : typeof x)).join(', ')})`);
  }

  _component(ptr, name) {
    const td = this._resolveTd(name);
    const go = this.il.tdOfKlass(this.il.klassOf(ptr)) === this.unity.td.GameObject ? ptr : this.unity.gameObjectOf(ptr);
    if (!go) return null;
    for (const c of this.unity.components(go)) if (this.il.isInstanceOf(c, td)) return this.wrap(c);
    return null;
  }

  _arrayProxy(ptr) {
    const self = this;
    const il = this.il;
    const info = () => il.arrayInfo(ptr);
    const target = [];
    return new Proxy(target, {
      get(_, key) {
        if (key === PTR) return ptr;
        if (key === KIND) return 'array';
        if (key === '$ptr') return ptr;
        if (key === 'length') return info().length;
        if (key === Symbol.iterator) return function* it() { const a = info(); for (let i = 0; i < a.length; i++) yield self.read(a.data + i * a.elemSize, a.elemType); };
        if (key === '$toArray' || key === 'toArray') return () => { const a = info(); const o = []; for (let i = 0; i < a.length; i++) o.push(self.read(a.data + i * a.elemSize, a.elemType)); return o; };
        if (key === '$type') return il.klassName(il.klassOf(ptr));
        if (key === 'toString') return () => self._label(ptr);
        if (key === 'then') return undefined;
        if (typeof key === 'string' && /^\d+$/.test(key)) {
          const a = info();
          const i = +key;
          if (i >= a.length) return undefined;
          return self.read(a.data + i * a.elemSize, a.elemType);
        }
        if (typeof key === 'string' && typeof Array.prototype[key] === 'function') {
          const arr = this.get(_, '$toArray')();
          return arr[key].bind(arr);
        }
        return undefined;
      },
      set(_, key, v) {
        if (typeof key === 'string' && /^\d+$/.test(key)) {
          const a = info();
          const i = +key;
          if (i >= a.length) throw new RangeError('Il2Cpp array index out of range');
          self.write(a.data + i * a.elemSize, a.elemType, v);
          return true;
        }
        throw new TypeError('Il2Cpp arrays only accept index writes');
      },
    });
  }

  // ------------------------------------------------------------------ finding and creating

  findAll(name, limit = Infinity) {
    const il = this.il;
    const td = this._resolveTd(name);
    let list;
    if (this.unity.td.Object >= 0 && il.isSubclassOf(td, this.unity.td.Object)) list = this.unity.objectsOfType(td).filter((p) => this.unity.alive(p));
    else {
      const k = il.klassOfTd(td);
      list = k ? il.findInstances(k, { limit: Math.min(limit, 5000) }) : [];
    }
    return list.slice(0, limit).map((p) => this.wrap(p));
  }

  gameObjects(name) {
    const h = this.unity.hierarchy();
    const out = [];
    const test = name instanceof RegExp ? (s) => name.test(s) : (s) => s === name;
    const walk = (n) => { if (test(n.name)) out.push(this.wrap(n.go)); n.children.forEach(walk); };
    h.roots.forEach(walk);
    return out;
  }

  construct(name, args) {
    const il = this.il;
    const td = this._resolveTd(name);
    const d = il.md.typeDef(td);
    const t = il.typeObjectOfTd(td);
    let obj = 0;
    for (const [tn, mn] of [['System.Runtime.CompilerServices.RuntimeHelpers', 'GetUninitializedObject'], ['System.Runtime.Serialization.FormatterServices', 'GetUninitializedObject']]) {
      const m = il.findMethod(tn, mn, ['System.Type']);
      if (m && !il.whyNotCallable(m)) { obj = il.call(m, 0, t); break; }
    }
    let ctorDone = false;
    if (!obj) {
      const act = il.findMethod('System.Activator', 'CreateInstance', ['System.Type']);
      if (!act) throw new Error('Il2Cpp.new: no way to allocate objects in this build');
      obj = il.call(act, 0, t);
      ctorDone = !args.length;
    }
    if (!ctorDone) {
      const ctors = this.il.methodsOf(td).filter((m) => m.name === '.ctor');
      const m = this.overload(ctors, args, false);
      if (m) this.invoke(m, d.isValueType ? obj + 8 : obj, args);
      else if (args.length || ctors.length) throw new TypeError(`Il2Cpp.new: no ${il.tdFullName(td)} constructor takes ${args.length} argument(s)`);
    }
    return this.wrap(obj);
  }
}

export { PTR };
