// The bootstrap's loading screen: a centered card while the game loads (or a corner card, per
// settings), showing the phases, each tool's steps, the build files, the runtime and a log.
// It folds into a small pill when everything is ready, then fades out. Errors keep it open.

import css from 'bundle-text:./modal.css';
import { fmtBytes, fmtMs, envLines } from './core.js';

const ICON_OK = '<svg viewBox="0 0 16 16"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_ERR = '<svg viewBox="0 0 16 16"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" fill="none" stroke-width="2" stroke-linecap="round"/></svg>';
const EMBLEM = `<svg viewBox="0 0 52 52" aria-hidden="true">
  <defs><linearGradient id="ubg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff3d4d"/><stop offset="1" stop-color="#8c0b17"/></linearGradient></defs>
  <circle cx="26" cy="26" r="24" fill="none" stroke="#1d1d23" stroke-width="2"/>
  <circle class="ring" cx="26" cy="26" r="24" fill="none" stroke="url(#ubg)" stroke-width="2.6" stroke-linecap="round" stroke-dasharray="40 111"/>
  <circle class="ring2" cx="26" cy="26" r="19" fill="none" stroke="rgba(225,29,46,.45)" stroke-width="1.4" stroke-dasharray="3 5"/>
  <path class="hex" d="M26 12.5L37.7 19.25V32.75L26 39.5L14.3 32.75V19.25Z" fill="rgba(225,29,46,.10)" stroke="#e11d2e" stroke-width="1.6" stroke-linejoin="round"/>
  <path class="core" d="M26 20L31.2 23V29L26 32L20.8 29V23Z" fill="url(#ubg)"/>
  <g class="mark ok"><path d="M19.5 26.5l4.5 4.5 8.5-9.5" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></g>
  <g class="mark err"><path d="M21 21l10 10M31 21l-10 10" fill="none" stroke="#ff5967" stroke-width="2.6" stroke-linecap="round"/></g>
</svg>`;

const h = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const setText = (el, t) => { t = String(t ?? ''); if (el.textContent !== t) el.textContent = t; };
const setCls = (el, c) => { if (el.className !== c) el.className = c; };
const safeJson = (v) => { try { return JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? x + 'n' : x)); } catch (_) { return String(v); } };

/** Reuse one element per key so rows animate in once and then just update. */
function syncList(box, items, key, make, update) {
  const old = box.__rows || new Map();
  const next = new Map();
  let i = 0;
  for (const it of items) {
    const k = key(it);
    let el = old.get(k);
    if (!el) el = make(it);
    update(el, it);
    next.set(k, el);
    if (box.children[i] !== el) box.insertBefore(el, box.children[i] || null);
    i++;
  }
  for (const [k, el] of old) if (!next.has(k)) el.remove();
  box.__rows = next;
}

export class BootModal {
  constructor(boot) {
    this.boot = boot;
    this.mode = null;     // 'full' | 'compact' | 'pill' | 'hidden'
    this.open = false;    // details expanded
    this.tab = 'files';
    this.pinned = false;  // user opened it on purpose: no auto-hide
    this._timers = [];
    boot.on(() => this.schedule());
  }

  // ------------------------------------------------------------------ lifecycle

