// Harmony-style patching for IL2CPP methods in WebGL builds.
//
// Every managed method compiles to a wasm function that lives in the function table (on
// fastcomp builds, Unity 2018 – 2021.1, inside its signature's sub-table: Il2Cpp.slotOf). Calls
// that go through the table — virtual and interface calls, delegates, Unity messages
// (Update, Start, OnTriggerEnter…), reflection and engine callbacks — can be intercepted by
// swapping that table slot for a wasm-typed JS wrapper. Direct (non-virtual) calls compiled
// into game code don't use the table: hook.js rewrites them to go through it when the game's
// wasm loads (the saved plan, or every function with the "without reloading" setting).

import { wasmFunction } from './wasmfn.js';
import { readPlan, writePlan } from '../hook.js';
import { T } from '../il2cpp/types.js';

export class Patcher {
  constructor(loader) {
    this.loader = loader;
    this.byPtr = new Map(); // table index -> PatchedMethod (every slot that holds the function)
    this.all = new Set();   // Patch handles
  }

  get il() { return this.loader.il; }

  /** Resolve a target into a callable descriptor (see Interop.resolveMethod). */
  resolve(target, sig) {
    if (!this.loader.interop || !this.loader.il) throw new Error('patch: IL2CPP isn\'t ready yet (patch from onInitializeBanan or later)');
    return this.loader.interop.resolveMethod(target, sig);
  }

  /**
   * @param owner  the Banan (or null for the loader)
   * @param target "Type::Method", or a method record
   * @param hooks  { prefix?(ctx) -> false to skip, postfix?(ctx), sig?, priority? }
   */
  patch(owner, target, hooks) {
    hooks = hooks || {};
    const il = this.il;
    const d = this.resolve(target, hooks.sig);
    const why = il.whyNotCallable(d);
    if (why) throw new Error(`patch: can't patch ${d.label}: ${why}`);
    const ptr = il.slotOf(d); // the real table slot (fastcomp: per-signature table + pointer)
    if (!ptr) throw new Error(`patch: can't patch ${d.label}: ${d._noSlot || 'no code'}`);
    let pm = this.byPtr.get(ptr);
    if (!pm) {
      pm = new PatchedMethod(this, d, ptr);
      this.byPtr.set(ptr, pm);
    } else if (pm.bare) {
      pm.adopt(d); // it was only relaying direct calls for another slot until now
    } else if (pm.method.label !== d.label && !d.mi) {
      this.loader.log.warn(`${d.label} shares its code with ${pm.method.label}; both are patched`);
    }
    // the relay only adds direct-call coverage through a merged slot: if it can't be set up, patch without it
    try { this._relay(pm, d); } catch (e) { this.loader.log.warn(`${d.label}: direct calls through its merged code won't be caught (${e && e.message || e})`); }
    const p = {
      owner,
      method: d,
      view: pm.viewFor(d),
      slot: ptr,
      target: d.label,
      // shared generic code serves several instantiations: only run for ours (the caller passes its MethodInfo*)
      mi: d.mi || 0,
      prefix: hooks.prefix || null,
      postfix: hooks.postfix || null,
      priority: hooks.priority || 0,
      calls: 0,
      errors: 0,
      active: true,     // false once unpatched, or auto-disabled after too many errors
      removed: false,
      unpatch: () => this.unpatch(p),
    };
    pm.add(p);
    this.all.add(p);
    p.coverage = this.coverage(ptr, !!owner);
    if (owner) this._savePlan();
    this.loader.emit('patches');
    return p;
  }

  /** What the document-start hook did with the game's wasm (null if it loaded before us). */
  get wasm() { return (window.__bananaHooks && window.__bananaHooks.wasm) || null; }

  /** The slot direct calls to `ptr`'s function were rewritten to go through, or -1. */
  viaSlot(ptr) {
    const w = this.wasm;
    return w && w.slotVia && ptr < w.slotVia.length ? w.slotVia[ptr] : -1;
  }

  /** Is `ptr`'s function also in other slots (identical methods merged by the compiler)? */
  shared(ptr) {
    const w = this.wasm;
    return !!(w && w.shared && ptr < w.shared.length && w.shared[ptr]);
  }

  /**
   * Direct calls to a merged function go through one "via" slot. If that's another method's
   * slot, it gets a relay that also runs this method's hooks for direct calls.
   */
  _relay(pm, d) {
    const v = this.viaSlot(pm.ptr);
    if (v < 0 || v === pm.ptr || pm.host) return;
    let host = this.byPtr.get(v);
    if (!host) {
      host = new PatchedMethod(this, d, v); // same code, so the same wasm signature
      host.bare = true;
      this.byPtr.set(v, host);
    }
    host.guests.add(pm);
    pm.host = host;
  }

