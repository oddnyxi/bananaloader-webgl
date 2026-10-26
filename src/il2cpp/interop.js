// Il2Cpp interop for Banans: managed objects and types as JS proxies, so mods read like C#.
//
//   const Time = Il2Cpp.type('UnityEngine.Time');
//   Time.timeScale = 0.5;                                  // static property
//   const cam = Il2Cpp.find('UnityEngine.Camera');
//   cam.transform.position = { x: 0, y: 10, z: 0 };        // instance property, struct as object
//   cam.gameObject.GetComponent.of('UnityEngine.Camera')(); // generic method
//   const list = Il2Cpp.new('System.Collections.Generic.List<System.Int32>');
//   list.Add(5); list.Count;                               // generic class instance
//
// Members come from the runtime class when it's set up (its MethodInfos carry inflated
// generic types and the context shared generic code needs), else from metadata.

import { T, FIELD, METHOD } from './types.js';
import { TypeIndex } from './typeindex.js';
import { ALIAS, fieldKey } from './runtime.js';

const PTR = Symbol('il2cpp.ptr');

export class Ref {
  constructor(value) { this.value = value; }
}

const REF = new Set([T.STRING, T.CLASS, T.OBJECT, T.SZARRAY, T.ARRAY]);
const PRIM_TYPE = {
  [T.VOID]: 'System.Void', [T.BOOLEAN]: 'System.Boolean', [T.CHAR]: 'System.Char', [T.I1]: 'System.SByte', [T.U1]: 'System.Byte',
  [T.I2]: 'System.Int16', [T.U2]: 'System.UInt16', [T.I4]: 'System.Int32', [T.U4]: 'System.UInt32', [T.I8]: 'System.Int64',
  [T.U8]: 'System.UInt64', [T.R4]: 'System.Single', [T.R8]: 'System.Double', [T.STRING]: 'System.String', [T.I]: 'System.IntPtr',
  [T.U]: 'System.UIntPtr', [T.OBJECT]: 'System.Object', [T.TYPEDBYREF]: 'System.TypedReference',
};

export class Interop {
  constructor(il, unity, fmt) {
    this.il = il;
    this.unity = unity;
    this.fmt = fmt;
    this._members = new Map();
    this._kfields = new Map();
    this._kmethods = new Map();
    this._types = new Map();
    this._index = null;
  }

  /** Name index (bare type names, namespaces, completion). */
  get index() { return (this._index ||= new TypeIndex(this.il)); }

  /** `with` scope for bare type names: Camera.main, UnityEngine.Time.timeScale. */
  typeScope(opts) { return this.index.scope(this, opts); }

  // ------------------------------------------------------------------ public API (exposed as Il2Cpp)

  api() {
    const self = this;
    return {
      /** Static side of a type: Il2Cpp.type('UnityEngine.Time'), Il2Cpp.type('System.Collections.Generic.List<int>') */
      type: (name) => self.typeProxy(name),
      wrap: (ptr) => self.wrap(ptr),
      ptr: (x) => self.unwrap(x),
      find: (name) => self.findAll(name, 1)[0] || null,
      findAll: (name, limit) => self.findAll(name, limit),
      gameObject: (name) => self.gameObjects(name)[0] || null,
      gameObjects: (name) => self.gameObjects(name),
      new: (name, ...args) => self.construct(name, args),
      ref: (v) => new Ref(v),
      string: (x) => {
        if (typeof x === 'string') return self.wrap(self.il.newString(x));
        const p = self.unwrap(x);
        return typeof p === 'number' && self.il.isString(p) ? self.il.readString(p) : null;
      },
      /** System.Type object for a name (for APIs that take a Type). */
      typeOf: (name) => self.wrap(self.il.typeObject(self.il.resolveTypeName(name))),
      isProxy: (x) => !!(x && x[PTR] !== undefined),
      /** A method as a patch target or callable descriptor: Il2Cpp.method('List<int>::Add') */
      method: (spec, sig) => self.resolveMethod(spec, sig),
      il: self.il,
      unity: self.unity,
    };
  }

  unwrap(v) {
    if (v && (typeof v === 'object' || typeof v === 'function') && v[PTR] !== undefined) return v[PTR];
    return v;
  }

  /** A type proxy (Il2Cpp.type(...), a bare Camera)? */
  _isTypeProxy(v) { return typeof v === 'function' && v[PTR] === 0 && v.$td !== undefined; }

  /** The boxed object's value (a struct as { field }, an enum as its number) when v is a proxy of a boxed struct/enum. */
  _boxedValue(v) {
    if (!v || typeof v !== 'object' || v[PTR] === undefined || !v[PTR]) return undefined;
    const il = this.il;
    const ptr = v[PTR];
    const k = il.klassOf(ptr);
    const td = il.tdOfKlass(k);
    if (!(td >= 0 && il.md.typeDef(td).isValueType)) return undefined;
    return this.read(ptr + 8, k + il.layout.byval);
  }

