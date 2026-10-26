// Unity Bootstrap: the shared state behind the loading screen.
//
// One instance per page, shared by every tool built on it (Unity Explorer, BananaLoader): the
// first script to run creates it on window.__unityBootstrap, later ones join it as clients.
// It records what the page is doing while the game loads (which Unity loader, the build files
// and their download progress, the WebAssembly compile, the Emscripten runtime) and each
// client reports its own steps (IL2CPP metadata, registrations, UI…) into it.

export const PROTOCOL = 2;
/** File names only Unity builds use. */
const UNITY_FILE = /\.unityweb$|unityloader\.js$|\.loader\.js$|\.framework\.js(\.gz|\.br)?$/i;
const SETTINGS_KEY = 'unity-bootstrap:settings';

/** Global phases, in order. Client steps are shown separately, per client. */
export const PHASES = [
  ['detect', 'Detect Unity build'],
  ['download', 'Download build files'],
  ['compile', 'Compile WebAssembly'],
  ['runtime', 'Start Unity runtime'],
  ['attach', 'Attach tools'],
];

export const fmtBytes = (n) => {
  if (!n && n !== 0) return '–';
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1048576).toFixed(n < 10485760 ? 2 : 1)} MB`;
};
export const fmtMs = (ms) => (ms == null ? '' : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)} s`);

