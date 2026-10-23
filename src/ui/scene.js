// Scene tab: hierarchy tree on the left, inspector on the right.
import { h, icon, mark, debounce, splitter } from './dom.js';
import { I } from './icons.js';
import { VList } from './vlist.js';
import { Inspector } from './inspector.js';

export class SceneView {
  constructor(app) {
    this.app = app;
    this.expanded = new Set();
    this.groupOpen = new Map();
    this.query = '';
    this.showHidden = false;
    this.data = null;
    this.selected = 0;

    this.search = h('input.ue-in', { placeholder: 'Search GameObjects', spellcheck: false });
    this.search.addEventListener('input', debounce(() => { this.query = this.search.value.trim(); this.flatten(); }, 120));
    this.hidBtn = h('button.ue-ib', { title: 'Show hidden / internal objects', html: I.eyeOff, on: { click: () => { this.showHidden = !this.showHidden; this.hidBtn.classList.toggle('on', this.showHidden); this.hidBtn.innerHTML = this.showHidden ? I.eye : I.eyeOff; this.flatten(); } } });
    this.refreshBtn = h('button.ue-ib', { title: 'Refresh hierarchy', html: I.refresh, on: { click: () => this.refresh() } });
    this.count = h('span.ue-count');
    this.list = new VList({
      rowHeight: 24,
      render: (it, r) => this.renderRow(it, r),
      onClick: (it, e) => this.click(it, e),
      onKey: (it, e) => { if (it.node) { if (e.key === 'ArrowLeft') this.expanded.delete(it.node.go); else if (e.key === 'ArrowRight') this.expanded.add(it.node.go); else this.toggle(it.node); this.flatten(); } },
    });
    this.inspector = new Inspector(app, {
      onSelectGameObject: (go, fromHistory) => this.select(go, !fromHistory),
      onChange: () => this.refresh(true),
    });
    const left = h('div.ue-pane.ue-left',
      h('div.ue-bar', h('div.ue-search', { html: I.search }, this.search), this.hidBtn, this.refreshBtn),
      this.list.el,
      h('div.ue-bar.ue-sub', this.count));
    const gut = h('div.ue-gut');
    this.el = h('div.ue-split', left, gut, h('div.ue-pane', this.inspector.el));
    splitter(this.el, gut, 'scene');
  }

  refresh(keepSel = true) {
    const { unity } = this.app;
    try {
      const t0 = performance.now();
      this.data = unity.hierarchy();
      this.lastMs = performance.now() - t0;
    } catch (e) {
      this.data = { roots: [], byGo: new Map(), source: 'error', error: e };
      console.error('[UnityExplorer]', e);
    }
    if (!keepSel) this.selected = 0;
    this.flatten();
  }

  _groups() {
    const roots = this.data.roots;
    const scenes = new Map();
    const out = [];
    const prefabs = [];
    const hidden = [];
    for (const r of roots) {
      if (r.hideFlags) { hidden.push(r); continue; }
      if (this.data.source.startsWith('Resources') && r.scene == null && r.active && r.activeInHierarchy === false) { prefabs.push(r); continue; }
      const key = r.scene ?? 'scene';
      if (!scenes.has(key)) scenes.set(key, []);
      scenes.get(key).push(r);
    }
    for (const [key, list] of scenes) {
      const name = key === 'scene' ? 'Scene' : (this.app.unity.sceneName(key) || `Scene ${key}`);
      out.push({ title: name, list });
    }
    if (prefabs.length) out.push({ title: 'Not in a scene (prefabs / assets)', list: prefabs, closed: true });
    if (hidden.length && this.showHidden) out.push({ title: 'Hidden objects', list: hidden });
    return out;
  }

  flatten() {
    if (!this.data) return;
    const items = [];
    const q = this.query.toLowerCase();
    let total = 0;
    const matches = (n) => n.name.toLowerCase().includes(q);
    const subtreeMatch = new Map();
    const sm = (n) => {
      if (subtreeMatch.has(n)) return subtreeMatch.get(n);
      const v = matches(n) || n.children.some(sm);
      subtreeMatch.set(n, v);
      return v;
    };
    const walk = (n, depth) => {
      total++;
      if (q && !sm(n)) return;
      items.push({ node: n, depth });
      const open = q ? n.children.some(sm) : this.expanded.has(n.go);
      if (open) for (const c of n.children) walk(c, depth + 1);
    };
    for (const g of this._groups()) {
      if (q && !g.list.some(sm)) continue;
      const gkey = 'g:' + g.title;
      const closed = q ? false : this.groupOpen.has(gkey) ? !this.groupOpen.get(gkey) : !!g.closed;
      items.push({ group: g.title, key: gkey, closed, n: g.list.length });
      if (!closed) for (const r of g.list) walk(r, 0);
    }
    this.items = items;
    this.list.setItems(items);
    const d = this.data;
    this.count.textContent = d.error ? `Error: ${d.error.message}` : `${d.count ?? 0} objects · ${d.source}`;
    if (!items.length) {
      this.list.el.querySelectorAll('.ue-empty').forEach((e) => e.remove());
      this.list.el.append(h('div.ue-empty', { html: q ? 'No GameObjects match.' : 'No GameObjects found.<br>Press <b>refresh</b> once the game has loaded a scene.' }));
    } else this.list.el.querySelectorAll('.ue-empty').forEach((e) => e.remove());
  }

  renderRow(it, r) {
    if (it.group) {
      r.classList.add('grp');
      r.style.paddingLeft = '8px';
      r.innerHTML = '';
      r.append(h('span.car', { html: it.closed ? I.chevR : I.chevD }), h('span.nm', it.group), h('span.hint', String(it.n)));
      return;
    }
    const n = it.node;
    r.style.paddingLeft = 6 + it.depth * 14 + 'px';
    if (n.go === this.selected) r.classList.add('sel');
    if (!n.active || n.activeInHierarchy === false) r.classList.add('off');
    if (n.hideFlags) r.classList.add('hid');
    const car = h('span.car', { html: n.children.length ? (this.query || this.expanded.has(n.go) ? I.chevD : I.chevR) : '' });
    car.onclick = (e) => { e.stopPropagation(); this.toggle(n); this.flatten(); };
    r.replaceChildren(car, icon(n.active ? I.cube : I.cubeOff), h('span.nm', { html: mark(n.name, this.query) }), n.children.length ? h('span.hint', String(n.children.length)) : '');
  }

  toggle(n) {
    if (!n.children.length) return;
    if (this.expanded.has(n.go)) this.expanded.delete(n.go); else this.expanded.add(n.go);
  }

  click(it, e) {
    if (it.group) {
      this.groupOpen.set(it.key, it.closed);
      this.flatten();
      return;
    }
    this.selected = it.node.go;
    this.list.draw(true);
    this.inspector.show({ kind: 'go', go: it.node.go });
    void e;
  }

  /** Select a GameObject: expand its parents, scroll to it and inspect it. */
  select(go, inspect = true) {
    if (!this.data || !this.data.byGo.has(go)) this.refresh();
    const n = this.data && this.data.byGo.get(go);
    if (n) {
      for (let p = n.parent; p; p = p.parent) this.expanded.add(p.go);
      this.selected = go;
      if (this.query) { this.query = ''; this.search.value = ''; }
      this.flatten();
      const i = this.items.findIndex((x) => x.node === n);
      if (i >= 0) { this.list.sel = i; this.list.scrollToIndex(i); }
    }
    if (inspect) this.inspector.show({ kind: 'go', go });
    this.app.focusTab('scene');
  }
}
