// Harmony-style patching for IL2CPP methods in WebGL builds.
//
// Every managed method compiles to a wasm function that lives in the function table. Calls
// that go through the table — virtual and interface calls, delegates, Unity messages
// (Update, Start, OnTriggerEnter…), reflection and engine callbacks — can be intercepted by
// swapping that table slot for a wasm-typed JS wrapper. Direct (non-virtual) calls compiled
// into game code don't use the table and are not intercepted.

import { wasmFunction } from './wasmfn.js';
import { T, METHOD } from '../il2cpp/types.js';

const WASM = { i32: 'i32', ptr: 'i32', i64: 'i64', f32: 'f32', f64: 'f64' };

export class Patcher {
  constructor(loader) {
    this.loader = loader;
    this.byPtr = new Map(); // table index -> PatchedMethod
    this.all = new Set();   // Patch handles
  }

  get il() { return this.loader.il; }

  /** Resolve "Namespace.Type::Method" (+ optional signature) or a method record. */
  resolve(target, sig) {
    const il = this.il;
    if (target && typeof target === 'object' && target.token !== undefined) return target;
    if (typeof target !== 'string') throw new TypeError('patch target must be "Type::Method" or a method record');
    let [type, name] = target.split('::');
    if (!name) { const i = target.lastIndexOf('.'); type = target.slice(0, i); name = target.slice(i + 1); }
    const td = il.findType(type);
    if (td < 0) throw new Error(`patch: type ${type} not found`);
    // only methods declared on the type itself (patching a base method would hit every subclass)
    let cands = il.methodsOf(td).filter((m) => m.name === name);
    if (!cands.length) {
      const inherited = il.findMethod(td, name, sig);
      if (inherited) cands = [inherited];
    }
    if (sig !== undefined) {
      cands = cands.filter((m) => {
        if (typeof sig === 'number') return m.parameterCount === sig;
        if (m.parameterCount !== sig.length) return false;
        const ps = il.params(m);
        return sig.every((s, k) => s === '*' || il.typeName(ps[k].type, true) === s || il.typeName(ps[k].type) === s);
      });
    }
    if (!cands.length) throw new Error(`patch: ${type}::${name} not found${sig !== undefined ? ' with that signature' : ''}`);
    if (cands.length > 1) throw new Error(`patch: ${type}::${name} has ${cands.length} overloads; pass a signature (parameter count or type names)`);
    return cands[0];
  }

  /**
   * @param owner  the Banan (or null for the loader)
   * @param target "Type::Method", or a method record
   * @param hooks  { prefix?(ctx) -> false to skip, postfix?(ctx), sig?, priority? }
   */
  patch(owner, target, hooks) {
    const il = this.il;
    const m = this.resolve(target, hooks.sig);
    const why = m.genericContainerIndex !== -1 ? 'generic method' : il.md.typeDef(m.declaringType).isGeneric ? 'method of a generic type' : null;
    if (why) throw new Error(`patch: can't patch a ${why}`);
    const ptr = il.methodPointer(m);
    if (!ptr) throw new Error(`patch: ${il.tdFullName(m.declaringType)}::${m.name} has no code in this build (stripped or abstract)`);
    let pm = this.byPtr.get(ptr);
    if (!pm) {
      pm = new PatchedMethod(this, m, ptr);
      this.byPtr.set(ptr, pm);
    } else if (pm.method.index !== m.index) {
      this.loader.log.warn(`${il.tdFullName(m.declaringType)}::${m.name} shares its code with ${il.tdFullName(pm.method.declaringType)}::${pm.method.name}; both are patched`);
    }
    const p = {
      owner,
      method: m,
      target: `${il.tdFullName(m.declaringType)}::${m.name}`,
      prefix: hooks.prefix || null,
      postfix: hooks.postfix || null,
      priority: hooks.priority || 0,
      calls: 0,
      errors: 0,
      active: true,
      unpatch: () => this.unpatch(p),
    };
    pm.add(p);
    this.all.add(p);
    return p;
  }

  unpatch(p) {
    if (!p.active) return;
    p.active = false;
    this.all.delete(p);
    const pm = this.byPtr.get(this.il.methodPointer(p.method));
    if (pm) {
      pm.remove(p);
      if (!pm.patches.length) { pm.restore(); this.byPtr.delete(pm.ptr); }
    }
  }

