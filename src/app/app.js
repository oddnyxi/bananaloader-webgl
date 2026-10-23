// The BananaLoader window (Odium UI): Banans, Console, Preferences, Patches, Editor,
// the built-in Unity Explorer, tabs added by Banans, and Settings.
import { UI } from '../odium/index.js';
import { EXPLORER_HOST_ID } from '../hook.js';
import { h } from '../ui/dom.js';
import { SceneView } from '../ui/scene.js';
import { ClassesView } from '../ui/classes.js';
import { B, LOGO } from './brand.js';
import { BanansView } from './banans.js';
import { ConsoleView } from './console.js';
import { PrefsView } from './prefsview.js';
import { PatchesView } from './patches.js';
import { EditorView } from './editor.js';
import { VERSION } from '../loader/loader.js';
import explorerCss from 'bundle-text:../ui/explorer.css';
import appCss from 'bundle-text:./bananaloader.css';
import apiDts from 'bundle-text:../loader/bananaloader.d.ts';
import { TypeGen } from '../loader/typegen.js';

export class App {
  constructor(loader) {
    this.loader = loader;
    loader.app = this;
    const S = loader.settings;
    this.settings = S; // the explorer views read autoProps / showAccessors from here
    this.ui = new UI();
    this.ui.createWindow('BANANALOADER', { subtitle: 'v' + VERSION, width: 1080, height: 690, toggleKey: S.toggleKey || 'F8', icon: LOGO });
    this.ui.host.id = EXPLORER_HOST_ID;
    const style = document.createElement('style');
    style.textContent = explorerCss + '\n' + appCss;
    this.ui.root.getRootNode().appendChild(style);
    this.foot = this.ui.win.querySelector('.foot span');
    this.bananTabs = new Map(); // banan -> [tab]
    this.bananKeys = new Map();
    this.tabs = {};

    const fill = (name, group, ic) => { const t = this.ui.addTab(name, { group, icon: ic }); t.page.classList.add('ue-fill'); return t; };
    this.tabs.banans = fill('Banans', 'Loader', B.banana);
    this.tabs.console = fill('Console', 'Loader', B.terminal);
    this.tabs.prefs = this.ui.addTab('Preferences', { group: 'Loader', icon: B.sliders });
    this.tabs.patches = fill('Patches', 'Loader', B.hook);
    this.tabs.editor = fill('Editor', 'Loader', B.code);
    if (S.explorer) {
      this.tabs.scene = fill('Scene', 'Explorer', B.cube);
      this.tabs.classes = fill('Classes', 'Explorer', B.klass);
      const wait = (msg) => h('div.ue-loading', h('div', h('div.sp', { style: { margin: '0 auto 14px' } }), h('div', { text: msg })));
      this.tabs.scene.page.append(wait('Waiting for IL2CPP…'));
      this.tabs.classes.page.append(wait('Waiting for IL2CPP…'));
    }
    this.settingsTab = this.ui.addSettingsTab('Settings', { group: 'System' });
    this._settings();

    this.editor = new EditorView(this);
    this.tabs.editor.page.append(this.editor.el);
    this.banans = new BanansView(this);
    this.tabs.banans.page.append(this.banans.el);
    this.console = new ConsoleView(this);
    this.tabs.console.page.append(this.console.el);
    this.prefsView = new PrefsView(this, this.tabs.prefs);
    this.patches = new PatchesView(this);
    this.tabs.patches.page.append(this.patches.el);
    this.ui.selectTab(this.tabs.banans);

    loader.on('unload', (inst) => this.removeBananUI(inst));
    loader.on('stage', () => { this._foot(); if (loader.stageAtLeast('initialized')) this._explorer(); });
    loader.on('banans', () => this._foot());
    loader.on('failed', (e) => this._failed(e));
    this._dropTarget();
    this._foot();
  }

  // ------------------------------------------------------------------ explorer

  get il() { return this.loader.il; }
  get Module() { return this.loader.Module; }
  get unity() { return this.loader.unity; }
  get fmt() { return this.loader.fmt; }

  _explorer() {
    if (this._explorerReady || !this.loader.settings.explorer || !this.loader.il) return;
    this._explorerReady = true;
    this.scene = new SceneView(this);
    this.classes = new ClassesView(this, this.scene);
    this.tabs.scene.page.replaceChildren(this.scene.el);
    this.tabs.classes.page.replaceChildren(this.classes.el);
    this.classes.load();
    this.scene.refresh();
    this.loader.on('scenes', () => setTimeout(() => this.scene && this.scene.refresh(), 100));
  }

  _failed(e) {
    const note = () => h('div.ue-note.warn', { html: `<b>BananaLoader couldn't attach to IL2CPP.</b><br>${String(e && e.message || e).replace(/</g, '&lt;')}<br>Banans that only use onPreInitialize still run.` });
    if (this.tabs.scene) this.tabs.scene.page.replaceChildren(note());
    if (this.tabs.classes) this.tabs.classes.page.replaceChildren(note());
  }

