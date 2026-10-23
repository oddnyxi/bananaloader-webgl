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
import { Metadata } from './metadata.js';
import { findRegistrations } from './registration.js';
import { T, PRIM_NAME, PRIM_SIZE, REF_KINDS, FIELD, METHOD } from './types.js';

const hex = (n) => '0x' + (n >>> 0).toString(16);

// CLR names -> the C# keywords typeName() prints for primitives
const ALIAS = {
  'System.Void': 'void', 'System.Boolean': 'bool', 'System.Char': 'char', 'System.SByte': 'sbyte', 'System.Byte': 'byte',
  'System.Int16': 'short', 'System.UInt16': 'ushort', 'System.Int32': 'int', 'System.UInt32': 'uint', 'System.Int64': 'long',
  'System.UInt64': 'ulong', 'System.Single': 'float', 'System.Double': 'double', 'System.String': 'string', 'System.Object': 'object',
  'System.IntPtr': 'IntPtr', 'System.UIntPtr': 'UIntPtr',
};

export class ManagedError extends Error {
  constructor(message, info = {}) { super(message); Object.assign(this, info); }
}

export class Il2Cpp {
  /**
   * @param {object} Module  the Emscripten Module (unityInstance.Module)
   * @param {(msg:string)=>void} log
   */
  constructor(Module, log = () => {}) {
    this.Module = Module;
    this.log = log;
    const exp = Module.asm || Module.wasmExports || {};
    const vals = Object.values(exp);
    const memory = Module.wasmMemory || vals.find((v) => v instanceof WebAssembly.Memory);
    this.table = Module.wasmTable || vals.find((v) => v instanceof WebAssembly.Table);
    if (!memory) throw new Error('wasm memory not found on Module');
    if (!this.table) throw new Error('wasm function table not found on Module');
    this.mem = new Memory(memory);
    this.malloc = Module._malloc || exp.malloc || exp._malloc;
    this.free = Module._free || exp.free || exp._free;
    if (typeof this.malloc !== 'function' || typeof this.free !== 'function') throw new Error('malloc/free not found on Module');
    this.stackSave = Module.stackSave || exp.stackSave;
    this.stackRestore = Module.stackRestore || exp.stackRestore;
    this._fn = new Map();
    this.ready = false;
  }

  // ------------------------------------------------------------------ init

