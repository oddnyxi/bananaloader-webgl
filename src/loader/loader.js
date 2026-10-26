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

export const VERSION = '1.6.0';
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
    this.settings = { safeMode: false, explorer: true, toggleKey: 'F8', autoProps: 'engine', showAccessors: false, registry: 'https://api.bananaloader.com', checkUpdates: true, directCallsAll: false };
    try { const st = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); if (st && typeof st === 'object' && !Array.isArray(st)) Object.assign(this.settings, st); } catch (_) { /* ignore */ }
    // Safe mode is read once per page: turning it on or off in Settings takes effect after a reload.
    this.safeMode = this.settings.safeMode === true;
    this._loadStack = [];
    this._order = null;
    this.prefs.on('saved', () => this._each('onPreferencesSaved'));
    this.prefs.on('loaded', () => this._each('onPreferencesLoaded'));
  }

  saveSettings() {
    this._syncHookSettings();
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings)); } catch (_) { /* ignore */ }
  }

  /** hook.js turns "catch direct calls without reloading" off when the rewritten wasm didn't compile. */
  _syncHookSettings() {
    const w = window.__bananaHooks && window.__bananaHooks.wasm;
    if (w && w.allOff) this.settings.directCallsAll = false;
  }

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
    // IndexedDB is only opened once a Unity game is detected, so other sites and frames get no database
    await boot.whenDetected();
    const recordsP = this.readRecords().catch((e) => { this.log.error('could not read installed Banans:', e); return []; });
    const records = await this.client.run('records', 'Read installed Banans', async (note) => {
      const r = await recordsP;
      note(`${r.length} installed${r.some((x) => x.origin === 'folder') ? ' · linked folder' : ''}${this.safeMode ? ' · safe mode' : ''}`);
      return r;
    });
    for (const r of records) this._addEntry(r);
    await boot.whenModule();
    this._syncHookSettings();
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
    this._order = null;
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
    addEventListener('pagehide', () => { this.prefs.save(); this._each('onApplicationQuit'); this.prefs.save(true); });
    this.stage = 'pre';
    this.emit('stage');
    const list = this.ordered();
    const st = this.client.step('load', 'Load Banans');
    if (this.safeMode) { this.log.warn('Safe mode is on: no Banans are loaded.'); st.skip('safe mode: none loaded'); }
    else {
      for (const e of list) if (e.rec.enabled !== false) this.load(e, { quiet: true });
      const failed = list.filter((e) => e.state === 'error');
      const ok = list.filter((e) => e.state === 'loaded');
      st.done(`${ok.length} loaded${failed.length ? ` · ${failed.length} failed` : ''}${list.length - ok.length - failed.length ? ` · ${list.length - ok.length - failed.length} skipped` : ''} · onPreInitialize`);
    }
    this.bootstrap.whenRuntime().then(() => this.initIl2Cpp());
  }

  /** Load order: plugins before mods, dependencies before dependents, then by name. Cached until the set of Banans changes. */
  ordered() {
    if (this._order && this._orderSize === this.entries.size && this._order.every((e) => this.entries.get(e.id) === e)) return this._order;
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
    this._order = out;
    this._orderSize = this.entries.size;
    return out;
  }

  /** Banans that use e through @require or @optional, directly or not; the furthest ones first. */
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
    return out;
  }

  /** Whether e needs lib through a chain of @require (an @optional link doesn't count). */
  _needs(e, lib, seen = new Set()) {
    if (seen.has(e)) return false;
    seen.add(e);
    for (const d of e.info.requires) {
      const de = this._entry(d.name);
      if (de === lib || (de && this._needs(de, lib, seen))) return true;
    }
    return false;
  }

  /**
   * e is (back) up: load the Banans that were waiting for it, directly or through other Banans,
   * and restart the ones that ran without it (they used it through @optional).
   */
  _wakeWaiting(e) {
    if (e.state !== 'loaded') return;
    const deps = new Set(this.dependents(e));
    for (const d of this.ordered()) {
      if (!deps.has(d) || d.rec.enabled === false) continue;
      const without = d._waitingOn === e.id;
      d._waitingOn = null;
      if (d.state === 'error' || (d.state === 'idle' && without)) this.load(d, { quiet: true });
      else if (d.state === 'loaded' && without) { const dd = this.unload(d); if (this.load(d, { quiet: true })) this._restore(dd); else this._afterLoss(d, dd); }
    }
  }

  /** e went away (disabled, deleted, failed): bring back what doesn't need it, and mark what waits for it. */
  _afterLoss(e, deps) {
    for (const d of this.ordered()) {
      if (!deps.includes(d)) continue;
      if (d.rec.enabled !== false) {
        // @require users get a clear "requires X, which is disabled/isn't installed" error; @optional users run without it
        this.load(d, { quiet: true });
      }
      d._waitingOn = e.id;
    }
  }

  /** null if requirements are met (loading them if needed), else an error string. */
  _deps(e) {
    for (const d of e.info.requires) {
      const de = this._entry(d.name);
      if (!de) return `requires ${d.name}${d.range ? ' ' + d.range : ''}, which isn't installed`;
      if (de.rec.enabled === false) return `requires ${d.name}, which is disabled`;
      if (d.range && !satisfies(de.info.version, d.range)) return `requires ${d.name} ${d.range} (installed: ${de.info.version})`;
      if (de.state !== 'loaded') {
        const at = this._loadStack.indexOf(de);
        if (at >= 0) return `dependency cycle: ${[...this._loadStack.slice(at), de].map((x) => x.info.name).join(' → ')}`;
        if (!this.load(de, { quiet: true })) return `requires ${d.name}, which failed to load${de.error ? ` (${de.error})` : ''}`;
      }
    }
    for (const d of e.info.optional) {
      const de = this._entry(d.name);
      // an @optional Banan that is itself loading (a cycle) is simply not there yet
      if (de && de.rec.enabled !== false && de.state === 'idle' && !this._loadStack.includes(de)) this.load(de, { quiet: true });
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

    try {
      c.run('init', 'Initialize Banans', (note) => {
        this.stage = 'started';
        for (const e of this.loaded()) if (e.info.type === 'plugin') this.safe(e.instance, 'onApplicationStarted');
        this.stage = 'initialized';
        for (const e of this.loaded()) this.safe(e.instance, 'onInitializeBanan');
        // the late stage and the frame loop must come even if scene tracking breaks
        this._lateNext = true;
        try { this._trackScenes(); } catch (e) { this.log.warn('scene tracking unavailable:', e && e.message || e); }
        this.emit('stage');
        const n = this.loaded().length;
        note(`${n} Banan${n === 1 ? '' : 's'} initialized · ${this.scenes.size} scene${this.scenes.size === 1 ? '' : 's'} tracked`);
      });
    } catch (e) {
      this.stage = 'initialized';
      this._lateNext = true;
      this.log.error('initializing Banans failed:', e && e.stack || e);
    }
    const n = this.loaded().length;
    c.ready(`${n} Banan${n === 1 ? '' : 's'} · press ${this.settings.toggleKey || 'F8'}`);
  }

  _unityVersion() {
    try {
      const m = this.il.findMethod('UnityEngine.Application', 'get_unityVersion', 0);
      if (m && !this.il.whyNotCallable(m)) { const v = this.il.call(m, 0); if (typeof v === 'string' && v.trim()) return v.trim(); }
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
    if (this._loadStack.includes(e)) return false;
    e.error = null;
    if (e.rec.enabled === false) { e.state = 'idle'; this.emit('banans'); return false; }
    if (this.safeMode) {
      e.state = 'idle';
      e.error = 'not loaded: safe mode is on (turn it off in Settings, then reload the page)';
      this.emit('banans');
      return false;
    }
    if (!this.matchesGame(e)) { e.state = 'skipped'; e.error = `not for this game (${e.info.games.join(', ')})`; this.emit('banans'); return false; }
    this._loadStack.push(e);
    let depErr;
    try { depErr = this._deps(e); } finally { this._loadStack.pop(); }
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
    inst._timers ||= [];
    inst._errors = {};
    inst._disposed = false;
    e.instance = inst;
    e.state = 'loaded';
    this.safe(inst, 'onPreInitialize');
    if (this.stageAtLeast('started') && e.info.type === 'plugin') this.safe(inst, 'onApplicationStarted');
    if (this.stageAtLeast('initialized')) {
      this.safe(inst, 'onInitializeBanan');
      if (this.stageAtLeast('late')) this.safe(inst, 'onLateInitializeBanan');
      // catch up on the scenes that are already up; ones still waiting for their first frame
      // get onSceneWasInitialized from frame() like everybody else
      const pending = new Set(this._sceneInit || []);
      for (const sc of this.scenes.values()) {
        if (e.state !== 'loaded') break;
        this.safe(inst, 'onSceneWasLoaded', sc.buildIndex, sc.name);
        if (!pending.has(sc)) this.safe(inst, 'onSceneWasInitialized', sc.buildIndex, sc.name);
      }
    }
    if (!quiet) logger.success(`${e.info.name} v${e.info.version} loaded`);
    this.emit('banans');
    return true;
  }

  /**
   * Stop e and, first, everything that uses it (furthest dependents first). Returns the
   * dependents that were stopped, so the caller can bring them back.
   */
  unload(e, { cascade = true } = {}) {
    if (e.state !== 'loaded' || !e.instance) {
      if (e.state !== 'skipped') { e.state = 'idle'; e.error = null; }
      this.emit('banans');
      return [];
    }
    const deps = cascade ? this.dependents(e).filter((d) => d.state === 'loaded') : [];
    for (const d of deps) if (d.state === 'loaded') this._teardown(d);
    this._teardown(e);
    this.emit('banans');
    return deps;
  }

  /** Stop one Banan (no dependents). */
  _teardown(e) {
    const inst = e.instance;
    // still 'loaded' during its own callbacks; preferences are saved while everybody can still hear about it
    this.prefs.save();
    this.safe(inst, 'onDeinitializeBanan');
    inst._disposed = true;
    this.patcher.unpatchOwner(inst);
    this.coroutines.stopOwner(inst);
    for (const t of inst._timers || []) { clearInterval(t); clearTimeout(t); }
    inst._timers = [];
    this.prefs.save(true);
    this.prefs.removeOwner(inst);
    e.instance = null;
    e.state = 'idle';
    e.error = null;
    this.emit('unload', inst);
    this.hub.logger(e.info.name, e.info.color).msg('unloaded');
  }

  /** Bring back Banans stopped by unload() (in load order). */
  _restore(deps) {
    for (const d of this.ordered()) if (deps.includes(d) && d.rec.enabled !== false && d.state !== 'loaded') this.load(d, { quiet: true });
  }

  /** Re-read e's source and restart it (and what uses it). A disabled Banan is only re-read. */
  reload(e) {
    const deps = this.unload(e);
    this._addEntry(e.rec);
    if (e.rec.enabled === false) { e.state = 'idle'; this.emit('banans'); return false; }
    const ok = this.load(e);
    if (ok) { this._restore(deps); this._wakeWaiting(e); } else this._afterLoss(e, deps);
    return ok;
  }

  // ------------------------------------------------------------------ install / remove

  /** A free id for a new Banan named name (never another Banan's). */
  _freeId(base, self = null) {
    let id = base;
    for (let n = 2; this.entries.has(id) && this.entries.get(id) !== self; n++) id = `${base}-${n}`;
    return id;
  }

  async install(source, { origin = 'file', url = '', file = '', registry = null, enabled } = {}) {
    const info = parseHeader(source);
    let id = slug(info.name || file.replace(/\.(banan\.)?js$/i, '') || 'banan');
    let existing = this.entries.get(id);
    if (existing && existing.rec.origin === 'folder') { id = this._freeId(id + '-copy'); existing = this.entries.get(id) || null; }
    const on = enabled !== undefined ? enabled !== false : existing ? existing.rec.enabled !== false : true;
    const rec = { id, source, origin, url, file, enabled: on, name: info.name };
    if (registry) rec.registry = registry;
    await this.store.put(rec);
    const deps = existing ? this.unload(existing) : [];
    const e = this._addEntry(rec);
    if (this.stageAtLeast('pre') && on) {
      const ok = this.load(e);
      if (ok) { this._restore(deps); this._wakeWaiting(e); } else this._afterLoss(e, deps);
    } else if (deps.length) this._afterLoss(e, deps);
    this.emit('banans');
    return e;
  }

  async installFromUrl(url) {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return this.install(await r.text(), { origin: 'url', url, file: url.split('/').pop() });
  }

  // ------------------------------------------------------------------ bananaloader.com registry

  /** API base (https://api.bananaloader.com by default; Settings can point it elsewhere). */
  get registryBase() { return String(this.settings.registry || 'https://api.bananaloader.com').replace(/\/+$/, ''); }

  async registry(path, init) {
    let r;
    try { r = await fetch(`${this.registryBase}/v1${path}`, { cache: 'no-store', credentials: 'omit', ...init }); } catch (e) {
      throw new Error(`can't reach ${this.registryBase} (offline, or this game's page blocks outside connections)`);
    }
    if (!r.ok) { let m = `HTTP ${r.status}`; try { m = (await r.json()).error || m; } catch (_) { /* not json */ } throw new Error(m); }
    return r;
  }

  /** Install (or update) a Banan from the registry by slug. Checks the server's SHA-256. */
  async installFromRegistry(slugName, version = null) {
    const path = version ? `/banans/${encodeURIComponent(slugName)}/versions/${encodeURIComponent(version)}/download` : `/banans/${encodeURIComponent(slugName)}/download`;
    const r = await this.registry(path);
    const text = await r.text();
    const want = r.headers.get('x-content-sha256');
    if (want && crypto.subtle) {
      const got = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, '0')).join('');
      if (got !== want) throw new Error('download corrupted (checksum mismatch)');
    }
    const v = r.headers.get('x-banan-version') || parseHeader(text).version || '';
    const e = await this.install(text, { origin: 'registry', url: `${this.registryBase}/v1/banans/${slugName}/versions/${v}/download`, file: `${slugName}.js`, registry: { slug: slugName, version: v } });
    this.log.msg(`Installed ${e.info.name} ${v} from bananaloader.com`);
    return e;
  }

  /** Registry Banans with a newer approved version: [{ entry, slug, installed, latest, changelog }] */
  async registryUpdates() {
    const installed = [...this.entries.values()].filter((e) => e.rec.registry && e.rec.registry.slug);
    if (!installed.length) return [];
    const r = await this.registry('/updates', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ banans: installed.map((e) => ({ slug: e.rec.registry.slug, version: e.rec.registry.version })) }) });
    const { banans } = await r.json();
    const out = [];
    for (const u of banans) {
      if (!u.update) continue;
      const entry = installed.find((e) => e.rec.registry.slug === u.slug);
      if (entry) out.push({ entry, slug: u.slug, name: u.name, installed: u.installed, latest: u.latest, changelog: u.changelog || '' });
    }
    this.updates = out;
    this.emit('updates', out);
    return out;
  }

  async updateFromUrl(e) {
    if (!e.rec.url) throw new Error('not installed from a URL');
    const r = await fetch(e.rec.url, { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    e.rec.source = await r.text();
    await this.store.put(e.rec);
    return this.reload(e);
  }

  /**
   * Save edited source. A folder Banan becomes an editable copy in the browser (the folder's file
   * stays as it is, switched off, so a later folder sync doesn't overwrite or duplicate the copy).
   */
  async saveSource(e, source) {
    if (e.rec.origin === 'folder') {
      const oldId = e.id;
      const folderRec = { ...e.rec, enabled: false };
      const id = this._freeId(slug(parseHeader(source).name || oldId.replace(/^folder:/, '').replace(/\.(banan\.)?js$/i, '')), e);
      const deps = this.unload(e);
      this.entries.delete(oldId);
      e.rec = { id, source, origin: 'editor', url: '', file: e.rec.file, enabled: true, name: parseHeader(source).name };
      e.id = id;
      this.entries.set(id, e);
      this.prefs.renameCategory(oldId, id);
      const states = (await this.store.getMeta('folderStates')) || {};
      states[oldId] = false;
      await this.store.setMeta('folderStates', states);
      this._addEntry(folderRec);
      await this.store.put(e.rec);
      this._addEntry(e.rec);
      const ok = this.load(e);
      if (ok) { this._restore(deps); this._wakeWaiting(e); } else this._afterLoss(e, deps);
      this.emit('banans');
      return ok;
    }
    e.rec.source = source;
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
      this._wakeWaiting(e);
    } else this._afterLoss(e, this.unload(e));
  }

  async remove(e) {
    const deps = this.unload(e);
    if (e.rec.origin !== 'folder') await this.store.remove(e.id);
    this.entries.delete(e.id);
    this._order = null;
    this._afterLoss(e, deps);
    this.emit('banans');
  }

  /** Re-read the linked folder and hot-reload what changed. */
  async syncFolder(request = false) {
    const perm = await this.store.folderPermission(request);
    if (perm !== 'granted') throw new Error(perm === 'none' ? 'no folder linked' : 'permission to read the folder was not granted');
    const files = await this.store.readFolder();
    const states = (await this.store.getMeta('folderStates')) || {};
    const seen = new Set();
    const up = [];
    for (const f of files) {
      const id = 'folder:' + f.file;
      seen.add(id);
      const cur = this.entries.get(id);
      if (cur && cur.rec.source === f.source) continue;
      const rec = { id, source: f.source, origin: 'folder', file: f.file, enabled: states[id] !== false };
      if (cur) {
        const deps = this.unload(cur);
        cur.rec = rec;
        this._addEntry(rec);
        if (rec.enabled && this.stageAtLeast('pre')) {
          if (this.load(cur)) { this._restore(deps); up.push(cur); } else this._afterLoss(cur, deps);
        } else this._afterLoss(cur, deps);
      } else {
        const e = this._addEntry(rec);
        if (rec.enabled && this.stageAtLeast('pre') && this.load(e)) up.push(e);
      }
    }
    for (const e of [...this.entries.values()]) {
      if (e.rec.origin === 'folder' && !seen.has(e.id)) {
        const deps = this.unload(e);
        this.entries.delete(e.id);
        this._order = null;
        this._afterLoss(e, deps);
      }
    }
    for (const e of up) this._wakeWaiting(e);
    this.emit('banans');
    return files.length;
  }

  // ------------------------------------------------------------------ lifecycle plumbing

  /** Call a Banan callback, catching and rate-limiting errors. */
  safe(inst, name, ...args) {
    if (!inst) return undefined;
    const fn = typeof name === 'function' ? name : inst[name];
    if (typeof fn !== 'function') return undefined;
    return this.safeCall(inst, typeof name === 'function' ? 'callback' : name, fn, args);
  }

  /** Call fn with the Banan as `this`, counting its errors under key (25 errors switch that key off). */
  safeCall(inst, key, fn, args = []) {
    if (!inst || typeof fn !== 'function') return undefined;
    const errs = (inst._errors ||= {});
    if (errs[key] >= 25) return undefined;
    try {
      return fn.apply(inst, args);
    } catch (e) {
      errs[key] = (errs[key] || 0) + 1;
      const n = errs[key];
      const log = inst.logger || this.log;
      if (n <= 3) log.error(`${key} threw: ${e && e.stack || e}`);
      if (n === 25) log.error(`${key} disabled after 25 errors`);
      return undefined;
    }
  }

  _overrides(inst, name) { return inst && typeof inst[name] === 'function' && inst[name] !== Banan.prototype[name]; }

  _each(name, ...args) { for (const e of this.loaded()) if (this._overrides(e.instance, name)) this.safe(e.instance, name, ...args); }

  _hookFrames(M) {
    if (M.__bananaFrames) return;
    M.__bananaFrames = true;
    const prevPost = M.postMainLoop;
    const self = this;
    M.postMainLoop = function (...a) {
      try { if (prevPost) prevPost.apply(this === undefined ? M : this, a); } finally { self.frame(); }
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
    if (this._pollScenes) { try { this._pollScenes(); } catch (e) { this.log.debug('scene poll: ' + (e && e.message || e)); } }
    this.coroutines.tick();
    this._each('onUpdate');
    // fixed steps at Time.fixedDeltaTime, driven by scaled delta time
    let dt = 1 / 60;
    let fdt = 0.02;
    try {
      if (this._time === undefined) {
        this._time = this.il.findType('UnityEngine.Time');
        this._dtM = this._time >= 0 ? this.il.findMethod(this._time, 'get_deltaTime', 0) : null;
        this._fdtM = this._time >= 0 ? this.il.findMethod(this._time, 'get_fixedDeltaTime', 0) : null;
      }
      if (this._time >= 0) {
        if (this._dtM) dt = this.il.call(this._dtM, 0);
        if (this._fdtM) fdt = this.il.call(this._fdtM, 0) || 0.02;
      }
    } catch (_) { /* keep defaults */ }
    this._fixedAcc += dt;
    let steps = 0;
    while (this._fixedAcc >= fdt && steps < 5) { this._fixedAcc -= fdt; steps++; this._each('onFixedUpdate'); }
    // still behind after 5 steps: drop whole steps (no spiral), keep the fraction
    if (steps === 5 && this._fixedAcc >= fdt) this._fixedAcc %= fdt;
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
    // loaded and unloaded within one frame: it never gets initialized
    if (this._sceneInit) this._sceneInit = this._sceneInit.filter((x) => x !== s && x.handle !== handle);
    this._each('onSceneWasUnloaded', s.buildIndex, s.name);
    this.emit('scenes');
  }

  /** Current scenes via SceneManager, if the build kept those APIs. */
  _currentScenes() {
    const il = this.il;
    const M = 'UnityEngine.SceneManagement.SceneManager';
    this._sceneApi ||= { count: il.findMethod(M, 'get_sceneCount', 0), at: il.findMethod(M, 'GetSceneAt', 1), active: il.findMethod(M, 'GetActiveScene', 0) };
    const { count, at, active } = this._sceneApi;
    try {
      if (count && at && !il.whyNotCallable(count) && !il.whyNotCallable(at)) {
        const n = il.call(count, 0);
        const all = [];
        for (let i = 0; i < n; i++) all.push(this._sceneHandle(il.call(at, 0, i)));
        if (all.length) return [...new Set(all)];
      }
    } catch (_) { /* fall through */ }
    try { if (active && !il.whyNotCallable(active)) return [this._sceneHandle(il.call(active, 0))]; } catch (_) { /* ignore */ }
    return [];
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

  /** A Banan by name or id; when several share a name, an enabled one wins. */
  _entry(name) {
    const byId = this.entries.get(name);
    if (byId) return byId;
    let first = null;
    for (const e of this.entries.values()) {
      if (e.info.name !== name) continue;
      if (e.rec.enabled !== false) return e;
      first ||= e;
    }
    return first;
  }

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
      patch: (target, hooks) => { if (!self.interop) throw new Error('BananaLoader.patch() needs IL2CPP, which isn\'t ready yet'); return self.patcher.patch(null, target, hooks); },
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
      /** bananaloader.com: search, install and update Banans. */
      registry: {
        search: async (q = '', o = {}) => (await (await self.registry(`/banans?${new URLSearchParams({ q, ...o })}`)).json()).banans,
        get: async (slug) => (await self.registry(`/banans/${encodeURIComponent(slug)}`)).json(),
        install: (slug, version) => self.installFromRegistry(slug, version),
        updates: () => self.registryUpdates(),
      },
      uninstall: async (name) => { const e = self._entry(name); if (!e) throw new Error('no Banan ' + name); await self.remove(e); },
      on: (ev, fn) => self.on(ev, fn),
    };
    return this._api;
  }
}

