// Editor tab: write and hot-reload Banans in the browser.
import { h, icon } from '../ui/dom.js';
import { B } from './brand.js';
import { attachComplete } from '../ui/complete.js';
import { Banan, BananPlugin } from '../loader/banan.js';
import { Ref } from '../il2cpp/interop.js';

export const TEMPLATE = `// ==Banan==
// @name        My Banan
// @version     1.0.0
// @author      You
// @description What this Banan does.
// @game        *
// ==/Banan==

module.exports = class MyBanan extends Banan {
  onInitializeBanan() {
    this.enabled = this.pref('enabled', true, 'Enabled');
    this.logger.msg('Hello from my Banan!');
  }

  onSceneWasLoaded(buildIndex, sceneName) {
    this.logger.msg(\`Scene loaded: \${sceneName}\`);
  }

  onUpdate() {
    // runs every frame
  }
};
`;

export class EditorView {
  constructor(app) {
    this.app = app;
    this.loader = app.loader;
    this.entry = null;
    this.sel = h('select.ue-in', { style: { width: '220px' } });
    this.sel.onchange = () => { const e = this.loader.entries.get(this.sel.value); if (e) this.open(e, false); };
    this.ta = h('textarea.bl-code', { spellcheck: false, wrap: 'off' });
    this.gutter = h('div.bl-gutter');
    this.status = h('span.ue-count');
    this.dirty = false;
    this.ta.addEventListener('input', () => { this.dirty = true; this.lines(); this._status(); });
    this.ta.addEventListener('scroll', () => { this.gutter.scrollTop = this.ta.scrollTop; });
    this.ac = attachComplete(this.ta, {
      completer: () => this.loader.completer,
      context: () => ({
        roots: { Banan, BananPlugin, BananaLoader: this.loader.publicApi(), Il2Cpp: this.loader.Il2Cpp, logger: (this._logger ||= this.loader.hub.logger('editor')), Ref, module: { exports: {} } },
        bare: true, unityFirst: false, thisProto: Banan.prototype, minPrefix: 2,
        thisValues: { logger: (this._logger ||= this.loader.hub.logger('editor')), info: { name: '', version: '', author: '', description: '', games: [] } },
      }),
    });
    this.ta.addEventListener('keydown', (e) => { if (this.ac.key(e)) return; this.key(e); });
    this.saveBtn = h('button.ue-btn.pri', { on: { click: () => this.save() } }, icon(B.save, 'i'), 'Save & reload');
    this.el = h('div.bl-view',
      h('div.ue-bar', this.sel,
        h('button.ue-btn', { on: { click: () => this.newBanan() } }, icon(B.plus, 'i'), 'New'),
        h('span', { style: { flex: 1 } }),
        h('button.ue-btn', { title: 'Discard changes', on: { click: () => this.entry && this.open(this.entry, false) } }, icon(B.refresh, 'i'), 'Revert'),
        h('button.ue-btn', { title: 'Download as .js', on: { click: () => this.app.download(`${(this.entry ? this.entry.id : 'banan').replace(/^folder:/, '').replace(/\.js$/, '')}.js`, this.ta.value) } }, icon(B.upload, 'i'), 'Export'),
        this.saveBtn),
      h('div.bl-editor', this.gutter, this.ta),
      h('div.ue-bar.ue-sub', this.status, h('span.ue-count', { style: { marginLeft: 'auto' } }, 'Ctrl+S saves and hot-reloads')));
    this.loader.on('banans', () => this.options());
    this.options();
    this.ta.value = '';
    this.lines();
    this._status();
  }

  options() {
    const cur = this.entry ? this.entry.id : '';
    this.sel.replaceChildren(h('option', { value: '', text: this.entry ? '' : 'Choose a Banan…', disabled: true }));
    for (const e of this.loader.ordered()) this.sel.append(h('option', { value: e.id, text: e.info.name + (e.rec.origin === 'folder' ? ' (folder)' : '') }));
    this.sel.value = cur;
  }

  open(e, focus = true) {
    this.entry = e;
    this.ta.value = e.rec.source;
    this.dirty = false;
    this.options();
    this.lines();
    this._status();
    if (focus) this.app.focusTab('editor');
  }

  async newBanan() {
    const name = await this.app.ui.prompt('Name for the new Banan:', { title: 'New Banan', placeholder: 'My Banan' });
    if (!name) return;
    const src = TEMPLATE.replace('@name        My Banan', `@name        ${name}`).replace('class MyBanan', `class ${name.replace(/[^A-Za-z0-9_]/g, '') || 'MyBanan'}`);
    const e = await this.loader.install(src, { origin: 'editor', file: name });
    this.open(e);
  }

  async save() {
    if (!this.entry) { this.app.notify('Choose or create a Banan first', 'warn'); return; }
    if (this.entry.rec.origin === 'folder') {
      const ok = await this.app.ui.confirm('This Banan comes from your linked folder, which BananaLoader only reads. Save an editable copy in the browser instead?', { title: 'Save a copy' });
      if (!ok) return;
    }
    const ok = await this.loader.saveSource(this.entry, this.ta.value);
    this.dirty = false;
    this._status();
    this.options();
    this.app.notify(ok ? `${this.entry.info.name} saved and reloaded` : `${this.entry.info.name} saved, but failed to load (see Console)`, ok ? 'success' : 'error', 3000);
  }

  key(e) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); this.save(); return; }
    if (e.key === 'Tab') {
      e.preventDefault();
      const s = this.ta.selectionStart;
      this.ta.setRangeText('  ', s, this.ta.selectionEnd, 'end');
      this.dirty = true;
      this._status();
    }
  }

  lines() {
    const n = this.ta.value.split('\n').length;
    if (n === this._n) return;
    this._n = n;
    this.gutter.textContent = Array.from({ length: n }, (_, i) => i + 1).join('\n');
  }

  _status() {
    const e = this.entry;
    if (!e) { this.status.textContent = 'No Banan open'; return; }
    const st = e.state === 'error' ? `failed: ${e.error}` : e.state === 'loaded' ? 'running' : e.state;
    this.status.textContent = `${e.info.name} · ${st}${this.dirty ? ' · unsaved changes' : ''}`;
    this.saveBtn.classList.toggle('pulse', this.dirty);
  }
}