  init() {
    const t0 = performance.now();
    const base = Metadata.locate(this.mem);
    if (base < 0) throw new Error('global-metadata not found in memory (is the game fully loaded?)');
    this.md = new Metadata(this.mem, base);
    this.md._declTd = (typeIndex) => this.tdOfTypeIndex(typeIndex);
    this.log(`metadata v${this.md.version} at ${hex(base)}: ${this.md.images.length} assemblies, ${this.md.typeCount} types, ${this.md.methodCount} methods`);

    const limit = Math.min(base, 512 << 20);
    const reg = findRegistrations(this.mem, this.md, limit);
    if (!reg.meta) throw new Error('Il2CppMetadataRegistration not found');
    if (!reg.modules.size) throw new Error('Il2CppCodeRegistration not found');
    this.reg = reg;
    this.log(`registrations: ${reg.meta.typesCount} types, ${reg.modules.size} code modules`);

    // image index -> code module
    this.moduleOfImage = this.md.images.map((img) => reg.modules.get(img.name) || null);

    this._indexTypes();
    this._calibrate();
    this.ready = true;
    this.log(`ready in ${Math.round(performance.now() - t0)} ms`);
    return this;
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
    return { ptr: p, data: m.u32At(p), attrs: bits & 0xffff, kind: (bits >>> 16) & 0xff, byref: ((bits >>> 29) & 1) === 1 };
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

  _genericParamName(d) {
    const md = this.md;
    const sec = md.sec.genericParameters;
    const addr = d < sec.size / 16 ? sec.off + d * 16 : d;
    if (addr < sec.off || addr >= sec.off + sec.size) return 'T';
    return md.str(this.mem.u32At(addr + 4));
  }

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
    if (t.isGeneric) {
      const gc = this.md.sec.genericContainers;
      const c = gc.off + t.genericContainerIndex * 16;
      const argc = this.mem.i32At(c + 4);
      const start = this.mem.i32At(c + 12);
      const names = [];
      for (let k = 0; k < argc; k++) names.push(this.md.str(this.mem.u32At(this.md.sec.genericParameters.off + (start + k) * 16 + 4)));
      n += '<' + names.join(', ') + '>';
    }
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
    if (i === undefined) i = this.byFullName.get(fullName.replace(/\./g, '+').replace(/^([^+]*)\+/, '$1.'));
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
    for (let i = 0; i < n; i++) params.push({ name: metaParams[i] ? metaParams[i].name : `arg${i}`, type: m.u32At(pp + i * 4) });
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
    const PRIM = { int: 'System.Int32', uint: 'System.UInt32', long: 'System.Int64', ulong: 'System.UInt64', short: 'System.Int16', ushort: 'System.UInt16', byte: 'System.Byte', sbyte: 'System.SByte', float: 'System.Single', double: 'System.Double', bool: 'System.Boolean', char: 'System.Char', string: 'System.String', object: 'System.Object' };
    if (PRIM[name]) name = PRIM[name];
    if (name.endsWith('[]')) {
      const el = this.resolveTypeName(name.slice(0, -2));
      const t = this.call(this.findMethod('System.RuntimeType', 'MakeArrayType', 0) || this.findMethod('System.Type', 'MakeArrayType', 0), this.typeObject(el));
      return this._typeOfTypeObject(t);
    }
    const lt = name.indexOf('<');
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
    const mk = this.findMethod('System.RuntimeType', 'MakeGenericType', 1);
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
        if (rc) { try { this.invokeRaw(rc, 0, [p]); } catch (_) { /* ignore */ } }
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
  inflateMethod(meta, argTypes) {
    const key = meta.index + ':' + argTypes.join(',');
    this._ginfl ||= new Map();
    if (this._ginfl.has(key)) return this._ginfl.get(key);
    const declTd = meta.declaringType;
    if (this.md.typeDef(declTd).isGeneric) throw new Error('generic methods of generic types: call them on an instance');
    const k = this.ensureClass(declTd);
    const local = meta.index - this.md.typeDef(declTd).methodStart;
    const arr = k && this.layout.methods !== undefined ? this.mem.u32At(k + this.layout.methods) : 0;
    const defMi = arr ? this.mem.u32At(arr + local * 4) : 0;
    if (!this.mem.valid(defMi)) throw new Error(`no runtime MethodInfo for ${meta.name} (class not set up)`);
    const fromHandle = this.findMethod('System.Reflection.MethodBase', 'GetMethodFromHandle', 1);
    const make = this.findMethod('System.Reflection.RuntimeMethodInfo', 'MakeGenericMethod', 1);
    if (!fromHandle || !make) throw new Error('reflection (MethodBase.GetMethodFromHandle / MakeGenericMethod) is not available in this build');
    const rmi = this.call(fromHandle, 0, defMi);
    const inst = this.call(make, rmi, this.typeArray(argTypes));
    const f = this.allFields(this.klassOf(inst)).find((x) => x.name === 'mhandle');
    if (!f) throw new Error('RuntimeMethodInfo.mhandle not found');
    const mi = this.mem.u32At(inst + f.offset);
    const d = this.miDesc(mi, meta);
    d.label = `${this.tdFullName(declTd)}::${meta.name}<${argTypes.map((t) => this.typeName(t)).join(', ')}>`;
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

    const fast = this.findMethod(strTd, 'FastAllocateString', 1);
    if (!fast) throw new Error('String.FastAllocateString not found');
    this._fastAlloc = fast;
    const s = this._rawCall(this.methodPointer(fast), [1]) >>> 0;
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
    L.fieldInfoSize = 20;
    // static_fields -> String.Empty is a zero-length string
    const empty = this.runtimeFields(K).find((f) => f.name === 'Empty' && f.isStatic);
    for (let o = L.fields; o < 260 && empty; o += 4) {
      const p = m.u32At(K + o);
      if (!m.valid(p)) continue;
      const v = m.u32At(p + empty.offset);
      if (m.valid(v) && m.u32At(v) === K && m.i32At(v + 8) === 0) { L.staticFields = o; break; }
    }
    // methods -> MethodInfo*[] { methodPointer, virtualMethodPointer, invoker, name, klass, return_type, parameters, ... }
    const firstMethod = this.methodsOf(strTd)[0];
    const mName = md.strAddr(firstMethod.nameIndex);
    for (let o = L.fields; o < 200; o += 4) {
      const arr = m.u32At(K + o);
      if (!m.valid(arr)) continue;
      const mi = m.u32At(arr);
      if (m.valid(mi) && m.u32At(mi + 12) === mName && m.u32At(mi + 16) === K) { L.methods = o; break; }
    }
    L.mi = { ptr: 0, vptr: 4, invoker: 8, name: 12, klass: 16, ret: 20, params: 24, token: 36, flags: 40, slot: 44, count: 46 };
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
    return td;
  }

  /** Il2CppClass* for a type definition if the runtime has created it, else 0. */
  klassOfTd(td) {
    if (this.classTable) return this.mem.u32At(this.classTable + td * 4);
    return 0;
  }

  klassName(k, full = true) {
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
        token: m.u32At(p + 16),
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
  abi(p) {
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
        const single = this._singleElement(td, 0);
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
    return { wasm: 'i32' };
  }

  /** Can this method be called directly? Returns null or a reason string. */
  whyNotCallable(m) {
    if (m.__desc) {
      if (m.generic) return m.meta && m.meta.genericContainerIndex !== -1 ? 'generic method (use .of(...types))' : 'method of a generic type (call it on an instance)';
      if (!m.ptr) return 'no code in this build';
      for (const t of [m.retType, ...m.params.map((p) => p.type)]) { const a = this.abi(t); if (a.wasm === 'unsupported') return a.why; }
      return null;
    }
    if (m.genericContainerIndex !== -1) return 'generic method';
    const td = this.md.typeDef(m.declaringType);
    if (td.isGeneric) return 'method of a generic type';
    if (!this.methodPointer(m)) return (m.flags & METHOD.ABSTRACT) ? 'abstract' : 'stripped from the build';
    const ret = this.abi(this.typePtr(m.returnType));
    if (ret.wasm === 'unsupported') return 'returns ' + ret.why;
    for (const p of this.params(m)) {
      const a = this.abi(p.type);
      if (a.wasm === 'unsupported') return `parameter ${p.name}: ${a.why}`;
    }
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
    const ptr = d.ptr;
    if (!ptr) throw new Error(`${d.name}: no code (${this.whyNotCallable(d)})`);
    const isStatic = d.isStatic;
    const ret = this.abi(d.retType);
    const f = this.fn(ptr);
    const list = [];
    let retAddr = 0;
    if (ret.wasm === 'ptr') {
      retAddr = this.malloc(Math.max(ret.size, 4));
      this.mem.fill(retAddr, 0, ret.size);
      list.push(retAddr);
    }
    if (!isStatic) list.push(self >>> 0);
    list.push(...args);
    list.push(d.mi >>> 0); // const MethodInfo* (needed by shared generic code)
    if (f.length !== list.length) {
      if (retAddr) this.free(retAddr);
      throw new Error(`${m.name}: signature mismatch (expected ${list.length} wasm params, function takes ${f.length})`);
    }
    let value;
    try {
      value = this._rawCall(ptr, list);
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
      const inner = this.typeInfo(p);
      const size = Math.max(8, PRIM_SIZE[inner.kind] || (inner.kind === T.VALUETYPE ? this.valueSize(this._tdFromData(inner.data)) : 4));
      const buf = this.malloc(size);
      temps.push(buf);
      m.fill(buf, 0, size);
      if (v != null) this.writeValue(buf, p, v, true);
      return buf;
    }
    switch (a.wasm) {
      case 'i64': return BigInt.asIntN(64, BigInt(v ?? 0));
      case 'f32': case 'f64': return Number(v ?? 0);
      case 'ptr': {
        const buf = this.malloc(Math.max(a.size, 4));
        temps.push(buf);
        m.fill(buf, 0, a.size);
        if (typeof v === 'number') m.copy(buf, v, a.size); // address of existing struct data
        else if (v && typeof v === 'object') this.writeStruct(buf, a.td, v);
        return buf;
      }
      case 'i32':
      default: {
        if (a.single && v && typeof v === 'object') { // single-field struct given as {field: x}
          const f = this.fieldsOf(a.td).find((x) => !(x.attrs & FIELD.STATIC));
          v = v[f.name];
        }
        if (a.kind === T.STRING && typeof v === 'string') return this.newString(v);
        if (typeof v === 'boolean') return v ? 1 : 0;
        if (typeof v === 'string' && a.kind === T.CHAR) return v.charCodeAt(0) || 0;
        return Number(v ?? 0) | 0;
      }
    }
  }

  unmarshalReturn({ value, retAddr, ret, retType }) {
    if (ret.wasm === 'void') return undefined;
    if (ret.wasm === 'ptr') {
      const out = retType ? this.readDeep(retAddr, retType) : this.readStruct(retAddr, ret.td);
      this.free(retAddr);
      return out;
    }
    switch (ret.kind) {
      case T.BOOLEAN: return (value & 0xff) !== 0;
      case T.U1: return value & 0xff;
      case T.I1: return (value << 24) >> 24;
      case T.CHAR: return String.fromCharCode(value & 0xffff);
      case T.U2: return value & 0xffff;
      case T.I2: return (value << 16) >> 16;
      case T.U4: case T.U: return value >>> 0;
      case T.STRING: return this.readString(value >>> 0);
      case T.VALUETYPE:
        if (ret.single) {
          const f = this.fieldsOf(ret.td).find((x) => !(x.attrs & FIELD.STATIC));
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
    const s = this._rawCall(this.methodPointer(this._fastAlloc), [str.length, 0]) >>> 0;
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
      case T.BOOLEAN: return m.setU8(addr, v === true || v === 'true' || v === 1 || v === '1' ? 1 : 0);
      case T.CHAR: return m.setU16(addr, typeof v === 'string' ? v.charCodeAt(0) || 0 : Number(v));
      case T.I1: return m.setI8(addr, Number(v));
      case T.U1: return m.setU8(addr, Number(v));
      case T.I2: return m.setI16(addr, Number(v));
      case T.U2: return m.setU16(addr, Number(v));
      case T.I4: return m.setI32(addr, Number(v));
      case T.U4: case T.I: case T.U: case T.PTR: return m.setU32(addr, Number(v));
      case T.I8: return m.setI64(addr, v);
      case T.U8: return m.setU64(addr, v);
      case T.R4: return m.setF32(addr, Number(v));
      case T.R8: return m.setF64(addr, Number(v));
      case T.STRING: return m.setU32(addr, typeof v === 'string' ? this.newString(v) : Number(v ?? 0));
      case T.VALUETYPE: {
        const td = this._tdFromData(t.data);
        const d = this.md.typeDef(td);
        if (d.isEnum) return this.writeValue(addr, this.typePtr(d.elementTypeIndex), v, raw);
        if (typeof v === 'number') return m.copy(addr, v, this.valueSize(td));
        return this.writeStruct(addr, td, v);
      }
      case T.GENERICINST: {
        const fs = this.fieldsOfStructType(p);
        if (fs) {
          if (typeof v === 'number') return m.copy(addr, v, this.sizeOfType(p));
          for (const f of fs) if (v && v[f.name] !== undefined) this.writeValue(addr + f.offset, f.type, v[f.name]);
          return undefined;
        }
        return m.setU32(addr, Number(v ?? 0));
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

  /** Inline size of a value of type p (references are 4). */
  sizeOfType(p) {
    const t = this.typeInfo(p);
    if (t.byref) return 4;
    if (t.kind === T.VALUETYPE) {
      const td = this._tdFromData(t.data);
      const d = this.md.typeDef(td);
      if (d.isEnum) return this.sizeOfType(this.typePtr(d.elementTypeIndex));
      return this.valueSize(td);
    }
    if (t.kind === T.GENERICINST) {
      const b = this.tdOfType(p);
      if (b >= 0 && this.md.typeDef(b).isValueType) { const k = this.cachedClass(p); return k ? this.klassValueSize(k) : 0; }
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
    for (const f of this.structFields(td)) if (obj[f.name] !== undefined) this.writeValue(addr + f.offset, f.type, obj[f.name]);
  }

  /** Literal (const / enum member) value from metadata. */
  constValue(metaFieldIndex) {
    const d = this.md.fieldDefault(metaFieldIndex);
    if (!d || !d.dataAddr) return null;
    const p = this.typePtr(d.typeIndex);
    const t = this.typeInfo(p);
    const m = this.mem;
    if (t.kind === T.STRING) {
      // compressed length prefix (v29+) or int32 length
      let a = d.dataAddr;
      let len;
      if (this.md.version >= 29) {
        const b = m.u8At(a);
        if ((b & 0x80) === 0) { len = b; a += 1; }
        else if ((b & 0xc0) === 0x80) { len = ((b & 0x3f) << 8) | m.u8At(a + 1); a += 2; }
        else { len = ((b & 0x1f) << 24) | (m.u8At(a + 1) << 16) | (m.u8At(a + 2) << 8) | m.u8At(a + 3); a += 4; }
        if (len === 0xffffffff >> 0 || len < 0) return null;
      } else { len = m.i32At(a); a += 4; }
      return new TextDecoder().decode(m.bytes(a, len));
    }
    if (this.md.version >= 29 && (t.kind === T.I4 || t.kind === T.U4 || t.kind === T.CHAR || t.kind === T.I2 || t.kind === T.U2 || t.kind === T.I8 || t.kind === T.U8)) {
      // v29 stores these as compressed (zigzag for signed) varints
      return this._readCompressed(d.dataAddr, t.kind);
    }
    return this.readValue(d.dataAddr, p);
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
    if (kind === T.I4 || kind === T.I2) {
      // zigzag
      if (v === 0xffffffff) return -2147483648;
      return (v & 1) ? -((v >>> 1) + 1) : (v >>> 1);
    }
    if (kind === T.CHAR) return String.fromCharCode(v);
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
    // flags
    const n = Number(value);
    if (n > 0) {
      let rest = n;
      for (const [name, v] of all) {
        const x = Number(v);
        if (x && (rest & x) === x && (x & (x - 1)) === 0) { names.push(name); rest &= ~x; }
      }
      if (names.length && rest === 0) return names.join(' | ');
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
    return this.invokeRaw(this._getTypeFromHandle, 0, [p]).value >>> 0;
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
      if (rc) this.invokeRaw(rc, 0, [this.typePtr(this.md.typeDef(td).byvalTypeIndex)]);
    }
    return k || this.klassOfTd(td);
  }

  /** Scan the heap for live objects whose class is exactly `k`. */
  findInstances(k, { limit = 5000, validate } = {}) {
    const m = this.mem.views();
    const u32 = m.u32;
    const out = [];
    const start = (this.reg.meta.addr + 0x100000) >>> 2;
    for (let i = start; i < u32.length - 2; i++) {
      if (u32[i] !== k) continue;
      const mon = u32[i + 1];
      if (mon !== 0 && (mon < 0x1000 || mon >= m.size)) continue;
      const a = i << 2;
      if (validate && !validate(a)) continue;
      out.push(a);
      if (out.length >= limit) break;
    }
    return out;
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
