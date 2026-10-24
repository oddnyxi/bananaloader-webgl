// BananaLoader core: finds Banans, runs their lifecycle against the game's frame loop,
// tracks scenes, and owns the patcher, preferences, coroutines and GUI overlay.

import { getBootstrap, prepareIl2Cpp } from '../bootstrap/index.js';
import { Il2Cpp } from '../il2cpp/runtime.js';
import { UnityApi } from '../il2cpp/unity.js';
import { ValueFormatter } from '../il2cpp/values.js';
import { Banan, BananPlugin, parseHeader, compile, instantiate, slug } from './banan.js';
import { Patcher } from './patcher.js';
import { Interop, Ref } from './interop.js';
import { Completer } from '../il2cpp/complete.js';
import { Preferences } from './prefs.js';
import { LogHub } from './logger.js';
import { Store } from './store.js';
import { Coroutines } from './coroutines.js';
import { Overlay } from './overlay.js';
import { TypeGen } from './typegen.js';
import { liveDump } from '../dumper/live.js';

export const VERSION = '1.3.0';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SETTINGS_KEY = 'bananaloader:settings';
const STAGES = ['boot', 'pre', 'started', 'initialized', 'late'];
const PALETTE = ['#f5c518', '#4ade80', '#60a5fa', '#f472b6', '#a78bfa', '#fb923c', '#2dd4bf', '#facc15', '#f87171', '#38bdf8'];