  /**
   * Which calls a patch on `ptr` catches:
   *  'all'      every call (direct calls were rewritten to go through the table when the game loaded)
   *  'most'     every call, except direct calls in a few function bodies the rewriter couldn't decode
   *  'pending'  indirect calls now; direct calls too after a reload (saved in the plan)
   *  'indirect' indirect calls only, and a reload doesn't change that
   */
  coverage(ptr, owned) {
    const w = this.wasm;
    const S = this.loader.settings || {};
    const canRewrite = S.directCalls !== false && !S.safeMode;
    if (!w) return 'indirect';
    if (this.viaSlot(ptr) >= 0) return w.skipped ? 'most' : 'all';
    if (w.mode === 'all' && w.slotVia && !w.error) return 'indirect'; // everything was rewritten: this slot's function is imported or not in the table
    if (w.error || (w.missing && w.missing.includes(ptr))) return 'indirect';
    // only Banan patches are saved for the next load: console patches don't outlive the page
    return owned && canRewrite ? 'pending' : 'indirect';
  }

  /** Remember which functions need their direct calls rewritten on the next load. */
  _savePlan() {
    clearTimeout(this._pt);
    this._pt = setTimeout(() => {
      const w = this.wasm;
      // after a rewrite that didn't compile, hook.js dropped the plan: don't write it back (every load would fail again)
      if (!w || !w.key || w.error || this.loader.settings.directCalls === false) return;
      const slots = new Set();
      const labels = {};
      for (const p of this.all) if (p.owner && p.active) { slots.add(p.slot); labels[p.slot] = p.target; }
      const prev = readPlan(w.key);
      writePlan(w.key, { byteLength: w.byteLength, slots: [...slots], labels, saved: Date.now() });
      if (!prev || JSON.stringify([...(prev.slots || [])].sort()) !== JSON.stringify([...slots].sort())) this.loader.emit('patches');
    }, 300);
  }

  /** Patches that will also catch direct calls after a reload. */
  pendingDirect() { return [...this.all].filter((p) => p.owner && p.active && p.coverage === 'pending'); }

  unpatch(p) {
    if (p.removed) return; // auto-disabled patches (active false) can still be removed
    p.removed = true;
    p.active = false;
    this.all.delete(p);
    if (p.owner) this._savePlan();
    const pm = this.byPtr.get(p.slot);
    if (pm) {
      pm.remove(p);
      if (!pm.patches.length) this._release(pm);
    }
    this.loader.emit('patches');
  }

  /** A slot with no patches left: put the original back, unless it still relays for others. */
  _release(pm) {
    if (pm.patches.length) return;
    if (pm.guests.size) { pm.bare = true; return; }
    pm.restore();
    if (this.byPtr.get(pm.ptr) === pm) this.byPtr.delete(pm.ptr);
    const host = pm.host;
    if (host) { pm.host = null; host.guests.delete(pm); this._release(host); }
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
    this.guests = new Set(); // other slots' methods whose direct calls arrive here (merged code)
    this.host = null;        // the slot relaying our direct calls, when it isn't ours
    this.bare = false;       // only relaying for guests, no patches of its own
    this.shared = patcher.shared(ptr);
    this._isOurs = new Map(); // Il2CppClass* -> is it the declaring class (or a subclass)?
    this.views = new Map(); // method label -> how to read that method's arguments
    this.base = this.viewFor(m);
    this.ret = this.base.ret;
    for (const a of [this.ret, ...this.base.argAbi]) if (a.wasm === 'unsupported') throw new Error(`patch: unsupported signature (${a.why})`);
    // The wrapper must have exactly the wasm type of the function it replaces (call_indirect
    // checks it). callSig() knows it, including fastcomp's split 64-bit values and f64 floats.
    const cs = il.callSig(m);
    if (cs.error) throw new Error(`patch: ${cs.error}`);
    if (il.flavor === 'fastcomp' && !cs.exact) throw new Error('patch: the exact wasm signature is unknown on this fastcomp build (reload the page so the bootstrap sees the wasm)');
    this.cs = cs;
    this.sig = cs.params;
    this.result = cs.ilResult; // IL-level result type; cs.retOut converts it for the wasm side
    this.original = il.table.get(ptr);
    if (!this.original) throw new Error(`patch: table slot ${ptr} is empty`);
    if (this.original.length !== cs.params.length) throw new Error(`patch: signature mismatch (${cs.params.length} vs ${this.original.length} params)`);
    const self = this;
    this.wrapper = wasmFunction(function bananaHook(...raw) { return cs.retOut(self.call(cs.join(raw))); }, cs.params, cs.result);
    il.table.set(ptr, this.wrapper);
    il._fn.delete(ptr); // the bridge caches table entries; make our own calls see the patch
  }