/**
 * "Name >=1.2.0" -> { name, range }. The range is optional and can have several comparators
 * ("Name >=1.0 <2.0", "Name ^1.2 || ^2"); names may contain spaces ("Scene Tools ~1.1").
 */
export function parseDep(s) {
  s = String(s).trim();
  const i = s.search(/(?:>=|<=|>|<|=|\^|~)\s*v?\d/);
  if (i <= 0) return { name: s, range: '' };
  const range = s.slice(i).trim().replace(/(>=|<=|>|<|=|\^|~)\s+/g, '$1').replace(/\s+/g, ' ');
  return { name: s.slice(0, i).trim(), range };
}

/** "1.2.3-beta.1" -> { nums: [1, 2, 3], parts: how many numbers were given, pre: ['beta', 1] } */
function parseVer(v) {
  const m = /^\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.\d+)*(?:-([0-9A-Za-z.-]+))?(?:\+\S*)?\s*$/.exec(String(v));
  if (!m) {
    // not semver ("2024b", "1_0"): compare whatever numbers it has
    const nums = (String(v).match(/\d+/g) || ['0']).slice(0, 3).map(Number);
    const parts = nums.length;
    while (nums.length < 3) nums.push(0);
    return { nums, parts, pre: [] };
  }
  const parts = m[3] !== undefined ? 3 : m[2] !== undefined ? 2 : 1;
  return { nums: [+m[1], +(m[2] || 0), +(m[3] || 0)], parts, pre: m[4] ? m[4].split('.').map((x) => (/^\d+$/.test(x) ? +x : x)) : [] };
}

