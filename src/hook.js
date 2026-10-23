// Runs at document-start, before the game's loader:
//  1. capture the Emscripten Module when the framework assigns Module.asm
//  2. keep keystrokes typed into the explorer away from the game's key handlers

const state = { Module: null, waiters: [] };
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

  // ---- 2. key shield
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