  /** This slot was only relaying for guests; now it's patched itself. */
  adopt(d) {
    this.bare = false;
    this.method = d;
    this.base = this.viewFor(d);
  }

  /** Argument and return layout of one of the methods sharing this code (shared generics, merged code). */
  viewFor(d) {
    let v = this.views.get(d.label);
    if (v) return v;
    const il = this.patcher.il;
    const ret = il.abi(d.retType, true);
    v = {
      method: d,
      params: d.params,
      retType: d.retType,
      isStatic: d.isStatic,
      ret,
      argAbi: d.params.map((p) => il.abi(p.type)),
      // IL-level args: [sret?] [this? — static methods had an unused one until Unity 2018.3] args… MethodInfo*
      offset: (ret.wasm === 'ptr' ? 1 : 0) + (il.hasThis(d) ? 1 : 0),
    };
    this.views.set(d.label, v);
    return v;
  }

  add(p) {
    this.patches.push(p);
    this.patches.sort((a, b) => b.priority - a.priority);
  }

  remove(p) { this.patches = this.patches.filter((x) => x !== p); }

  /** Call the unpatched function with IL-level arguments; returns the IL-level result. */
  invokeOriginal(args) { return this.cs.retIn(this.original(...this.cs.split(args))); }

  restore() {
    const il = this.patcher.il;
    // only put back what we replaced: another tool may have swapped the slot since
    if (il.table.get(this.ptr) === this.wrapper) il.table.set(this.ptr, this.original);
    il._fn.delete(this.ptr);
  }

  /**
   * A direct call to merged code can't say which of the merged methods it meant. For instance
   * methods, `this` tells: a patch only runs when the object is of the patched method's class.
   */
  _ours(p, raw) {
    const v = p.view;
    if (v.isStatic || !(v.method.declTd >= 0)) return true;
    const il = this.patcher.il;
    if (il.md.typeDef(v.method.declTd).isValueType) return true;
    const self = raw[v.ret.wasm === 'ptr' ? 1 : 0] >>> 0;
    if (!self) return true;
    // `self` may be a merged static twin's first argument (any number): never let a bad read reach the game
    try {
      if (il.mem.valid && !il.mem.valid(self)) return false;
      const key = il.klassOf(self) + ':' + v.method.declTd;
      let ok = this._isOurs.get(key);
      if (ok === undefined) { ok = il.isInstanceOf(self, v.method.declTd); this._isOurs.set(key, ok); }
      return ok;
    } catch (_) { return false; }
  }

  call(raw) {
    const callerMi = raw[raw.length - 1] >>> 0; // IL-level args: the MethodInfo* is always last
    // IL2CPP passes no MethodInfo* on direct calls to non-generic methods, and one on virtual,
    // delegate and reflection calls: a call without one may be meant for a merged twin
    const direct = !callerMi;
    let list = this.patches.slice(); // a hook may patch or unpatch this method while we run
    if (direct && this.guests.size) {
      for (const g of this.guests) list.push(...g.patches);
      list.sort((a, b) => b.priority - a.priority);
    }
    const ambiguous = direct && (this.shared || this.guests.size > 0);
    const applies = (p) => p.active && (!p.mi || !callerMi || callerMi === p.mi) && (!ambiguous || this._ours(p, raw));
    // the instantiation being called decides how arguments are read (shared generic code)
    const own = (callerMi && list.find((p) => p.mi === callerMi)) || list.find(applies);
    const view = own ? own.view : this.base;
    const ctx = new HookContext(this, view, raw);
    let run = true;
    for (const p of list) {
      if (!p.prefix || !applies(p)) continue;
      p.calls++;
      try {
        if (p.prefix.call(p.owner, ctx) === false) run = false;
      } catch (e) {
        // the original threw (from ctx.callOriginal()): that's the game's exception, not the hook's
        if (ctx._origThrew && (e === ctx._origErr || (e && e.raw === ctx._origErr))) throw ctx._origErr;
        this._fail(p, 'prefix', e);
      }
    }
    if (run && !ctx.skipOriginal && !ctx._origCalled) ctx._origRaw = ctx.raw = this.invokeOriginal(ctx.args);
    else if (view.ret.wasm === 'ptr' && !ctx._resultSet && !ctx._origCalled) ctx._zeroResult(); // skipped without a result: don't hand back the caller's garbage
    for (const p of list) {
      if (!p.postfix || !applies(p)) continue;
      if (!p.prefix) p.calls++;
      try { p.postfix.call(p.owner, ctx); } catch (e) {
        if (ctx._origThrew && (e === ctx._origErr || (e && e.raw === ctx._origErr))) throw ctx._origErr;
        this._fail(p, 'postfix', e);
      }
    }
    try {
      if (this.result === 'i64') return BigInt.asIntN(64, BigInt(ctx.raw ?? 0n));
      if (this.result === 'i32') return Number(ctx.raw ?? 0) | 0;
      if (this.result) return Number(ctx.raw ?? 0);
      return undefined;
    } catch (e) {
      // a hook left a value of the wrong kind in ctx.raw (a fraction for a long…): log it, don't crash the game
      const log = (own && own.owner && own.owner.logger) || this.patcher.loader.log;
      log.error(`${view.method.label}: the hooks' return value ${typeof ctx.raw === 'bigint' ? ctx.raw + 'n' : String(ctx.raw)} doesn't fit a ${this.result}: ${e && e.message || e}`);
      const v = ctx._origRaw;
      if (this.result === 'i64') return typeof v === 'bigint' ? v : 0n;
      if (this.result === 'i32') return typeof v === 'number' ? v | 0 : 0;
      return this.result ? (typeof v === 'number' ? v : 0) : undefined;
    }
  }