export class Bootstrap {
  constructor() {
    this.protocol = PROTOCOL;
    this.t0 = performance.now();
    this.startedAt = Date.now();
    this.settings = { modal: 'full', autoHide: true };
    try { Object.assign(this.settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')); } catch (_) { /* ignore */ }
    this.state = {
      page: { url: location.href, title: '', readyState: document.readyState },
      loader: null,        // { kind, label, era, script, at }
      config: {},          // what the page passed to the Unity loader (product, urls, unityVersion…)
      progress: null,      // Unity's own 0..1 progress
      files: new Map(),    // url -> file record
      wasm: null,          // compile / instantiate record
      runtime: null,       // { at, startedAt, heap }
      unsupported: null,   // e.g. asm.js builds
      error: null,
    };
    this.phases = PHASES.map(([id, label]) => ({ id, label, status: 'pending', detail: '', start: null, end: null }));
    this.clients = [];
    this.timeline = [];
    this.detected = false;
    this._listeners = new Set();
    this._waiters = { detected: [], module: [], runtime: [], analysis: [] };
    this.Module = null;
    this.instance = null; // the unityInstance / gameInstance
    this.analysis = null; // { signatures, fnTables, ... } from the wasm bytes
    this.hintsExtra = {};
    this.facts = new Map(); // things tools found out ("Unity" -> "2019.3.0f6", "IL2CPP" -> "metadata v24.2")
    // a tool that rewrites the game's wasm before it compiles maps its bytes to the game's own,
    // so the analysis and dumps describe the real module
    this.originalBytes = new WeakMap();
    this.rawFetch = null; // the page's fetch, before the bootstrap wrapped it (for our own requests)
  }

  // ------------------------------------------------------------------ time, events

  now() { return performance.now() - this.t0; }

  on(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }

  changed() {
    for (const fn of this._listeners) { try { fn(this); } catch (e) { console.error('[Bootstrap]', e); } }
  }

  log(text, level = 'info', source = 'bootstrap') {
    this._seq = (this._seq || 0) + 1;
    this.timeline.push({ seq: this._seq, t: this.now(), level, text, source });
    if (this.timeline.length > 600) this.timeline.splice(0, 100);
    this.changed();
  }

  /** Record a fact for the loading screen and report (a tool learned the Unity version, …). */
  fact(key, value) {
    if (value == null || value === '' || this.facts.get(key) === value) return;
    this.facts.set(key, value);
    if (key === 'Unity' && !this.state.config.unityVersion) this.state.config.unityVersion = value;
    this.changed();
  }

  saveSettings(patch) {
    Object.assign(this.settings, patch);
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings)); } catch (_) { /* ignore */ }
    this.changed();
  }

  // ------------------------------------------------------------------ phases

  phase(id) { return this.phases.find((p) => p.id === id); }

  setPhase(id, status, detail) {
    const p = this.phase(id);
    if (!p) return;
    const prev = p.status;
    if (status === 'active' && p.start == null) p.start = this.now();
    if (status === 'active' && p.end != null) p.end = null; // more work arrived (another build file)
    if ((status === 'done' || status === 'error' || status === 'skipped') && p.end == null) {
      p.end = this.now();
      if (p.start == null) p.start = p.end;
    }
    p.status = status;
    if (detail !== undefined) p.detail = detail;
    // earlier phases can't still be pending once a later one moved on
    if (status !== 'pending') {
      for (const q of this.phases) {
        if (q === p) break;
        if (q.status === 'pending') { q.status = 'skipped'; q.end = q.start = this.now(); }
      }
    }
    if (prev !== status && (status === 'done' || status === 'error')) this.log(`${p.label}: ${status === 'done' ? 'done' : 'failed'}${p.detail ? ' · ' + p.detail : ''}`, status === 'error' ? 'error' : 'ok');
    this.changed();
  }

  // ------------------------------------------------------------------ waiting

  _resolve(kind, v) { for (const w of this._waiters[kind].splice(0)) w(v); }

  /** Resolves when the page is known to run a Unity build (never on other sites). */
  whenDetected() { return this.detected ? Promise.resolve(this) : new Promise((r) => this._waiters.detected.push(r)); }

  // NOTE: these two resolve with nothing; read boot.Module. On Unity 2018 – 2020 the Emscripten
  // Module has a then() method, so a Promise resolved with it adopts it as a thenable, and
  // Module.then calls back with the Module again: an endless microtask loop that freezes the page.

  /** Resolves (with no value: read boot.Module) as soon as the Emscripten Module exists. */
  whenModule() { return this.Module ? Promise.resolve() : new Promise((r) => this._waiters.module.push(() => r())); }

  /** Resolves (with no value: read boot.Module) once main() has run. */
  whenRuntime() { return this.state.runtime && this.state.runtime.startedAt != null ? Promise.resolve() : new Promise((r) => this._waiters.runtime.push(() => r())); }

  /** Resolves with the wasm analysis (or null if the bytes were never seen). */
  whenAnalysis() {
    if (this.analysis || this._analysisDone) return Promise.resolve(this.analysis);
    return new Promise((r) => this._waiters.analysis.push(r));
  }

  markDetected(how) {
    if (this.detected) return;
    this.detected = true;
    if (this.kickWatch) this.kickWatch();
    this.setPhase('detect', 'active', how);
    const build = [...this.state.files.values()].filter((x) => x.kind !== 'loader' && x.kind !== 'other');
    if (build.some((x) => x.status === 'loading')) this.setPhase('download', 'active');
    this.log(`Unity detected: ${how}`);
    this._resolve('detected', this);
  }

  setLoader(kind, info = {}) {
    const KINDS = {
      UnityLoader: { label: 'UnityLoader.js', era: 'Unity 5.6 – 2019.4' },
      createUnityInstance: { label: 'createUnityInstance()', era: 'Unity 2020.1+' },
      injected: { label: 'already running', era: 'attached late' },
    };
    if (this.state.loader && this.state.loader.kind !== 'injected') return;
    this.state.loader = { kind, ...(KINDS[kind] || { label: kind, era: '' }), ...info, at: this.now() };
    this.markDetected(this.state.loader.label);
    this.setPhase('detect', 'done', `${this.state.loader.label} · ${this.state.loader.era}`);
  }

  /** Is this an actual Unity game (and not some other Emscripten app)? */
  unityEvidence(M = this.Module) {
    if (this.state.loader) return true;
    for (const f of this.state.files.values()) if (UNITY_FILE.test(f.name)) return true;
    return !!(M && (typeof M._SendMessage === 'function' || typeof M.SendMessage === 'function' || M.unityVersion));
  }

  setModule(M, how) {
    if (this.Module) return;
    this.Module = M;
    this.state.runtime = { at: this.now(), how, startedAt: null };
    this.log(`Emscripten Module captured (${how})`);
    if (this.unityEvidence(M)) {
      this.markDetected('Emscripten Module');
      if (this.phase('detect').status !== 'done') this.setPhase('detect', 'done', this.state.loader ? `${this.state.loader.label} · ${this.state.loader.era}` : 'Unity runtime found on the page');
    }
    this._resolve('module');
    const c = this.phase('compile').status;
    if (this.phase('runtime').status === 'pending' && (c === 'done' || c === 'skipped')) this.setPhase('runtime', 'active', 'waiting for main()');
  }

  setRuntimeStarted(detail) {
    const r = this.state.runtime || (this.state.runtime = { at: this.now() });
    if (r.startedAt != null) return;
    if (!this.detected) {
      this.markDetected('Unity runtime');
      this.setPhase('detect', 'done', 'Unity runtime found on the page');
    }
    r.startedAt = this.now();
    for (const id of ['download', 'compile']) if (this.phase(id).status === 'active') this.setPhase(id, 'done');
    this.setPhase('runtime', 'done', detail);
    if (this.clients.length) this.setPhase('attach', 'active', this._clientSummary());
    this._resolve('runtime');
  }

  setAnalysis(a) {
    this.analysis = a;
    this._analysisDone = true;
    this._resolve('analysis', a);
    this.changed();
  }

  /** What the IL2CPP bridge needs that old (fastcomp) Modules don't expose themselves. */
  hints() {
    const w = this.state.wasm || {};
    const a = this.analysis || {};
    return {
      exports: w.exports || null,
      memory: w.memory || null,
      table: w.table || null,
      flavor: w.flavor || null,
      signatures: a.signatures || null,
      fnTables: a.fnTables || null,
      ...this.hintsExtra,
    };
  }

  fail(message, where = 'bootstrap') {
    this.state.error = { message: String(message), where, at: this.now() };
    this.log(String(message), 'error', where);
  }

  // ------------------------------------------------------------------ files

  file(url, via) {
    let f = this.state.files.get(url);
    if (!f) {
      const raw = String(url).split(/[?#]/)[0].split('/').pop() || String(url);
      let name = raw;
      try { name = decodeURIComponent(raw); } catch (_) { /* malformed %-escape: keep it as is */ }
      f = { url, name, kind: classify(name), via, status: 'loading', loaded: 0, total: 0, encoding: '', start: this.now(), end: null, error: null };
      this.state.files.set(url, f);
      if (!this.detected && UNITY_FILE.test(name)) this.markDetected(`build file ${name}`);
      if (this.detected && f.kind !== 'loader' && f.kind !== 'other') this.setPhase('download', 'active');
    }
    return f;
  }

  fileDone(f, ok = true, err) {
    if (f.status !== 'loading') return;
    f.end = this.now();
    f.status = ok ? 'done' : 'error';
    if (!ok) f.error = String(err || 'failed');
    if (ok && f.total && f.loaded < f.total && !f.encoding) f.loaded = f.total;
    this.log(`${ok ? 'Loaded' : 'Failed'} ${f.name}${ok ? ` · ${fmtBytes(f.loaded || f.total)}${f.encoding ? ` (${f.encoding})` : ''} in ${fmtMs(f.end - f.start)}` : ` · ${f.error}`}`, ok ? 'net' : 'error');
    const build = [...this.state.files.values()].filter((x) => x.kind !== 'loader' && x.kind !== 'other');
    if (this.detected && build.length && build.every((x) => x.status !== 'loading')) {
      const bytes = build.reduce((a, x) => a + (x.loaded || x.total || 0), 0);
      const bad = build.filter((x) => x.status === 'error').length;
      // one missing optional file (a 404 symbols file, an aborted retry) isn't a failed load:
      // the runtime starting decides that
      this.setPhase('download', bad && bad === build.length ? 'error' : 'done', `${build.length - bad} file${build.length - bad === 1 ? '' : 's'} · ${fmtBytes(bytes)}${bad ? ` · ${bad} failed` : ''}`);
    }
    this.changed();
  }

  /** Overall 0..1 progress for the main bar. */
  overall() {
    if (this.phase('attach').status === 'done') return 1;
    const files = [...this.state.files.values()].filter((x) => x.kind !== 'loader' && x.kind !== 'other');
    let dl = this.state.progress;
    if (dl == null && files.length) {
      const tot = files.reduce((a, x) => a + (x.total || 0), 0);
      const got = files.reduce((a, x) => a + Math.min(x.loaded, x.total || x.loaded), 0);
      dl = tot ? got / tot : 0;
    }
    if (dl == null) dl = this.phase('download').status === 'done' ? 1 : 0;
    // download 0–60 %, compile 60–75 %, runtime 75–85 %, attach 85–100 %
    let p = Math.min(1, dl) * 0.6;
    const st = (id) => this.phase(id).status;
    if (st('compile') === 'active') p = Math.max(p, 0.62);
    if (['done', 'skipped'].includes(st('compile'))) p = Math.max(p, 0.75);
    if (['done', 'skipped'].includes(st('runtime'))) p = Math.max(p, 0.85);
    if (this.clients.length) {
      const steps = this.clients.flatMap((c) => c.steps);
      const done = steps.filter((s) => s.status === 'done').length;
      const expect = this.clients.reduce((a, c) => a + Math.max(c.expected || 0, c.steps.length), 0) || 1;
      if (['done', 'skipped'].includes(st('runtime'))) p = Math.max(p, 0.85 + 0.15 * Math.min(1, done / expect));
    }
    return Math.min(p, 0.995);
  }

  // ------------------------------------------------------------------ clients

  /** A tool joining the bootstrap: returns its step reporter. */
  client(info) {
    let c = this.clients.find((x) => x.id === info.id);
    if (c) return c.api;
    c = { ...info, status: 'waiting', steps: [], joined: this.now(), readyAt: null, summary: '', expected: info.expectedSteps || 0 };
    const self = this;
    const step = (id, label) => {
      let s = c.steps.find((x) => x.id === id);
      if (!s) { s = { id, label, status: 'active', detail: '', start: self.now(), end: null, error: null }; c.steps.push(s); }
      else { s.label = label || s.label; s.status = 'active'; s.error = null; if (s.end != null) { s.start = self.now(); s.end = null; } }
      if (c.status === 'waiting') c.status = 'active';
      self.changed();
      return {
        note(text) { s.detail = text; self.changed(); },
        wait(text) { s.status = 'waiting'; s.detail = text; self.changed(); },
        done(text) { if (text !== undefined) s.detail = text; s.status = 'done'; s.end = self.now(); self.changed(); },
        skip(text) { if (text !== undefined) s.detail = text; s.status = 'skipped'; s.end = self.now(); self.changed(); },
        fail(err) { s.status = 'error'; s.error = String(err && err.message || err); s.end = self.now(); self.log(`${c.name}: ${s.label || id} failed · ${s.error}`, 'error', c.name); },
      };
    };
    c.api = {
      id: c.id,
      boot: this,
      step,
      /** Run fn(note) as a timed step; a throw marks it failed and rethrows. */
      run(id, label, fn) {
        const s = step(id, label);
        let detail = '';
        try {
          const r = fn((t) => { detail = t; s.note(t); });
          // only real Promises: an Emscripten Module is a thenable on old Unity versions
          if (r instanceof Promise) return r.then((v) => { s.done(detail); return v; }, (e) => { s.fail(e); throw e; });
          s.done(detail);
          return r;
        } catch (e) { s.fail(e); throw e; }
      },
      info(text) { self.log(text, 'info', c.name); },
      expect(n) { c.expected = n; self.changed(); },
      ready(summary = '') {
        c.status = 'ready'; c.readyAt = self.now(); c.summary = summary;
        self.log(`${c.name} ready${summary ? ' · ' + summary : ''}`, 'ok', c.name);
        self._checkAttached();
      },
      fail(err) {
        c.status = 'error'; c.readyAt = self.now(); c.summary = String(err && err.message || err);
        self.fail(`${c.name}: ${c.summary}`, c.name);
        self._checkAttached();
      },
    };
    this.clients.push(c);
    this.log(`${c.name} ${c.version ? 'v' + c.version + ' ' : ''}joined`, 'info', c.name);
    if (this.phase('attach').status === 'done') this.setPhase('attach', 'active', this._clientSummary());
    this.changed();
    return c.api;
  }

  _clientSummary() { return this.clients.map((c) => `${c.name}${c.status === 'ready' ? ' ✓' : c.status === 'error' ? ' ✕' : ''}`).join(' · '); }

  _checkAttached() {
    const done = this.clients.every((c) => c.status === 'ready' || c.status === 'error');
    if (!done) { this.setPhase('attach', 'active', this._clientSummary()); return; }
    const anyErr = this.clients.some((c) => c.status === 'error');
    this.setPhase('attach', anyErr ? 'error' : 'done', this._clientSummary());
    this.finishedAt = this.now();
    this.changed();
  }

  get finished() { return this.phase('attach').status === 'done' || this.phase('attach').status === 'error'; }
  get failed() { return !!this.state.unsupported || !!this.state.error || this.phases.some((p) => p.status === 'error') || this.clients.some((c) => c.status === 'error'); }

  /**
   * Keep a tool's window out of the way while the full-screen loading screen is up, and show it
   * once the loading screen folds away (the tool's own hotkey still opens it any time).
   * ui needs show() and hide().
   */
  deferWindow(ui) {
    if (this.settings.modal !== 'full' || (this.finished && !this.failed)) return;
    ui.hide();
    const off = this.on(() => {
      const mode = this.ui && this.ui.mode;
      if (mode && mode !== 'full') { off(); ui.show(); }
    });
  }

  // ------------------------------------------------------------------ report

  /** Plain-text report of everything the bootstrap saw (for bug reports). */
  report() {
    const s = this.state;
    const L = [];
    const pad = (x, n) => String(x).padEnd(n);
    L.push('Unity Bootstrap report', `Page: ${location.origin}${location.pathname}`, `Time: ${new Date(this.startedAt).toISOString()}`, `UA: ${navigator.userAgent}`);
    const c = s.config;
    const game = [c.productName, c.companyName && `(${c.companyName})`, c.productVersion && `v${c.productVersion}`].filter(Boolean).join(' ');
    if (game) L.push(`Game: ${game}`);
    if (c.unityVersion) L.push(`Unity: ${c.unityVersion}`);
    if (s.loader) L.push(`Loader: ${s.loader.label} (${s.loader.era})${s.loader.script ? ' · ' + s.loader.script : ''} at +${fmtMs(s.loader.at)}`);
    if (s.unsupported) L.push(`UNSUPPORTED: ${s.unsupported}`);
    if (s.error) L.push(`ERROR: ${s.error.message}`);
    L.push('', 'Phases:');
    for (const p of this.phases) L.push(`  ${pad(icon(p.status), 2)}${pad(p.label, 24)}${pad(p.start != null && p.end != null ? fmtMs(p.end - p.start) : '', 10)}${p.detail}`);
    if (s.files.size) {
      L.push('', 'Build files:');
      for (const f of s.files.values()) L.push(`  ${pad(f.name, 40)} ${pad(f.kind, 9)} ${pad(fmtBytes(f.loaded || f.total), 10)} ${pad(f.encoding || '-', 8)} ${pad(f.via, 6)} ${f.end != null ? fmtMs(f.end - f.start) : f.status}${f.error ? ' ' + f.error : ''}`);
    }
    const w = s.wasm;
    if (w) {
      L.push('', 'WebAssembly:');
      L.push(`  ${fmtBytes(w.bytes)} · ${w.streaming ? 'streaming' : 'from bytes'} · ${w.ms != null ? 'compiled + instantiated in ' + fmtMs(w.ms) : 'compiling'}`);
      if (w.flavor) L.push(`  toolchain: ${w.flavor === 'fastcomp' ? 'Emscripten fastcomp (asm2wasm)' : 'Emscripten LLVM wasm backend'}`);
      if (w.memoryInfo) L.push(`  memory: ${w.memoryInfo}`);
      if (w.tableInfo) L.push(`  table: ${w.tableInfo}`);
      if (w.exportCount != null) L.push(`  ${w.importCount} imports · ${w.exportCount} exports`);
    }
    const a = this.analysis;
    if (a) { if (!w) L.push('', 'WebAssembly:'); L.push(`  analysis: ${a.summary}`); }
    if (this.facts.size) {
      L.push('', 'Facts:');
      for (const [k, v] of this.facts) L.push(`  ${pad(k, 14)} ${typeof v === 'object' ? safeJson(v) : String(v)}`);
    }
    if (s.runtime) L.push('', `Runtime: Module at +${fmtMs(s.runtime.at)} (${s.runtime.how || '?'})${s.runtime.startedAt != null ? `, started at +${fmtMs(s.runtime.startedAt)}` : ', not started'}`);
    for (const cl of this.clients) {
      L.push('', `${cl.name} ${cl.version || ''} — ${cl.status}${cl.summary ? ' · ' + cl.summary : ''}`);
      for (const st of cl.steps) L.push(`  ${pad(icon(st.status), 2)}${pad(st.label, 36)}${pad(st.end != null ? fmtMs(st.end - st.start) : '', 10)}${st.error ? 'ERROR ' + st.error : st.detail}`);
    }
    L.push('', 'Environment:', ...envLines().map((x) => '  ' + x));
    L.push('', 'Timeline:');
    for (const e of this.timeline) L.push(`  +${pad(fmtMs(e.t), 9)} ${pad(e.level, 6)} ${e.source !== 'bootstrap' ? '[' + e.source + '] ' : ''}${e.text}`);
    return L.join('\n');
  }
}

function safeJson(v) { try { return JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? x + 'n' : x)); } catch (_) { return String(v); } }