  mount() {
    if (this.host) return;
    const host = (this.host = document.createElement('div'));
    host.id = 'unity-bootstrap-host';
    host.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = css;
    root.appendChild(style);
    const ub = (this.el = h('div', 'ub'));
    ub.setAttribute('role', 'dialog');
    ub.setAttribute('aria-label', 'Unity bootstrap');
    ub.innerHTML = `
      <div class="backdrop"></div>
      <div class="card">
        <div class="glow"></div>
        <div class="head">
          <div class="emblem">${EMBLEM}</div>
          <div class="titles">
            <div class="kicker">Unity Bootstrap <span class="clients"></span></div>
            <div class="title"></div>
            <div class="subtitle"></div>
          </div>
          <div class="timer">0.0 s</div>
        </div>
        <div class="progress">
          <div class="bar"><div class="fill"></div></div>
          <div class="prow"><div class="activity" aria-live="polite"></div><div class="pct">0%</div></div>
        </div>
        <div class="alertbox"></div>
        <div class="body">
          <div class="sec"><h3>Boot sequence <span class="ptime"></span></h3><ul class="steps phases"></ul></div>
          <div class="sec"><h3>Tools <span class="ccount"></span></h3><div class="clist"></div></div>
        </div>
        <div class="details">
          <div class="tabs">
            <button class="tab" data-tab="files">Build files<span class="n nf"></span></button>
            <button class="tab" data-tab="runtime">Runtime</button>
            <button class="tab" data-tab="env">Environment</button>
            <button class="tab" data-tab="log">Log<span class="n nl"></span></button>
          </div>
          <div class="pane" data-pane="files"><table><thead><tr><th>File</th><th>Kind</th><th>Size</th><th></th><th>Enc.</th><th>Via</th><th>Time</th></tr></thead><tbody class="files"></tbody></table><div class="empty nofiles">No build files seen (the game may have loaded before the bootstrap, or from cache).</div></div>
          <div class="pane" data-pane="runtime"><div class="kv rt"></div></div>
          <div class="pane" data-pane="env"><div class="kv envkv"></div></div>
          <div class="pane log" data-pane="log"></div>
        </div>
        <div class="foot">
          <button class="btn" data-act="copy"><svg viewBox="0 0 16 16"><rect x="5" y="5" width="8" height="9" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M3 11V3.5A1.5 1.5 0 0 1 4.5 2H10" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>Copy report</button>
          <button class="btn only-full" data-act="details">Details ▾</button>
          <span class="spacer"></span>
          <span class="hint only-full">Turn this screen off in the tool's Settings</span>
          <button class="btn ghost only-full" data-act="compact">Compact</button>
          <button class="btn ghost only-compact" data-act="expand">Expand</button>
          <button class="btn ghost" data-act="hide">Hide</button>
        </div>
      </div>
      <button class="pillbtn" data-act="expand"><span class="pe"></span><span class="pt">Loading</span><span class="pp"></span></button>
      <div class="toast"></div>`;
    root.appendChild(ub);
    this.$ = (s) => ub.querySelector(s);
    ub.addEventListener('click', (e) => {
      const t = e.target.closest('[data-act],[data-tab]');
      if (!t) return;
      if (t.dataset.tab) { this.tab = t.dataset.tab; this.schedule(); return; }
      this.action(t.dataset.act);
    });
    (document.documentElement || document.body).appendChild(host);
    this._startTick();
  }

  /** Re-render 5×/s while loading (timers, speeds); stops itself when hidden or finished. */
  _startTick() {
    if (this._tick) return;
    this._tick = setInterval(() => {
      if (this.mode === 'hidden' || this.boot.finished) { clearInterval(this._tick); this._tick = null; return; }
      if (this.mode) this.schedule();
    }, 200);
  }

  action(a) {
    if (a === 'copy') this.copy();
    else if (a === 'details') { this.open = !this.open; this.pinned = true; }
    else if (a === 'compact') this.setMode('compact');
    else if (a === 'expand') { this.pinned = true; this.setMode('full'); }
    else if (a === 'hide') this.setMode(this.boot.finished && !this.boot.failed ? 'hidden' : 'pill');
    this.schedule();
  }

  setMode(m) {
    if (!this.host) this.mount();
    this.mode = m;
    if (m !== 'hidden') this._startTick();
    for (const t of this._timers.splice(0)) clearTimeout(t);
    this.el.classList.remove('leaving', 'fade');
    this.render();
    this.boot.changed(); // tools waiting for the screen to fold away (deferWindow) listen for this
  }

  /** Show it (the Status tab's "Show loading screen"). */
  reopen() { this.pinned = true; this.setMode('full'); }

  /** Called when the bootstrap detects Unity. */
  start() {
    const m = this.boot.settings.modal;
    if (m === 'off') return;
    this.setMode(m === 'compact' ? 'compact' : 'full');
  }

  copy() {
    const text = this.boot.report();
    const ok = () => this.toast('Bootstrap report copied');
    try { navigator.clipboard.writeText(text).then(ok, () => this._fallbackCopy(text)); } catch (_) { this._fallbackCopy(text); }
  }