  _fail(p, where, e) {
    p.errors++;
    const log = p.owner && p.owner.logger ? p.owner.logger : this.patcher.loader.log;
    if (p.errors <= 5) log.error(`${where} on ${p.target} threw: ${e && e.stack || e}`);
    if (p.errors === 100) {
      p.active = false; // stays in the list (greyed out) until it's unpatched or its Banan unloads
      log.error(`${p.target}: patch disabled after 100 errors`);
      this.patcher.loader.emit('patches');
    }
  }
}

/** What a prefix / postfix receives. */
class HookContext {
  constructor(pm, view, raw) {
    this._pm = pm;
    this._v = view;
    this.args = raw.slice();             // raw wasm arguments; edit via setArg()
    this.raw = undefined;                // raw return value
    this.skipOriginal = false;
    this.method = view.method;
  }

  get loader() { return this._pm.patcher.loader; }
  get name() { return this._v.method.name; }
  /** Raw `this` pointer (0 for static methods). For struct methods, the address of the struct's data. */
  get self() {
    if (this._v.isStatic) return 0;
    const p = this.args[this._v.ret.wasm === 'ptr' ? 1 : 0] >>> 0;
    // Unity 2018 – 2021.1: struct methods are called through an adjustor thunk, which gets the boxed object
    return p && this.loader.il.boxedThis(this._v.method) ? p + 8 : p;
  }
  /** `this` as an Il2Cpp proxy (null for static methods and for struct methods: read ctx.self). */
  get instance() {
    if (this._v.isStatic) return null;
    const il = this.loader.il;
    const declTd = this._v.method.declTd;
    // value-type methods get the unboxed data, which has no object header to read a class from
    if (declTd >= 0 && il.md.typeDef(declTd).isValueType) return null;
    return this.loader.interop.wrap(this.self);
  }
  get argCount() { return this._v.params.length; }
  paramName(i) { return this._v.params[i].name; }

  /** Argument i as a JS value (strings decoded, objects as proxies, structs as objects). */
  arg(i) {
    const v = this._v;
    const il = this.loader.il;
    const interop = this.loader.interop;
    const p = v.params[i];
    const x = this.args[v.offset + i];
    const a = v.argAbi[i];
    if (a.byref) return interop.read(x >>> 0, p.type);
    if (a.wasm === 'ptr') return interop.read(x >>> 0, p.type);
    if (interop.isRefType(p.type)) return il.typeInfo(p.type).kind === T.STRING ? il.readString(x >>> 0) : interop.wrap(x >>> 0);
    return il.unmarshalReturn({ value: x, retAddr: 0, ret: a });
  }

