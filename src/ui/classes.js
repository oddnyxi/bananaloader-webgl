// Classes tab: every type in the game's metadata, searchable, with a static inspector.
import { h, icon, mark, debounce, splitter } from './dom.js';
import { I } from './icons.js';
import { VList } from './vlist.js';
import { Inspector } from './inspector.js';

export class ClassesView {
  constructor(app, scene) {
    this.app = app;
    this.query = '';
    this.asm = -1;
    this.selected = -1;

    this.search = h('input.ue-in', { placeholder: 'Search types (e.g. Player, Weapon)', spellcheck: false });
    this.search.addEventListener('input', debounce(() => { this.query = this.search.value.trim(); this.filter(); }, 150));
    this.asmSel = h('select.ue-in', { style: { width: '100%' } });
    this.asmSel.onchange = () => { this.asm = +this.asmSel.value; this.filter(); };
    this.count = h('span.ue-count');
    this.list = new VList({
      rowHeight: 24,
      render: (it, r) => this.renderRow(it, r),
      onClick: (it) => this.open(it.td),
      onKey: (it) => this.open(it.td),
    });
    this.inspector = new Inspector(app, {
      onSelectGameObject: (go) => scene.select(go),
    });
    const left = h('div.ue-pane.ue-left',
      h('div.ue-bar', h('div.ue-search', { html: I.search }, this.search)),
      h('div.ue-bar.ue-sub', this.asmSel),
      this.list.el,
      h('div.ue-bar.ue-sub', this.count));
    const gut = h('div.ue-gut');
    this.el = h('div.ue-split', left, gut, h('div.ue-pane', this.inspector.el));
    splitter(this.el, gut, 'classes');
  }

  load() {
    const { il } = this.app;
    const md = il.md;
    this.all = [];
    for (let i = 0; i < md.typeCount; i++) {
      const d = md.typeDef(i);
      if (d.name === '<Module>' || d.name.startsWith('<PrivateImplementationDetails>')) continue;
      let hint = d.namespace;
      if (d.declaringTypeIndex >= 0) { const o = il.tdOfTypeIndex(d.declaringTypeIndex); if (o >= 0) hint = 'in ' + il.tdShortName(o); }
      this.all.push({ td: i, name: il.tdShortName(i), full: il.tdFullName(i), image: d.image, d, hint, gen: d.name.startsWith('<') });
    }
    // game assemblies first
    const order = (img) => {
      const n = md.images[img].name;
      if (/^Assembly-CSharp/.test(n)) return 0;
      if (/^(mscorlib|System|Mono|UnityEngine|Unity\.|netstandard)/.test(n)) return 2;
      return 1;
    };
    this.all.sort((a, b) => order(a.image) - order(b.image) || a.full.localeCompare(b.full));
    this.asmSel.replaceChildren(h('option', { value: '-1', text: `All assemblies (${md.images.length})` }));
    md.images.map((im, i) => [im, i]).sort((a, b) => order(a[1]) - order(b[1]) || a[0].name.localeCompare(b[0].name))
      .forEach(([im, i]) => this.asmSel.append(h('option', { value: String(i), text: `${im.name.replace(/\.dll$/, '')} (${im.typeCount})` })));
    const def = md.images.findIndex((im) => im.name === 'Assembly-CSharp.dll');
    if (def >= 0) { this.asm = def; this.asmSel.value = String(def); }
    this.filter();
  }

  filter() {
    const q = this.query.toLowerCase();
    let items = this.all;
    if (this.asm >= 0) items = items.filter((x) => x.image === this.asm);
    if (!q.startsWith('<')) items = items.filter((x) => !x.gen); // compiler-generated (closures, iterators)
    if (q) {
      items = items.filter((x) => x.full.toLowerCase().includes(q));
      // exact / prefix matches on the short name first
      const rank = (x) => { const n = x.name.toLowerCase(); return n === q ? 0 : n.startsWith(q) ? 1 : n.includes(q) ? 2 : 3; };
      items = items.slice().sort((a, b) => rank(a) - rank(b));
    }
    this.items = items;
    this.list.setItems(items, false);
    this.count.textContent = `${items.length.toLocaleString()} types`;
  }

  renderRow(it, r) {
    const d = it.d;
    if (it.td === this.selected) r.classList.add('sel');
    const ico = d.isEnum ? I.enum : d.isInterface ? I.iface : d.isValueType ? I.struct : I.klass;
    r.style.paddingLeft = '8px';
    r.replaceChildren(icon(ico), h('span.nm', { html: mark(it.name, this.query), style: { flexShrink: '0', maxWidth: '72%' } }), h('span.hint', { text: it.hint, title: it.full, style: { overflow: 'hidden', textOverflow: 'ellipsis' } }));
  }

  open(td) {
    this.selected = td;
    this.list.draw(true);
    this.inspector.show({ kind: 'static', td });
  }

  /** Jump here from elsewhere and show a type. */
  reveal(td) {
    this.app.focusTab('classes');
    this.open(td);
  }
}