  _fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.cssText = 'position:fixed;left:-9999px;top:0';
    (document.body || document.documentElement).appendChild(ta); ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
    this.toast(ok ? 'Bootstrap report copied' : 'Copy failed: use Ctrl+C in the Log tab');
    ta.remove();
  }

  toast(msg) {
    const t = this.$('.toast');
    t.textContent = msg; t.classList.add('on');
    clearTimeout(this._toastT);
    this._toastT = setTimeout(() => t.classList.remove('on'), 1600);
  }

  schedule() {
    if (!this.host || this._pending) return;
    this._pending = true;
    const go = () => { if (!this._pending) return; this._pending = false; this.render(); };
    requestAnimationFrame(go);
    setTimeout(go, 250); // rAF doesn't run in background tabs
  }

  // ------------------------------------------------------------------ finishing

  _onFinish() {
    const b = this.boot;
    const state = b.failed ? 'failed' : 'ok';
    // a failure sticks while it lasts; a phase that recovered (e.g. a retried compile) lets the normal finish run
    if (this._finishedHandled === state || (this._finishedHandled === 'failed' && b.failed)) return;
    const after = this._finishedHandled; // a tool can fail after everything else was ready
    this._finishedHandled = state;
    if (state === 'failed') {
      // the game may well be running: say what failed without covering it
      for (const t of this._timers.splice(0)) clearTimeout(t);
      if (b.settings.modal !== 'off' && !this.pinned && (this.mode !== 'hidden' || after === 'ok')) this.setMode('compact');
      return;
    }
    if (b.settings.autoHide === false || this.pinned) return;
    const later = (ms, fn) => this._timers.push(setTimeout(fn, ms));
    // pill for a few seconds, then fade away (setMode clears pending timers, so schedule after it)
    const toPill = () => {
      if (this.pinned) return;
      this.setMode('pill');
      later(6500, () => {
        if (this.pinned || this.mode !== 'pill') return;
        this.el.classList.add('fade');
        later(600, () => { if (this.mode === 'pill' && !this.pinned) this.setMode('hidden'); });
      });
    };
    later(this.mode === 'full' ? 1500 : 1100, () => {
      if (this.pinned) return;
      if (this.mode === 'full') { this.el.classList.add('leaving'); later(380, toPill); } else toPill();
    });
  }

  // ------------------------------------------------------------------ render

  render() {
    if (!this.host) return;
    const b = this.boot;
    const s = b.state;
    const ub = this.el;
    const finished = b.finished;
    const failed = b.failed;
    // a failure before the tools attach (every download failed, the loader rejected) must not
    // leave the full-screen card up for good
    if (finished || failed) this._onFinish();
    setCls(ub, `ub ${this.mode || 'hidden'}${this.open ? ' open' : ''}${finished && !failed ? ' done' : ''}${failed ? ' failed' : ''}${ub.classList.contains('leaving') ? ' leaving' : ''}${ub.classList.contains('fade') ? ' fade' : ''}`);
    if (this.mode === 'full') ub.setAttribute('aria-modal', 'true'); else ub.removeAttribute('aria-modal');
    if (this.mode === 'hidden') return;

    // ---- header
    const c = s.config;
    const product = c.productName || (document.title && document.title.trim()) || 'Unity game';
    setText(this.$('.title'), product);
    setText(this.$('.kicker .clients'), b.clients.length ? '· ' + b.clients.map((x) => x.name).join(' · ') : '');
    const unityVer = c.unityVersion || (b.facts && b.facts.get('Unity'));
    const sub = [
      unityVer ? `Unity ${unityVer}` : null,
      c.companyName || null,
      s.loader ? s.loader.label : null,
      s.wasm && s.wasm.flavor ? (s.wasm.flavor === 'fastcomp' ? 'Emscripten fastcomp' : 'Emscripten LLVM') : null,
      b.facts && b.facts.get('IL2CPP') ? b.facts.get('IL2CPP') : null,
    ].filter(Boolean);
    setText(this.$('.subtitle'), sub.join(' · ') || 'Waiting for the game to load…');
    const elapsed = finished ? b.finishedAt : b.now();
    setText(this.$('.timer'), fmtMs(elapsed).replace(' ms', ' ms'));

    // ---- progress
    const p = failed ? Math.max(0.04, b.overall()) : b.overall();
    this.$('.fill').style.width = `${(finished && !failed ? 1 : p) * 100}%`;
    const pct = finished ? 100 : Math.min(99, Math.round(p * 100)); // 100% only once it's really done
    setText(this.$('.pct'), failed ? 'ERR' : `${pct}%`);
    const act = this._activity();
    const ae = this.$('.activity');
    if (ae.__h !== act) { ae.innerHTML = act; ae.__h = act; } // the live region only changes when its text does

    // ---- alert
    const errs = [];
    if (s.unsupported) errs.push(`<b>Unsupported build.</b> ${esc(s.unsupported)}`);
    for (const cl of b.clients) if (cl.status === 'error') errs.push(`<b>${esc(cl.name)} couldn't attach.</b> ${esc(cl.summary)}`);
    for (const ph of b.phases) if (ph.status === 'error' && !s.unsupported) errs.push(`<b>${esc(ph.label)} failed.</b> ${esc(ph.detail)}`);
    if (s.error && !s.unsupported && !b.clients.some((cl) => cl.status === 'error')) errs.push(`<b>Error.</b> ${esc(s.error.message)}`);
    const ab = this.$('.alertbox');
    const ah = errs.length ? `<div class="alert">${errs.join('<br>')}<br><span style="color:var(--mute)">Use <b style="color:var(--text)">Copy report</b> and include it in a bug report.</span></div>` : '';
    if (ab.__h !== ah) { ab.innerHTML = ah; ab.__h = ah; }

    // ---- phases
    syncList(this.$('.phases'), b.phases, (x) => x.id, () => this._stepEl(), (el, ph) => this._updStep(el, ph));
    const first = b.phases.find((x) => x.start != null);
    setText(this.$('.ptime'), first ? fmtMs((finished ? b.finishedAt : b.now()) - first.start) : '');

    // ---- clients
    const box = this.$('.clist');
    if (!b.clients.length) { if (!box.__empty) { box.innerHTML = '<div class="empty">Waiting for tools to attach…</div>'; box.__empty = true; box.__rows = null; } }
    else {
      if (box.__empty) { box.innerHTML = ''; box.__empty = false; }
      syncList(box, b.clients, (x) => x.id, () => {
        const el = h('div', 'client', '<div class="chead"><span class="dot"></span><span class="cname"></span><span class="cver"></span><span class="badge"></span></div><ul class="steps"></ul>');
        return el;
      }, (el, cl) => {
        const dot = el.querySelector('.dot');
        dot.style.background = cl.color || '#e11d2e'; dot.style.color = cl.color || '#e11d2e';
        setText(el.querySelector('.cname'), cl.name);
        setText(el.querySelector('.cver'), cl.version ? 'v' + cl.version : '');
        const badge = el.querySelector('.badge');
        setCls(badge, `badge ${cl.status}`);
        setText(badge, cl.status === 'ready' ? `ready${cl.readyAt != null ? ' · ' + fmtMs(cl.readyAt - cl.joined) : ''}` : cl.status);
        syncList(el.querySelector('.steps'), cl.steps, (x) => x.id, () => this._stepEl(), (sel, st) => this._updStep(sel, st));
      });
    }
    setText(this.$('.ccount'), b.clients.length ? `${b.clients.filter((x) => x.status === 'ready').length}/${b.clients.length} ready` : '');

    // ---- details
    const det = this.$('[data-act="details"]');
    setText(det, this.open ? 'Details ▴' : 'Details ▾');
    if (this.mode === 'full' && this.open) this._details();
    else { setText(this.$('.nf'), s.files.size || ''); setText(this.$('.nl'), b.timeline.length || ''); }

    // ---- pill
    const pt = this.$('.pt');
    setText(pt, failed ? 'Bootstrap failed · details' : finished ? `Ready in ${fmtMs(b.finishedAt)}` : this._shortActivity());
    setText(this.$('.pp'), finished || failed ? '' : `${pct}%`);
  }

  _stepEl() { return h('li', 'step', '<span class="ico"></span><div><div class="lbl"></div><div class="det"></div></div><span class="t"></span>'); }

  _updStep(el, x) {
    setCls(el, `step ${x.status}`);
    const ico = el.firstChild;
    const want = x.status === 'done' ? 'ok' : x.status === 'error' ? 'err' : '';
    if (ico.__k !== want) { ico.innerHTML = want === 'ok' ? ICON_OK : want === 'err' ? ICON_ERR : ''; ico.__k = want; }
    setText(el.querySelector('.lbl'), x.label);
    setText(el.querySelector('.det'), x.error || x.detail || '');
    const b = this.boot;
    const t = x.start == null ? '' : x.end != null ? fmtMs(x.end - x.start) : x.status === 'active' || x.status === 'waiting' ? fmtMs(b.now() - x.start) : '';
    setText(el.querySelector('.t'), t);
  }

  _downloadLine() {
    const files = [...this.boot.state.files.values()].filter((f) => f.kind !== 'other');
    const loaded = files.reduce((a, f) => a + (f.loaded || 0), 0);
    const total = files.reduce((a, f) => a + (f.total || 0), 0);
    const t0 = Math.min(...files.map((f) => f.start));
    const secs = Math.max(0.2, (this.boot.now() - t0) / 1000);
    const speed = Math.round(loaded / secs);
    const busy = files.filter((f) => f.status === 'loading').map((f) => f.name);
    return `<span>Downloading ${esc(busy.slice(0, 2).join(', ') || 'build')}</span> <span class="sub">· ${fmtBytes(loaded)}${total && total >= loaded ? ' / ' + fmtBytes(total) : ''} · ${fmtBytes(speed)}/s</span>`;
  }

  _activity() {
    const b = this.boot;
    const s = b.state;
    if (s.unsupported) return '<span>Unsupported build</span>';
    if (b.finished) return b.failed ? '<span>Finished with errors</span>' : `<span>Ready</span> <span class="sub">· everything attached in ${fmtMs(b.finishedAt)}</span>`;
    for (const cl of b.clients) {
      const st = cl.steps.find((x) => x.status === 'active' || x.status === 'waiting');
      if (st) return `<span>${esc(cl.name)}: ${esc(st.label)}</span>${st.detail ? ` <span class="sub">· ${esc(st.detail)}</span>` : ''}`;
    }
    const ph = [...b.phases].reverse().find((x) => x.status === 'active');
    if (!ph && b.phase('download').status === 'done' && b.phase('compile').status === 'pending') return '<span>Preparing the build</span> <span class="sub">· unpacking files and starting the framework</span>';
    if (!ph) return '<span>Waiting for the game…</span>';
    if (ph.id === 'download') return this._downloadLine();
    if (ph.id === 'compile') return `<span>Compiling WebAssembly</span> <span class="sub">· ${esc(ph.detail)}</span>`;
    if (ph.id === 'runtime') return `<span>Starting the Unity runtime</span> <span class="sub">· ${esc(ph.detail)}</span>`;
    if (ph.id === 'attach') return `<span>Attaching tools</span> <span class="sub">· ${esc(ph.detail)}</span>`;
    return `<span>${esc(ph.label)}</span>${ph.detail ? ` <span class="sub">· ${esc(ph.detail)}</span>` : ''}`;
  }

  _shortActivity() {
    const b = this.boot;
    const ph = [...b.phases].reverse().find((x) => x.status === 'active');
    return ph ? ph.label : 'Loading';
  }

  _details() {
    const b = this.boot;
    const s = b.state;
    for (const t of this.el.querySelectorAll('.tab')) t.classList.toggle('on', t.dataset.tab === this.tab);
    for (const p of this.el.querySelectorAll('.pane')) p.classList.toggle('on', p.dataset.pane === this.tab);
    setText(this.$('.nf'), s.files.size || '');
    setText(this.$('.nl'), b.timeline.length || '');

    if (this.tab === 'files') {
      const files = [...s.files.values()];
      this.$('.nofiles').style.display = files.length ? 'none' : '';
      syncList(this.$('.files'), files, (f) => f.url, () => h('tr', '', '<td class="name"></td><td><span class="kind"></span></td><td class="mono size"></td><td><div class="mini"><i></i></div></td><td class="mono enc"></td><td class="mono via"></td><td class="mono tm"></td>'), (el, f) => {
        const [name, kind, size, mini, enc, via, tm] = el.children;
        setText(name, f.name); name.title = f.url;
        setCls(kind.firstChild, `kind ${f.kind}`); setText(kind.firstChild, f.kind);
        setText(size, f.total && f.status === 'loading' ? `${fmtBytes(f.loaded)} / ${fmtBytes(f.total)}` : fmtBytes(f.loaded || f.total));
        const frac = f.status === 'done' ? 1 : f.total ? Math.min(1, f.loaded / f.total) : 0.15;
        setCls(mini.firstChild, `mini ${f.status}`);
        mini.firstChild.firstChild.style.width = `${frac * 100}%`;
        setText(enc, f.encoding || (/\.unityweb$/i.test(f.name) ? 'unityweb' : '–'));
        setText(via, f.via);
        setText(tm, f.status === 'error' ? f.error || 'failed' : f.end != null ? fmtMs(f.end - f.start) : '…');
      });
    } else if (this.tab === 'runtime') {
      const w = s.wasm;
      const c = s.config;
      const rows = [
        ['Product', [c.productName, c.productVersion && 'v' + c.productVersion].filter(Boolean).join(' ') || '–'],
        ['Company', c.companyName || '–'],
        ['Unity', c.unityVersion || (b.facts && b.facts.get('Unity')) || 'not known yet'],
        ['Loader', s.loader ? `${s.loader.label} (${s.loader.era})` : '–'],
        ['Loader script', s.loader && s.loader.script ? s.loader.script.split('/').pop() : '–'],
        ['Unity progress', s.progress == null ? '–' : `${Math.round(s.progress * 100)}%`],
        ['Toolchain', w && w.flavor ? (w.flavor === 'fastcomp' ? 'Emscripten fastcomp / asm2wasm (Unity 2018 – 2021.1)' : 'Emscripten LLVM wasm backend (Unity 2021.2+)') : '–'],
        ['WebAssembly', w ? `${w.bytes ? fmtBytes(w.bytes) : 'size unknown'} · ${w.streaming ? 'streaming' : 'from bytes'}${w.ms != null ? ' · ' + fmtMs(w.ms) : ' · compiling'}` : 'not seen'],
        ['Memory', w ? w.memoryInfo || '–' : '–'],
        ['Function table', w ? w.tableInfo || '–' : '–'],
        ['Imports / exports', w && w.exportCount != null ? `${w.importCount} / ${w.exportCount}` : '–'],
        ['Wasm analysis', b.analysis ? b.analysis.summary : w ? 'pending' : '–'],
        ['Module', s.runtime ? `captured at +${fmtMs(s.runtime.at)} via ${s.runtime.how || '?'}` : 'not yet'],
        ['Runtime started', s.runtime && s.runtime.startedAt != null ? `+${fmtMs(s.runtime.startedAt)}` : 'not yet'],
      ];
      if (b.facts) for (const [k, v] of b.facts) if (k !== 'Unity') rows.push([k, typeof v === 'bigint' ? v + 'n' : typeof v === 'object' ? safeJson(v) : v]);
      this._kv(this.$('.rt'), rows);
    } else if (this.tab === 'env') {
      this._kv(this.$('.envkv'), [['Page', location.host + location.pathname], ...envLines().map((l) => { const i = l.indexOf(':'); return [l.slice(0, i), l.slice(i + 1).trim()]; })]);
    } else if (this.tab === 'log') {
      const pane = this.$('[data-pane="log"]');
      const atBottom = pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 8;
      const last = pane.__seq || 0;
      for (const e of b.timeline) {
        if (e.seq <= last) continue;
        const row = h('div', '', `<span class="tt">+${esc(fmtMs(e.t))}</span><span class="${esc(e.level)}">${e.source !== 'bootstrap' ? `<span class="src">[${esc(e.source)}]</span> ` : ''}${esc(e.text)}</span>`);
        pane.appendChild(row);
        pane.__seq = e.seq;
      }
      while (pane.childElementCount > 600) pane.firstElementChild.remove();
      if (atBottom) pane.scrollTop = pane.scrollHeight;
    }
  }

  _kv(box, rows) {
    const key = safeJson(rows);
    if (box.__k === key) return;
    box.__k = key;
    box.innerHTML = rows.map(([k, v]) => `<div class="k">${esc(k)}</div><div class="v">${esc(v)}</div>`).join('');
  }
}