  shadowActive() { try { return this.ui.root.getRootNode().activeElement; } catch (_) { return null; } }

  focusTab(id) {
    const t = this.tabs[id];
    if (t && this.ui.active !== t) this.ui.selectTab(t);
  }

  inspect(x) {
    const { il, unity } = this.loader;
    if (!this.scene) throw new Error('the explorer is not available');
    const ptr = x && typeof x === 'object' && x.$ptr !== undefined ? x.$ptr : x;
    if (typeof ptr === 'string') { const td = il.findType(ptr); if (td < 0) throw new Error('type not found'); this.classes.reveal(td); return td; }
    if (typeof ptr === 'number' && ptr) {
      if (il.tdOfKlass(il.klassOf(ptr)) === unity.td.GameObject) this.scene.select(ptr);
      else { this.focusTab('scene'); this.scene.inspector.show({ kind: 'obj', ptr }); }
      this.ui.show();
      return ptr;
    }
    throw new Error('inspect() takes an object, an address or a type name');
  }

  // ------------------------------------------------------------------ banan UI

  createBananTab(banan, name, o = {}) {
    const tab = this.ui.addTab(name, { group: 'Banans', icon: o.icon || B.banana });
    // keep Banan tabs in their own group above System
    const side = this.ui.side;
    const prev = tab.btn.previousElementSibling;
    if (prev && prev.classList.contains('sgroup') && prev !== this._bananHead) prev.remove();
    const sys = [...side.querySelectorAll('.sgroup')].find((g) => g.textContent === 'System');
    if (sys) {
      if (!this._bananHead || !this._bananHead.isConnected) {
        this._bananHead = document.createElement('div');
        this._bananHead.className = 'sgroup';
        this._bananHead.textContent = 'Banans';
        side.insertBefore(this._bananHead, sys);
      }
      side.insertBefore(tab.btn, sys);
    }
    if (!this.bananTabs.has(banan)) this.bananTabs.set(banan, []);
    this.bananTabs.get(banan).push(tab);
    return tab;
  }

  bindKey(banan, spec, fn) {
    const k = this.ui.bindKey(spec, () => this.loader.safe(banan, fn));
    if (!this.bananKeys.has(banan)) this.bananKeys.set(banan, []);
    this.bananKeys.get(banan).push(k);
    return () => this.ui.unbindKey(k);
  }

  removeBananUI(banan) {
    for (const t of this.bananTabs.get(banan) || []) t.destroy();
    this.bananTabs.delete(banan);
    for (const k of this.bananKeys.get(banan) || []) this.ui.unbindKey(k);
    this.bananKeys.delete(banan);
    if (this._bananHead && ![...this.bananTabs.values()].some((l) => l.length)) this._bananHead.remove();
    if (this.ui.active && !this.ui.tabs.includes(this.ui.active)) this.ui.selectTab(this.tabs.banans);
  }

  showPrefs(id) {
    this.focusTab('prefs');
    setTimeout(() => this.prefsView.focus(id), 50);
  }

  notify(text, type = 'info', ms) { this.ui.notify(text, type, ms); }

