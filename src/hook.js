// Runs at document-start, before the game's loader:
//  1. rewrite the game's wasm before it compiles, so patched methods also catch direct calls
//  2. keep keystrokes typed into the explorer away from the game's key handlers
// (Finding the game, the Module and the wasm is the shared bootstrap's job: see src/bootstrap.)

import { rewriteDirectCalls } from './loader/wasmrewrite.js';
import { getBootstrap } from './bootstrap/index.js';

// Own global (Unity Explorer's userscript may be on the same page with its own hooks).
const state = window.__bananaHooks || (window.__bananaHooks = { wasm: null });
const PLAN_PREFIX = 'bananaloader:direct:';
const SETTINGS_KEY = 'bananaloader:settings';
const HOST_ID = 'unity-explorer-host';

export function installHooks() {
  // ---- 2. direct-call patching: rewrite the game's wasm before it compiles (see wasmrewrite.js)
  if (typeof WebAssembly === 'object' && WebAssembly) installWasmHook();

  // ---- 3. key shield
  const P = EventTarget.prototype;
  if (!P.__ueAdd) {
    const add = P.addEventListener;
    const remove = P.removeEventListener;
    P.__ueAdd = add;
    P.__ueRemove = remove;
    const wrapped = new WeakMap();
    const KEYS = new Set(['keydown', 'keyup', 'keypress']);
    const fromUs = (e) => {
      const t = e.target;
      return !!(t && t.id === HOST_ID);
    };
    // only key listeners on the window, the document and canvases are wrapped (and unwrapped)
    const shielded = (self, type, fn) => KEYS.has(type) && typeof fn === 'function' && (self === window || self === document || self instanceof HTMLCanvasElement);
    P.addEventListener = function (type, fn, opts) {
      if (shielded(this, type, fn)) {
        let w = wrapped.get(fn);
        if (!w) {
          w = function (e) { if (fromUs(e)) return undefined; return fn.call(this, e); };
          wrapped.set(fn, w);
        }
        return add.call(this, type, w, opts);
      }
      return add.call(this, type, fn, opts);
    };
    P.removeEventListener = function (type, fn, opts) {
      const w = shielded(this, type, fn) && wrapped.get(fn);
      return remove.call(this, type, w || fn, opts);
    };
  }
  return state;
}

export const EXPLORER_HOST_ID = HOST_ID;

/** Saved list of table slots whose direct calls should be rewritten, per game build. */
export function readPlan(key) {
  try {
    const p = JSON.parse(localStorage.getItem(PLAN_PREFIX + key) || 'null');
    return p && typeof p === 'object' && Array.isArray(p.slots) ? p : null;
  } catch (_) { return null; }
}
export function writePlan(key, plan) {
  try {
    if (plan && plan.slots.length) localStorage.setItem(PLAN_PREFIX + key, JSON.stringify(plan));
    else localStorage.removeItem(PLAN_PREFIX + key);
  } catch (_) { /* ignore */ }
}

/** The loader's settings, read straight from storage (the loader doesn't exist yet at document-start). */
function settings() {
  try { const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); return s && typeof s === 'object' ? s : {}; } catch (_) { return {}; }
}