  unpatchOwner(owner) {
    for (const p of [...this.all]) if (p.owner === owner) this.unpatch(p);
  }

  list() { return [...this.all]; }
}

class PatchedMethod {
  constructor(patcher, m, ptr) {
    const il = patcher.il;
    this.patcher = patcher;
    this.method = m;
    this.ptr = ptr;
    this.patches = [];
    this.isStatic = (m.flags & METHOD.STATIC) !== 0;
    this.params = il.params(m);
    this.retType = il.typePtr(m.returnType);
    this.ret = il.abi(this.retType);
    this.argAbi = this.params.map((p) => il.abi(p.type));
    for (const a of [this.ret, ...this.argAbi]) if (a.wasm === 'unsupported') throw new Error(`patch: unsupported signature (${a.why})`);
    const sig = [];
    if (this.ret.wasm === 'ptr') sig.push('i32');
    if (!this.isStatic) sig.push('i32');
    for (const a of this.argAbi) sig.push(WASM[a.wasm] || 'i32');
    sig.push('i32'); // MethodInfo*
    this.sig = sig;
    this.result = this.ret.wasm === 'void' || this.ret.wasm === 'ptr' ? null : WASM[this.ret.wasm];
    this.original = il.table.get(ptr);
    if (this.original.length !== sig.length) throw new Error(`patch: signature mismatch (${sig.length} vs ${this.original.length} params)`);
    this.offset = (this.ret.wasm === 'ptr' ? 1 : 0) + (this.isStatic ? 0 : 1);
    const self = this;
    this.wrapper = wasmFunction(function bananaHook(...raw) { return self.call(raw); }, sig, this.result);
    il.table.set(ptr, this.wrapper);
    il._fn.delete(ptr); // the bridge caches table entries; make our own calls see the patch
  }

  add(p) {
    this.patches.push(p);
    this.patches.sort((a, b) => b.priority - a.priority);
  }

  remove(p) { this.patches = this.patches.filter((x) => x !== p); }

  restore() { this.patcher.il.table.set(this.ptr, this.original); this.patcher.il._fn.delete(this.ptr); }

  call(raw) {
    const ctx = new HookContext(this, raw);
    const loader = this.patcher.loader;
    let run = true;
    for (const p of this.patches) {
      if (!p.prefix || !p.active) continue;
      p.calls++;
      try {
        if (p.prefix.call(p.owner, ctx) === false) run = false;
      } catch (e) { this._fail(p, 'prefix', e); }
    }
    if (run && !ctx.skipOriginal) ctx.raw = this.original(...ctx.args);
    else if (this.ret.wasm === 'ptr' && ctx._resultSet === false) { /* sret buffer stays zeroed */ }
    for (const p of this.patches) {
      if (!p.postfix || !p.active) continue;
      if (!p.prefix) p.calls++;
      try { p.postfix.call(p.owner, ctx); } catch (e) { this._fail(p, 'postfix', e); }
    }
    void loader;
    if (this.result === 'i64') return BigInt.asIntN(64, BigInt(ctx.raw ?? 0n));
    if (this.result === 'i32') return (ctx.raw ?? 0) | 0;
    if (this.result) return Number(ctx.raw ?? 0);
    return undefined;
  }

  _fail(p, where, e) {
    p.errors++;
    const log = p.owner && p.owner.logger ? p.owner.logger : this.patcher.loader.log;
    if (p.errors <= 5) log.error(`${where} on ${p.target} threw: ${e && e.stack || e}`);
    if (p.errors === 100) { p.active = false; log.error(`${p.target}: patch disabled after 100 errors`); }
  }
}

/** What a prefix / postfix receives. */
class HookContext {
  constructor(pm, raw) {
    this._pm = pm;
    this.args = raw.slice();             // raw wasm arguments; edit via setArg()
    this.raw = undefined;                // raw return value
    this.skipOriginal = false;
    this.method = pm.method;
  }