  /** Box a JS number / boolean / BigInt as System.Int32, Double, Boolean or Int64 (for `object` slots). */
  box(v) {
    const il = this.il;
    const name = typeof v === 'boolean' ? 'System.Boolean' : typeof v === 'bigint' ? 'System.Int64'
      : Number.isInteger(v) && v >= -2147483648 && v <= 2147483647 ? 'System.Int32' : 'System.Double';
    const ref = this.typeRef(name);
    const obj = this._allocate(ref);
    if (!obj) throw new TypeError(`Il2Cpp: can't box ${typeof v} values in this build`);
    il.writeValue(obj + 8, ref.p, v);
    return obj;
  }

  /** JS value for a reference-type slot or argument: proxies → pointers, type proxies → System.Type, numbers/bools → boxed, strings → System.String. */
  _toRef(p, v, kind) {
    const il = this.il;
    if (v === null || v === undefined) return 0;
    if (this._isTypeProxy(v)) {
      if (kind !== T.OBJECT && kind !== T.CLASS) throw new TypeError(`Il2Cpp: a type can't go where ${il.typeName(p)} is expected`);
      return il.typeObject(il.resolveTypeName(v.$name));
    }
    if (v && (typeof v === 'object' || typeof v === 'function') && v[PTR] !== undefined) return v[PTR];
    if (typeof v === 'string') {
      if (kind === T.STRING || kind === T.OBJECT) return il.newString(v);
      if (il.typeName(p, true) === 'System.Type') return il.typeObject(il.resolveTypeName(v));
      throw new TypeError(`Il2Cpp: a string can't go where ${il.typeName(p)} is expected`);
    }
    if ((typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') && kind === T.OBJECT) return this.box(v);
    if (typeof v === 'number') return v >>> 0; // a raw object pointer
    throw new TypeError(`Il2Cpp: ${Array.isArray(v) ? 'an array' : typeof v} can't go where ${il.typeName(p)} is expected (pass an Il2Cpp object or null)`);
  }

  // ------------------------------------------------------------------ type references

  /** { td, p (Il2CppType*), k (class, may be 0), name, generic } */
  typeRef(name) {
    const il = this.il;
    if (typeof name === 'number') { const p = il.typePtr(il.md.typeDef(name).byvalTypeIndex); return { td: name, p, k: il.klassOfTd(name), name: il.tdFullName(name) }; }
    if (name && name.$td !== undefined) return this.typeRef(name.$name);
    const p = il.resolveTypeName(String(name));
    const t = il.typeInfo(p);
    const generic = t.kind === T.GENERICINST;
    const k = generic ? il.klassOfType(p) : 0;
    let td = generic ? il.tdOfKlass(k) : il.tdOfType(p);
    // System.Int32, System.String, System.Object…: their types have primitive kinds, so go by name
    if (td < 0 && !generic && PRIM_TYPE[t.kind]) td = il.findType(PRIM_TYPE[t.kind]);
    if (td < 0 && !generic) throw new Error(`Il2Cpp: ${name} is not a class or struct type`);
    return { td, p, k: k || il.klassOfTd(td), name: il.typeName(p, true), generic };
  }

  _klass(ref, init = false) {
    if (!ref.k || (init && !this.il.staticFieldsBase(ref.k) && this._hasStatics(ref))) {
      ref.k = ref.generic ? this.il.klassOfType(ref.p) : this.il.ensureClass(ref.td, init);
      if (ref.generic && init && ref.k && !this.il.staticFieldsBase(ref.k)) {
        // generic instances get their statics when their class constructor runs
        const rc = this.il.findMethod('System.Runtime.CompilerServices.RuntimeHelpers', 'RunClassConstructor', 1);
        if (rc) { try { this.il.call(rc, 0, ref.p); } catch (_) { /* leave them uninitialized */ } }
      }
    }
    return ref.k;
  }

  _hasStatics(ref) { return this.il.fieldsOf(ref.td).some((f) => (f.attrs & FIELD.STATIC) && !(f.attrs & FIELD.LITERAL)); }

  // ------------------------------------------------------------------ members

  /** Metadata members of td and its bases (derived first). */
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

  /** Callable descriptors by name for a runtime class and its bases (derived first). */
  methodsOn(k) {
    let map = this._kmethods.get(k);
    if (map) return map;
    const il = this.il;
    map = new Map();
    for (let c = k, g = 0; c && g < 64; c = il.parentKlass(c), g++) {
      let list = il.runtimeMethods(c);
      if (!list.length) { const td = il.tdOfKlass(c); list = td >= 0 ? il.methodsOf(td).map((m) => il.desc(m)) : []; }
      for (const d of list) {
        if (!map.has(d.name)) map.set(d.name, []);
        map.get(d.name).push(d);
      }
    }
    if (il.runtimeMethods(k).length) this._kmethods.set(k, map); // only cache once the class is set up
    return map;
  }

  /** Runtime instance fields of a class by name (handles generic instances). */
  klassFields(k) {
    let f = this._kfields.get(k);
    if (f) return f;
    f = new Map();
    for (const x of this.il.allFields(k)) if (!x.isStatic && !x.isConst) f.set(x.name, x);
    for (const [n, x] of [...f]) { const mm = /^<(.+)>k__BackingField$/.exec(n); if (mm && !f.has(mm[1])) f.set(mm[1], x); }
    this._kfields.set(k, f);
    return f;
  }

  _staticFieldOn(k, name) {
    for (let c = k, g = 0; c && g < 64; c = this.il.parentKlass(c), g++) {
      const f = this.il.runtimeFields(c).find((x) => (x.name === name || x.name === `<${name}>k__BackingField`) && (x.isStatic || x.isConst));
      if (f) {
        // [ThreadStatic] fields have no slot in the static block (offset -1)
        if (f.isStatic && !f.isConst && f.offset === -1) throw new Error(`Il2Cpp: ${name} is [ThreadStatic], which isn't supported`);
        return f;
      }
    }
    return null;
  }

  /**
   * A property accessor as a callable descriptor, or null when there's no such accessor.
   * An accessor that exists but can't be called (stripped, unsupported struct ABI…) comes back
   * as { uncallable: reason }.
   */
  _accessor(k, td, name, isSetter) {
    const p = this.members(td).props.get(name);
    if (!p) return null;
    const meta = isSetter ? p.setter : p.getter;
    if (!meta) return null;
    const list = (k && this.methodsOn(k).get(meta.name)) || [];
    const d = list.find((x) => x.parameterCount === meta.parameterCount && !this.il.whyNotCallable(x)) || this.il.desc(meta);
    const why = this.il.whyNotCallable(d);
    if (why) return { uncallable: why, isStatic: d.isStatic, name: meta.name };
    return d;
  }

  // ------------------------------------------------------------------ values

  /** Is a value of type p an object pointer? With `deref`, judge a byref type (ref/out) by its pointee. */
  isRefType(p, deref = false) {
    const t = this.il.typeInfo(p);
    if (t.byref && !deref) return false;
    if (REF.has(t.kind)) return true;
    if (t.kind === T.GENERICINST) { const b = this.il.tdOfType(p); return !(b >= 0 && this.il.md.typeDef(b).isValueType); }
    return false;
  }

  /** Read the value of type p stored at addr. A byref type (ref/out) reads its pointee stored at addr. */
  read(addr, p, depth = 0) {
    const il = this.il;
    const t = il.typeInfo(p);
    if (t.kind === T.STRING) return il.readString(il.mem.u32At(addr));
    if (this.isRefType(p, true)) return this.wrap(il.mem.u32At(addr));
    if (t.kind === T.VALUETYPE || t.kind === T.GENERICINST) {
      if (t.kind === T.VALUETYPE && il.md.typeDef(il._tdFromData(t.data)).isEnum) return il.readValue(addr, p);
      const fs = il.fieldsOfStructType(p);
      if (!fs || depth > 6) return null;
      const o = {};
      for (const f of fs) o[fieldKey(f.name)] = this.read(addr + f.offset, f.type, depth + 1);
      return o;
    }
    return il.readValue(addr, p);
  }

  write(addr, p, v) {
    const il = this.il;
    const t = il.typeInfo(p);
    if (this.isRefType(p, true)) { il.mem.setU32(addr, this._toRef(p, v, t.kind)); return; }
    // a boxed struct/enum proxy (Il2Cpp.new('UnityEngine.Vector3', …)) into a struct slot: its value, not its header
    const bv = this._boxedValue(v);
    if (bv !== undefined) v = bv;
    v = this.unwrap(v);
    if ((t.kind === T.VALUETYPE || t.kind === T.GENERICINST) && v && typeof v === 'object') {
      const fs = il.fieldsOfStructType(p);
      if (fs) {
        for (const f of fs) {
          const x = v[fieldKey(f.name)] !== undefined ? v[fieldKey(f.name)] : v[f.name];
          if (x !== undefined) this.write(addr + f.offset, f.type, x);
        }
        return;
      }
    }
    il.writeValue(addr, p, v);
  }

  _ret(r, p) {
    const il = this.il;
    if (r.ret.wasm === 'void') return undefined;
    if (r.ret.wasm === 'ptr') {
      try { return this.read(r.retAddr, p); } finally { il.free(r.retAddr); }
    }
    if (this.isRefType(p)) {
      const ptr = r.value >>> 0;
      return il.typeInfo(p).kind === T.STRING ? il.readString(ptr) : this.wrap(ptr);
    }
    const out = il.unmarshalReturn(r);
    // one-field structs: same property-style names as struct reads (<X>k__BackingField → X)
    if (r.ret.single && out && typeof out === 'object') { const o = {}; for (const [n, x] of Object.entries(out)) o[fieldKey(n)] = x; return o; }
    return out;
  }

  /** Call a method record or descriptor with JS arguments. */
  invoke(m, self, args) {
    const il = this.il;
    const d = il.desc(m);
    const ps = d.params;
    const temps = [];
    const refs = [];
    try {
      const raw = ps.map((p, i) => {
        let v = args[i];
        const byref = il.typeInfo(p.type).byref;
        if (v instanceof Ref) { if (byref) refs.push([i, v]); v = v.value; }
        const pt = il.typeInfo(p.type);
        if (this.isRefType(p.type, true)) {
          if (pt.kind === T.STRING && typeof v === 'string') return il.marshal(p.type, v, temps);
          v = this._toRef(p.type, v, pt.kind);
          return byref ? il.marshal(p.type, v, temps) : v;
        }
        const bv = this._boxedValue(v);
        if (bv !== undefined) v = bv;
        v = this.unwrap(v);
        return il.marshal(p.type, v, temps);
      });
      const r = il.invokeRaw(d, self, raw);
      const out = this._ret(r, d.retType);
      for (const [i, ref] of refs) ref.value = this.read(raw[i], ps[i].type);
      return out;
    } finally {
      for (const t of temps) il.free(t);
    }
  }

  overload(list, args, isStatic) {
    const il = this.il;
    let best = null;
    let bestScore = -Infinity;
    for (const m0 of list) {
      const m = il.desc(m0);
      if (m.isStatic !== isStatic) continue;
      if (m.parameterCount !== args.length) continue;
      if (il.whyNotCallable(m)) continue;
      let score = 0;
      for (let i = 0; i < m.params.length && score > -Infinity; i++) score += this._fit(m.params[i].type, args[i]);
      if (score > bestScore) { best = m; bestScore = score; }
    }
    return bestScore === -Infinity ? null : best;
  }

  _fit(p, v) {
    const il = this.il;
    const t = il.typeInfo(p);
    if (v instanceof Ref) return t.byref ? 3 : -Infinity;
    const k = t.kind;
    const isRef = this.isRefType(p);
    if (v === null || v === undefined) return isRef ? 1 : -Infinity;
    if (this._isTypeProxy(v)) {
      if (!isRef) return -Infinity;
      return il.typeName(p, true) === 'System.Type' ? 4 : k === T.OBJECT ? 2 : -Infinity;
    }
    if (v && (typeof v === 'object' || typeof v === 'function') && v[PTR] !== undefined) {
      const ptr = v[PTR];
      if (!isRef) {
        // a boxed struct/enum proxy for a struct/enum parameter of the same type
        const bt = ptr ? il.tdOfKlass(il.klassOf(ptr)) : -1;
        return bt >= 0 && bt === il.tdOfType(p) && il.md.typeDef(bt).isValueType ? 4 : -Infinity;
      }
      if (k === T.GENERICINST && ptr) {
        // List<string> isn't a List<int>: compare the instantiated classes when the runtime has made them
        const pk = il.cachedClass(p);
        const base = il.tdOfType(p);
        if (pk) {
          if (isSubKlass(il, il.klassOf(ptr), pk)) return 4;
          if (!(base >= 0 && il.md.typeDef(base).isInterface)) return -Infinity;
        }
      }
      const ptd = il.tdOfType(p);
      if (ptd >= 0 && ptr && il.isInstanceOf(ptr, ptd)) return k === T.GENERICINST ? 3 : 4;
      return k === T.OBJECT ? 2 : 1;
    }
    let isEnum = false;
    if (k === T.VALUETYPE) isEnum = il.md.typeDef(il._tdFromData(t.data)).isEnum;
    switch (typeof v) {
      case 'string':
        if (k === T.STRING) return 4;
        if (isRef && il.typeName(p, true) === 'System.Type') return 2;
        if (isEnum) { try { il.enumValue(il._tdFromData(t.data), v); return 3; } catch (_) { return -Infinity; } }
        return k === T.OBJECT ? 1 : (k === T.CHAR && v.length === 1) ? 2 : -Infinity;
      case 'boolean': return k === T.BOOLEAN ? 4 : k === T.OBJECT ? 0.5 : -Infinity; // object: boxed
      case 'bigint': return k === T.I8 || k === T.U8 ? 4 : k === T.OBJECT ? 0.5 : -Infinity;
      case 'number':
        if (k === T.R4 || k === T.R8) return 3;
        if (isEnum) return 2;
        if ((k >= T.I1 && k <= T.U8) || k === T.I || k === T.U || k === T.CHAR) return Number.isInteger(v) ? 3 : 1;
        if (k === T.BOOLEAN) return 0;
        if (k === T.OBJECT) return 0.5;
        return -Infinity;
      case 'object':
        if ((k === T.VALUETYPE && !isEnum) || (k === T.GENERICINST && !isRef)) {
          const fs = il.fieldsOfStructType(p) || [];
          return 2 + fs.filter((f) => f.name in v || fieldKey(f.name) in v).length / Math.max(1, fs.length);
        }
        return -Infinity;
      default: return -Infinity;
    }
  }

  /** A callable function for method `name`, with .of(...types) for generic methods. */
  _methodFn(list, metaDefs, self, isStatic, label, klass = 0) {
    const fn = (...a) => {
      const m = this.overload(list, a, isStatic) || (isStatic ? null : this.overload(list, a, true));
      if (!m) {
        const gen = metaDefs.some((x) => x.genericContainerIndex !== -1);
        throw new TypeError(`Il2Cpp: no ${label} overload takes (${a.map(describe).join(', ')})${gen ? '; for a generic method use .of(type, ...)(args)' : ''}`);
      }
      return this.invoke(m, m.isStatic ? 0 : self, a);
    };
    fn.of = (...types) => (...a) => {
      const il = this.il;
      const argTypes = types.map((t) => il.resolveTypeName(typeof t === 'string' ? t : t.$name));
      const defs = metaDefs.filter((x) => x.genericContainerIndex !== -1 && x.parameterCount === a.length);
      if (!defs.length) throw new TypeError(`Il2Cpp: ${label} has no generic overload with ${a.length} parameter(s)`);
      const descs = [];
      for (const d of defs) { try { descs.push(il.inflateMethod(d, argTypes, klass)); } catch (e) { if (defs.length === 1) throw e; } }
      // an instance can call static generic methods too; a type can't call instance ones (no `this`)
      const m = this.overload(descs, a, isStatic) || (isStatic ? null : this.overload(descs, a, true));
      if (!m) throw new TypeError(`Il2Cpp: no ${label}<${types.join(', ')}> overload takes these arguments`);
      return this.invoke(m, m.isStatic ? 0 : self, a);
    };
    return fn;
  }

  // ------------------------------------------------------------------ static side

  typeProxy(name) {
    const key = typeof name === 'number' ? name : String(name);
    if (this._types.has(key)) return this._types.get(key);
    return this._typeProxy(key, this.typeRef(name));
  }

  /** Type proxy straight from a runtime class (works for generic instances and their nested types). */
  typeProxyOfKlass(k) {
    const key = `klass:${k}`;
    if (this._types.has(key)) return this._types.get(key);
    const il = this.il;
    const p = k + il.layout.byval;
    const generic = il.typeInfo(p).kind === T.GENERICINST;
    return this._typeProxy(key, { td: il.tdOfKlass(k), p, k, name: il.klassName(k), generic });
  }

  _typeProxy(key, ref) {
    const self = this;
    const il = this.il;
    const td = ref.td;
    const fullName = ref.name;
    const metaStatic = () => this.members(td);
    const staticAddr = (fname) => {
      const k = this._klass(ref, true);
      const f = k ? this._staticFieldOn(k, fname) : null;
      if (!f) return null;
      if (f.isConst) return { constIndex: f.metaIndex };
      const base = il.staticFieldsBase(f.klass);
      if (!base) throw new Error(`Il2Cpp: static fields of ${fullName} are not initialized`);
      return { addr: base + f.offset, type: f.type };
    };
    const target = function Il2CppType() {};
    const proxy = new Proxy(target, {
      get(_, key) {
        if (key === PTR) return 0;
        if (typeof key === 'symbol') return undefined;
        switch (key) {
          case '$td': return td;
          case '$name': return fullName;
          case '$type': return self.wrap(il.typeObject(ref.p));
          case '$klass': return self._klass(ref);
          case '$new': return (...a) => self.construct(ref, a);
          case '$find': return () => self.findAll(ref, 1)[0] || null;
          case '$findAll': return (limit) => self.findAll(ref, limit);
          case '$method': return (n, sig) => self.resolveMethod(`${fullName}::${n}`, sig);
          case 'toString': return () => `[Il2Cpp type ${fullName}]`;
          case 'then': return undefined;
          default: break;
        }
        const fm = metaStatic().fields.get(key) || metaStatic().fields.get(`<${key}>k__BackingField`);
        if (fm && (fm.attrs & FIELD.LITERAL)) return il.constValue(fm.index);
        if (fm && (fm.attrs & FIELD.STATIC)) { const s = staticAddr(fm.name); if (s && s.addr) return self.read(s.addr, s.type); }
        const k = self._klass(ref, true);
        const g = self._accessor(k, td, key, false);
        if (g && g.isStatic) return g.uncallable ? undefined : self.invoke(g, 0, []); // no code in this build: undefined
        const list = k ? self.methodsOn(k).get(key) : (metaStatic().methods.get(key) || []).map((m) => il.desc(m));
        const metas = metaStatic().methods.get(key) || [];
        if ((list && list.length) || metas.length) return self._methodFn(list || [], metas, 0, true, `${fullName}.${key}`, k);
        const d = il.md.typeDef(td);
        for (let i = 0; i < d.nestedCount; i++) {
          const n = il.md.nestedType(d.nestedTypesStart + i);
          if (il.md.typeDef(n).name === key) return self.typeProxy(n);
        }
        return undefined;
      },
      set(_, key, v) {
        const fm = metaStatic().fields.get(key) || metaStatic().fields.get(`<${key}>k__BackingField`);
        if (fm && (fm.attrs & FIELD.STATIC) && !(fm.attrs & FIELD.LITERAL)) { const s = staticAddr(fm.name); if (s && s.addr) { self.write(s.addr, s.type, v); return true; } }
        const k = self._klass(ref, true);
        const st = self._accessor(k, td, key, true);
        if (st && st.isStatic) {
          if (st.uncallable) throw new TypeError(`Il2Cpp: can't set ${fullName}.${String(key)}: ${st.uncallable}`);
          self.invoke(st, 0, [v]); return true;
        }
        throw new TypeError(`Il2Cpp: ${fullName}.${String(key)} is not a writable static member`);
      },
      construct(_, a) { return self.construct(ref, a); },
      ownKeys() {
        const m = metaStatic();
        return [...new Set([...[...m.fields].filter(([, f]) => f.attrs & FIELD.STATIC).map(([n]) => n), ...[...m.props].filter(([, p]) => (p.getter || p.setter).flags & METHOD.STATIC).map(([n]) => n), 'prototype'])];
      },
      getOwnPropertyDescriptor(_, key) {
        if (key === 'prototype') return Object.getOwnPropertyDescriptor(target, 'prototype');
        return { configurable: true, enumerable: true, writable: true, value: undefined };
      },
    });
    this._types.set(key, proxy);
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
    const thisPtr = isValue ? ptr + 8 : ptr;
    return new Proxy({}, {
      get(_, key) {
        if (key === PTR) return ptr;
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
          case '$is': return (name) => { const r = self.typeRef(name); return r.k ? isSubKlass(il, k, r.k) : il.isInstanceOf(ptr, r.td); };
          case '$toArray': return () => { const el = self.fmt.elements(ptr, 1e6); return el ? el.items.map((e) => self.read(e.addr, e.type)) : null; };
          case '$static': return self.typeProxyOfKlass(k);
          case '$get': return (name) => self._getMember(ptr, thisPtr, k, td, name);
          case '$set': return (name, v) => self._setMember(ptr, thisPtr, k, td, name, v);
          case '$call': return (name, ...a) => {
            const f = self._getMember(ptr, thisPtr, k, td, name);
            if (typeof f !== 'function') throw new Error(`Il2Cpp: ${self.il.klassName(k) || 'object'} has no method ${name} (it may have been stripped from this build)`);
            return f(...a);
          };
          case '$method': return (name, sig) => self.resolveMethod({ klass: k, name }, sig);
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
        return self.klassFields(k).has(key) || self.members(td).props.has(key) || self.methodsOn(k).has(key);
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
    const g = this._accessor(k, td, key, false);
    if (g) return g.uncallable ? undefined : this.invoke(g, g.isStatic ? 0 : thisPtr, []); // no code in this build: undefined
    const list = this.methodsOn(k).get(key);
    const metas = this.members(td).methods.get(key) || [];
    if ((list && list.length) || metas.length) return this._methodFn(list || [], metas, thisPtr, false, `${il.klassName(k, false)}.${key}`, k);
    const sf = this._staticFieldOn(k, key);
    if (sf && sf.isConst) return il.constValue(sf.metaIndex);
    if (sf) { const base = il.staticFieldsBase(sf.klass); if (base) return this.read(base + sf.offset, sf.type); }
    return undefined;
  }

  _setMember(ptr, thisPtr, k, td, key, v) {
    const il = this.il;
    const f = this.klassFields(k).get(key);
    if (f) { this.write(ptr + f.offset, f.type, v); return; }
    const s = this._accessor(k, td, key, true);
    if (s) {
      if (s.uncallable) throw new TypeError(`Il2Cpp: can't set ${il.klassName(k)}.${String(key)}: ${s.uncallable}`);
      // a partial struct ({ y: 5 }) keeps the other fields, like a struct field write does
      const pt = s.params[0] && s.params[0].type;
      if (pt && v && typeof v === 'object' && v[PTR] === undefined && !Array.isArray(v) && il.fieldsOfStructType(pt)) {
        const g = this._accessor(k, td, key, false);
        if (g && !g.uncallable) {
          const cur = this.invoke(g, g.isStatic ? 0 : thisPtr, []);
          if (cur && typeof cur === 'object') v = { ...cur, ...v };
        }
      }
      this.invoke(s, s.isStatic ? 0 : thisPtr, [v]); return;
    }
    const sf = this._staticFieldOn(k, key);
    if (sf && !sf.isConst) { const base = il.staticFieldsBase(sf.klass); if (base) { this.write(base + sf.offset, sf.type, v); return; } }
    throw new TypeError(`Il2Cpp: ${il.klassName(k)}.${String(key)} is not writable`);
  }

  _component(ptr, name) {
    const ref = this._isTypeProxy(name) ? this.typeRef(name.$name) : this.typeRef(name);
    const go = this.il.tdOfKlass(this.il.klassOf(ptr)) === this.unity.td.GameObject ? ptr : this.unity.gameObjectOf(ptr);
    if (!go) return null;
    for (const c of this.unity.components(go)) {
      // generic components: MyGeneric<int> isn't a MyGeneric<string>
      if (ref.generic ? ref.k && isSubKlass(this.il, this.il.klassOf(c), ref.k) : this.il.isInstanceOf(c, ref.td)) return this.wrap(c);
    }
    return null;
  }

  _arrayProxy(ptr) {
    const self = this;
    const il = this.il;
    const info = () => il.arrayInfo(ptr);
    const toArray = () => { const a = info(); const o = []; for (let i = 0; i < a.length; i++) o.push(self.read(a.data + i * a.elemSize, a.elemType)); return o; };
    return new Proxy([], {
      get(_, key) {
        if (key === PTR) return ptr;
        if (key === '$ptr') return ptr;
        if (key === 'length') return info().length;
        if (key === Symbol.iterator) return function* it() { yield* toArray(); };
        if (key === '$toArray' || key === 'toArray') return toArray;
        if (key === '$type') return il.klassName(il.klassOf(ptr));
        if (key === 'toString') return () => self._label(ptr);
        if (key === 'then') return undefined;
        if (typeof key === 'string' && /^\d+$/.test(key)) {
          const a = info();
          const i = +key;
          return i < a.length ? self.read(a.data + i * a.elemSize, a.elemType) : undefined;
        }
        if (typeof key === 'string' && typeof Array.prototype[key] === 'function') { const arr = toArray(); return arr[key].bind(arr); }
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

  // ------------------------------------------------------------------ methods as values (patch targets)

  /**
   * Resolve 'Type::Method', 'List<int>::Add', 'GameObject::GetComponent<Rigidbody>',
   * or { klass, name } into a callable descriptor.
   */
  resolveMethod(spec, sig) {
    const il = this.il;
    let k;
    let td;
    let name;
    let genArgs = null;
    if (spec && spec.__desc) return spec;
    if (typeof spec === 'object' && spec.klass) { k = spec.klass; td = il.tdOfKlass(k); name = spec.name; }
    else {
      const s = String(spec);
      const i = s.lastIndexOf('::');
      let typeName = i >= 0 ? s.slice(0, i) : s.slice(0, s.lastIndexOf('.'));
      name = i >= 0 ? s.slice(i + 2) : s.slice(s.lastIndexOf('.') + 1);
      const lt = name.indexOf('<');
      if (lt > 0) { genArgs = splitArgs(name.slice(lt + 1, name.lastIndexOf('>'))); name = name.slice(0, lt); }
      const ref = this.typeRef(typeName.trim());
      td = ref.td;
      k = ref.generic ? ref.k : 0;
      typeName = ref.name;
    }
    const matchSig = (d) => {
      if (sig === undefined) return true;
      if (typeof sig === 'number') return d.parameterCount === sig;
      if (d.parameterCount !== sig.length) return false;
      return sig.every((s, j) => { const a = ALIAS[s] || s; return s === '*' || il.typeName(d.params[j].type, true) === a || il.typeName(d.params[j].type) === a; });
    };
    let cands;
    if (genArgs) {
      const argTypes = genArgs.map((a) => il.resolveTypeName(a));
      cands = il.methodsOf(td).filter((m) => m.name === name && m.genericContainerIndex !== -1).map((m) => { try { return il.inflateMethod(m, argTypes); } catch (e) { return { err: e }; } });
      const err = cands.find((c) => c.err);
      cands = cands.filter((c) => !c.err && matchSig(c));
      if (!cands.length && err) throw err.err;
    } else if (k) {
      // a runtime class (generic instance, or an object's class): its methods, nearest declaring class first
      cands = [];
      for (let c = k, g = 0; c && g < 64 && !cands.length; c = il.parentKlass(c), g++) {
        let list = il.runtimeMethods(c);
        if (!list.length) { const ctd = il.tdOfKlass(c); list = ctd >= 0 ? il.methodsOf(ctd).map((m) => il.desc(m)) : []; }
        cands = list.filter((d) => d.name === name && matchSig(d));
      }
    } else {
      // declared here, else on the nearest base type that has it (with the same ambiguity check)
      cands = [];
      for (const t of il.hierarchy(td)) {
        cands = il.methodsOf(t).filter((m) => m.name === name && il.methodPointer(m)).map((m) => il.desc(m)).filter(matchSig);
        if (!cands.length && t === td) cands = il.methodsOf(t).filter((m) => m.name === name).map((m) => il.desc(m)).filter(matchSig);
        if (cands.length) break;
      }
    }
    if (!cands.length) throw new Error(`${il.tdFullName(td)}::${name}${genArgs ? `<${genArgs.join(', ')}>` : ''} not found${sig !== undefined ? ' with that signature' : ''}`);
    if (cands.length > 1) throw new Error(`${il.tdFullName(td)}::${name} has ${cands.length} overloads; pass a signature (parameter count or type names)`);
    return cands[0];
  }

  // ------------------------------------------------------------------ finding and creating

  findAll(name, limit = Infinity) {
    const il = this.il;
    const ref = typeof name === 'object' && name.td !== undefined ? name : this.typeRef(name);
    let list;
    limit = Number(limit);
    if (Number.isNaN(limit)) limit = Infinity;
    if (limit <= 0) return [];
    if (!ref.generic && this.unity.td.Object >= 0 && il.isSubclassOf(ref.td, this.unity.td.Object)) list = this.unity.objectsOfType(ref.td).filter((p) => this.unity.alive(p));
    else {
      const k = this._klass(ref);
      // heap scan: the class itself plus derived classes (and implementers, for an interface)
      const klasses = ref.generic ? new Set(k ? [k] : []) : il.subKlasses(ref.td, [k]);
      list = klasses.size ? il.findInstances(k, { limit: Math.min(limit, 5000), klasses }) : [];
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

  /** A new, zeroed object of the type (no constructor run), or 0 when this build can't do that. */
  _allocate(ref) {
    const il = this.il;
    const t = il.typeObject(ref.p);
    for (const [tn, mn] of [['System.Runtime.CompilerServices.RuntimeHelpers', 'GetUninitializedObject'], ['System.Runtime.Serialization.FormatterServices', 'GetUninitializedObject']]) {
      const m = il.findMethod(tn, mn, ['System.Type']);
      if (m && !il.whyNotCallable(m)) return il.call(m, 0, t) >>> 0;
    }
    return 0;
  }

  construct(name, args) {
    const il = this.il;
    const ref = typeof name === 'object' && name.td !== undefined ? name : this.typeRef(name);
    const t = il.typeObject(ref.p);
    let obj = this._allocate(ref);
    let done = false;
    if (!obj) {
      const act = il.findMethod('System.Activator', 'CreateInstance', ['System.Type']);
      if (!act) throw new Error('Il2Cpp.new: no way to allocate objects in this build');
      obj = il.call(act, 0, t);
      done = !args.length;
    }
    if (!done) {
      const k = il.klassOf(obj);
      const ctors = (this.methodsOn(k).get('.ctor') || []).filter((d) => d.klass === undefined || d.klass === k);
      const m = this.overload(ctors, args, false);
      const isValue = ref.td >= 0 && il.md.typeDef(ref.td).isValueType;
      if (m) this.invoke(m, isValue ? obj + 8 : obj, args);
      // a struct with no arguments is its zeroed default value (C# `new Vector3()`), constructors or not
      else if (args.length || (ctors.length && !isValue)) throw new TypeError(`Il2Cpp.new: no ${ref.name} constructor takes ${args.length} argument(s)`);
    }
    return this.wrap(obj);
  }
}


function isSubKlass(il, k, base) {
  for (let c = k, g = 0; c && g < 64; c = il.parentKlass(c), g++) if (c === base) return true;
  return false;
}

function describe(x) {
  if (x && x[PTR] !== undefined) return 'object';
  if (x === null) return 'null';
  return typeof x;
}

function splitArgs(s) {
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

export { PTR };
