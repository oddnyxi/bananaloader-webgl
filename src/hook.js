// Runs at document-start, before the game's loader:
//  1. capture the Emscripten Module when the framework assigns Module.asm
//  2. keep keystrokes typed into the explorer away from the game's key handlers

import { rewriteDirectCalls } from './loader/wasmrewrite.js';

const state = { Module: null, waiters: [], wasm: null };
const PLAN_PREFIX = 'bananaloader:direct:';
const HOST_ID = 'unity-explorer-host';

function found(M) {
  if (state.Module) return;
  state.Module = M;
  for (const w of state.waiters.splice(0)) w(M);
}

export function installHooks() {
  if (window.__ueHooks) return window.__ueHooks;
  window.__ueHooks = state;

  // ---- 1. Module.asm = exports  (all Unity 2019–6000 frameworks do this)
  try {
    if (!Object.getOwnPropertyDescriptor(Object.prototype, 'asm')) {
      Object.defineProperty(Object.prototype, 'asm', {
        configurable: true,
        enumerable: false,
        get() { return undefined; },
        set(v) {
          Object.defineProperty(this, 'asm', { value: v, writable: true, configurable: true, enumerable: true });
          if (v && typeof v === 'object' && ('locateFile' in this || 'preRun' in this || 'HEAPU8' in this)) found(this);
        },
      });
    }
  } catch (_) { /* ignore */ }

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

/** Look for an already-running Unity instance (script injected after the game loaded). */
export function findModuleInPage() {
  if (state.Module) return state.Module;
  const ok = (M) => M && typeof M === 'object' && M.HEAPU8 && (M.asm || M.wasmExports);
  const names = ['unityInstance', 'unityGameInstance', 'gameInstance', 'myGameInstance', 'unity', 'UnityInstance', 'game'];
  for (const n of names) {
    try {
      const v = window[n];
      if (v && ok(v.Module)) return v.Module;
      if (ok(v)) return v;
    } catch (_) { /* ignore */ }
  }
  try { if (ok(window.Module)) return window.Module; } catch (_) { /* ignore */ }
  for (const k of Object.keys(window)) {
    try {
      const v = window[k];
      if (v && typeof v === 'object' && ok(v.Module) && typeof v.SendMessage === 'function') return v.Module;
    } catch (_) { /* ignore */ }
  }
  return null;
}

/** Resolves as soon as a Unity Module exists on the page (captured or found), never on other sites. */
export function detectUnity() {
  return new Promise((resolve) => {
    if (state.Module) return resolve(state.Module);
    state.waiters.push(resolve);
    let n = 0;
    const iv = setInterval(() => {
      if (state.Module) { clearInterval(iv); return; }
      const M = n++ < 60 ? findModuleInPage() : null;
      if (M) { clearInterval(iv); found(M); }
      if (n > 600) clearInterval(iv);
    }, 1000);
  });
}

/** Resolves with the Module once its runtime has started. */
export function waitForModule(onStatus) {
  return new Promise((resolve) => {
    const check = () => {
      const M = state.Module || findModuleInPage();
      if (M && M.HEAPU8 && (M.calledRun || M.runtimeInitialized || (M.asm && M._malloc))) {
        if (M.calledRun === false) return false;
        resolve(M);
        return true;
      }
      return false;
    };
    if (check()) return;
    const iv = setInterval(() => {
      if (check()) clearInterval(iv);
      else onStatus && onStatus(state.Module ? 'Game is starting…' : 'Waiting for the Unity game to load…');
    }, 500);
  });
}
