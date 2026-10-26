// Browse tab: search bananaloader.com, install Banans, and keep registry installs up to date.
import { h, icon } from '../ui/dom.js';
import { B } from './brand.js';

const ago = (t) => { const s = (Date.now() - t) / 1000; if (s < 3600) return `${Math.max(1, Math.floor(s / 60))} min ago`; if (s < 86400) return `${Math.floor(s / 3600)} h ago`; if (s < 86400 * 30) return `${Math.floor(s / 86400)} d ago`; return new Date(t).toLocaleDateString(); };
const num = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n || 0));
const hue = (s) => { let x = 0; for (const c of s) x = (x * 31 + c.charCodeAt(0)) >>> 0; return x % 360; };
const badge = (b, size = 36) => h('div.bl-reg-ic', { style: { width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.42)}px`, background: `linear-gradient(135deg, hsl(${hue(b.slug)} 70% 50%), hsl(${(hue(b.slug) + 40) % 360} 75% 32%))` }, text: (b.name || '?').trim()[0].toUpperCase() });

/**
 * The description HTML is sanitized by the server already; this allowlist is a second layer,
 * since it's rendered inside the game's page.
 */
function sanitize(html) {
  const ALLOWED = new Set(['P', 'H2', 'H3', 'H4', 'STRONG', 'EM', 'DEL', 'CODE', 'PRE', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'A', 'IMG', 'HR', 'BR']);
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
  const walk = (node) => {
    for (const el of [...node.children]) {
      if (!ALLOWED.has(el.tagName)) { el.replaceWith(document.createTextNode(el.textContent)); continue; }
      for (const a of [...el.attributes]) {
        const keep = (el.tagName === 'A' && a.name === 'href' && /^https?:\/\//i.test(a.value)) || (el.tagName === 'IMG' && (a.name === 'src' && /^https:\/\//i.test(a.value) || a.name === 'alt'));
        if (!keep) el.removeAttribute(a.name);
      }
      if (el.tagName === 'A') { el.setAttribute('target', '_blank'); el.setAttribute('rel', 'noopener noreferrer nofollow'); }
      if (el.tagName === 'IMG') el.setAttribute('referrerpolicy', 'no-referrer');
      walk(el);
    }
  };
  const root = doc.body.firstChild;
  walk(root);
  return [...root.childNodes];
}

export class BrowseView {
  constructor(app) {
    this.app = app;
    this.loader = app.loader;
    this.state = { q: '', sort: 'popular', page: 1 };
    this.results = [];
    this.selected = null;
    this.busy = new Set();
    const search = h('input.ue-in', { placeholder: 'Search bananaloader.com', spellcheck: false });
    let t;
    search.oninput = () => { clearTimeout(t); t = setTimeout(() => { this.state.q = search.value.trim(); this.load(); }, 250); };
    const sort = h('select.ue-in', { style: { width: '130px' } }, ['popular', 'new', 'updated', 'name'].map((s) => h('option', { value: s, text: s[0].toUpperCase() + s.slice(1) })));
    sort.onchange = () => { this.state.sort = sort.value; this.load(); };
    this.forGame = h('input', { type: 'checkbox', checked: false });
    this.forGame.onchange = () => this.load();
    this.list = h('div.bl-reg-list');
    this.detail = h('div.bl-reg-detail', h('div.ue-empty', { text: 'Pick a Banan to see what it does.' }));
    this.updatesBar = h('div.bl-reg-updates', { style: { display: 'none' } });
    this.status = h('span.ue-count');
    this.more = h('button.ue-btn', { style: { display: 'none', margin: '10px auto' }, on: { click: () => { this.state.page++; this.load(true); } } }, 'Load more');
    this.el = h('div.bl-view',
      h('div.ue-bar',
        h('div.ue-search', { html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>' }, search),
        sort,
        h('label.bl-reg-check', { title: "Only Banans whose @game matches this game's name" }, this.forGame, 'This game'),
        h('button.ue-ib', { title: 'Check for updates', html: B.refresh, on: { click: () => this.checkUpdates(true) } })),
      this.updatesBar,
      h('div.bl-reg', h('div.ue-scroll', this.list, this.more), h('div.ue-scroll', this.detail)),
      h('div.ue-bar.ue-sub', this.status, h('a.ue-count', { href: 'https://bananaloader.com', target: '_blank', rel: 'noopener', style: { marginLeft: 'auto' }, text: 'bananaloader.com' })));
    this.loader.on('banans', () => { this.renderList(); if (this.selected) this.renderDetail(this.selected); });
    this.loader.on('updates', () => this.renderUpdates());
    this.loaded = false;
  }

  /** Called when the tab is first shown. */
  activate() { if (!this.loaded) { this.loaded = true; this.load(); } }

  installedFor(slug) {
    for (const e of this.loader.entries.values()) if (e.rec.registry && e.rec.registry.slug === slug) return e;
    return null;
  }

  async load(append = false) {
    if (!append) this.state.page = 1;
    const p = new URLSearchParams({ sort: this.state.sort, page: this.state.page, per: 30 });
    if (this.state.q) p.set('q', this.state.q);
    if (this.forGame.checked && this.loader.game.product) p.set('game', this.loader.game.product);
    this.status.textContent = 'Loading…';
    try {
      const r = await (await this.loader.registry(`/banans?${p}`)).json();
      this.results = append ? this.results.concat(r.banans) : r.banans;
      this.more.style.display = r.more ? 'block' : 'none';
      this.status.textContent = `${this.results.length}${r.more ? '+' : ''} Banan${this.results.length === 1 ? '' : 's'}${this.state.q ? ` for "${this.state.q}"` : ''}`;
      this.renderList();
    } catch (e) {
      this.results = [];
      this.list.replaceChildren(h('div.ue-note.warn', { text: e.message }));
      this.status.textContent = '';
    }
  }

  renderList() {
    if (!this.results.length && this.list.querySelector('.ue-note')) return;
    this.list.replaceChildren(...(this.results.length ? this.results.map((b) => {
      const inst = this.installedFor(b.slug);
      const row = h(`div.bl-reg-row${this.selected && this.selected.slug === b.slug ? '.on' : ''}`, { on: { click: () => this.select(b.slug) } },
        badge(b),
        h('div.bl-reg-main',
          h('div.bl-reg-name', h('b', { text: b.name }), h('span', { text: ` by ${b.author.name}` })),
          h('div.bl-reg-sum', { text: b.summary || '' })),
        h('div.bl-reg-side', ...[
          inst ? h('span.bl-reg-tag.ok', { text: inst.rec.registry.version === b.version ? 'Installed' : `Update ${b.version}` }) : null,
          h('span', { text: `${num(b.downloads)} ↓` })].filter(Boolean)));
      return row;
    }) : [h('div.ue-empty', { text: 'No Banans found.' })]));
  }

  async select(slug) {
    this.selected = { slug };
    this.renderList();
    this.detail.replaceChildren(h('div.ue-empty', { text: 'Loading…' }));
    try {
      const b = await (await this.loader.registry(`/banans/${encodeURIComponent(slug)}`)).json();
      this.selected = b;
      this.renderDetail(b);
    } catch (e) { this.detail.replaceChildren(h('div.ue-note.warn', { text: e.message })); }
  }

  renderDetail(b) {
    if (!b.name) return;
    const inst = this.installedFor(b.slug);
    const busy = this.busy.has(b.slug);
    const newer = inst && inst.rec.registry.version !== b.version;
    const doInstall = async () => {
      this.busy.add(b.slug); this.renderDetail(b);
      try {
        const e = await this.loader.installFromRegistry(b.slug);
        this.app.notify(`${newer ? 'Updated' : 'Installed'} ${e.info.name} ${e.rec.registry.version}`, e.state === 'error' ? 'error' : 'success', 3000);
        if (this.loader.updates) this.loader.updates = this.loader.updates.filter((u) => u.slug !== b.slug);
        this.renderUpdates();
      } catch (err) { this.app.notify(`${b.name}: ${err.message}`, 'error', 6000); }
      this.busy.delete(b.slug); this.renderDetail(b); this.renderList();
    };
    const desc = h('div.bl-reg-desc');
    if (b.descriptionHtml) desc.append(...sanitize(b.descriptionHtml));
    else desc.append(h('p', { text: b.summary || 'No description.' }));
    const games = b.games.join(', ');
    const product = this.loader.game.product;
    const fits = !product || b.games.some((g) => g === '*' || new RegExp(`^${g.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i').test(product));
    this.detail.replaceChildren(...[
      h('div.bl-reg-head', badge(b, 52), h('div', h('h2', { text: b.name }), h('div.bl-reg-meta', { text: `v${b.version} · by ${b.author.name} · ${num(b.downloads)} downloads · updated ${ago(b.updatedAt)}` }))),
      h('p.bl-reg-summary', { text: b.summary }),
      h('div.bl-reg-actions', ...[
        inst && !newer
          ? h('button.ue-btn', { disabled: true }, icon(B.banana, 'i'), `Installed ${inst.rec.registry.version}`)
          : h('button.ue-btn.pri', { disabled: busy, on: { click: doInstall } }, icon(B.download, 'i'), busy ? 'Installing…' : newer ? `Update to ${b.version}` : 'Install'),
        inst ? h('button.ue-btn', { on: { click: async () => { try { await this.loader.remove(inst); this.app.notify(`Removed ${b.name}`, 'success'); } catch (e) { this.app.notify(e.message, 'error'); } } } }, icon(B.trash, 'i'), 'Remove') : null,
        h('a.ue-btn', { href: `https://bananaloader.com/banans/${b.slug}`, target: '_blank', rel: 'noopener' }, icon(B.link, 'i'), 'Page')].filter(Boolean)),
      !fits ? h('div.ue-note.warn', { text: `Made for ${games}; this game is "${product}". It may not do anything here.` }) : null,
      b.requires && b.requires.length ? h('div.ue-note', { text: `Needs: ${b.requires.join(', ')}. Install those too.` }) : null,
      desc,
      b.versions && b.versions.length ? h('div.bl-reg-versions', h('h3', 'Versions'), b.versions.slice(0, 8).map((v) => h('div.bl-reg-ver', ...[h('b', { text: v.version }), h('span', { text: ` · ${ago(v.createdAt)}` }), v.changelog ? h('div', { text: v.changelog }) : null].filter(Boolean)))) : null,
    ].filter(Boolean));
  }

  renderUpdates() {
    const u = this.loader.updates || [];
    this.updatesBar.style.display = u.length ? 'flex' : 'none';
    if (!u.length) return;
    this.updatesBar.replaceChildren(
      icon(B.sync, 'i'),
      h('span', { text: `${u.length} update${u.length === 1 ? '' : 's'}: ${u.map((x) => `${x.name} ${x.latest}`).join(', ')}` }),
      h('button.ue-btn.pri', { style: { marginLeft: 'auto' }, on: { click: async () => {
        for (const x of [...u]) { try { await this.loader.installFromRegistry(x.slug); } catch (e) { this.app.notify(`${x.name}: ${e.message}`, 'error', 5000); } }
        this.loader.updates = [];
        this.renderUpdates(); this.renderList();
        this.app.notify('Updated', 'success');
      } } }, 'Update all'));
  }

  async checkUpdates(manual = false) {
    try {
      const u = await this.loader.registryUpdates();
      if (manual) this.app.notify(u.length ? `${u.length} update${u.length === 1 ? '' : 's'} available` : 'Everything is up to date', u.length ? 'info' : 'success');
      else if (u.length) this.app.notify(`${u.length} Banan update${u.length === 1 ? '' : 's'} on bananaloader.com (Browse tab)`, 'info', 6000);
    } catch (e) { if (manual) this.app.notify(e.message, 'error', 5000); }
  }
}