function installWasmHook() {
  const W = WebAssembly;
  if (W.__bananaHooked) return;
  W.__bananaHooked = true;
  const origStreaming = W.instantiateStreaming;
  const origInstantiate = W.instantiate;
  // direct-call patching is off in Settings, or safe mode is on
  const disabled = () => { const s = settings(); return s.directCalls === false || s.safeMode === true; };
  // "catch direct calls without reloading": every function in the table gets its direct calls rewritten
  const everything = () => settings().directCallsAll === true;
  const big = (n) => n > 4 << 20; // only the game module, not tiny helper modules

  /** Record the game module: the biggest one (a smaller codec or physics wasm loaded later doesn't replace it). */
  const record = (info) => {
    const cur = state.wasm;
    // a bigger module replaces it; so does any big module when the recorded one's size wasn't known
    if (cur && cur.compiled && !(info.byteLength && (cur.byteLength ? info.byteLength > cur.byteLength : big(info.byteLength)))) return false;
    state.wasm = info;
    return true;
  };

  /** Rewrite `bytes` per the saved plan (or everything); returns the bytes to compile. */
  const apply = (bytes, key) => {
    const off = disabled();
    const all = !off && everything();
    const info = { key, byteLength: bytes.length, applied: [], missing: [], sites: 0, ms: 0, error: null, disabled: off, mode: all ? 'all' : 'plan' };
    if (!record(info)) return { bytes, info: null };
    const plan = off || all ? null : readPlan(key);
    // Rewriting is always semantically safe (a call through slot S still reaches the function
    // in S), so a plan from an older build only costs a few useless indirect calls.
    if (!all && (!plan || !plan.slots.length)) return { bytes, info };
    const t0 = performance.now();
    try {
      const r = rewriteDirectCalls(bytes, all ? 'all' : plan.slots);
      info.applied = all ? [] : plan.slots.filter((x) => !r.missing.includes(x));
      info.missing = r.missing;
      info.slotVia = r.slotVia; // slot -> the slot its function's direct calls now go through (-1: not rewritten)
      info.shared = r.shared;   // slot -> 1 when its function also sits in other slots (merged identical methods)
      info.sites = r.sites;
      info.skipped = r.skipped; // function bodies that couldn't be decoded: their direct calls (if any) were left alone
      info.ms = Math.round(performance.now() - t0);
      if (r.bytes !== bytes) {
        info.rewritten = true;
        // the bootstrap analyses (and dumps) the game's own bytes, not ours
        try { const boot = getBootstrap(); if (boot && boot.originalBytes instanceof WeakMap) boot.originalBytes.set(r.bytes, bytes); } catch (_) { /* ignore */ }
      }
      return { bytes: r.bytes, info, original: bytes };
    } catch (e) {
      info.error = String(e && e.message || e);
      return { bytes, info };
    }
  };

  /** Compile the rewritten bytes; if that fails, forget the plan and compile the original. */
  const compile = (self, out, imports, rest) => {
    const p = origInstantiate.call(self, out.bytes, imports, ...rest);
    if (!out.original) return p.then((r) => { if (out.info) out.info.compiled = true; return r; });
    return p.then((r) => { out.info.compiled = true; return r; }, (e) => {
      // a decoder desync would otherwise break the game on every load
      out.info.error = `the rewritten module didn't compile (${e && e.message || e}); loaded the original`;
      out.info.applied = []; out.info.slotVia = null; out.info.shared = null; out.info.mode = 'plan';
      if (out.info.key) writePlan(out.info.key, null);
      out.info.allOff = true; // the loader read its settings before this: it turns the setting off in its copy too
      try { const s = settings(); if (s.directCallsAll) { s.directCallsAll = false; localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } } catch (_) { /* ignore */ }
      return origInstantiate.call(self, out.original, imports, ...rest).then((r) => { out.info.compiled = true; return r; });
    });
  };

  if (origStreaming) {
    W.instantiateStreaming = async function (source, imports, ...rest) {
      const resp = await source;
      let key = '';
      try { key = 'url:' + new URL(resp.url, location.href).pathname; } catch (_) { /* ignore */ }
      const plan = key && !disabled() ? readPlan(key) : null;
      const wantBytes = key && !disabled() && (everything() || (plan && plan.slots.length));
      if (!wantBytes) {
        // Content-Length is the size on the wire: a 20 MB wasm served brotli can be 4 MB
        let len = 0, enc = '';
        try { len = +resp.headers.get('content-length') || 0; enc = (resp.headers.get('content-encoding') || '').toLowerCase(); } catch (_) { /* ignore */ }
        const encoded = enc && enc !== 'identity';
        let info = null;
        if (key && (!len || encoded || big(len))) {
          info = { key, byteLength: encoded ? 0 : len, applied: [], missing: [], sites: 0, streaming: true, disabled: disabled(), mode: 'plan' };
          if (!record(info)) info = null;
        }
        const p = origStreaming.call(this, resp, imports, ...rest);
        if (!info) return p;
        return p.then((r) => {
          // an encoded small response may still be a helper module: keep it only if it looks like the game
          try {
            const m = r && r.module;
            const n = m ? W.Module.exports(m).length + W.Module.imports(m).length : 0;
            if (encoded && len && !big(len) && m && n < 40) { if (state.wasm === info) state.wasm = null; } else info.compiled = true;
          } catch (_) { info.compiled = true; }
          return r;
        }, (e) => { if (state.wasm === info) state.wasm = null; throw e; });
      }
      const bytes = new Uint8Array(await resp.arrayBuffer());
      if (!big(bytes.length)) return origInstantiate.call(this, bytes, imports, ...rest);
      return compile(this, apply(bytes, key), imports, rest);
    };
  }
  W.instantiate = function (src, imports, ...rest) {
    if (src instanceof W.Module) return origInstantiate.call(this, src, imports, ...rest);
    // anything that isn't bytes goes to the browser untouched (it rejects bad arguments itself)
    const bytes = src instanceof Uint8Array ? src : ArrayBuffer.isView(src) ? new Uint8Array(src.buffer, src.byteOffset, src.byteLength) : src instanceof ArrayBuffer ? new Uint8Array(src) : null;
    if (!bytes || !big(bytes.length)) return origInstantiate.call(this, src, imports, ...rest);
    return compile(this, apply(bytes, 'buf:' + bytes.length), imports, rest);
  };
}
