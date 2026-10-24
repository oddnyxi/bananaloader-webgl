// Runs at document-start, before the game's loader:
//  1. rewrite the game's wasm before it compiles, so patched methods also catch direct calls
//  2. keep keystrokes typed into the explorer away from the game's key handlers
// (Finding the game, the Module and the wasm is the shared bootstrap's job: see src/bootstrap.)

import { rewriteDirectCalls } from './loader/wasmrewrite.js';

// Own global (Unity Explorer's userscript may be on the same page with its own hooks).
const state = window.__bananaHooks || (window.__bananaHooks = { wasm: null });
const PLAN_PREFIX = 'bananaloader:direct:';
const HOST_ID = 'unity-explorer-host';

export function installHooks() {
  // ---- 2. direct-call patching: rewrite the game's wasm before it compiles (see wasmrewrite.js)
  installWasmHook();

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
    P.addEventListener = function (type, fn, opts) {
      if (KEYS.has(type) && typeof fn === 'function' && (this === window || this === document || this instanceof HTMLCanvasElement)) {
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
      const w = typeof fn === 'function' && wrapped.get(fn);
      return remove.call(this, type, w || fn, opts);
    };
  }
  return state;
}

export const EXPLORER_HOST_ID = HOST_ID;

/** Saved list of table slots whose direct calls should be rewritten, per game build. */
export function readPlan(key) {
  try { return JSON.parse(localStorage.getItem(PLAN_PREFIX + key) || 'null'); } catch (_) { return null; }
}
export function writePlan(key, plan) {
  try {
    if (plan && plan.slots.length) localStorage.setItem(PLAN_PREFIX + key, JSON.stringify(plan));
    else localStorage.removeItem(PLAN_PREFIX + key);
  } catch (_) { /* ignore */ }
}

function installWasmHook() {
  const W = WebAssembly;
  if (W.__bananaHooked) return;
  W.__bananaHooked = true;
  const origStreaming = W.instantiateStreaming;
  const origInstantiate = W.instantiate;
  const disabled = () => { try { return JSON.parse(localStorage.getItem('bananaloader:settings') || '{}').directCalls === false || JSON.parse(localStorage.getItem('bananaloader:settings') || '{}').safeMode === true; } catch (_) { return false; } };
  const big = (n) => n > 4 << 20; // only the game module, not tiny helper modules

  const apply = (bytes, key) => {
    const info = { key, byteLength: bytes.length, applied: [], sites: 0, ms: 0, error: null };
    state.wasm = info;
    const plan = disabled() ? null : readPlan(key);
    // Rewriting is always semantically safe (a call through slot S still reaches the function
    // in S), so a plan from an older build only costs a few useless indirect calls.
    if (!plan || !plan.slots || !plan.slots.length) return bytes;
    const t0 = performance.now();
    try {
      const r = rewriteDirectCalls(bytes, plan.slots);
      info.applied = plan.slots.filter((x) => !r.missing.includes(x));
      info.sites = r.sites;
      info.ms = Math.round(performance.now() - t0);
      return r.bytes;
    } catch (e) {
      info.error = String(e && e.message || e);
      return bytes;
    }
  };

  if (origStreaming) {
    W.instantiateStreaming = async function (source, imports) {
      const resp = await source;
      let key = '';
      try { key = 'url:' + new URL(resp.url, location.href).pathname; } catch (_) { /* ignore */ }
      const plan = key && !disabled() ? readPlan(key) : null;
      if (!plan) {
        const len = +resp.headers.get('content-length') || 0;
        if (key && (!len || big(len))) state.wasm = { key, byteLength: len, applied: [], sites: 0, streaming: true };
        return origStreaming.call(this, resp, imports);
      }
      const bytes = new Uint8Array(await resp.arrayBuffer());
      return origInstantiate.call(this, apply(bytes, key), imports);
    };
  }
  W.instantiate = function (src, imports) {
    if (src instanceof W.Module) return origInstantiate.call(this, src, imports);
    const bytes = src instanceof Uint8Array ? src : ArrayBuffer.isView(src) ? new Uint8Array(src.buffer, src.byteOffset, src.byteLength) : new Uint8Array(src);
    if (!big(bytes.length)) return origInstantiate.call(this, src, imports);
    return origInstantiate.call(this, apply(bytes, 'buf:' + bytes.length), imports);
  };
}
