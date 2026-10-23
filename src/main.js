// BananaLoader: a MelonLoader-style mod loader for Unity WebGL (IL2CPP) games, in JavaScript.
import { installHooks } from './hook.js';
import { BananaLoader } from './loader/loader.js';
import { App } from './app/app.js';

installHooks();

const loader = new BananaLoader();
window.BananaLoader = loader.publicApi();

const domReady = () => new Promise((r) => (document.body ? r() : document.addEventListener('DOMContentLoaded', () => r(), { once: true })));

loader.boot().then(async (Module) => {
  await domReady();
  try { new App(loader); } catch (e) { console.error('[BananaLoader] UI failed', e); }
  loader.onModule(Module);
});
