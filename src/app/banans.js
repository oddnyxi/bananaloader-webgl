// Banans tab: installed mods, their state, and installing new ones.
import { h, icon } from '../ui/dom.js';
import { B } from './brand.js';

const ORIGIN = { file: ['File', B.file], url: ['URL', B.url], editor: ['Editor', B.code], folder: ['Folder', B.folder], example: ['Example', B.banana] };

export class BanansView {
  constructor(app) {
    this.app = app;
    this.loader = app.loader;
    this.query = '';
    this.fileIn = h('input', { type: 'file', accept: '.js,text/javascript', multiple: true, style: { display: 'none' } });
    this.fileIn.onchange = () => { this.installFiles([...this.fileIn.files]); this.fileIn.value = ''; };
    const search = h('input.ue-in', { placeholder: 'Search Banans', spellcheck: false });
    search.oninput = () => { this.query = search.value.trim().toLowerCase(); this.render(); };
    this.folderBtn = h('button.ue-btn', { on: { click: () => this.folderMenu() } }, icon(B.folder, 'i'), 'Folder');
    this.list = h('div.bl-list');
    this.summary = h('span.ue-count');
    this.el = h('div.bl-view',
      h('div.ue-bar',
        h('div.ue-search', { html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>' }, search),
        h('button.ue-btn.pri', { on: { click: () => this.fileIn.click() } }, icon(B.upload, 'i'), 'Add file'),
        h('button.ue-btn', { on: { click: () => this.fromUrl() } }, icon(B.url, 'i'), 'URL'),
        h('button.ue-btn', { on: { click: () => app.editor.newBanan() } }, icon(B.plus, 'i'), 'New'),
        this.folderBtn,
        this.fileIn),
      h('div.ue-scroll', this.list),
      h('div.ue-bar.ue-sub', this.summary, h('span', { style: { marginLeft: 'auto' } }, h('span.ue-count', 'Drop .js files on the window to install'))));
    this.loader.on('banans', () => this.render());
    this.loader.on('stage', () => this.render());
    this.render();
    this._folderState();
  }

  async _folderState() {
    try {
      const perm = await this.loader.store.folderPermission(false);
      this.folderBtn.classList.toggle('warn', perm === 'prompt');
      this.folderBtn.title = perm === 'none' ? 'Link a Banans folder on your computer' : perm === 'granted' ? 'Linked folder' : 'Reconnect the Banans folder';
      this._perm = perm;
    } catch (_) { this._perm = 'none'; }
  }

  async installFiles(files) {
    for (const f of files) {
      if (!/\.js$/i.test(f.name)) { this.app.notify(`${f.name}: not a .js file`, 'warn'); continue; }
      try {
        const e = await this.loader.install(await f.text(), { origin: 'file', file: f.name });
        this.app.notify(`Installed ${e.info.name}`, e.state === 'error' ? 'error' : 'success');
      } catch (err) { this.app.notify(`${f.name}: ${err.message || err}`, 'error'); }
    }
  }

  async fromUrl() {
    const url = await this.app.ui.prompt('Install a Banan from a URL (raw .js file):', { title: 'Install from URL', placeholder: 'https://…/my-banan.js' });
    if (!url) return;
    try {
      const e = await this.loader.installFromUrl(url.trim());
      this.app.notify(`Installed ${e.info.name}`, 'success');
    } catch (err) { this.app.notify(`Couldn't download: ${err.message || err}`, 'error', 5000); }
  }

  async folderMenu() {
    const st = this.loader.store;
    if (!st.folderSupported) { this.app.ui.alert('Linking a folder needs a Chromium browser (Chrome, Edge, Opera, Brave). You can still add Banans from files.', { title: 'Banans folder' }); return; }
    await this._folderState();
    const m = this.app.ui.createContextMenu();
    const dir = await st.folder();
    if (dir) m.addLabel(`Linked: ${dir.name}`);
    if (this._perm === 'prompt') m.addButton('Reconnect folder', () => this.syncFolder(true), { icon: B.link });
    if (this._perm === 'granted') m.addButton('Reload from folder', () => this.syncFolder(false), { icon: B.sync });
    m.addButton(dir ? 'Link a different folder…' : 'Link a Banans folder…', () => this.linkFolder(), { icon: B.folder });
    if (dir) { m.addSeparator(); m.addButton('Unlink folder', async () => { await st.unlinkFolder(); for (const e of [...this.loader.entries.values()]) if (e.rec.origin === 'folder') { this.loader.unload(e); this.loader.entries.delete(e.id); } this.render(); this._folderState(); }, { danger: true }); }
    const r = this.folderBtn.getBoundingClientRect();
    this.app.ui.contextMenu(m, r.left, r.bottom + 4);
  }

  async linkFolder() {
    try {
      await this.loader.store.pickFolder();
      const n = await this.loader.syncFolder(false);
      this.app.notify(`Folder linked: ${n} Banan${n === 1 ? '' : 's'} found`, 'success');
    } catch (e) { if (e.name !== 'AbortError') this.app.notify(e.message || String(e), 'error'); }
    this._folderState();
  }

  async syncFolder(request) {
    try {
      const n = await this.loader.syncFolder(request);
      this.app.notify(`Folder: ${n} Banan${n === 1 ? '' : 's'}`, 'success');
    } catch (e) { this.app.notify(e.message || String(e), 'error'); }
    this._folderState();
  }

  render() {
    const L = this.loader;
    const all = L.ordered();
    const list = all.filter((e) => !this.query || `${e.info.name} ${e.info.author} ${e.info.description}`.toLowerCase().includes(this.query));
    this.list.replaceChildren();
    if (!all.length) {
      this.list.append(h('div.bl-empty',
        h('div.bl-empty-ico', { html: B.banana }),
        h('h3', 'No Banans yet'),
        h('p', { html: 'Banans are JavaScript mods. Add a <b>.js</b> file, install one from a URL, link a folder, or start a new one in the editor.' }),
        h('div', { style: { display: 'flex', gap: '8px', justifyContent: 'center' } },
          h('button.ue-btn.pri', { on: { click: () => this.fileIn.click() } }, icon(B.upload, 'i'), 'Add file'),
          h('button.ue-btn', { on: { click: () => this.app.editor.newBanan() } }, icon(B.plus, 'i'), 'New Banan'))));
    }
    for (const e of list) this.list.append(this.card(e));
    const loaded = all.filter((e) => e.state === 'loaded').length;
    const errors = all.filter((e) => e.state === 'error').length;
    this.summary.textContent = `${all.length} installed · ${loaded} running${errors ? ` · ${errors} failed` : ''}${L.settings.safeMode ? ' · SAFE MODE' : ''}`;
  }

  card(e) {
    const L = this.loader;
    const info = e.info;
    const on = e.rec.enabled !== false;
    const sw = h('button.ue-sw', { title: on ? 'Disable' : 'Enable' });
    sw.classList.toggle('on', on);
    sw.onclick = async () => { await L.setEnabled(e, !on); };
    const [oname, oico] = ORIGIN[e.rec.origin] || ORIGIN.file;
    const patches = e.instance ? L.patcher.list().filter((p) => p.owner === e.instance).length : 0;
    const cat = e.instance && L.prefs.getCategory(e.id);
    const prefs = cat ? cat.entries.size : 0;
    let status;
    if (L.settings.safeMode) status = h('span.bl-st.dim', 'Safe mode');
    else if (e.state === 'loaded') status = h('span.bl-st.ok', 'Running');
    else if (e.state === 'error') status = h('span.bl-st.err', 'Failed');
    else if (e.state === 'skipped') status = h('span.bl-st.dim', 'Other game');
    else status = h('span.bl-st.dim', on ? 'Waiting' : 'Disabled');
    const actions = h('div.bl-actions',
      h('button.ue-ib', { title: 'Reload', html: B.refresh, disabled: !on, on: { click: () => { L.reload(e); this.app.notify(`${info.name} reloaded`, 'success', 1500); } } }),
      h('button.ue-ib', { title: 'Edit', html: B.edit, on: { click: () => this.app.editor.open(e) } }),
      prefs ? h('button.ue-ib', { title: 'Preferences', html: B.sliders, on: { click: () => this.app.showPrefs(e.id) } }) : null,
      e.rec.url ? h('button.ue-ib', { title: 'Update from URL', html: B.download, on: { click: async () => { try { await L.updateFromUrl(e); this.app.notify(`${info.name} updated`, 'success'); } catch (err) { this.app.notify(err.message, 'error'); } } } }) : null,
      h('button.ue-ib', { title: 'Export .js', html: B.upload, on: { click: () => this.app.download(`${e.id.replace(/^folder:/, '').replace(/\.js$/, '')}.js`, e.rec.source) } }),
      e.rec.origin === 'folder' ? null : h('button.ue-ib', { title: 'Delete', html: B.trash, on: { click: () => this.remove(e) } }));
    const tile = h('div.bl-tile', { html: info.type === 'plugin' ? B.plugin : B.banana, style: { color: info.color, background: hexA(info.color, 0.12), borderColor: hexA(info.color, 0.35) } });
    return h('div.bl-card' + (on ? '' : '.off') + (e.state === 'error' ? '.err' : ''),
      tile,
      h('div.bl-main',
        h('div.bl-title', h('b', info.name), h('span.bl-ver', 'v' + info.version), h('span.bl-by', 'by ' + info.author)),
        info.description ? h('div.bl-desc', info.description) : null,
        h('div.bl-meta', status,
          h('span.chip', info.type === 'plugin' ? 'Plugin' : 'Mod'),
          h('span.chip', { title: e.rec.url || e.rec.file || '' }, icon(oico, 'i'), oname),
          patches ? h('span.chip.red', `${patches} patch${patches === 1 ? '' : 'es'}`) : null,
          prefs ? h('span.chip', `${prefs} pref${prefs === 1 ? '' : 's'}`) : null,
          info.games.join(',') !== '*' ? h('span.chip', { title: 'Games' }, info.games.join(', ')) : null),
        e.error ? h('div.bl-error', { text: e.error }) : null),
      h('div.bl-side', sw, actions));
  }

  async remove(e) {
    const ok = await this.app.ui.confirm(`Delete ${e.info.name}? Its code is removed from this browser. Preferences are kept.`, { title: 'Delete Banan' });
    if (!ok) return;
    await this.loader.remove(e);
    this.app.notify(`${e.info.name} deleted`, 'info');
  }
}

function hexA(hex, a) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return `rgba(225,29,46,${a})`;
  const n = parseInt(m[1], 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}
