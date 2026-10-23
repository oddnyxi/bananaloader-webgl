// Console tab: the loader log (MelonLoader's console window) plus a JavaScript prompt.
import { h, icon, copy } from '../ui/dom.js';
import { B } from './brand.js';

const LEVEL_CLASS = { msg: '', warning: 'warn', error: 'err', success: 'ok', debug: 'dbg', big: 'big' };

export class ConsoleView {
  constructor(app) {
    this.app = app;
    this.loader = app.loader;
    this.source = '';
    this.level = 'all';
    this.query = '';
    this.hist = [];
    this.hpos = 0;
    this.out = h('div.con-out.bl-log');
    this.srcSel = h('select.ue-in', { style: { width: '170px' } });
    this.srcSel.onchange = () => { this.source = this.srcSel.value; this.redraw(); };
    const lvl = h('select.ue-in', { style: { width: '120px' } },
      h('option', { value: 'all', text: 'All levels' }), h('option', { value: 'warning', text: 'Warnings +' }), h('option', { value: 'error', text: 'Errors' }), h('option', { value: 'debug', text: 'Include debug' }));
    lvl.onchange = () => { this.level = lvl.value; this.redraw(); };
    const search = h('input.ue-in', { placeholder: 'Filter', spellcheck: false });
    search.oninput = () => { this.query = search.value.toLowerCase(); this.redraw(); };
    this.input = h('textarea.ue-in', { placeholder: 'JavaScript — BananaLoader, Il2Cpp, il, unity and banans are in scope. Enter runs, Shift+Enter adds a line.', spellcheck: false, rows: 1 });
    this.input.addEventListener('keydown', (e) => this.key(e));
    this.input.addEventListener('input', () => { this.input.style.height = 'auto'; this.input.style.height = Math.min(160, this.input.scrollHeight) + 'px'; });
    this.el = h('div.con',
      h('div.ue-bar', this.srcSel, lvl, h('div.ue-search', { html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>' }, search),
        h('button.ue-ib', { title: 'Copy log', html: B.copy, on: { click: () => { copy(this.visible().map(fmtLine).join('\n')); app.notify('Log copied', 'success', 1200); } } }),
        h('button.ue-ib', { title: 'Clear', html: B.trash, on: { click: () => { this.loader.hub.lines.length = 0; this.redraw(); } } })),
      this.out,
      h('div.con-in', this.input, h('button.ue-btn.pri', { on: { click: () => this.run() } }, icon(B.play, 'i'), 'Run')));
    this.loader.hub.on((line) => this.append(line));
    this.loader.on('banans', () => this.sources());
    this.sources();
    this.redraw();
  }

  sources() {
    const cur = this.srcSel.value;
    this.srcSel.replaceChildren(h('option', { value: '', text: 'All sources' }), h('option', { value: 'BananaLoader', text: 'BananaLoader' }));
    for (const e of this.loader.ordered()) this.srcSel.append(h('option', { value: e.info.name, text: e.info.name }));
    this.srcSel.value = cur || '';
  }

  pass(l) {
    if (this.source && l.source !== this.source) return false;
    if (this.level === 'all' && l.level === 'debug') return false;
    if (this.level === 'warning' && l.level !== 'warning' && l.level !== 'error') return false;
    if (this.level === 'error' && l.level !== 'error') return false;
    if (this.query && !(`${l.source} ${l.text}`).toLowerCase().includes(this.query)) return false;
    return true;
  }

  visible() { return this.loader.hub.lines.filter((l) => this.pass(l)); }

  row(l) {
    const t = l.time;
    const ts = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}:${String(t.getSeconds()).padStart(2, '0')}.${String(t.getMilliseconds()).padStart(3, '0')}`;
    return h('div.l.' + (LEVEL_CLASS[l.level] || 'msg'),
      h('span.ts', ts), ' ',
      l.source === 'BananaLoader' && l.level === 'big' ? null : h('span.src', { style: { color: l.color } }, `[${l.source}]`), l.source === 'BananaLoader' && l.level === 'big' ? '' : ' ',
      h('span.tx', l.level === 'big' && l.source !== 'BananaLoader' ? { style: { color: l.color }, text: l.text } : { text: l.text }));
  }

  append(l) {
    if (!this.pass(l)) return;
    const stick = this.out.scrollTop + this.out.clientHeight >= this.out.scrollHeight - 30;
    this.out.append(this.row(l));
    while (this.out.childElementCount > 1500) this.out.firstChild.remove();
    if (stick) this.out.scrollTop = this.out.scrollHeight;
  }

  redraw() {
    this.out.replaceChildren(...this.visible().slice(-1500).map((l) => this.row(l)));
    this.out.scrollTop = this.out.scrollHeight;
  }

  key(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.run(); }
    else if (e.key === 'ArrowUp' && !this.input.value.includes('\n') && this.hist.length) { e.preventDefault(); this.hpos = Math.max(0, this.hpos - 1); this.input.value = this.hist[this.hpos] || ''; }
    else if (e.key === 'ArrowDown' && !this.input.value.includes('\n') && this.hist.length) { e.preventDefault(); this.hpos = Math.min(this.hist.length, this.hpos + 1); this.input.value = this.hist[this.hpos] || ''; }
  }

  run() {
    const code = this.input.value.trim();
    if (!code) return;
    this.hist.push(code);
    this.hpos = this.hist.length;
    this.input.value = '';
    this.input.style.height = '';
    const L = this.loader;
    const con = L.hub.logger('>', '#93c5fd');
    con.msg(code);
    const scope = {
      BananaLoader: L.publicApi(),
      Il2Cpp: L.Il2Cpp,
      il: L.il,
      unity: L.unity,
      banans: Object.fromEntries([...L.entries.values()].filter((e) => e.instance).map((e) => [e.info.name.replace(/\W+/g, '_'), e.instance])),
      inspect: (x) => this.app.inspect(x),
    };
    const keys = Object.keys(scope);
    let fn;
    try { fn = new Function(...keys, `return (${code}\n);`); } catch (_) {
      try { fn = new Function(...keys, code); } catch (e) { con.error(String(e)); return; }
    }
    try {
      const r = fn(...keys.map((k) => scope[k]));
      Promise.resolve(r).then((v) => { if (v !== undefined) con.msg(show(v)); }, (e) => con.error(String(e && e.message || e)));
    } catch (e) { con.error(String(e && e.message || e)); }
  }
}

function show(v) {
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'bigint') return v + 'n';
  if (v && typeof v === 'object' && typeof v.toString === 'function' && v.$ptr !== undefined) return String(v);
  if (Array.isArray(v) || (v && typeof v === 'object')) {
    try {
      return JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? x + 'n' : x && typeof x === 'object' && x.$ptr !== undefined ? String(x) : x), 2);
    } catch (_) { return String(v); }
  }
  return String(v);
}

const fmtLine = (l) => `[${l.time.toISOString().slice(11, 23)}] [${l.source}] ${l.text}`;