/** Semver order: numbers, then a pre-release sorts before its release. */
function cmpParsed(a, b) {
  for (let i = 0; i < 3; i++) if (a.nums[i] !== b.nums[i]) return a.nums[i] - b.nums[i];
  if (!a.pre.length || !b.pre.length) return (b.pre.length ? 1 : 0) - (a.pre.length ? 1 : 0);
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i], y = b.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x - y;
    if (typeof x === 'number') return -1;
    if (typeof y === 'number') return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

export const compareVersions = (a, b) => cmpParsed(parseVer(a), parseVer(b));

function one(v, c) {
  const m = /^(>=|<=|>|<|=|\^|~)?(.+)$/.exec(c);
  if (!m) return false;
  const op = m[1] || '=';
  const w = parseVer(m[2]);
  const d = cmpParsed(v, w);
  const [M, m2, p] = w.nums;
  const below = (nums) => cmpParsed(v, { nums, parts: 3, pre: [] }) < 0 && !(v.pre.length && v.nums.join() === nums.join());
  switch (op) {
    case '>=': return d >= 0;
    case '<=': return d <= 0;
    case '>': return d > 0;
    case '<': return d < 0;
    // ^1.2.3 := >=1.2.3 <2.0.0 · ^0.2.3 := <0.3.0 · ^0.0.3 := <0.0.4 (^1 / ^0.2 work as partials)
    case '^': {
      if (d < 0) return false;
      if (M > 0 || w.parts === 1) return below([M + 1, 0, 0]);
      if (m2 > 0 || w.parts === 2) return below([0, m2 + 1, 0]);
      return below([0, 0, p + 1]);
    }
    // ~1.2.3 := >=1.2.3 <1.3.0 · ~1 := <2.0.0
    case '~': return d >= 0 && below(w.parts === 1 ? [M + 1, 0, 0] : [M, m2 + 1, 0]);
    default: return d === 0;
  }
}

/** Does version v match range? Comparators separated by spaces must all match; `||` separates alternatives. */
export function satisfies(v, range) {
  const r = String(range || '').trim();
  if (!r || r === '*') return true;
  const pv = parseVer(v);
  return r.split('||').some((alt) => {
    const cs = alt.trim().replace(/(>=|<=|>|<|=|\^|~)\s+/g, '$1').split(/\s+/).filter(Boolean);
    return cs.length > 0 && cs.every((c) => one(pv, c));
  });
}
