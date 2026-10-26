// Editor tab: write and hot-reload Banans in the browser.
import { h, icon } from '../ui/dom.js';
import { B } from './brand.js';
import { attachComplete } from '../ui/complete.js';
import { highlight } from './highlight.js';
import { Banan, BananPlugin, slug } from '../loader/banan.js';
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
    this.hl = h('pre.bl-hl', { 'aria-hidden': 'true' });
    this.hlCode = h('code');
    this.hl.append(this.hlCode);
    this.gutter = h('div.bl-gutter');
    this.status = h('span.ue-count');
    this.dirty = false;
    this.ta.addEventListener('input', () => { this.dirty = true; this.lines(); this.paint(); this._status(); });
    this.ta.addEventListener('scroll', () => this._sync());
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
      h('div.bl-editor', this.gutter, h('div.bl-code-wrap', this.hl, this.ta)),
      h('div.ue-bar.ue-sub', this.status, h('span.ue-count', { style: { marginLeft: 'auto' } }, 'Ctrl+S saves and hot-reloads')));
    this.loader.on('banans', () => this.options());
    this.options();
    this.ta.value = '';
    this.lines();
    this.paint();
    this._status();
    // type names become known once Il2Cpp is up: recolour then
    this.loader.on('stage', () => { if (this.loader.interop && !this._typed) this.paint(); });
  }

  /** Re-highlight the whole source (a few ms even for long Banans). */
  paint() {
    const L = this.loader;
    const ix = L.interop ? L.interop.index : null;
    this._typed = !!ix;
    const isType = ix ? (w) => ix.bareKind(w, false) === 'type' : () => false;
    // the trailing newline keeps the last line's height when the source ends with one
    this.hlCode.innerHTML = highlight(this.ta.value, isType) + '\n';
    this._sync();
  }

  _sync() {
    this.gutter.scrollTop = this.ta.scrollTop;
    this.hl.scrollTop = this.ta.scrollTop;
    this.hl.scrollLeft = this.ta.scrollLeft;
  }

  options() {
    // the open Banan was deleted: keep the text, but Save no longer writes it back silently
    if (this.entry && this.loader.entries.get(this.entry.id) !== this.entry) {
      const now = this.loader.entries.get(this.entry.id);
      if (now) this.entry = now; // reinstalled under the same id: follow it
      else { this.entry = null; this.dirty = true; this._status(); }
    }
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
    this.paint();
    this._status();
    if (focus) this.app.focusTab('editor');
  }

  async newBanan() {
    let name = await this.app.ui.prompt('Name for the new Banan:', { title: 'New Banan', placeholder: 'My Banan' });
    name = String(name || '').replace(/[\r\n]+/g, ' ').trim();
    if (!name) return;
    // a name that turns into the same id would overwrite that Banan's code
    const other = this.loader.entries.get(slug(name));
    if (other) { this.app.notify(`There's already a Banan called ${other.info.name}. Pick another name.`, 'warn', 4000); return; }
    const src = TEMPLATE.replace('@name        My Banan', () => `@name        ${name}`).replace('class MyBanan', () => `class ${className(name)}`);
    const e = await this.loader.install(src, { origin: 'editor', file: name });
    this.open(e);
  }

  async save() {
    if (!this.entry) {
      if (!this.ta.value.trim()) { this.app.notify('Choose or create a Banan first', 'warn'); return; }
      const ok = await this.app.ui.confirm('This Banan isn\'t installed any more. Install this code as a Banan?', { title: 'Save' });
      if (!ok) return;
      const e = await this.loader.install(this.ta.value, { origin: 'editor' });
      this.open(e, false);
      this.app.notify(e.state === 'error' ? `${e.info.name} installed, but failed to load: ${e.error || 'see Console'}` : `${e.info.name} installed`, e.state === 'error' ? 'error' : 'success', 3000);
      return;
    }
    if (this.entry.rec.origin === 'folder') {
      const ok = await this.app.ui.confirm('This Banan comes from your linked folder, which BananaLoader only reads. Save an editable copy in the browser instead?', { title: 'Save a copy' });
      if (!ok) return;
    }
    const ok = await this.loader.saveSource(this.entry, this.ta.value);
    this.dirty = false;
    this._status();
    this.options();
    const e = this.entry;
    if (ok) this.app.notify(`${e.info.name} saved and reloaded`, 'success', 3000);
    else if (e.state === 'skipped') this.app.notify(`${e.info.name} saved. It's made for another game (@game), so it isn't running here.`, 'info', 4000);
    else if (e.rec.enabled === false) this.app.notify(`${e.info.name} saved. It's disabled, so it wasn't started.`, 'info', 3000);
    else if (this.loader.safeMode) this.app.notify(`${e.info.name} saved. Safe mode is on, so it wasn't started.`, 'info', 3000);
    else this.app.notify(`${e.info.name} saved, but failed to load${e.error ? ': ' + e.error : ' (see Console)'}`, 'error', 4000);
  }

  key(e) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); this.save(); return; }
    if (e.key === 'Tab' && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      const ta = this.ta;
      const v = ta.value;
      let s = ta.selectionStart, en = ta.selectionEnd;
      const multi = v.slice(s, en).includes('\n');
      if (!e.shiftKey && !multi) { this._insert('  ', s, en); return; }
      // indent / outdent every selected line (Shift+Tab on one line outdents it)
      const ls = v.lastIndexOf('\n', s - 1) + 1;
      if (multi && en > s && v[en - 1] === '\n') en--;
      let le = v.indexOf('\n', en);
      if (le < 0) le = v.length;
      const lines = v.slice(ls, le).split('\n');
      const out = lines.map((l) => (e.shiftKey ? l.replace(/^ {1,2}|^\t/, '') : l.length ? '  ' + l : l));
      const firstDelta = out[0].length - lines[0].length;
      const text = out.join('\n');
      this._insert(text, ls, le);
      ta.selectionStart = Math.max(ls, s + firstDelta);
      ta.selectionEnd = ls + text.length;
      if (!multi) ta.selectionStart = ta.selectionEnd = Math.max(ls, s + firstDelta);
    }
  }

  /** Replace [from, to) with text through insertText, which keeps undo and fires input (repaint, gutter, dirty). */
  _insert(text, from, to) {
    const ta = this.ta;
    ta.setSelectionRange(from, to);
    if (!document.execCommand('insertText', false, text)) {
      ta.setRangeText(text, from, to, 'end');
      ta.dispatchEvent(new Event('input'));
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

const RESERVED = new Set('break case catch class const continue debugger default delete do else enum export extends false finally for function if implements import in instanceof interface let new null package private protected public return static super switch this throw true try typeof var void while with yield await async arguments eval undefined NaN Infinity Banan BananPlugin BananaLoader Il2Cpp module exports logger il unity Ref'.split(' '));

/** A valid class name for a Banan called `name` ("2048 Helper" → "B2048Helper"). */
export function className(name) {
  let c = String(name).replace(/[^A-Za-z0-9_$ ]/g, '').replace(/(?:^|\s+)(\w)/g, (_, x) => x.toUpperCase()).replace(/\s+/g, '');
  if (!c) c = 'MyBanan';
  if (/^\d/.test(c)) c = 'B' + c;
  if (RESERVED.has(c)) c += 'Mod';
  return c;
}
