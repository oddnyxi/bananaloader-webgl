// Unity Bootstrap entry point. Call getBootstrap() first thing at document-start; every tool on
// the page shares one instance (window.__unityBootstrap), one set of hooks and one loading screen.
//
//   const boot = getBootstrap();
//   const client = boot.client({ id: 'my-tool', name: 'My Tool', version: '1.0.0', color: '#e11d2e' });
//   await boot.whenDetected();            // a Unity game is on this page
//   await boot.whenRuntime(); const Module = boot.Module; // (never `return`/resolve the Module itself: it's a thenable on old Unity)
//   const hints = await prepareIl2Cpp(boot); // what new Il2Cpp(Module, log, hints) needs on old builds
//   il.init(client);                      // each IL2CPP stage shows up as a step
//   client.ready('…');

import { Bootstrap, PROTOCOL, fmtBytes, fmtMs } from './core.js';
import { installHooks, findModuleInPage } from './hooks.js';
import { BootModal } from './modal.js';
import { WasmModule } from '../dumper/wasm.js';
import { fetchGameWasm } from '../dumper/live.js';

export { Bootstrap, fmtBytes, fmtMs, findModuleInPage };

export function getBootstrap() {
  const existing = window.__unityBootstrap;
  if (existing && existing.protocol === PROTOCOL && typeof existing.client === 'function') return existing;
  const boot = new Bootstrap();
  if (!existing) {
    try { Object.defineProperty(window, '__unityBootstrap', { value: boot, configurable: true, writable: false, enumerable: false }); } catch (_) { window.__unityBootstrap = boot; }
  }
  installHooks(boot);
  const ui = new BootModal(boot);
  boot.ui = ui;
  boot.whenDetected().then(() => {
    const go = () => { try { ui.start(); } catch (e) { console.error('[Unity Bootstrap] loading screen failed', e); } };
    if (document.documentElement) go(); else document.addEventListener('DOMContentLoaded', go, { once: true });
  });
  return boot;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Everything the IL2CPP bridge needs from the bootstrap, once the runtime has started.
 * fastcomp builds (Unity 2018 – 2021.1) need the wasm analysis (per-signature function
 * tables); if the bootstrap never saw the wasm (the tool was injected late), it's fetched again.
 */
export async function prepareIl2Cpp(boot, step) {
  await boot.whenRuntime();
  const M = boot.Module;
  const asmKeys = Object.keys(M.asm && typeof M.asm === 'object' ? M.asm : {});
  const fastcomp = (boot.state.wasm && boot.state.wasm.flavor === 'fastcomp') || asmKeys.includes('_malloc');
  let a = await Promise.race([boot.whenAnalysis(), sleep(fastcomp ? 20000 : 1500).then(() => undefined)]);
  if (!a && fastcomp) {
    if (step) step.note('re-reading the game\'s wasm for function tables');
    a = await refetchAnalysis(boot);
  }
  const hints = boot.hints();
  hints.flavor = hints.flavor || (fastcomp ? 'fastcomp' : 'upstream');
  if (fastcomp && !hints.fnTables) {
    boot.log('fastcomp build without function tables: calls and patches are unavailable until the page is reloaded with the bootstrap active', 'warn');
  }
  return hints;
}

async function refetchAnalysis(boot) {
  if (boot._refetch) return boot._refetch;
  boot._refetch = (async () => {
    const got = await fetchGameWasm((m) => boot.log(m, 'net'));
    if (!got) { boot.log('could not fetch the game\'s wasm again', 'warn'); return null; }
    const t = performance.now();
    const w = new WasmModule(got.bytes);
    const fnTables = w.fnTables();
    const signatures = w.slotSignatures();
    const ms = performance.now() - t;
    boot.wasmBytes = got.bytes;
    const a = { fnTables, signatures, functions: w.funcCount, types: w.types.length, ms, summary: `${w.funcCount.toLocaleString()} functions · ${fnTables ? fnTables.size + ' per-signature function tables (fastcomp)' : 'direct function pointers'} · ${signatures.count.toLocaleString()} table slots (re-fetched) · ${fmtMs(ms)}` };
    boot.setAnalysis(a);
    boot.log(`Analysed wasm (re-fetched): ${a.summary}`);
    return a;
  })();
  return boot._refetch;
}