export class BananaLoader {
  constructor() {
    this.version = VERSION;
    this.hub = new LogHub();
    this.log = this.hub.logger('BananaLoader', '#e11d2e');
    this.prefs = new Preferences();
    this.store = new Store();
    this.patcher = new Patcher(this);
    this.coroutines = new Coroutines(this);
    this.overlay = new Overlay(this);
    this.entries = new Map();
    this.stage = 'boot';
    this.game = {};
    this.scenes = new Map();
    this._events = {};
    this._colors = 0;
    this.settings = { safeMode: false, explorer: true, toggleKey: 'F8', autoProps: 'engine', showAccessors: false };
    try { Object.assign(this.settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')); } catch (_) { /* ignore */ }
    this.prefs.on('saved', () => this._each('onPreferencesSaved'));
    this.prefs.on('loaded', () => this._each('onPreferencesLoaded'));
  }

  saveSettings() { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings)); } catch (_) { /* ignore */ } }

  on(ev, fn) { (this._events[ev] ||= []).push(fn); }
  emit(ev, ...a) { for (const fn of this._events[ev] || []) { try { fn(...a); } catch (e) { console.error(e); } } }

  stageAtLeast(s) { return STAGES.indexOf(this.stage) >= STAGES.indexOf(s); }

  // ------------------------------------------------------------------ boot

  /**
   * Runs at document-start. Joins the shared bootstrap (which shows the loading screen) and
   * resolves with { Module } once a Unity game is detected and its exports exist.
   */
  async boot() {
    const boot = (this.bootstrap = getBootstrap());
    this.client = boot.client({ id: 'bananaloader', name: 'BananaLoader', version: VERSION, color: '#f5c518', expectedSteps: 11 });
    const recordsP = this.readRecords().catch((e) => { this.log.error('could not read installed Banans:', e); return []; });
    await boot.whenDetected();
    const records = await this.client.run('records', 'Read installed Banans', async (note) => {
      const r = await recordsP;
      note(`${r.length} installed${r.some((x) => x.origin === 'folder') ? ' · linked folder' : ''}${this.settings.safeMode ? ' · safe mode' : ''}`);
      return r;
    });
    for (const r of records) this._addEntry(r);
    await boot.whenModule();
    // wrapped: on Unity 2018 – 2020 the Module is a thenable, so it can't be a promise's value
    return { Module: boot.Module };
  }

  async readRecords() {
    const recs = await this.store.all();
    // linked folder (only when permission is still granted; otherwise the UI offers to reconnect)
    try {
      if ((await this.store.folderPermission(false)) === 'granted') {
        const files = await this.store.readFolder();
        const states = (await this.store.getMeta('folderStates')) || {};
        for (const f of files) {
          const id = 'folder:' + f.file;
          recs.push({ id, source: f.source, origin: 'folder', file: f.file, enabled: states[id] !== false });
        }
      }
    } catch (e) { this.log.warn('linked Banans folder unavailable:', e.message || e); }
    return recs;
  }

  _addEntry(rec) {
    const info = parseHeader(rec.source);
    const e = this.entries.get(rec.id) || {};
    Object.assign(e, {
      id: rec.id,
      rec,
      info: {
        id: rec.id,
        name: info.name || rec.name || rec.id,
        version: info.version || '0.0.0',
        author: info.author || 'Unknown',
        description: info.description || '',
        type: (info.type || 'mod').toLowerCase() === 'plugin' ? 'plugin' : 'mod',
        games: info.game || ['*'],
        color: info.color || PALETTE[[...String(rec.id)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % PALETTE.length],
        homepage: info.homepage || info.url || '',
        requires: (info.require || []).map(parseDep),
        optional: (info.optional || []).map(parseDep),
      },
      state: e.state || 'idle',
      instance: e.instance || null,
      error: null,
    });
    this.entries.set(rec.id, e);
    return e;
  }

  matchesGame(e) {
    const name = this.game.product || '';
    return e.info.games.some((g) => {
      if (g === '*' || !name) return true;
      const re = new RegExp('^' + g.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i');
      return re.test(name);
    });
  }

  onModule(M) {
    this.Module = M;
    this.game = { company: M.companyName || '', product: M.productName || document.title || '', version: M.productVersion || '' };
    this._hookFrames(M);
    addEventListener('pagehide', () => { this._each('onApplicationQuit'); this.prefs.save(); });
    this.stage = 'pre';
    this.emit('stage');
    const list = this.ordered();
    const st = this.client.step('load', 'Load Banans');
    if (this.settings.safeMode) { this.log.warn('Safe mode is on: no Banans are loaded.'); st.skip('safe mode: none loaded'); }
    else {
      for (const e of list) if (e.rec.enabled !== false) this.load(e, { quiet: true });
      const failed = list.filter((e) => e.state === 'error');
      const ok = list.filter((e) => e.state === 'loaded');
      st.done(`${ok.length} loaded${failed.length ? ` · ${failed.length} failed` : ''}${list.length - ok.length - failed.length ? ` · ${list.length - ok.length - failed.length} skipped` : ''} · onPreInitialize`);
    }
    this.bootstrap.whenRuntime().then(() => this.initIl2Cpp());
  }

  /** Plugins first, then mods, each by name. */
  /** Load order: plugins before mods, dependencies before dependents, then by name. */
  ordered() {
    const list = [...this.entries.values()].sort((a, b) => (a.info.type === b.info.type ? a.info.name.localeCompare(b.info.name) : a.info.type === 'plugin' ? -1 : 1));
    const out = [];
    const state = new Map();
    const visit = (e) => {
      const st = state.get(e);
      if (st === 2) return;
      if (st === 1) return; // cycle: reported when loading
      state.set(e, 1);
      for (const d of [...e.info.requires, ...e.info.optional]) { const de = this._entry(d.name); if (de) visit(de); }
      state.set(e, 2);
      out.push(e);
    };
    for (const e of list) visit(e);
    return out;
  }

  /** Banans that require e (directly or not). */
  dependents(e) {
    const out = [];
    const seen = new Set([e]);
    const walk = (x) => {
      for (const o of this.entries.values()) {
        if (seen.has(o)) continue;
        if ([...o.info.requires, ...o.info.optional].some((d) => this._entry(d.name) === x)) { seen.add(o); walk(o); out.push(o); }
      }
    };
    walk(e);
    return out.reverse();
  }

  /** Load Banans that failed only because e was missing, disabled or too old. */
  _wakeWaiting(e) {
    if (e.state !== 'loaded') return;
    for (const d of this.dependents(e)) {
      if (d.state === 'error' && d.rec.enabled !== false && d.info.requires.some((r) => this._entry(r.name) === e)) this.load(d, { quiet: true });
    }
  }

  /** null if requirements are met (loading them if needed), else an error string. */
  _deps(e, chain = []) {
    if (chain.includes(e)) return `dependency cycle: ${[...chain, e].map((x) => x.info.name).join(' → ')}`;
    for (const d of e.info.requires) {
      const de = this._entry(d.name);
      if (!de) return `requires ${d.name}${d.range ? ' ' + d.range : ''}, which isn't installed`;
      if (de.rec.enabled === false) return `requires ${d.name}, which is disabled`;
      if (d.range && !satisfies(de.info.version, d.range)) return `requires ${d.name} ${d.range} (installed: ${de.info.version})`;
      if (de.state !== 'loaded') {
        const err = this._deps(de, [...chain, e]);
        if (err) return `${d.name}: ${err}`;
        if (!this.load(de, { quiet: true })) return `requires ${d.name}, which failed to load`;
      }
    }
    for (const d of e.info.optional) {
      const de = this._entry(d.name);
      if (de && de.rec.enabled !== false && de.state !== 'loaded' && !this._deps(de, [...chain, e])) this.load(de, { quiet: true });
    }
    return null;
  }

  async initIl2Cpp() {
    const c = this.client;
    const boot = this.bootstrap;
    const failed = (e) => { this.log.error('IL2CPP bridge failed:', e.message || e); c.fail(e); this.emit('failed', e); };
    if (boot.state.unsupported) { failed(new Error(boot.state.unsupported)); return; }
    let hints;
    try {
      const prep = c.step('prepare', 'Prepare the IL2CPP bridge');
      hints = await prepareIl2Cpp(boot, prep);
      prep.done(hints.fnTables ? `fastcomp build · ${hints.fnTables.size} per-signature function tables` : hints.flavor === 'fastcomp' ? 'fastcomp build · function tables unavailable' : 'LLVM build · direct function pointers');
    } catch (e) { failed(e); return; }
    for (let attempt = 0; ; attempt++) {
      try {
        const il = new Il2Cpp(this.Module, (m) => this.log.debug(m), hints);
        await il.initAsync(c);
        this.il = il;
        break;
      } catch (e) {
        if (attempt < 60 && /metadata not found/.test(e.message)) {
          c.step('metadata', 'Locate global-metadata.dat').wait(`not in memory yet, retrying (${attempt + 1})`);
          await sleep(1000);
          continue;
        }
        failed(e);
        return;
      }
    }
    try {
      c.run('unity', 'Resolve the UnityEngine API', (note) => {
        this.unity = new UnityApi(this.il);
        const keys = Object.keys(UnityApi.CANDIDATES);
        note(`${keys.filter((k) => this.unity.has(k)).length}/${keys.length} engine methods available`);
      });
      c.run('interop', 'Build Il2Cpp interop', (note) => {
        this.fmt = new ValueFormatter(this.il, this.unity);
        this.interop = new Interop(this.il, this.unity, this.fmt);
        this.Il2Cpp = this.interop.api();
        this.completer = new Completer({ il: this.il, index: this.interop.index, api: this.Il2Cpp });
        note('Il2Cpp.type · find · patch · generics · IntelliSense');
      });
    } catch (e) { failed(e); return; }
    this.game.unity = this._unityVersion();
    boot.fact('Unity', this.game.unity !== 'unknown' ? this.game.unity : null);
    boot.fact('IL2CPP', `metadata v${this.il.md.versionLabel}`);
    this._banner();

    c.run('init', 'Initialize Banans', (note) => {
      this.stage = 'started';
      for (const e of this.loaded()) if (e.info.type === 'plugin') this.safe(e.instance, 'onApplicationStarted');
      this.stage = 'initialized';
      for (const e of this.loaded()) this.safe(e.instance, 'onInitializeBanan');
      this._trackScenes();
      this.emit('stage');
      this._lateNext = true;
      const n = this.loaded().length;
      note(`${n} Banan${n === 1 ? '' : 's'} initialized · ${this.scenes.size} scene${this.scenes.size === 1 ? '' : 's'} tracked`);
    });
    const n = this.loaded().length;
    c.ready(`${n} Banan${n === 1 ? '' : 's'} · press ${this.settings.toggleKey || 'F8'}`);
  }

  _unityVersion() {
    try {
      const m = this.il.findMethod('UnityEngine.Application', 'get_unityVersion', 0);
      if (m && !this.il.whyNotCallable(m)) return this.il.call(m, 0);
    } catch (_) { /* ignore */ }
    try {
      const mem = this.il.mem.views();
      const end = Math.min(this.il.reg.meta.addr + 0x400000, 64 << 20, mem.size);
      const text = new TextDecoder('latin1').decode(mem.u8.subarray(0, end));
      const counts = new Map();
      for (const x of text.matchAll(/\b(20[1-9]\d|6\d{3})\.\d{1,2}\.\d{1,3}[abfp]\d{1,2}\b/g)) counts.set(x[0], (counts.get(x[0]) || 0) + 1);
      return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 'unknown';
    } catch (_) { return 'unknown'; }
  }

  _banner() {
    const L = this.log;
    const loaded = this.loaded();
    L.big('------------------------------');
    L.big(`BananaLoader v${VERSION}`);
    L.msg(`Game: ${this.game.product || 'Unknown'}${this.game.company ? ` (${this.game.company})` : ''}${this.game.version ? ` v${this.game.version}` : ''}`);
    L.msg(`Unity ${this.game.unity} · IL2CPP metadata v${this.il.md.versionLabel} · ${this.il.md.typeCount.toLocaleString()} types`);
    L.big('------------------------------');
    L.msg(`${loaded.length} Banan${loaded.length === 1 ? '' : 's'} loaded`);
    for (const e of loaded) {
      L.big('------------------------------');
      const lg = this.hub.logger(e.info.name, e.info.color);
      lg.big(`${e.info.name} v${e.info.version}${e.info.type === 'plugin' ? ' [plugin]' : ''}`);
      lg.msg(`by ${e.info.author}`);
    }
    L.big('------------------------------');
    for (const e of this.entries.values()) if (e.state === 'error') L.error(`${e.info.name} failed to load: ${e.error}`);
  }

  loaded() { return this.ordered().filter((e) => e.state === 'loaded'); }

  // ------------------------------------------------------------------ loading banans

  scope(e, logger) {
    return {
      Banan, BananPlugin,
      BananaLoader: this.publicApi(),
      Il2Cpp: new Proxy({}, { get: (_, k) => { if (!this.Il2Cpp) throw new Error('Il2Cpp is not ready yet (use it from onInitializeBanan or later)'); return this.Il2Cpp[k]; } }),
      logger,
      Ref,
    };
  }

  /**
   * Bare type names for Banans (`Camera.main`, `UnityEngine.Time.timeScale`). Resolved when the
   * code runs, so it's fine to compile before Il2Cpp is up; browser globals keep their meaning.
   */
  typeScope() {
    if (this._typeScope) return this._typeScope;
    let inner = null;
    const live = () => (inner ||= this.interop ? this.interop.typeScope({ unityFirst: false }) : null);
    this._typeScope = new Proxy(Object.create(null), {
      has: (_, k) => { const s = live(); return !!s && k in s; },
      get: (_, k) => { const s = live(); return s ? s[k] : undefined; },
      set: () => false,
    });
    return this._typeScope;
  }

  /** Compile, instantiate and bring a Banan up to the current stage. */
  load(e, { quiet = false } = {}) {
    if (e.state === 'loaded') return true;
    e.error = null;
    if (!this.matchesGame(e)) { e.state = 'skipped'; e.error = `not for this game (${e.info.games.join(', ')})`; this.emit('banans'); return false; }
    const depErr = this._deps(e);
    if (depErr) { e.state = 'error'; e.error = depErr; this.log.error(`${e.info.name}: ${depErr}`); this.emit('banans'); return false; }
    const logger = this.hub.logger(e.info.name, e.info.color);
    let inst;
    try {
      const ex = compile(e.rec.source, e.id, this.scope(e, logger), this.typeScope());
      inst = instantiate(ex);
    } catch (err) {
      e.state = 'error';
      e.error = String(err && err.message || err);
      this.log.error(`${e.info.name}: ${err && err.stack || err}`);
      this.emit('banans');
      return false;
    }
    if (inst instanceof BananPlugin) e.info.type = 'plugin';
    inst.info = e.info;
    inst.logger = logger;
    inst.loader = this;
    inst._timers = [];
    inst._errors = {};
    e.instance = inst;
    e.state = 'loaded';
    this.safe(inst, 'onPreInitialize');
    if (this.stageAtLeast('started') && e.info.type === 'plugin') this.safe(inst, 'onApplicationStarted');
    if (this.stageAtLeast('initialized')) this.safe(inst, 'onInitializeBanan');
    if (this.stageAtLeast('late')) {
      this.safe(inst, 'onLateInitializeBanan');
      for (const s of this.scenes.values()) { this.safe(inst, 'onSceneWasLoaded', s.buildIndex, s.name); this.safe(inst, 'onSceneWasInitialized', s.buildIndex, s.name); }
    }
    if (!quiet) logger.success(`${e.info.name} v${e.info.version} loaded`);
    this.emit('banans');
    return true;
  }

  unload(e) {
    if (e.state !== 'loaded' || !e.instance) { e.state = 'idle'; this.emit('banans'); return; }
    // dependents go first
    for (const d of this.dependents(e)) if (d.state === 'loaded') { this.unload(d); d.state = 'idle'; d._unloadedFor = e; }
    const inst = e.instance;
    this.safe(inst, 'onDeinitializeBanan');
    this.patcher.unpatchOwner(inst);
    this.coroutines.stopOwner(inst);
    for (const t of inst._timers) { clearInterval(t); clearTimeout(t); }
    this.prefs.save();
    this.prefs.removeOwner(inst);
    this.emit('unload', inst);
    e.instance = null;
    e.state = 'idle';
    this.hub.logger(e.info.name, e.info.color).msg('unloaded');
    this.emit('banans');
  }

  reload(e) {
    const deps = this.dependents(e).filter((d) => d.state === 'loaded');
    this.unload(e);
    this._addEntry(e.rec);
    const ok = this.load(e);
    for (const d of deps) if (d.rec.enabled !== false) this.load(d, { quiet: true });
    return ok;
  }

  // ------------------------------------------------------------------ install / remove

  async install(source, { origin = 'file', url = '', file = '' } = {}) {
    const info = parseHeader(source);
    let id = slug(info.name || file.replace(/\.(banan\.)?js$/i, '') || 'banan');
    const existing = this.entries.get(id);
    if (existing && existing.rec.origin === 'folder') id += '-copy';
    const rec = { id, source, origin, url, file, enabled: true, name: info.name };
    await this.store.put(rec);
    const deps = existing ? this.dependents(existing).filter((d) => d.state === 'loaded') : [];
    if (existing && existing.state === 'loaded') this.unload(existing);
    const e = this._addEntry(rec);
    if (this.stageAtLeast('pre') && !this.settings.safeMode) {
      this.load(e);
      for (const d of deps) if (d.rec.enabled !== false) this.load(d, { quiet: true });
      this._wakeWaiting(e);
    }
    this.emit('banans');
    return e;
  }

  async installFromUrl(url) {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return this.install(await r.text(), { origin: 'url', url, file: url.split('/').pop() });
  }

  async updateFromUrl(e) {
    if (!e.rec.url) throw new Error('not installed from a URL');
    const r = await fetch(e.rec.url, { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    e.rec.source = await r.text();
    await this.store.put(e.rec);
    return this.reload(e);
  }

  async saveSource(e, source) {
    e.rec.source = source;
    if (e.rec.origin === 'folder') { e.rec.origin = 'editor'; e.rec.id = e.id = slug(parseHeader(source).name || e.id.replace(/^folder:/, '')); this.entries.set(e.id, e); }
    await this.store.put(e.rec);
    return this.reload(e);
  }

  async setEnabled(e, on) {
    e.rec.enabled = on;
    if (e.rec.origin === 'folder') {
      const states = (await this.store.getMeta('folderStates')) || {};
      states[e.id] = on;
      await this.store.setMeta('folderStates', states);
    } else await this.store.put(e.rec);
    if (on) {
      this.load(e);
      for (const d of this.entries.values()) if (d._unloadedFor === e && d.rec.enabled !== false) { d._unloadedFor = null; this.load(d, { quiet: true }); }
      this._wakeWaiting(e);
    } else this.unload(e);
  }

  async remove(e) {
    this.unload(e);
    if (e.rec.origin !== 'folder') await this.store.remove(e.id);
    this.entries.delete(e.id);
    this.emit('banans');
  }

  /** Re-read the linked folder and hot-reload what changed. */
  async syncFolder(request = false) {
    const perm = await this.store.folderPermission(request);
    if (perm !== 'granted') throw new Error(perm === 'none' ? 'no folder linked' : 'permission to read the folder was not granted');
    const files = await this.store.readFolder();
    const states = (await this.store.getMeta('folderStates')) || {};
    const seen = new Set();
    for (const f of files) {
      const id = 'folder:' + f.file;
      seen.add(id);
      const cur = this.entries.get(id);
      if (cur && cur.rec.source === f.source) continue;
      const rec = { id, source: f.source, origin: 'folder', file: f.file, enabled: states[id] !== false };
      if (cur) { this.unload(cur); cur.rec = rec; this._addEntry(rec); if (rec.enabled) this.load(cur); }
      else { const e = this._addEntry(rec); if (rec.enabled && this.stageAtLeast('pre') && !this.settings.safeMode) this.load(e); }
    }
    for (const e of [...this.entries.values()]) if (e.rec.origin === 'folder' && !seen.has(e.id)) { this.unload(e); this.entries.delete(e.id); }
    this.emit('banans');
    return files.length;
  }

  // ------------------------------------------------------------------ lifecycle plumbing

  /** Call a Banan callback, catching and rate-limiting errors. */
  safe(inst, name, ...args) {
    if (!inst) return undefined;
    const fn = typeof name === 'function' ? name : inst[name];
    if (typeof fn !== 'function') return undefined;
    const key = typeof name === 'function' ? 'callback' : name;
    if (inst._errors && inst._errors[key] >= 25) return undefined;
    try {
      return fn.apply(inst, args);
    } catch (e) {
      inst._errors[key] = (inst._errors[key] || 0) + 1;
      const n = inst._errors[key];
      if (n <= 3) inst.logger.error(`${key} threw: ${e && e.stack || e}`);
      if (n === 25) inst.logger.error(`${key} disabled after 25 errors`);
      return undefined;
    }
  }

  _overrides(inst, name) { return inst && typeof inst[name] === 'function' && inst[name] !== Banan.prototype[name]; }

  _each(name, ...args) { for (const e of this.loaded()) if (this._overrides(e.instance, name)) this.safe(e.instance, name, ...args); }

  _hookFrames(M) {
    if (M.__bananaFrames) return;
    M.__bananaFrames = true;
    const prevPost = M.postMainLoop;
    M.postMainLoop = () => {
      if (prevPost) prevPost();
      this.frame();
    };
    this._fixedAcc = 0;
  }

  frame() {
    if (!this.stageAtLeast('initialized')) return;
    this.frameCount = (this.frameCount || 0) + 1;
    if (this._lateNext) {
      this._lateNext = false;
      this.stage = 'late';
      this._each('onLateInitializeBanan');
      this.emit('stage');
    }
    // scenes loaded last frame are now initialized
    if (this._sceneInit && this._sceneInit.length) {
      const list = this._sceneInit.splice(0);
      for (const s of list) this._each('onSceneWasInitialized', s.buildIndex, s.name);
    }
    if (this._pollScenes) this._pollScenes();
    this.coroutines.tick();
    this._each('onUpdate');
    // fixed steps at Time.fixedDeltaTime, driven by scaled delta time
    let dt = 1 / 60;
    let fdt = 0.02;
    try {
      if (this._time === undefined) this._time = this.il.findType('UnityEngine.Time');
      if (this._time >= 0) {
        this._dtM ||= this.il.findMethod(this._time, 'get_deltaTime', 0);
        this._fdtM ||= this.il.findMethod(this._time, 'get_fixedDeltaTime', 0);
        if (this._dtM) dt = this.il.call(this._dtM, 0);
        if (this._fdtM) fdt = this.il.call(this._fdtM, 0) || 0.02;
      }
    } catch (_) { /* keep defaults */ }
    this._fixedAcc += dt;
    let steps = 0;
    while (this._fixedAcc >= fdt && steps < 5) { this._fixedAcc -= fdt; steps++; this._each('onFixedUpdate'); }
    if (steps === 5) this._fixedAcc = 0;
    this._each('onLateUpdate');
    this.overlay.frame();
    this.emit('frame');
  }

  // ------------------------------------------------------------------ scenes

  sceneInfo(handle) {
    const il = this.il;
    const info = { handle, name: `Scene ${handle}`, buildIndex: -1 };
    const call = (key, cands) => {
      for (const [n, argc, inst] of cands) {
        const m = il.findMethod('UnityEngine.SceneManagement.Scene', n, argc);
        if (!m || il.whyNotCallable(m)) continue;
        try {
          if (!inst) return il.call(m, 0, handle);
          const buf = il.malloc(4);
          try { il.mem.setI32(buf, handle); return il.call(m, buf); } finally { il.free(buf); }
        } catch (_) { /* next */ }
      }
      return undefined;
    };
    const n = call('name', [['GetNameInternal', 1, false], ['get_name', 0, true]]);
    if (n) info.name = n;
    const b = call('build', [['GetBuildIndexInternal', 1, false], ['get_buildIndex', 0, true]]);
    if (typeof b === 'number') info.buildIndex = b;
    return info;
  }

  _sceneHandle(v) { return v && typeof v === 'object' ? Object.values(v)[0] : v; }

  _sceneLoaded(handle) {
    if (this.scenes.has(handle)) return;
    const s = this.sceneInfo(handle);
    this.scenes.set(handle, s);
    this.log.msg(`Scene loaded: ${s.name}${s.buildIndex >= 0 ? ` (#${s.buildIndex})` : ''}`);
    this._each('onSceneWasLoaded', s.buildIndex, s.name);
    (this._sceneInit ||= []).push(s);
    this.emit('scenes');
  }

  _sceneUnloaded(handle) {
    const s = this.scenes.get(handle) || this.sceneInfo(handle);
    this.scenes.delete(handle);
    this._each('onSceneWasUnloaded', s.buildIndex, s.name);
    this.emit('scenes');
  }

  /** Current scenes via SceneManager, if the build kept those APIs. */
  _currentScenes() {
    const il = this.il;
    const out = [];
    const count = il.findMethod('UnityEngine.SceneManagement.SceneManager', 'get_sceneCount', 0);
    const at = il.findMethod('UnityEngine.SceneManagement.SceneManager', 'GetSceneAt', 1);
    try {
      if (count && at && !il.whyNotCallable(count) && !il.whyNotCallable(at)) {
        const n = il.call(count, 0);
        for (let i = 0; i < n; i++) out.push(this._sceneHandle(il.call(at, 0, i)));
        return out;
      }
    } catch (_) { /* fall through */ }
    const active = il.findMethod('UnityEngine.SceneManagement.SceneManager', 'GetActiveScene', 0);
    try { if (active && !il.whyNotCallable(active)) out.push(this._sceneHandle(il.call(active, 0))); } catch (_) { /* ignore */ }
    return out;
  }

  _trackScenes() {
    let hooked = 0;
    try {
      this.patcher.patch(null, 'UnityEngine.SceneManagement.SceneManager::Internal_SceneLoaded', {
        postfix: (ctx) => this._sceneLoaded(this._sceneHandle(ctx.arg(0))),
      });
      hooked++;
    } catch (e) { this.log.debug('scene load hook unavailable: ' + e.message); }
    try {
      this.patcher.patch(null, 'UnityEngine.SceneManagement.SceneManager::Internal_SceneUnloaded', {
        postfix: (ctx) => this._sceneUnloaded(this._sceneHandle(ctx.arg(0))),
      });
      hooked++;
    } catch (e) { this.log.debug('scene unload hook unavailable: ' + e.message); }
    for (const h of this._currentScenes()) if (h) this._sceneLoaded(h);
    if (hooked < 2) {
      // poll as a fallback
      let last = 0;
      this._pollScenes = () => {
        if (this.frameCount - last < 30) return;
        last = this.frameCount;
        const now = new Set(this._currentScenes().filter(Boolean));
        for (const h of now) if (!this.scenes.has(h)) this._sceneLoaded(h);
        for (const h of [...this.scenes.keys()]) if (!now.has(h) && now.size) this._sceneUnloaded(h);
      };
    }
  }

  _entry(name) { for (const e of this.entries.values()) if (e.info.name === name || e.id === name) return e; return null; }

  // ------------------------------------------------------------------ public API (window.BananaLoader and inside Banans)

  publicApi() {
    if (this._api) return this._api;
    const self = this;
    this._api = {
      version: VERSION,
      Banan, BananPlugin, Ref,
      get game() { return { ...self.game }; },
      get stage() { return self.stage; },
      get scenes() { return [...self.scenes.values()]; },
      get banans() { return [...self.entries.values()].map((e) => ({ id: e.id, name: e.info.name, version: e.info.version, state: e.state, instance: e.instance })); },
      find: (name) => { const e = self._entry(name); return e ? e.instance : null; },
      enable: (name) => { const e = self._entry(name); if (!e) throw new Error('no Banan ' + name); return self.setEnabled(e, true); },
      disable: (name) => { const e = self._entry(name); if (!e) throw new Error('no Banan ' + name); return self.setEnabled(e, false); },
      reload: (name) => { const e = self._entry(name); if (!e) throw new Error('no Banan ' + name); return self.reload(e); },
      get Il2Cpp() { return self.Il2Cpp; },
      get il() { return self.il; },
      get unity() { return self.unity; },
      /** The shared Unity Bootstrap (loading screen, build info, report()). */
      get bootstrap() { return self.bootstrap; },
      Preferences: {
        createCategory: (id, name) => self.prefs.createCategory(id, name),
        getCategory: (id) => self.prefs.getCategory(id),
        save: () => self.prefs.save(),
        load: () => self.prefs.load(),
      },
      logger: (name, color) => self.hub.logger(name, color),
      patch: (target, hooks) => self.patcher.patch(null, target, hooks),
      /** Odium Dumper output from the running game: { files: [{ name, data }], summary }. */
      dump: (o = {}) => { if (!self.il) throw new Error('IL2CPP is not ready'); return liveDump(self.il, { wasmBytes: self.bootstrap && self.bootstrap.wasmBytes, ...o }); },
      /** TypeScript definitions for the game: generateTypes({ assemblies: ['Assembly-CSharp', ...], publicOnly }) */
      generateTypes: (o = {}) => {
        const il = self.il;
        if (!il) throw new Error('IL2CPP is not ready');
        const names = o.assemblies ? new Set(o.assemblies.map((n) => n.replace(/\.dll$/, ''))) : null;
        const images = il.md.images.map((im, i) => [im.name.replace(/\.dll$/, ''), i]).filter(([n]) => !names || names.has(n)).map(([, i]) => i);
        const gen = new TypeGen(il);
        gen.game = `${self.game.product} (Unity ${self.game.unity})`;
        return gen.generate({ images, publicOnly: o.publicOnly !== false });
      },
      /**
       * IntelliSense used by the console and editor: complete('Camera.main.tr') →
       * { from, to, items: [{ label, kind, detail }], hint }. Static only; nothing is called.
       */
      complete: (text, caret = String(text).length, ctx = {}) => {
        if (!self.completer) return null;
        const roots = { BananaLoader: self._api, Il2Cpp: self.Il2Cpp, il: self.il, unity: self.unity, ...(ctx.roots || {}) };
        return self.completer.complete(String(text), caret, { bare: true, unityFirst: true, ...ctx, roots }, true);
      },
      /** The loader window (UI views), once it's built. */
      get app() { return self.app || null; },
      install: (source, o) => self.install(source, o),
      installFromUrl: (url) => self.installFromUrl(url),
      uninstall: async (name) => { const e = self._entry(name); if (!e) throw new Error('no Banan ' + name); await self.remove(e); },
      on: (ev, fn) => self.on(ev, fn),
    };
    return this._api;
  }
}

/** "Name >=1.2.0" -> { name, range } (the range is optional) */
function parseDep(s) {
  const m = /^(.*?)\s*((?:>=|<=|>|<|=|\^|~)\s*\d[\w.\-]*)?$/.exec(s.trim());
  return { name: m[1].trim(), range: m[2] ? m[2].replace(/\s+/g, '') : '' };
}

function cmp(a, b) {
  const pa = String(a).split(/[.\-]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split(/[.\-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d; }
  return 0;
}

export function satisfies(v, range) {
  const parts = String(range).trim().split(/\s+/);
  if (parts.length > 1) return parts.every((r) => satisfies(v, r));
  const m = /^(>=|<=|>|<|=|\^|~)?(.+)$/.exec(range);
  const op = m[1] || '=';
  const want = m[2];
  const c = cmp(v, want);
  switch (op) {
    case '>=': return c >= 0;
    case '<=': return c <= 0;
    case '>': return c > 0;
    case '<': return c < 0;
    case '^': return c >= 0 && String(v).split('.')[0] === String(want).split('.')[0];
    case '~': return c >= 0 && String(v).split('.').slice(0, 2).join('.') === String(want).split('.').slice(0, 2).join('.');
    default: return c === 0;
  }
}