  /** Replace argument i (prefix only). Strings, numbers, booleans, proxies, structs. */
  setArg(i, value) {
    const v = this._v;
    const il = this.loader.il;
    const interop = this.loader.interop;
    const p = v.params[i];
    const a = v.argAbi[i];
    const at = v.offset + i;
    // reference parameters: proxies, null, strings, type proxies, and numbers/bools boxed for `object`
    if (!a.byref && a.wasm !== 'ptr' && interop.isRefType(p.type)) { this.args[at] = interop._toRef(p.type, value, il.typeInfo(p.type).kind) | 0; return; }
    value = interop.unwrap(value);
    if (a.singleByPtr && !isObj(value)) { writeScalar(il, this.args[at] >>> 0, a.singleByPtr.wasm, value); return; } // fastcomp: one-scalar struct by pointer
    if (a.byref || a.wasm === 'ptr') { interop.write(this.args[at] >>> 0, p.type, value); return; }
    if (a.single && isObj(value)) value = Object.values(value)[0]; // {field: x} for a one-scalar struct
    this.args[at] = toWasm(a.wasm, value);
  }

  /** Return value as a JS value (postfix), or what was set with setResult. */
  get result() {
    const v = this._v;
    const il = this.loader.il;
    const interop = this.loader.interop;
    if (v.ret.wasm === 'void') return undefined;
    if (v.ret.wasm === 'ptr') return interop.read(this.args[0] >>> 0, v.retType);
    if (this.raw === undefined) return undefined;
    if (v.ret.byref) return this.raw >>> 0 ? interop.read(this.raw >>> 0, v.retType) : null; // ref return: the value it points at
    if (interop.isRefType(v.retType)) return il.typeInfo(v.retType).kind === T.STRING ? il.readString(this.raw >>> 0) : interop.wrap(this.raw >>> 0);
    return il.unmarshalReturn({ value: this.raw, retAddr: 0, ret: v.ret });
  }

  /** Set the return value. In a prefix, also skips the original. */
  set result(value) { this.setResult(value); }

  setResult(value) {
    const v = this._v;
    const il = this.loader.il;
    const interop = this.loader.interop;
    if (v.ret.wasm !== 'ptr' && !v.ret.byref && interop.isRefType(v.retType)) {
      this.raw = interop._toRef(v.retType, value, il.typeInfo(v.retType).kind) | 0;
      this._resultSet = true;
      this.skipOriginal = true;
      return;
    }
    value = interop.unwrap(value);
    if (v.ret.wasm === 'ptr') interop.write(this.args[0] >>> 0, v.retType, value);
    else if (v.ret.byref) {
      // a number is the address to return; anything else is written where the returned reference points
      if (typeof value === 'number') this.raw = value | 0;
      else if (this.raw) interop.write(this.raw >>> 0, v.retType, value);
      else throw new Error('setResult: a ref return needs an address (call the original first, or pass a pointer)');
    }
    else this.raw = toWasm(v.ret.wasm, v.ret.single && isObj(value) ? Object.values(value)[0] : value);
    if (this.raw === undefined && v.ret.wasm !== 'ptr') this.raw = 0;
    this._resultSet = true;
    this.skipOriginal = true;
  }

  /** Call the original method yourself (e.g. from a prefix that returns false). */
  callOriginal() {
    this._origCalled = true;
    try {
      this.raw = this._pm.invokeOriginal(this.args);
    } catch (e) {
      // a managed exception: hand the hook a readable error; if the hook lets it go, the game gets the original exception
      this._origThrew = true;
      this._origErr = e;
      let w = e;
      try { w = this.loader.il._wrapError(e); if (w !== e) w.raw = e; } catch (_) { w = e; }
      throw w;
    }
    this._origRaw = this.raw;
    return this.result;
  }

  _zeroResult() {
    const il = this.loader.il;
    const size = this._v.ret.size || 0;
    if (size > 0 && this.args[0]) il.mem.fill(this.args[0] >>> 0, 0, size);
  }
}

const isObj = (v) => v !== null && typeof v === 'object';

/** Does a parameter of this type take a managed object a JS string can become (string, object)? */
/** A JS value as a raw wasm argument / result of the given kind. */
function toWasm(kind, value) {
  if (kind === 'i64') return BigInt.asIntN(64, typeof value === 'bigint' ? value : BigInt(Math.trunc(Number(value ?? 0)) || 0));
  if (kind === 'f32' || kind === 'f64') return Number(value ?? 0);
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'bigint') return Number(BigInt.asIntN(32, value));
  return Number(value ?? 0) | 0;
}

function writeScalar(il, addr, kind, value) {
  if (kind === 'i64') il.mem.setI64(addr, toWasm('i64', value));
  else if (kind === 'f32') il.mem.setF32(addr, Number(value ?? 0));
  else if (kind === 'f64') il.mem.setF64(addr, Number(value ?? 0));
  else il.mem.setI32(addr, toWasm('i32', value));
}
