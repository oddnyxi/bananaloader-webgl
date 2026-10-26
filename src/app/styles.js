// Styles tab: pick, install and share BananaStyles (themes + layouts for this window).
import { h, icon } from '../ui/dom.js';
import { B } from './brand.js';
import { styleTokens } from '../loader/styles.js';

const LAYOUT_NAMES = { window: 'One window', tabs: 'Tabs on top', panels: 'Separate panels' };
const SAFE_IMG = (u) => (typeof u === 'string' && /^https:\/\//i.test(u) ? u : '');

/** A small live sketch of a style: its colours on its layout. */
function preview(tokens, layout, img) {
  const box = h('div.bs-prev');
  if (SAFE_IMG(img)) {
    box.append(h('img', { src: SAFE_IMG(img), alt: '', referrerpolicy: 'no-referrer', loading: 'lazy' }));
    return box;
  }
  const t = (k, d) => (tokens[k] || d).replace(/var\([^)]*\)/g, d);
  const bg = t('--win-bg', t('--bg', '#09090b'));
  const side = t('--side-bg', t('--panel', '#101013'));
  const line = t('--line', '#26262d');
  const acc = t('--accent', '#e11d2e');
  const text = t('--text', '#ececf1');
  const blur = tokens['--backdrop'] ? 'blur(6px)' : 'none';
  const st = (o) => ({ ...o, backdropFilter: blur, webkitBackdropFilter: blur });
  const rad = /^\d+px$/.test(t('--radius', '12px')) ? Math.min(10, Math.round(parseInt(t('--radius', '12px'), 10) / 2)) + 'px' : '6px';
  const lines = (n) => Array.from({ length: n }, (_, i) => h('i', { style: { background: i === 0 ? acc : text, opacity: i === 0 ? 1 : 0.25, width: `${70 - i * 12}%` } }));
  if (layout === 'panels') {
    box.append(
      h('div.bs-bar', { style: st({ background: bg, borderColor: line, borderRadius: rad }) }, h('b', { style: { background: acc } }), h('span', { style: { background: text } }), h('span', { style: { background: text } }), h('span', { style: { background: text } })),
      h('div.bs-pan.l', { style: st({ background: bg, borderColor: line, borderRadius: rad }) }, ...lines(4)),
      h('div.bs-pan.r', { style: st({ background: bg, borderColor: line, borderRadius: rad }) }, ...lines(3)));
  } else {
    const head = h('div.bs-head', { style: { borderColor: line, background: t('--head-bg', side) } }, h('b', { style: { background: acc } }));
    const tabs = layout === 'tabs'
      ? h('div.bs-tabs', { style: { background: side, borderColor: line } }, h('i', { style: { borderTopColor: acc, background: bg } }), h('i'), h('i'))
      : null;
    const body = h('div.bs-body', layout === 'tabs' ? null : h('div.bs-side', { style: { background: side, borderColor: line } }, h('i', { style: { background: acc } }), h('i', { style: { background: text } }), h('i', { style: { background: text } })), h('div.bs-main', ...lines(4)));
    box.append(h('div.bs-win', { style: st({ background: bg, borderColor: line, borderRadius: rad }) }, ...[head, tabs, body].filter(Boolean)));
  }
  return box;
}

