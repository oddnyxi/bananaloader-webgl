// The BananaLoader window (Odium UI): Banans, Console, Preferences, Patches, Editor,
// the built-in Unity Explorer, tabs added by Banans, and Settings.
import { UI } from '../odium/index.js';
import { EXPLORER_HOST_ID } from '../hook.js';
import { h, copy } from '../ui/dom.js';
import { SceneView } from '../ui/scene.js';
import { ClassesView } from '../ui/classes.js';
import { B, LOGO } from './brand.js';
import { BanansView } from './banans.js';
import { ConsoleView } from './console.js';
import { BrowseView } from './browse.js';
import { PrefsView } from './prefsview.js';
import { PatchesView } from './patches.js';
import { EditorView } from './editor.js';
import { VERSION } from '../loader/loader.js';
import explorerCss from 'bundle-text:../ui/explorer.css';
import appCss from 'bundle-text:./bananaloader.css';
import apiDts from 'bundle-text:../loader/bananaloader.d.ts';
import { TypeGen } from '../loader/typegen.js';
import { liveDump, liveMetadata, zip } from '../dumper/live.js';
import { download as saveFile } from '../dumper/zip.js';

export class App {
  constructor(loader) {
    this.loader = loader;
    loader.app = this;
    const S = loader.settings;
    this.settings = S; // the explorer views read autoProps / showAccessors from here
    this.ui = new UI();
    this.ui.createWindow('BANANALOADER', { subtitle: 'v' + VERSION, width: 1080, height: 690, toggleKey: S.toggleKey || 'F8', icon: LOGO });
    if (loader.bootstrap) loader.bootstrap.deferWindow(this.ui); // appears when the loading screen folds away
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
    this.tabs.browse = fill('Browse', 'Loader', B.download);
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
    this.browse = new BrowseView(this);
    this.tabs.browse.page.append(this.browse.el);
    this.tabs.browse.btn.addEventListener('click', () => this.browse.activate());
    this.console = new ConsoleView(this);
    this.tabs.console.page.append(this.console.el);
    this.prefsView = new PrefsView(this, this.tabs.prefs);
    this.patches = new PatchesView(this);
    this.tabs.patches.page.append(this.patches.el);
    this.ui.selectTab(this.tabs.banans);

    loader.on('unload', (inst) => this.removeBananUI(inst));
    loader.on('stage', () => {
      this._foot();
      if (loader.stageAtLeast('initialized')) this._explorer();
      // one quiet update check per page load, once the game is up
      if (loader.stageAtLeast('initialized') && !this._checkedUpdates && S.checkUpdates !== false && !S.safeMode) { this._checkedUpdates = true; setTimeout(() => this.browse.checkUpdates(false), 4000); }
    });
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
    // the tabs exist only when the setting was on at page load (changing it needs a reload)
    if (this._explorerReady || !this.tabs.scene || !this.loader.il) return;
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
    if (id === 'browse' && this.browse) this.browse.activate();
    const t = this.tabs[id];
    if (t && this.ui.active !== t) this.ui.selectTab(t);
  }