  download(name, text) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/javascript' }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  _foot() {
    const L = this.loader;
    const n = L.loaded().length;
    const stage = { boot: 'starting', pre: 'game starting', started: 'starting', initialized: 'ready', late: 'ready' }[L.stage] || L.stage;
    if (this.foot) this.foot.textContent = `BananaLoader · ${n} Banan${n === 1 ? '' : 's'} running · ${stage}${L.game.product ? ' · ' + L.game.product : ''}`;
  }

  _dropTarget() {
    const win = this.ui.win;
    win.addEventListener('dragover', (e) => { if (e.dataTransfer && [...e.dataTransfer.items].some((i) => i.kind === 'file')) { e.preventDefault(); win.classList.add('bl-drop'); } });
    win.addEventListener('dragleave', (e) => { if (e.target === win || !win.contains(e.relatedTarget)) win.classList.remove('bl-drop'); });
    win.addEventListener('drop', (e) => {
      e.preventDefault();
      win.classList.remove('bl-drop');
      const files = [...(e.dataTransfer && e.dataTransfer.files || [])];
      if (files.length) { this.focusTab('banans'); this.banans.installFiles(files); }
    });
  }

  _typesUi(t) {
    const L = this.loader;
    const box = t.createGroup('IntelliSense for Banans', { icon: B.code });
    box.page.append(h('div.ue-note', { style: { margin: '0' }, html: 'Exports <code>game.d.ts</code> (every type in the chosen assemblies) and <code>bananaloader.d.ts</code> (the Banan API). Put them in a <code>types</code> folder next to your Banans with the <code>jsconfig.json</code>, and VS Code autocompletes <code>Il2Cpp.type(\'UnityEngine.Time\').</code>…' }));
    let picker = null;
    let publicOnly = true;
    const pick = () => {
      if (!L.il || picker) return;
      const imgs = L.il.md.images.map((im) => im.name.replace(/\.dll$/, ''));
      const def = imgs.filter((n) => /^(Assembly-CSharp|UnityEngine\.CoreModule|UnityEngine\.PhysicsModule|UnityEngine\.UI|UnityEngine\.UIModule|UnityEngine\.InputLegacyModule|UnityEngine\.AnimationModule|UnityEngine\.AudioModule|mscorlib)$/.test(n) || /^Assembly-CSharp/.test(n));
      picker = box.createMultiSelect(imgs, () => {}, { label: 'Assemblies', selected: def, save: false });
      box.createToggle('Public members only (much smaller)', (v) => { publicOnly = v; }, true, { save: false });
      const [a, b, c] = box.createColumns(3);
      a.createButton('game.d.ts', () => {
        const sel = new Set(picker.getValue());
        const images = L.il.md.images.map((im, i) => [im.name.replace(/\.dll$/, ''), i]).filter(([n]) => sel.has(n)).map(([, i]) => i);
        const t0 = performance.now();
        const gen = new TypeGen(L.il);
        gen.game = `${L.game.product} (Unity ${L.game.unity})`;
        const text = gen.generate({ images, publicOnly });
        this.download('game.d.ts', text);
        this.notify(`game.d.ts: ${gen.included.size.toLocaleString()} types, ${(text.length / 1048576).toFixed(1)} MB in ${Math.round(performance.now() - t0)} ms`, 'success', 4000);
      }, { icon: B.download });
      b.createButton('bananaloader.d.ts', () => this.download('bananaloader.d.ts', apiDts), { icon: B.download });
      c.createButton('jsconfig.json', () => this.download('jsconfig.json', JSON.stringify({ compilerOptions: { checkJs: true, target: 'ES2022', module: 'commonjs', lib: ['ES2022', 'DOM'], strict: false, noImplicitAny: false }, include: ['*.js', 'types/*.d.ts'] }, null, 2)), { icon: B.download });
    };
    if (L.il) pick(); else L.on('stage', pick);
  }

  _settings() {
    const t = this.settingsTab;
    const L = this.loader;
    const S = L.settings;
    const save = () => L.saveSettings();
    t.createSection('Loader');
    t.createToggle('Safe mode (load no Banans)', (v) => { S.safeMode = v; save(); this.notify('Takes effect after a page reload', 'info'); }, S.safeMode, { save: false })
      .setTooltip('Starts the game without any Banans, to get past a broken one.');
    t.createToggle('Direct-call patching', (v) => { S.directCalls = v; save(); this.notify('Takes effect after a page reload', 'info'); }, S.directCalls !== false, { save: false })
      .setTooltip('Rewrites the game\'s wasm as it loads so patches also catch calls compiled straight into game code.');
    t.createToggle('Unity Explorer tabs', (v) => { S.explorer = v; save(); this.notify('Takes effect after a page reload', 'info'); }, S.explorer, { save: false });
    t.createSection('Explorer');
    const modes = ['Engine types only', 'All types', 'Never (click to get)'];
    const keys = ['engine', 'all', 'none'];
    t.createDropdown(modes, (v) => { S.autoProps = keys[modes.indexOf(v)] || 'engine'; save(); }, { label: 'Evaluate properties automatically', selected: Math.max(0, keys.indexOf(S.autoProps)), save: false });
    t.createToggle('Show property / event accessor methods', (v) => { S.showAccessors = v; save(); }, S.showAccessors, { save: false });
    t.createSection('TypeScript');
    this._typesUi(t);
    t.createSection('Data');
    const [a, b] = t.createColumns(2);
    a.createButton('Export all Banans', () => {
      const out = [...L.entries.values()].map((e) => ({ id: e.id, source: e.rec.source, enabled: e.rec.enabled !== false, origin: e.rec.origin, url: e.rec.url || '' }));
      this.download('banans-backup.json', JSON.stringify({ bananaloader: VERSION, banans: out }, null, 2));
    });
    b.createButton('Import backup', () => {
      const inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = '.json';
      inp.onchange = async () => {
        try {
          const data = JSON.parse(await inp.files[0].text());
          for (const x of data.banans || []) await L.install(x.source, { origin: x.origin === 'folder' ? 'file' : x.origin, url: x.url, file: x.id });
          this.notify(`Imported ${(data.banans || []).length} Banans`, 'success');
        } catch (e) { this.notify('Import failed: ' + (e.message || e), 'error'); }
      };
      inp.click();
    });
    this.ui.setToggleKey(S.toggleKey || 'F8');
    const tk = this.ui.setToggleKey.bind(this.ui);
    this.ui.setToggleKey = (k) => { S.toggleKey = k; save(); return tk(k); };
  }
}