export class StylesView {
  constructor(app) {
    this.app = app;
    this.loader = app.loader;
    this.S = this.loader.styles;
    this.mine = h('div.bs-grid');
    this.results = h('div.bs-grid');
    this.getNote = h('div');
    this.q = h('input.ue-in', { placeholder: 'Search styles on bananaloader.com', spellcheck: false });
    let t;
    this.q.oninput = () => { clearTimeout(t); t = setTimeout(() => this.search(), 300); };
    this.el = h('div.bl-view',
      h('div.ue-bar',
        h('button.ue-btn', { on: { click: () => this.pickFile() } }, icon(B.file, 'i'), 'Install from file'),
        h('button.ue-btn', { on: { click: () => this.fromUrl() } }, icon(B.url, 'i'), 'Install from URL'),
        h('button.ue-btn', { on: { click: () => this.checkUpdates() } }, icon(B.refresh, 'i'), 'Check for updates'),
        h('span.ue-count', { style: { marginLeft: 'auto' }, text: 'Drop a .style.js or .css file anywhere on the window' })),
      h('div.ue-scroll.bs-scroll',
        h('h3.bs-h', 'Your styles'),
        this.mine,
        h('h3.bs-h', 'Get styles', h('a.ue-count', { href: 'https://bananaloader.com/styles', target: '_blank', rel: 'noopener', text: 'bananaloader.com/styles', style: { marginLeft: '10px', fontWeight: 400 } })),
        h('div.ue-search.bs-q', { html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>' }, this.q),
        this.getNote,
        this.results));
    this.loader.on('styles', () => this.render());
    this.loader.on('style', () => this.render());
    this.loaded = false;
    this.render();
  }

  activate() { if (!this.loaded) { this.loaded = true; this.search(); } }

  render() {
    const active = this.S.activeId;
    this.mine.replaceChildren(...this.S.list().map((e) => {
      const on = e.id === active;
      const css = e.kind === 'css' ? e.rec.source : (/css\s*:\s*`([\s\S]*?)`/.exec(e.rec.source) || [, ''])[1];
      return h(`div.bs-card${on ? '.on' : ''}`,
        preview(styleTokens(css), e.info.layout, e.info.preview),
        h('div.bs-info',
          h('div.bs-name', h('b', { text: e.info.name }), h('span.bl-ver', { text: e.info.version })),
          h('div.bs-by', { text: [e.info.author && `by ${e.info.author}`, LAYOUT_NAMES[e.info.layout]].filter(Boolean).join(', ') }),
          e.info.description ? h('div.bs-desc', { text: e.info.description }) : null,
          h('div.bs-tags', ...[
            e.builtin ? h('span.bs-tag', { text: 'Built in' }) : null,
            h(`span.bs-tag${e.runsCode ? '.runs' : ''}`, { text: e.runsCode ? 'Runs code' : 'CSS only' }),
            e.rec.registry ? h('span.bs-tag', { text: 'bananaloader.com' }) : null].filter(Boolean))),
        h('div.bs-act',
          on ? h('button.ue-btn', { disabled: true }, 'Active') : h('button.ue-btn.pri', { on: { click: () => this.apply(e) } }, 'Apply'),
          h('button.ue-ib', { title: 'Export', html: B.download, on: { click: () => this.app.download(`${e.id}.style.${e.kind === 'css' ? 'css' : 'js'}`, e.rec.source) } }),
          e.builtin ? null : h('button.ue-ib', { title: 'Remove', html: B.trash, on: { click: () => this.remove(e) } })));
    }));
    if (this._last) this.renderResults(this._last);
  }

  apply(e) {
    const r = this.S.apply(e.id);
    if (r.id === e.id) this.app.notify(`${e.info.name} style applied`, 'success', 2000);
  }

  async remove(e) {
    if (!(await this.app.ui.confirm(`Remove the ${e.info.name} style?`, { title: 'Remove style' }))) return;
    try { await this.S.remove(e.id); this.app.notify(`Removed ${e.info.name}`, 'success'); } catch (err) { this.app.notify(err.message, 'error'); }
  }

  /** Install from text; styles that run code are confirmed first. Returns the entry or null. */
  async installSource(text, o = {}) {
    let p;
    try { p = this.S.check(text); } catch (err) { this.app.notify(err.message, 'error', 5000); return null; }
    const code = p.kind === 'js' && /\bapply\b/.test(text);
    if (code && o.origin !== 'registry') {
      const ok = await this.app.ui.confirm(`${p.info.name} runs JavaScript in this page, with the same access as a Banan. Only install styles from people you trust.`, { title: 'This style runs code' });
      if (!ok) return null;
    }
    try {
      const e = await this.S.install(text, o);
      this.app.notify(`Installed the ${e.info.name} style`, 'success', 2500);
      return e;
    } catch (err) { this.app.notify(err.message, 'error', 5000); return null; }
  }

  async installFiles(files) {
    for (const f of files) {
      const e = await this.installSource(await f.text(), { origin: 'file', url: '' });
      if (e && files.length === 1) this.S.apply(e.id);
    }
  }

  pickFile() {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.js,.css';
    inp.multiple = true;
    inp.onchange = () => this.installFiles([...inp.files]);
    inp.click();
  }

  async fromUrl() {
    const url = await this.app.ui.prompt('Style URL', { placeholder: 'https://…/my.style.js' });
    if (!url || !url.trim()) return;
    try {
      const r = await fetch(url.trim(), { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await this.installSource(await r.text(), { origin: 'url', url: url.trim() });
    } catch (err) { this.app.notify(`Couldn't install from that URL: ${err.message}`, 'error', 5000); }
  }

  async checkUpdates() {
    try {
      const u = await this.S.updates();
      if (!u.length) return this.app.notify('Your styles are up to date', 'success');
      for (const x of u) await this.S.installFromRegistry(x.slug);
      this.app.notify(`Updated ${u.length} style${u.length === 1 ? '' : 's'}`, 'success');
    } catch (err) { this.connectNote(err) || this.app.notify(err.message, 'error', 5000); }
  }

  /** The "connect your account" state for a 401. Returns true when it handled the error. */
  connectNote(err) {
    if (!err || !err.needsLogin) return false;
    this.getNote.replaceChildren(h('div.ue-note.warn.bs-connect',
      h('div', { text: err.message }),
      h('div.bs-act',
        h('a.ue-btn.pri', { href: 'https://bananaloader.com/connect', target: '_blank', rel: 'noopener' }, icon(B.link, 'i'), 'Open bananaloader.com/connect'),
        h('button.ue-btn', { on: { click: () => this.app.focusTab('settings') } }, 'Paste the key in Settings'))));
    this.results.replaceChildren();
    return true;
  }

  async search() {
    this.getNote.replaceChildren(h('div.ue-count', { text: 'Loading…' }));
    try {
      const r = await this.S.search(this.q.value.trim());
      this._last = r.banans || [];
      this.getNote.replaceChildren(this._last.length ? '' : h('div.ue-empty', { text: 'No styles found.' }));
      this.renderResults(this._last);
    } catch (err) {
      if (!this.connectNote(err)) { this.getNote.replaceChildren(h('div.ue-note.warn', { text: err.message })); this.results.replaceChildren(); }
    }
  }

  renderResults(list) {
    const mine = new Map(this.S.list().filter((e) => e.rec.registry).map((e) => [e.rec.registry.slug, e]));
    this.results.replaceChildren(...list.map((b) => {
      const have = mine.get(b.slug);
      const newer = have && have.rec.registry.version !== b.version;
      return h('div.bs-card',
        have ? preview(styleTokens(have.kind === 'css' ? have.rec.source : (/css\s*:\s*`([\s\S]*?)`/.exec(have.rec.source) || [, ''])[1]), have.info.layout, b.thumbnail || have.info.preview) : preview({}, b.layout || 'window', b.thumbnail || b.preview),
        h('div.bs-info',
          h('div.bs-name', h('b', { text: b.name }), h('span.bl-ver', { text: b.version })),
          h('div.bs-by', { text: [b.author && b.author.name && `by ${b.author.name}`, LAYOUT_NAMES[b.layout]].filter(Boolean).join(', ') }),
          b.summary ? h('div.bs-desc', { text: b.summary }) : null,
          h('div.bs-tags', h(`span.bs-tag${b.runsCode ? '.runs' : ''}`, { text: b.runsCode ? 'Runs code' : b.runsCode === false ? 'CSS only' : 'Style' }))),
        h('div.bs-act',
          have && !newer
            ? h('button.ue-btn', { on: { click: () => this.S.apply(have.id) } }, have.id === this.S.activeId ? 'Active' : 'Apply')
            : h('button.ue-btn.pri', { on: { click: async (ev) => {
              ev.currentTarget.disabled = true;
              try { const e = await this.S.installFromRegistry(b.slug); this.app.notify(`${newer ? 'Updated' : 'Installed'} ${e.info.name}`, 'success'); this.S.apply(e.id); } catch (err) { if (!this.connectNote(err)) this.app.notify(err.message, 'error', 5000); }
            } } }, newer ? `Update to ${b.version}` : 'Install'),
          h('a.ue-ib', { title: 'Open on bananaloader.com', href: `https://bananaloader.com/banans/${b.slug}`, target: '_blank', rel: 'noopener', html: B.link })));
    }));
  }
}