  inspect(x) {
    const { il, unity } = this.loader;
    if (!this.scene) throw new Error('the explorer is not available');
    const ptr = x && typeof x === 'object' && x.$ptr !== undefined ? x.$ptr : x;
    if (typeof ptr === 'string') { const td = il.findType(ptr); if (td < 0) throw new Error('type not found'); this.classes.reveal(td); return td; }
    if (typeof ptr === 'number' && ptr) {
      this.ui.show(); // first, so the hierarchy can scroll to it
      if (il.tdOfKlass(il.klassOf(ptr)) === unity.td.GameObject) this.scene.select(ptr);
      else { this.focusTab('scene'); this.scene.inspector.show({ kind: 'obj', ptr }); }
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
      win.classList.remove('bl-drop');
      const files = [...(e.dataTransfer && e.dataTransfer.files || [])];
      // only file drops are ours; dropped text goes into the console or editor as usual
      if (!files.length) return;
      e.preventDefault();
      this.focusTab('banans');
      this.banans.installFiles(files);
    });
  }

  _typesUi(t) {
    const L = this.loader;
    const box = t.createGroup('IntelliSense for Banans', { icon: B.code });
    box.page.append(h('div.ue-note', { style: { margin: '0' }, html: 'Exports <code>game.d.ts</code> (every type in the chosen assemblies) and <code>bananaloader.d.ts</code> (the Banan API). Put them in a <code>types</code> folder next to your Banans with the <code>jsconfig.json</code>, and VS Code autocompletes <code>Il2Cpp.type(\'UnityEngine.Time\').</code>…' }));
    let picker = null;
    let publicOnly = true;
    // the Banan API typings don't need the game: always offer them
    const [b0, c0] = box.createColumns(2);
    b0.createButton('bananaloader.d.ts', () => this.download('bananaloader.d.ts', apiDts), { icon: B.download });
    c0.createButton('jsconfig.json', () => this.download('jsconfig.json', JSON.stringify({ compilerOptions: { checkJs: true, target: 'ES2022', module: 'commonjs', lib: ['ES2022', 'DOM'], strict: false, noImplicitAny: false }, include: ['*.js', 'types/*.d.ts'] }, null, 2)), { icon: B.download });
    const pick = () => {
      if (!L.il || picker) return;
      const imgs = L.il.md.images.map((im) => im.name.replace(/\.dll$/, ''));
      const def = imgs.filter((n) => /^(Assembly-CSharp|UnityEngine\.CoreModule|UnityEngine\.PhysicsModule|UnityEngine\.UI|UnityEngine\.UIModule|UnityEngine\.InputLegacyModule|UnityEngine\.AnimationModule|UnityEngine\.AudioModule|mscorlib)$/.test(n) || /^Assembly-CSharp/.test(n));
      picker = box.createMultiSelect(imgs, () => {}, { label: 'Assemblies', selected: def, save: false });
      box.createToggle('Public members only (much smaller)', (v) => { publicOnly = v; }, true, { save: false });
      box.createButton('game.d.ts', () => {
        const sel = new Set(picker.getValue());
        const images = L.il.md.images.map((im, i) => [im.name.replace(/\.dll$/, ''), i]).filter(([n]) => sel.has(n)).map(([, i]) => i);
        const t0 = performance.now();
        const gen = new TypeGen(L.il);
        gen.game = `${L.game.product} (Unity ${L.game.unity})`;
        const text = gen.generate({ images, publicOnly });
        this.download('game.d.ts', text);
        this.notify(`game.d.ts: ${gen.included.size.toLocaleString()} types, ${(text.length / 1048576).toFixed(1)} MB in ${Math.round(performance.now() - t0)} ms`, 'success', 4000);
      }, { icon: B.download });
    };
    if (L.il) pick(); else L.on('stage', pick);
  }

  _dumpUi(t) {
    const L = this.loader;
    const box = t.createGroup('IL2CPP dump', { icon: B.code });
    box.page.append(h('div.ue-note', { style: { margin: '0' }, html: 'Everything Odium Dumper makes, from the running game: <code>dump.cs</code>, a <code>.wasm</code> with C# function names (for DevTools and Ghidra), <code>script.json</code>, <code>methods.json</code> and <code>global-metadata.dat</code>, as one zip. Use it when a game has no <code>.data</code> file to dump offline.' }));
    let named = true;
    box.createToggle('Named .wasm (downloads the game\'s wasm again)', (v) => { named = v; }, true, { save: false });
    const [a, b] = box.createColumns(2);
    let busy = false;
    a.createButton('Dump game (.zip)', async () => {
      if (!L.il) return this.notify('IL2CPP isn\'t ready yet', 'warn');
      if (busy) return;
      busy = true;
      const t0 = performance.now();
      this.notify('Dumping… the game may pause for a few seconds', 'info', 3000);
      try {
        const r = await liveDump(L.il, { named, log: (m) => L.log.debug && L.log.debug(m), wasmBytes: L.bootstrap && L.bootstrap.wasmBytes || null });
        const name = (L.game.product || document.title || location.hostname || 'game').replace(/[^\w.-]+/g, '_');
        saveFile(`${name}-dump.zip`, zip(r.files), 'application/zip');
        this.notify(`Dumped ${r.summary.types.toLocaleString()} types in ${((performance.now() - t0) / 1000).toFixed(1)} s${r.wasm ? '' : ' (no wasm: function indices and names left out)'}`, 'success', 5000);
      } catch (e) {
        this.notify('Dump failed: ' + (e.message || e), 'error');
      } finally { busy = false; }
    }, { icon: B.download });
    b.createButton('global-metadata.dat', () => {
      if (!L.il) return this.notify('IL2CPP isn\'t ready yet', 'warn');
      saveFile('global-metadata.dat', liveMetadata(L.il));
    }, { icon: B.download });
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
    t.createToggle('Catch direct calls without reloading', (v) => { S.directCallsAll = v; save(); this.notify('Takes effect after a page reload', 'info'); }, S.directCallsAll === true, { save: false })
      .setTooltip('Rewrites every method\'s direct calls as the game loads, so new patches catch every call straight away, with no reload. Costs about 0.1–0.3 s at load (the wasm is compiled from bytes, without the browser\'s code cache) and makes method calls slightly slower.');
    t.createToggle('Unity Explorer tabs', (v) => { S.explorer = v; save(); this.notify('Takes effect after a page reload', 'info'); }, S.explorer, { save: false });
    t.createSection('bananaloader.com');
    t.createToggle('Check for Banan updates when a game starts', (v) => { S.checkUpdates = v; save(); }, S.checkUpdates !== false, { save: false })
      .setTooltip('Asks bananaloader.com once per page load whether Banans you installed from Browse have new versions. Sends only their names and versions.');
    t.createTextInput('Registry address', (v) => { S.registry = String(v || '').trim() || 'https://api.bananaloader.com'; save(); }, { value: S.registry || 'https://api.bananaloader.com', placeholder: 'https://api.bananaloader.com', save: false })
      .setTooltip('Where the Browse tab looks for Banans. Leave as https://api.bananaloader.com unless you run your own server.');
    t.createSection('Loading screen');
    const boot = L.bootstrap;
    if (boot) {
      const lmodes = ['Full screen', 'Corner card', 'Off'];
      const lkeys = ['full', 'compact', 'off'];
      t.createDropdown(lmodes, (v) => boot.saveSettings({ modal: lkeys[lmodes.indexOf(v)] || 'full' }), { label: 'Bootstrap loading screen', selected: Math.max(0, lkeys.indexOf(boot.settings.modal)), save: false })
        .setTooltip('Shown while the game loads, with download, compile and IL2CPP details. Shared with Unity Explorer.');
      // the loading screen and this switch must agree: a missing or odd stored value means "on"
      const autoHide = boot.settings.autoHide !== false;
      if (typeof boot.settings.autoHide !== 'boolean') { try { boot.saveSettings({ autoHide }); } catch (_) { /* older bootstrap */ } }
      t.createToggle('Hide it automatically when everything is ready', (v) => boot.saveSettings({ autoHide: v }), autoHide, { save: false });
      const [x, y] = t.createColumns(2);
      x.createButton('Show loading screen', () => boot.ui && boot.ui.reopen());
      y.createButton('Copy bootstrap report', async () => {
        const text = boot.report();
        // the page can block the clipboard (iframes): then show the text to copy by hand
        if (await copy(text)) this.notify('Bootstrap report copied', 'success');
        else this.ui.prompt('Bootstrap report', { value: text, multiline: true });
      });
    }
    t.createSection('Explorer');
    const modes = ['Engine types only', 'All types', 'Never (click to get)'];
    const keys = ['engine', 'all', 'none'];
    t.createDropdown(modes, (v) => { S.autoProps = keys[modes.indexOf(v)] || 'engine'; save(); }, { label: 'Evaluate properties automatically', selected: Math.max(0, keys.indexOf(S.autoProps)), save: false });
    t.createToggle('Show property / event accessor methods', (v) => { S.showAccessors = v; save(); }, S.showAccessors, { save: false });
    t.createSection('TypeScript');
    this._typesUi(t);
    t.createSection('Dumper');
    this._dumpUi(t);
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
          const list = (data && Array.isArray(data.banans) ? data.banans : []).filter((x) => x && typeof x.source === 'string');
          for (const x of list) {
            const e = await L.install(x.source, { origin: x.origin === 'folder' ? 'file' : x.origin, url: x.url, file: x.id, enabled: x.enabled !== false });
            // Banans that were off in the backup stay off
            if (x.enabled === false && e && e.rec.enabled !== false) await L.setEnabled(e, false);
          }
          this.notify(`Imported ${list.length} Banan${list.length === 1 ? '' : 's'}`, 'success');
        } catch (e) { this.notify('Import failed: ' + (e.message || e), 'error'); }
      };
      inp.click();
    });
    this.ui.setToggleKey(S.toggleKey || 'F8');
    const tk = this.ui.setToggleKey.bind(this.ui);
    this.ui.setToggleKey = (k) => { S.toggleKey = k; save(); return tk(k); };
  }
}
