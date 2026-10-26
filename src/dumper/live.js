// Dumping from inside a running game (Odium UE, BananaLoader): the metadata and registrations
// are already in the heap; the wasm bytes are fetched again from the URL the game loaded.

import { WasmModule, isWasm } from './wasm.js';
import { inflate, metadataSize } from './unityweb.js';
import { Dumper } from './dumper.js';
import { zip } from './zip.js';

/** URLs of wasm files this page loaded, newest first. */
export function wasmUrls() {
  let entries = [];
  try { entries = performance.getEntriesByType('resource'); } catch (_) { /* ignore */ }
  return entries
    .map((e) => e.name)
    .filter((u) => /\.wasm(\.br|\.gz|\.unityweb)?(\?|#|$)|\.code\.unityweb(\?|#|$)/i.test(u))
    .reverse();
}

/** The game's wasm, fetched again. Resolves null when it can't be read (e.g. raw brotli). */
export async function fetchGameWasm(log = () => {}) {
  for (const url of wasmUrls()) {
    try {
      // the page's own fetch, so the bootstrap doesn't count this as one of the game's downloads
      const boot = window.__unityBootstrap;
      const get = (boot && typeof boot.rawFetch === 'function' && boot.rawFetch) || fetch;
      const r = await get.call(window, url, { cache: 'force-cache' });
      if (!r.ok) continue;
      const bytes = await inflate(new Uint8Array(await r.arrayBuffer()));
      if (isWasm(bytes) && bytes.length > 1 << 20) { log(`wasm: ${url} (${(bytes.length / 1048576).toFixed(1)} MB)`); return { bytes, url }; }
      log(`wasm: ${url} is compressed in a way the browser can't undo here`);
    } catch (e) { log(`wasm: ${url}: ${e.message}`); }
  }
  return null;
}

/** global-metadata.dat out of the live heap. */
export function liveMetadata(il) {
  const u8 = il.mem.views().u8;
  const size = metadataSize(u8, il.md.base);
  return u8.slice(il.md.base, il.md.base + size);
}

/**
 * Everything a dump produces, as files. `named` adds the named wasm (needs the wasm bytes).
 * @returns {Promise<{ files: {name: string, data: Uint8Array|string}[], summary: object, wasm: boolean }>}
 */
export async function liveDump(il, { named = true, metadata = true, log = () => {}, wasmBytes = null } = {}) {
  const tick = () => new Promise((r) => setTimeout(r, 0));
  let wasm = null;
  const got = wasmBytes ? { bytes: wasmBytes } : await fetchGameWasm(log);
  if (got) { try { wasm = new WasmModule(got.bytes); } catch (e) { log(`wasm: ${e.message}`); } }
  await tick();
  const d = new Dumper(il, { wasm, log });
  const files = [];
  files.push({ name: 'dump.cs', data: d.dumpCs() }); await tick();
  files.push({ name: 'methods.json', data: JSON.stringify(d.methodsJson()) }); await tick();
  files.push({ name: 'script.json', data: JSON.stringify(d.scriptJson()) });
  files.push({ name: 'strings.json', data: JSON.stringify(d.stringLiterals(), null, 1) });
  if (wasm) files.push({ name: 'icalls.json', data: JSON.stringify(d.internalCalls()) });
  if (metadata) files.push({ name: 'global-metadata.dat', data: liveMetadata(il) });
  await tick();
  if (wasm && named) files.push({ name: 'game.named.wasm', data: wasm.withNames(d.functionNames()) });
  return { files, summary: d.summary(), wasm: !!wasm };
}

export { zip };
