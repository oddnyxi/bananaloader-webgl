// Unity Bootstrap hooks. They run at document-start on every page, before any of the page's
// scripts, so they follow three rules:
//  1. Pass everything through unchanged. Requests, responses and promises are the page's own
//     objects (progress is counted on a clone, never on the response the page reads).
//  2. Do nothing beyond passing through until there is definite Unity evidence: a Unity loader
//     call (UnityLoader.instantiate, createUnityInstance) or a Module that is Unity's.
//  3. Bookkeeping never throws into the page.
//
//  * Unity loaders: UnityLoader.instantiate (Unity 5.6 – 2019.4) and createUnityInstance
//    (2020.1+), for the build config, Unity's own progress and the game instance.
//  * Build files over fetch and XMLHttpRequest: size, encoding, progress, timing.
//  * WebAssembly.instantiate / instantiateStreaming: compile time, the module's memory and
//    table (old fastcomp builds import them), and the wasm bytes, analysed for exact function
//    signatures and fastcomp's per-signature tables.
//  * Module.asm and Module.postRun: when the Emscripten runtime has its exports, and when
//    main() has run.

import { WasmModule } from '../dumper/wasm.js';
import { fmtBytes, fmtMs } from './core.js';

const BUILD_FILE = /(?:\.unityweb|\.wasm|\.data|\.framework\.js|\.loader\.js|UnityLoader\.js|\.mem|\.symbols\.json)(?:\.gz|\.br)?(?:[?#]|$)|\/Build\/[^/?#]+\.json(?:[?#]|$)/i;
const BIG_WASM = 1 << 20;
const KEEP_WASM_MAX = 96 << 20;
const UNITY_HINT = 'script[src*="UnityLoader" i], script[src$=".loader.js" i], #unity-canvas, #unityContainer, #gameContainer, #unity-container';

const abs = (u) => { try { return new URL(u, location.href).href; } catch (_) { return String(u || ''); } };
const looksLikeModule = (M) => M && typeof M === 'object' && ('locateFile' in M || 'preRun' in M || 'HEAPU8' in M || 'postRun' in M || 'SendMessage' in M);
const hidden = (o, k, v) => { try { Object.defineProperty(o, k, { value: v, configurable: true }); } catch (_) { /* frozen */ } };

/** Make a wrapper look like the function it wraps (name, length, toString). */
function disguise(wrapper, orig) {
  try {
    Object.defineProperty(wrapper, 'name', { value: orig.name, configurable: true });
    Object.defineProperty(wrapper, 'length', { value: orig.length, configurable: true });
    Object.defineProperty(wrapper, 'toString', { value: function toString() { return Function.prototype.toString.call(orig); }, configurable: true, writable: true });
  } catch (_) { /* ignore */ }
  return wrapper;
}
const MARK = new WeakSet(); // functions installed by us

export function installHooks(boot) {
  boot.candidates = new Set();
  const W = typeof WebAssembly === 'object' ? WebAssembly : null;
  hookModuleAsm(boot);
  if (W) hookWasm(boot, W);
  hookFetch(boot);
  hookXhr(boot);
  hookLoaders(boot);
  watchRuntime(boot);
}

/** Is this Emscripten Module Unity's (and not some other wasm library on the page)? */
function isUnityModule(boot, M) {
  if (!M) return false;
  if (M === boot.pendingModule) return true;                               // UnityLoader's gameInstance.Module
  if (boot.unityCanvas && M.canvas === boot.unityCanvas) return true;      // createUnityInstance(canvas, …)
  return typeof M.SendMessage === 'function' || typeof M._SendMessage === 'function';
}

/**
 * Know when main() has run (that's when IL2CPP loads its metadata): Emscripten calls
 * Module.postRun right after main(), on every Unity version. Upstream Emscripten keeps calledRun
 * private, so this is the only reliable signal there.
 */
function armPostRun(boot, M) {
  if (!M || typeof M !== 'object' || M.__ubPostRun) return;
  try {
    hidden(M, '__ubPostRun', true);
    const cb = () => { hidden(M, '__ubMainRan', true); boot.changed(); };
    if (typeof M.postRun === 'function') M.postRun = [M.postRun, cb];
    else if (Array.isArray(M.postRun)) M.postRun.push(cb);
    else if (!M.postRun) M.postRun = [cb];
  } catch (_) { /* ignore */ }
}

// ---------------------------------------------------------------- Module.asm

function hookModuleAsm(boot) {
  // Every Unity framework assigns Module.asm (Module["asm"] = exports). Old Emscripten
  // (Unity 2018 – 2021.1) first assigns a factory function and later the exports object, so the
  // property stays an accessor on the Module to see both. The trap on Object.prototype is
  // removed again once Unity's Module is found, or when the page turns out not to be Unity.
  const seen = (M, v) => {
    try {
      if (!v || (typeof v !== 'object' && typeof v !== 'function') || !looksLikeModule(M)) return;
      if (boot.candidates.size < 16) boot.candidates.add(M);
      armPostRun(boot, M);
      if (typeof v === 'object' && isUnityModule(boot, M)) boot.setModule(M, 'Module.asm');
    } catch (_) { /* never break the page's assignment */ }
  };
  try {
    const d = Object.getOwnPropertyDescriptor(Object.prototype, 'asm');
    if (d && d.set && MARK.has(d.set)) return;
    if (d) return; // something else already owns it
    const set = function (v) {
      const M = this;
      if (M === Object.prototype || M == null) { try { Object.defineProperty(Object.prototype, 'asm', { value: v, writable: true, configurable: true, enumerable: false }); } catch (_) { /* ignore */ } return; }
      let cur = v;
      try {
        Object.defineProperty(M, 'asm', { configurable: true, enumerable: true, get() { return cur; }, set(x) { cur = x; seen(M, x); } });
      } catch (_) { return; } // frozen / sealed object: a plain assignment would have failed too
      seen(M, v);
    };
    MARK.add(set);
    Object.defineProperty(Object.prototype, 'asm', { configurable: true, enumerable: false, get() { return undefined; }, set });
    boot.releaseAsmTrap = () => {
      const cur = Object.getOwnPropertyDescriptor(Object.prototype, 'asm');
      if (cur && cur.set === set) { try { delete Object.prototype.asm; } catch (_) { /* ignore */ } }
    };
  } catch (_) { /* ignore */ }
}

// ---------------------------------------------------------------- WebAssembly

function hookWasm(boot, W) {
  if (W.instantiate && MARK.has(W.instantiate)) return;
  const origInstantiate = W.instantiate;
  const origStreaming = W.instantiateStreaming;

  // the game's module is the biggest one: a smaller wasm compiled before or after it (a codec, physics or
  // ML library) doesn't replace it, a bigger one does. n = the new module's size (0: not known yet).
  const keepCurrent = (n) => {
    const cur = boot.state.wasm;
    if (!cur || !cur.exports) return false;
    if (!n) return !!cur.bytes; // unknown size: only replaces a record whose size wasn't known either
    return !!cur.bytes && n <= cur.bytes;
  };
  const begin = (bytes, streaming, url) => {
    const rec = { bytes, streaming, url: url || '', start: boot.now(), ms: null, flavor: null };
    boot.state.wasm = rec;
    boot.setPhase('compile', 'active', `${bytes ? fmtBytes(bytes) + ' · ' : ''}${streaming ? 'streaming compile' : 'from bytes'}`);
    boot.log(`Compiling WebAssembly${bytes ? ' (' + fmtBytes(bytes) + ')' : ''}${streaming ? ', streaming' : ''}`);
    return rec;
  };

  const finish = (rec, result, imports) => {
    try {
      const instance = result instanceof W.Instance ? result : result && result.instance;
      const module = result && result.module;
      rec.ms = boot.now() - rec.start;
      if (!instance) return;
      const exp = instance.exports;
      const names = Object.keys(exp);
      const all = [];
      for (const k of names) all.push(['export', exp[k]]);
      for (const mod of Object.values(imports || {})) {
        if (!mod || typeof mod !== 'object') continue;
        for (const k of Object.keys(mod)) { try { all.push(['import', mod[k]]); } catch (_) { /* throwing getter */ } }
      }
      const mem = all.find(([, v]) => v instanceof W.Memory);
      const tab = all.find(([, v]) => v instanceof W.Table);
      rec.exports = exp;
      rec.memory = mem ? mem[1] : null;
      rec.table = tab ? tab[1] : null;
      rec.flavor = names.includes('_malloc') || names.includes('_free') ? 'fastcomp' : 'upstream';
      rec.exportCount = names.length;
      try { rec.importCount = module ? W.Module.imports(module).length : all.filter(([s]) => s === 'import').length; } catch (_) { rec.importCount = 0; }
      rec.memoryInfo = rec.memory ? `${fmtBytes(rec.memory.buffer.byteLength)} (${mem[0]}ed)` : 'not found';
      rec.tableInfo = rec.table ? `${rec.table.length.toLocaleString()} slots (${tab[0]}ed)` : 'not found';
      rec.liveGlobals = {};
      for (const mod of Object.values(imports || {})) {
        if (!mod || typeof mod !== 'object') continue;
        for (const k of Object.keys(mod)) {
          try {
            const v = mod[k];
            if (typeof v === 'number') rec.liveGlobals[k] = v;
            else if (v instanceof W.Global) rec.liveGlobals[k] = Number(v.value);
          } catch (_) { /* ignore */ }
        }
      }
      boot.setPhase('compile', 'done', `${rec.bytes ? fmtBytes(rec.bytes) + ' · ' : ''}${fmtMs(rec.ms)}${rec.streaming ? ' · streaming' : ''} · ${rec.flavor === 'fastcomp' ? 'fastcomp' : 'LLVM'}`);
      boot.log(`WebAssembly ready: ${rec.exportCount} exports, memory ${rec.memoryInfo}, table ${rec.tableInfo}`);
      if (boot.phase('runtime').status === 'pending') boot.setPhase('runtime', 'active', boot.Module ? 'waiting for main()' : 'starting');
    } catch (e) {
      try { boot.log(`could not inspect the wasm instance: ${e && e.message || e}`, 'warn'); } catch (_) { /* ignore */ }
    }
  };

  const analyse = (rec, bytes) => {
    // after the game has its instance, off the critical path; on our own copy of the bytes
    setTimeout(() => {
      try {
        const t = performance.now();
        const w = new WasmModule(bytes);
        w.globalValues = rec.liveGlobals || {};
        const fnTables = w.fnTables();
        const signatures = w.slotSignatures();
        const ms = performance.now() - t;
        if (bytes.length <= KEEP_WASM_MAX) boot.wasmBytes = bytes;
        boot.setAnalysis({
          fnTables, signatures, functions: w.funcCount, types: w.types.length, ms,
          summary: `${w.funcCount.toLocaleString()} functions · ${w.types.length} signatures · ${fnTables ? fnTables.size + ' per-signature function tables (fastcomp)' : 'direct function pointers'} · ${signatures.count.toLocaleString()} table slots · ${fmtMs(ms)}`,
        });
        boot.log(`Analysed wasm: ${boot.analysis.summary}`);
      } catch (e) {
        boot.log(`wasm analysis failed: ${e.message}`, 'warn');
        boot.setAnalysis(null);
      }
    }, 0);
  };

  const toBytes = (src) => (src instanceof Uint8Array ? src : ArrayBuffer.isView(src) ? new Uint8Array(src.buffer, src.byteOffset, src.byteLength) : src instanceof ArrayBuffer ? new Uint8Array(src) : null);

  const instantiate = function (src, imports) {
    // only a Unity page gets anything more than a pass-through
    if (!boot.detected) return origInstantiate.apply(this, arguments);
    if (src instanceof W.Module) {
      const pending = boot.state.wasm && boot.state.wasm.ms == null ? boot.state.wasm : null;
      const p = origInstantiate.apply(this, arguments);
      // compiled elsewhere (WebAssembly.compile): no bytes to analyse, so don't keep anyone waiting for them
      if (pending) p.then((inst) => { finish(pending, inst, imports); if (!boot._analysisDone) boot.setAnalysis(null); }, () => {});
      return p;
    }
    let bytes = null;
    try { bytes = toBytes(src); } catch (_) { /* ignore */ }
    if (!bytes || bytes.length < BIG_WASM || keepCurrent(bytes.length)) return origInstantiate.apply(this, arguments);
    let copy = null;
    // a tool that rewrote the bytes (BananaLoader's direct-call patching) registered the game's own
    const own = boot.originalBytes && boot.originalBytes.get(src);
    try { copy = (own || bytes).slice(); } catch (_) { /* detached or too big: skip the analysis */ }
    const rec = begin(bytes.length, false);
    const p = origInstantiate.apply(this, arguments);
    p.then((res) => { finish(rec, res, imports); if (copy) analyse(rec, copy); else boot.setAnalysis(null); },
      // rewritten bytes (BananaLoader's direct-call patching) that don't compile are retried with the original
      (e) => boot.setPhase('compile', own ? 'active' : 'error', own ? 'retrying with the original wasm' : String(e && e.message || e)));
    return p;
  };
  MARK.add(instantiate);
  W.instantiate = disguise(instantiate, origInstantiate);

  if (origStreaming) {
    const streaming = function (source, imports, ...rest) {
      if (!boot.detected) return origStreaming.apply(this, arguments);
      const self = this;
      // the page gets the original Response (its URL keeps the browser's compiled-code cache
      // working); the analysis reads a clone
      return Promise.resolve(source).then((resp) => {
        let copyP = null;
        let len = 0;
        try {
          len = resp && resp.headers ? +resp.headers.get('content-length') || 0 : 0;
          // duck-typed: a Response from another frame isn't an instance of ours
          if (resp && typeof resp.clone === 'function' && !resp.bodyUsed && !(len && len < BIG_WASM / 4)) copyP = resp.clone().arrayBuffer().then((b) => new Uint8Array(b), () => null);
        } catch (_) { copyP = null; }
        if (!copyP) return origStreaming.call(self, resp, imports, ...rest);
        // another big module already compiled: only take this one over if it turns out bigger (then it's the game)
        if (boot.state.wasm && boot.state.wasm.exports) {
          const p = origStreaming.call(self, resp, imports, ...rest);
          p.then(async (res) => {
            const bytes = await copyP;
            if (!bytes || keepCurrent(bytes.length)) return;
            const rec = begin(bytes.length, true, resp.url);
            finish(rec, res, imports);
            analyse(rec, bytes);
          }, () => {});
          return p;
        }
        const rec = begin(len, true, resp.url);
        const p = origStreaming.call(self, resp, imports, ...rest);
        p.then(async (res) => {
          const bytes = await copyP;
          if (bytes) rec.bytes = bytes.length;
          finish(rec, res, imports);
          if (bytes) analyse(rec, bytes); else boot.setAnalysis(null);
        }, (e) => {
          // Emscripten falls back to instantiate(ArrayBuffer) on a MIME error; that's hooked too
          boot.log(`streaming compile failed (${e && e.message || e}), the page will retry`, 'warn');
          boot.setPhase('compile', 'active', 'retrying from bytes');
        });
        return p;
      });
    };
    MARK.add(streaming);
    W.instantiateStreaming = disguise(streaming, origStreaming);
  }
}

// ---------------------------------------------------------------- network

function hookFetch(boot) {
  const orig = window.fetch;
  if (!orig || MARK.has(orig)) return;
  boot.rawFetch = orig; // our own requests (re-reading the wasm for a dump) aren't the page's downloads
  const wrapped = function (input, init) {
    let url = '';
    if (boot.detected) {
      try { url = abs(typeof input === 'string' || input instanceof URL ? String(input) : input && input.url); } catch (_) { url = ''; }
    }
    if (!url || !BUILD_FILE.test(url)) return orig.apply(this, arguments);
    let f = null;
    try { f = boot.file(url, 'fetch'); boot.changed(); } catch (_) { /* ignore */ }
    const p = orig.apply(this, arguments);
    if (f) p.then((resp) => track(boot, f, resp), (e) => { try { boot.fileDone(f, false, e && e.message || e); } catch (_) { /* ignore */ } });
    return p; // the page's own promise and Response, untouched
  };
  MARK.add(wrapped);
  window.fetch = disguise(wrapped, orig);
}

/** Count a response's bytes on a clone, so the page's Response stays the real one. */
function track(boot, f, resp) {
  try {
    f.httpStatus = resp.status;
    f.total = +resp.headers.get('content-length') || 0;
    f.encoding = resp.headers.get('content-encoding') || '';
    f.type = resp.headers.get('content-type') || '';
    if (resp.type === 'opaque' || resp.type === 'opaqueredirect') { f.via += ' (opaque)'; boot.fileDone(f, true); return; }
    if (!resp.ok) { boot.fileDone(f, false, `HTTP ${resp.status}`); return; }
    if (!resp.body || resp.bodyUsed) { f.loaded = f.total; boot.fileDone(f, true); return; }
    const reader = resp.clone().body.getReader();
    const pump = () => reader.read().then(({ done, value }) => {
      if (done) { boot.fileDone(f, true); return undefined; }
      f.loaded += value.byteLength;
      boot.changed();
      return pump();
    }, () => boot.fileDone(f, f.loaded > 0, 'stream error'));
    pump();
  } catch (_) {
    try { boot.fileDone(f, true); } catch (__) { /* ignore */ }
  }
}

function hookXhr(boot) {
  const X = window.XMLHttpRequest;
  if (!X || MARK.has(X.prototype.open)) return;
  const P = X.prototype;
  const open = P.open;
  const send = P.send;
  const urls = new WeakMap();
  const current = new WeakMap(); // xhr -> the file record of its latest request (an XHR can be reused)
  const wOpen = function (method, url) {
    try { urls.set(this, abs(url)); } catch (_) { /* ignore */ }
    return open.apply(this, arguments);
  };
  const listen = (x) => {
    const f = () => current.get(x);
    x.addEventListener('progress', (e) => { const r = f(); if (!r) return; r.loaded = e.loaded; if (e.lengthComputable) r.total = e.total; boot.changed(); });
    x.addEventListener('load', () => {
      const r = f();
      if (!r) return;
      try {
        r.httpStatus = x.status;
        try { r.encoding = x.getResponseHeader('content-encoding') || ''; r.type = x.getResponseHeader('content-type') || ''; } catch (_) { /* ignore */ }
        if (x.status >= 400) { boot.fileDone(r, false, `HTTP ${x.status}`); return; }
        if (!r.loaded) { const b = x.response; r.loaded = b && b.byteLength || (typeof b === 'string' ? b.length : 0); }
        if (r.kind === 'manifest') readManifest(boot, x);
        boot.fileDone(r, true);
      } catch (_) { /* ignore */ }
    });
    x.addEventListener('error', () => { const r = f(); if (r) boot.fileDone(r, false, 'network error'); });
    x.addEventListener('abort', () => { const r = f(); if (r) boot.fileDone(r, false, 'aborted'); });
    x.addEventListener('timeout', () => { const r = f(); if (r) boot.fileDone(r, false, 'timed out'); });
  };
  const wSend = function () {
    try {
      const url = urls.get(this);
      if (boot.detected && url && BUILD_FILE.test(url)) {
        if (!current.has(this)) listen(this);
        current.set(this, boot.file(url, 'xhr'));
      } else if (current.has(this)) current.set(this, null); // reused for something that isn't a build file
    } catch (_) { /* never break the request */ }
    return send.apply(this, arguments);
  };
  MARK.add(wOpen);
  P.open = disguise(wOpen, open);
  P.send = disguise(wSend, send);
}

/** UnityLoader builds describe themselves in Build/*.json. */
function readManifest(boot, x) {
  let j = null;
  try { j = x.responseType === 'json' ? x.response : JSON.parse(x.responseType === '' || x.responseType === 'text' ? x.responseText : ''); } catch (_) { return; }
  if (!j || typeof j !== 'object') return;
  const c = boot.state.config;
  for (const k of ['productName', 'companyName', 'productVersion', 'unityVersion', 'dataUrl', 'wasmCodeUrl', 'wasmFrameworkUrl', 'asmCodeUrl', 'TOTAL_MEMORY', 'graphicsAPI', 'developmentBuild']) if (j[k] !== undefined && c[k] === undefined) c[k] = j[k];
  if (!j.wasmCodeUrl && j.asmCodeUrl) unsupported(boot, 'this is an asm.js build (no WebAssembly). IL2CPP tools need a WebAssembly build: Unity 2018.1 or newer with WebAssembly enabled.');
  boot.log(`Build manifest: ${[c.productName, c.unityVersion && 'Unity ' + c.unityVersion].filter(Boolean).join(' · ') || 'read'}`);
}

function unsupported(boot, why) {
  if (boot.state.unsupported) return;
  boot.state.unsupported = why;
  boot.fail(`Unsupported build: ${why}`);
  boot.setPhase('compile', 'error', 'asm.js');
}

// ---------------------------------------------------------------- Unity loaders

function hookLoaders(boot) {
  // UnityLoader.js declares `var UnityLoader = UnityLoader || {…}`: a var assignment, so an
  // accessor on window sees it.
  if (!('UnityLoader' in window)) {
    let v;
    try {
      Object.defineProperty(window, 'UnityLoader', {
        configurable: true, enumerable: true,
        get() { return v; },
        set(x) { v = x; try { wrapUnityLoader(boot, x); } catch (_) { /* ignore */ } },
      });
    } catch (_) { /* ignore */ }
  }
  // createUnityInstance is a function declaration, which replaces any accessor, so wrap it
  // right after each script loads (capture listeners run before the script's own onload).
  const check = () => {
    try {
      const c = window.createUnityInstance;
      if (typeof c === 'function' && !MARK.has(c)) window.createUnityInstance = wrapCreate(boot, c);
      if (window.UnityLoader) wrapUnityLoader(boot, window.UnityLoader);
    } catch (_) { /* ignore */ }
  };
  document.addEventListener('load', (e) => { if (e.target && e.target.tagName === 'SCRIPT') check(); }, true);
  document.addEventListener('DOMContentLoaded', check, { once: true });
  let n = 0;
  const iv = setInterval(() => { check(); if (++n > 120 || boot.state.loader) clearInterval(iv); }, 250);
}

const scriptSrc = (re) => {
  try {
    const s = [...document.scripts].find((x) => x.src && re.test(x.src.split(/[?#]/)[0].split('/').pop()));
    return s ? s.src : '';
  } catch (_) { return ''; }
};

function wrapUnityLoader(boot, UL) {
  if (!UL || typeof UL !== 'object' || typeof UL.instantiate !== 'function' || MARK.has(UL.instantiate)) return;
  const orig = UL.instantiate;
  const wrapped = function (container, url, params) {
    try {
      boot.setLoader('UnityLoader', { script: scriptSrc(/^UnityLoader(\.min)?\.js$/i) });
      boot.state.config.manifestUrl = abs(url);
      params = params || {};
      const own = params.onProgress || (UL.Progress && UL.Progress.handler);
      params.onProgress = function (gi, p) {
        try { boot.state.progress = p; boot.changed(); } catch (_) { /* ignore */ }
        if (typeof own === 'function') return own.apply(this, arguments);
        return undefined;
      };
    } catch (_) { /* ignore */ }
    const gi = orig.call(this, container, url, params);
    try {
      if (gi && typeof gi === 'object') {
        boot.instance = gi;
        if (gi.Module) { boot.pendingModule = gi.Module; armPostRun(boot, gi.Module); }
      }
    } catch (_) { /* ignore */ }
    return gi;
  };
  MARK.add(wrapped);
  UL.instantiate = disguise(wrapped, orig);
}

function wrapCreate(boot, orig) {
  const wrapped = function (canvas, config, onProgress) {
    let progress = onProgress;
    try {
      boot.setLoader('createUnityInstance', { script: scriptSrc(/\.loader\.js$/i) });
      boot.unityCanvas = canvas; // Unity's Module gets this canvas: that's how it's recognised
      const c = boot.state.config;
      if (config && typeof config === 'object') {
        for (const k of ['productName', 'companyName', 'productVersion', 'dataUrl', 'frameworkUrl', 'codeUrl', 'streamingAssetsUrl', 'symbolsUrl', 'memoryUrl']) if (config[k] !== undefined) c[k] = config[k];
      }
      progress = function (v) {
        try { boot.state.progress = v; boot.changed(); } catch (_) { /* ignore */ }
        if (typeof onProgress === 'function') return onProgress.apply(this, arguments);
        return undefined;
      };
    } catch (_) { /* ignore */ }
    const p = orig.call(this, canvas, config, progress);
    if (p && typeof p.then === 'function') {
      // observe without hiding a failure from the page's console
      p.then((inst) => {
        try {
          boot.instance = inst;
          // Unity resolves this from Module.postRun, so main() has run by now
          if (inst && inst.Module) hidden(inst.Module, '__ubMainRan', true);
          if (inst && inst.Module && isUnityModule(boot, inst.Module)) boot.setModule(inst.Module, 'createUnityInstance()');
        } catch (_) { /* ignore */ }
      }, (e) => {
        boot.fail(`createUnityInstance failed: ${e && e.message || e}`, 'unity');
        console.error('[Unity Bootstrap] createUnityInstance failed:', e);
      });
    }
    return p;
  };
  MARK.add(wrapped);
  return disguise(wrapped, orig);
}

// ---------------------------------------------------------------- runtime start / late attach

/** An already-running Unity game (the script was injected after it loaded), or null. */
export function findModuleInPage() {
  const ok = (M) => M && typeof M === 'object' && M.HEAPU8 && (M.asm || M.wasmExports);
  const unity = (M, inst) => typeof M._SendMessage === 'function' || typeof M.SendMessage === 'function' || (inst && typeof inst.SendMessage === 'function');
  const names = ['unityInstance', 'unityGameInstance', 'gameInstance', 'myGameInstance', 'unity', 'UnityInstance', 'game'];
  for (const n of names) {
    try {
      const v = window[n];
      if (v && ok(v.Module) && unity(v.Module, v)) return v.Module;
      if (ok(v) && unity(v)) return v;
    } catch (_) { /* ignore */ }
  }
  try { if (ok(window.Module) && unity(window.Module)) return window.Module; } catch (_) { /* ignore */ }
  // a full scan of window only where the page looks like it hosts a Unity build
  let hint = false;
  try { hint = !!document.querySelector(UNITY_HINT) || typeof window.createUnityInstance === 'function'; } catch (_) { /* ignore */ }
  if (!hint) return null;
  for (const k of Object.keys(window)) {
    try {
      const v = window[k];
      if (v && typeof v === 'object' && ok(v.Module) && typeof v.SendMessage === 'function') return v.Module;
    } catch (_) { /* ignore */ }
  }
  return null;
}

function watchRuntime(boot) {
  let n = 0;
  let since = 0;
  let stopped = false;
  boot.kickWatch = () => { if (stopped) { stopped = false; setTimeout(tick, 250); } };
  // main() has run: our postRun hook fired, old Emscripten's public calledRun is set, or the
  // tool attached to a game that was already running. As a last resort, a minute after the
  // exports appeared.
  const started = (M) => M && M.HEAPU8 && (M.__ubMainRan || M.calledRun === true || boot.lateAttach || (since && n - since > 120));
  const tick = () => {
    n++;
    try {
      let M = boot.Module;
      if (!M) {
        // a Module whose Unity identity became clear later (Module.canvas / SendMessage set after asm)
        for (const c of boot.candidates) {
          if (c.asm && typeof c.asm === 'object' && isUnityModule(boot, c)) { boot.setModule(c, 'Module.asm'); M = c; break; }
        }
        if (!M && boot.pendingModule && boot.pendingModule.asm && typeof boot.pendingModule.asm === 'object') { boot.setModule(boot.pendingModule, 'UnityLoader gameInstance'); M = boot.Module; }
      }
      if (!M && n % 2 === 0 && n < 120) {
        const found = findModuleInPage();
        if (found) {
          boot.lateAttach = true;
          if (!boot.state.loader) boot.setLoader('injected');
          boot.setModule(found, 'found on the page');
          M = found;
        }
      }
      if (M && boot.releaseAsmTrap) { boot.releaseAsmTrap(); boot.releaseAsmTrap = null; }
      if (M && !since) { since = n; armPostRun(boot, M); }
      if (M && started(M)) {
        const w = boot.state.wasm;
        if (!w && !boot.state.unsupported) {
          // never saw a wasm compile: attached late, or an asm.js build
          const exp = M.asm && typeof M.asm === 'object' ? M.asm : {};
          const isWasm = Object.values(exp).some((v) => v instanceof WebAssembly.Memory || v instanceof WebAssembly.Table) || M.wasmMemory || M.wasmTable;
          if (!isWasm && [...boot.state.files.values()].some((f) => f.kind === 'asm.js')) unsupported(boot, 'this is an asm.js build (no WebAssembly).');
          boot.setPhase('compile', boot.state.unsupported ? 'error' : 'skipped', boot.state.unsupported ? 'asm.js' : 'compiled before the bootstrap attached');
          if (!boot.state.unsupported) boot.setAnalysis(null);
        }
        for (const f of boot.state.files.values()) if (f.status === 'loading') { f.status = 'done'; f.end = boot.now(); }
        const flavor = (w && w.flavor) || (Object.keys(M.asm && typeof M.asm === 'object' ? M.asm : {}).includes('_malloc') ? 'fastcomp' : 'upstream');
        boot.setRuntimeStarted(`Emscripten ${flavor === 'fastcomp' ? 'fastcomp' : 'LLVM'} · heap ${fmtBytes(M.HEAPU8.length)}`);
        return; // done
      }
    } catch (_) { /* keep watching */ }
    // nothing on this page yet: let the Object.prototype trap go once the page has loaded
    // without any sign of Unity (click-to-play pages keep it, they carry the loader script)
    if (!boot.Module && !boot.detected && boot.releaseAsmTrap && document.readyState === 'complete' && n > 16) {
      let hint = false;
      try { hint = !!document.querySelector(UNITY_HINT); } catch (_) { /* ignore */ }
      if (!hint) { boot.releaseAsmTrap(); boot.releaseAsmTrap = null; }
    }
    // fast while something is happening, then slow down; never give up on a Unity page
    const delay = boot.detected || boot.Module ? 250 : n < 240 ? 500 : 2000;
    if (!boot.detected && !boot.Module && !boot.releaseAsmTrap && n > 240) { stopped = true; return; } // not Unity: rest (detection restarts it)
    setTimeout(tick, delay);
  };
  setTimeout(tick, 250);
}
