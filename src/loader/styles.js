// BananaStyles: themes for the BananaLoader window. A style is CSS (inside the window's shadow root,
// so it can't touch the game page), a layout (window | tabs | panels) and, optionally, JavaScript
// that runs like a Banan. Built-ins are bundled; the rest live in IndexedDB ('styles').

import { compile, slug } from './banan.js';
import defaultSrc from 'bundle-text:../styles/default.style.css';
import glassSrc from 'bundle-text:../styles/glass.style.css';
import inspectorSrc from 'bundle-text:../styles/inspector.style.css';

export const LAYOUTS = ['window', 'tabs', 'panels'];
const BUILTINS = [['default', defaultSrc], ['glass', glassSrc], ['inspector', inspectorSrc]];

/** The ==BananaStyle== header of a .style.js (// comments) or .css (inside one /* comment *\/). */
export function parseStyle(source) {
  source = String(source || '');
  let m = /\/\/\s*==BananaStyle==([\s\S]*?)\/\/\s*==\/BananaStyle==/.exec(source);
  let kind = 'js';
  if (!m) { m = /\/\*\s*==BananaStyle==([\s\S]*?)==\/BananaStyle==\s*\*\//.exec(source); kind = 'css'; }
  if (!m) return null;
  const info = {};
  for (const line of m[1].split('\n')) {
    const x = /^\s*(?:\/\/|\*)?\s*@(\w+)\s+(.+?)\s*$/.exec(line);
    if (x) info[x[1].toLowerCase()] = x[2];
  }
  return { info, kind };
}

/** Tokens a style's CSS sets on .root ({ '--bg': '#101012', ... }), for previews. */
export function styleTokens(css) {
  const out = {};
  const re = /\.root\s*(?:,[^{]*)?\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(String(css || '')))) {
    for (const d of m[1].split(';')) {
      const x = /^\s*(--[\w-]+)\s*:\s*([\s\S]+?)\s*$/.exec(d.replace(/\/\*[\s\S]*?\*\//g, ''));
      if (x) out[x[1]] = x[2];
    }
  }
  return out;
}

const VERSION_RE = /^v?\d+(\.\d+){0,3}([-+][\w.]+)?$/;

export class StyleManager {
  constructor(loader) {
    this.loader = loader;
    this.entries = new Map();
    this.app = null;
    this.current = null; // { entry, el, cleanup: [] }
    for (const [id, src] of BUILTINS) this._add({ id, source: src, origin: 'builtin' });
  }

  get activeId() { return (this.current && this.current.entry.id) || this.loader.settings.style || 'default'; }

  _add(rec) {
    const p = parseStyle(rec.source);
    if (!p) throw new Error('not a BananaStyle: it needs a // ==BananaStyle== header (or /* ==BananaStyle== */ in a .css file)');
    const info = { name: rec.id, version: '0.0.0', author: '', description: '', layout: 'window', ...p.info };
    if (!LAYOUTS.includes(info.layout)) info.layout = 'window';
    const e = { id: rec.id, rec, info, kind: p.kind, builtin: rec.origin === 'builtin', runsCode: p.kind === 'js' && /\bapply\b/.test(rec.source.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '')) };
    this.entries.set(rec.id, e);
    return e;
  }

  list() { return [...this.entries.values()]; }
  get(id) { return this.entries.get(id) || [...this.entries.values()].find((e) => e.info.name === id) || null; }

  /** Read the installed styles (once IndexedDB is allowed: the loader opens it after Unity is detected). */
  async load() {
    let recs = [];
    try { recs = await this.loader.store.allStyles(); } catch (e) { this.loader.log.error('could not read installed styles:', e); }
    for (const r of recs) { try { this._add(r); } catch (e) { this.loader.log.error(`style ${r.id}: ${e.message}`); } }
    this.loader.emit('styles');
    // the saved style may be an installed one: apply it now that it's known
    const want = this.loader.settings.style || 'default';
    if (this.app && want !== this.activeId && this.entries.has(want)) this.apply(want);
  }

  /** Check a style's source; returns { info, kind } or throws with a readable message. */
  check(source) {
    const p = parseStyle(source);
    if (!p) throw new Error('not a BananaStyle: it needs a // ==BananaStyle== header (or /* ==BananaStyle== */ in a .css file)');
    if (!p.info.name) throw new Error('the header needs @name');
    if (!p.info.version || !VERSION_RE.test(p.info.version)) throw new Error('the header needs @version, a version like 1.0.0');
    if (p.info.layout && !LAYOUTS.includes(p.info.layout)) throw new Error(`@layout must be one of: ${LAYOUTS.join(', ')}`);
    if (p.kind === 'js') { try { new Function(source); } catch (e) { throw new Error(`syntax error: ${e.message}`); } } // eslint-disable-line no-new-func
    return p;
  }

  /** Install (or update) a style. Returns its entry. */
  async install(source, { origin = 'file', url = '', registry = null } = {}) {
    const p = this.check(source);
    const base = slug(p.info.name);
    let id = base;
    // a built-in keeps its id: a style with the same name gets its own (installing it again updates it)
    for (let n = 2; this.entries.has(id) && this.entries.get(id).builtin; n++) id = `${base}-${n}`;
    const rec = { id, name: p.info.name, version: p.info.version, source, origin, url, installedAt: Date.now() };
    if (registry) rec.registry = registry;
    await this.loader.store.putStyle(rec);
    const e = this._add(rec);
    this.loader.log.msg(`Installed style ${p.info.name} ${p.info.version}`);
    this.loader.emit('styles');
    if (this.activeId === id && this.app) this.apply(id); // updated the active style: show the new version
    return e;
  }

  async installUrl(url) {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return this.install(await r.text(), { origin: 'url', url });
  }

  async remove(id) {
    const e = this.entries.get(id);
    if (!e) throw new Error('no style ' + id);
    if (e.builtin) throw new Error(`${e.info.name} is built in`);
    if (this.activeId === id) this.apply('default');
    await this.loader.store.removeStyle(id);
    this.entries.delete(id);
    this.loader.emit('styles');
  }

  // ------------------------------------------------------------------ applying

  _teardown() {
    const c = this.current;
    if (!c) return;
    for (const fn of c.cleanup.splice(0).reverse()) { try { fn(); } catch (e) { this.loader.log.error(`style ${c.entry.info.name}: cleanup threw:`, e); } }
    if (c.el) c.el.remove();
    this.current = null;
  }

  /** Apply a style to the window (live; no reload). Falls back to Default when it fails. */
  apply(id, { save = true } = {}) {
    const app = this.app;
    const e = this.get(id) || this.entries.get('default');
    if (!app) { this.loader.settings.style = e.id; this.loader.saveSettings(); return e; }
    const ui = app.ui;
    this._teardown();
    const cur = (this.current = { entry: e, el: null, cleanup: [] });
    try {
      let mod = { css: e.kind === 'css' ? e.rec.source : '' };
      if (e.kind === 'js') {
        const log = this.loader.hub.logger(`Style: ${e.info.name}`, '#a78bfa');
        const ex = compile(e.rec.source, `style-${e.id}`, { BananaLoader: this.loader.publicApi(), logger: log });
        mod = ex && typeof ex === 'object' ? ex : typeof ex === 'function' ? { apply: ex } : {};
        if (typeof mod.css === 'function') mod.css = mod.css();
      }
      const css = String(mod.css || '');
      const el = document.createElement('style');
      el.dataset.bananastyle = e.id;
      el.textContent = css;
      ui.root.getRootNode().appendChild(el);
      cur.el = el;
      ui.setLayout(LAYOUTS.includes(mod.layout) ? mod.layout : e.info.layout);
      this._accent(styleTokens(css)['--accent']);
      if (typeof mod.apply === 'function') {
        if (this.loader.safeMode) this.loader.log.warn(`Safe mode: the ${e.info.name} style's code didn't run (its CSS did)`);
        else {
          const ctx = this._ctx(cur, e);
          const undo = mod.apply.call(mod, ctx);
          if (typeof undo === 'function') cur.cleanup.push(undo);
        }
      }
      if (save) { this.loader.settings.style = e.id; this.loader.saveSettings(); }
      this.loader.emit('style', e);
      return e;
    } catch (err) {
      this.loader.log.error(`style ${e.info.name} failed: ${err && err.stack || err}`);
      this._teardown();
      if (e.id !== 'default') { app.notify(`The ${e.info.name} style failed (see Console); back to Default`, 'error', 5000); return this.apply('default'); }
      ui.setLayout('window');
      return e;
    }
  }

  _accent(value) {
    const ui = this.app.ui;
    const v = value && value.trim();
    if (v && /^#[0-9a-f]{3,8}$/i.test(v)) {
      if (this._userAccent === undefined) this._userAccent = ui.accent;
      ui.setAccent(v);
    } else if (this._userAccent !== undefined) {
      ui.setAccent(this._userAccent);
      this._userAccent = undefined;
    }
  }

  /** What a style's apply(ctx) gets. Everything it adds is removed when the style changes. */
  _ctx(cur, e) {
    const app = this.app, ui = app.ui, root = ui.root;
    const add = (fn) => { cur.cleanup.push(fn); return fn; };
    return {
      ui, app, root, shadow: root.getRootNode(),
      loader: this.loader.publicApi(),
      layout: ui.layout,
      logger: this.loader.hub.logger(`Style: ${e.info.name}`, '#a78bfa'),
      addCss: (text) => {
        const s = document.createElement('style');
        s.textContent = String(text);
        root.getRootNode().appendChild(s);
        return add(() => s.remove());
      },
      onKey: (spec, fn) => { const k = ui.bindKey(spec, fn); return add(() => ui.unbindKey(k)); },
      onCleanup: (fn) => add(fn),
      setInterval: (fn, ms) => { const t = setInterval(fn, ms); return add(() => clearInterval(t)); },
    };
  }

  // ------------------------------------------------------------------ bananaloader.com

  async search(q = '', o = {}) {
    const p = new URLSearchParams({ kind: 'style', per: 30, ...o });
    if (q) p.set('q', q);
    return (await (await this.loader.registry(`/banans?${p}`)).json());
  }

  /** Registry styles with a newer approved version: [{ entry, slug, installed, latest }] */
  async updates() {
    const mine = this.list().filter((e) => e.rec.registry && e.rec.registry.slug);
    if (!mine.length) return [];
    const r = await this.loader.registry('/updates', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ banans: mine.map((e) => ({ slug: e.rec.registry.slug, version: e.rec.registry.version })) }) });
    const { banans } = await r.json();
    return banans.filter((u) => u.update).map((u) => ({ entry: mine.find((e) => e.rec.registry.slug === u.slug), slug: u.slug, installed: u.installed, latest: u.latest })).filter((u) => u.entry);
  }

  async installFromRegistry(slugName, version = null) {
    const text = await this.loader.registryDownload(slugName, version);
    const v = text.headers.version || parseStyle(text.body)?.info.version || '';
    return this.install(text.body, { origin: 'registry', url: `${this.loader.registryBase}/v1/banans/${slugName}/versions/${v}/download`, registry: { slug: slugName, version: v } });
  }
}