function icon(st) { return { done: '✓', error: '✕', active: '…', waiting: '…', skipped: '–', pending: '·' }[st] || '·'; }

/** What part of a Unity build a file is, from its name. */
export function classify(name) {
  const n = name.toLowerCase();
  if (/unityloader\.js$|\.loader\.js$/.test(n)) return 'loader';
  if (/symbols/.test(n)) return 'symbols';
  if (/\.json$/.test(n)) return 'manifest';
  if (/framework/.test(n)) return 'framework';
  if (/\.wasm(\.code)?(\.unityweb|\.gz|\.br)?$|\.wasm\.code\.unityweb$/.test(n)) return 'code';
  if (/\.asm\.code|\.asm\.js/.test(n)) return 'asm.js';
  if (/\.data(\.unityweb|\.gz|\.br)?$/.test(n)) return 'data';
  if (/\.mem(ory)?(\.unityweb)?$/.test(n)) return 'memory';
  return 'other';
}

export function envLines() {
  const n = navigator;
  const out = [];
  out.push(`browser: ${(n.userAgentData && n.userAgentData.brands || []).map((b) => `${b.brand} ${b.version}`).filter((x) => !/Not.?A.?Brand/i.test(x)).join(', ') || n.userAgent}`);
  out.push(`platform: ${(n.userAgentData && n.userAgentData.platform) || n.platform || '?'} · ${n.hardwareConcurrency || '?'} threads${n.deviceMemory ? ` · ${n.deviceMemory} GB RAM` : ''}`);
  out.push(`isolation: ${self.crossOriginIsolated ? 'cross-origin isolated (threads possible)' : 'not isolated'} · secure context: ${self.isSecureContext ? 'yes' : 'no'}`);
  let wasm = typeof WebAssembly === 'object' ? 'yes' : 'no';
  try { if (typeof WebAssembly === 'object') { new WebAssembly.Global({ value: 'i64', mutable: true }, 0n); wasm += ' · BigInt i64'; } } catch (_) { /* old browser */ }
  out.push(`WebAssembly: ${wasm}`);
  out.push(`screen: ${screen.width}×${screen.height} @${devicePixelRatio}x`);
  return out;
}
