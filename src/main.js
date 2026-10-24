// BananaLoader: a MelonLoader-style mod loader for Unity WebGL (IL2CPP) games, in JavaScript.
//
// The shared bootstrap goes first: it has to see the page's Unity loader, build files and
// WebAssembly compile happen (and shows the loading screen while they do). BananaLoader's own
// wasm hook (direct-call rewriting) is installed after it, so it wraps the bootstrap's.
import { getBootstrap } from './bootstrap/index.js';
import { installHooks } from './hook.js';
import { BananaLoader } from './loader/loader.js';
import { App } from './app/app.js';

getBootstrap();
installHooks();

const loader = new BananaLoader();
window.BananaLoader = loader.publicApi();

const domReady = () => new Promise((r) => (document.body ? r() : document.addEventListener('DOMContentLoaded', () => r(), { once: true })));

loader.boot().then(async ({ Module }) => {
  await domReady();
  try { new App(loader); } catch (e) { console.error('[BananaLoader] UI failed', e); }
  loader.onModule(Module);
});