  get loader() { return this._pm.patcher.loader; }
  get name() { return this._pm.method.name; }
  /** Raw `this` pointer (0 for static methods). */
  get self() { return this._pm.isStatic ? 0 : this.args[this._pm.ret.wasm === 'ptr' ? 1 : 0] >>> 0; }
  /** `this` as an Il2Cpp proxy. */
  get instance() {
    if (this._pm.isStatic) return null;
    const il = this.loader.il;
    const k = il.klassOf(this.self);
    const td = il.tdOfKlass(k);
    // value-type methods get the unboxed data, not an object
    if (td >= 0 && il.md.typeDef(this._pm.method.declaringType).isValueType) return null;
    return this.loader.interop.wrap(this.self);
  }
  get argCount() { return this._pm.params.length; }
  paramName(i) { return this._pm.params[i].name; }

  /** Argument i as a JS value (strings decoded, objects as proxies, structs as objects). */
  arg(i) {
    const pm = this._pm;
    const il = this.loader.il;
    const interop = this.loader.interop;
    const p = pm.params[i];
    const v = this.args[pm.offset + i];
    const a = pm.argAbi[i];
    if (a.byref) return interop.read(v >>> 0, p.type);
    if (a.wasm === 'ptr') return interop.read(v >>> 0, p.type);
    if (interop.isRefType(p.type)) return il.typeInfo(p.type).kind === T.STRING ? il.readString(v >>> 0) : interop.wrap(v >>> 0);
    return il.unmarshalReturn({ value: v, retAddr: 0, ret: a });
  }

  /** Replace argument i (prefix only). Strings, numbers, booleans, proxies, structs. */
  setArg(i, value) {
    const pm = this._pm;
    const il = this.loader.il;
    const interop = this.loader.interop;
    const p = pm.params[i];
    const a = pm.argAbi[i];
    const at = pm.offset + i;
    value = interop.unwrap(value);
    if (a.byref || a.wasm === 'ptr') { interop.write(this.args[at] >>> 0, p.type, value); return; }
    if (il.typeInfo(p.type).kind === T.STRING && typeof value === 'string') { this.args[at] = il.newString(value); return; }
    if (a.wasm === 'i64') { this.args[at] = BigInt.asIntN(64, BigInt(value)); return; }
    if (a.wasm === 'f32' || a.wasm === 'f64') { this.args[at] = Number(value); return; }
    if (typeof value === 'boolean') { this.args[at] = value ? 1 : 0; return; }
    if (a.single && value && typeof value === 'object') value = Object.values(value)[0];
    this.args[at] = Number(value ?? 0) | 0;
  }

  /** Return value as a JS value (postfix), or what was set with setResult. */
  get result() {
    const pm = this._pm;
    const il = this.loader.il;
    const interop = this.loader.interop;
    if (pm.ret.wasm === 'void') return undefined;
    if (pm.ret.wasm === 'ptr') return interop.read(this.args[0] >>> 0, pm.retType);
    if (this.raw === undefined) return undefined;
    if (interop.isRefType(pm.retType)) return il.typeInfo(pm.retType).kind === T.STRING ? il.readString(this.raw >>> 0) : interop.wrap(this.raw >>> 0);
    return il.unmarshalReturn({ value: this.raw, retAddr: 0, ret: pm.ret });
  }

  /** Set the return value. In a prefix, also skips the original. */
  set result(value) { this.setResult(value); }

  setResult(value) {
    const pm = this._pm;
    const il = this.loader.il;
    const interop = this.loader.interop;
    value = interop.unwrap(value);
    if (pm.ret.wasm === 'ptr') interop.write(this.args[0] >>> 0, pm.retType, value);
    else if (il.typeInfo(pm.retType).kind === T.STRING && typeof value === 'string') this.raw = il.newString(value);
    else if (pm.ret.wasm === 'i64') this.raw = BigInt.asIntN(64, BigInt(value));
    else if (pm.ret.wasm === 'f32' || pm.ret.wasm === 'f64') this.raw = Number(value);
    else if (typeof value === 'boolean') this.raw = value ? 1 : 0;
    else if (pm.ret.single && value && typeof value === 'object') this.raw = Number(Object.values(value)[0]) | 0;
    else this.raw = Number(value ?? 0) | 0;
    if (this.raw === undefined && pm.ret.wasm !== 'ptr') this.raw = 0;
    this.skipOriginal = true;
  }

  /** Call the original method yourself (e.g. from a prefix that returns false). */
  callOriginal() {
    this.raw = this._pm.original(...this.args);
    return this.result;
  }
}
