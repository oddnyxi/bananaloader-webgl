// The inspector: GameObjects (transform, components, children), objects (fields,
// properties, methods, elements) and types (static members), with history and live values.

import { h, icon, esc, copy } from './dom.js';
import { I } from './icons.js';
import { T, FIELD, METHOD, ACCESS_NAME } from '../il2cpp/types.js';
import { hexAddr, fmtNumber } from '../il2cpp/values.js';

const SPECIAL = /^(get_|set_|add_|remove_|op_)/;

export class Inspector {
  /**
   * @param app   { il, unity, fmt, ui, settings }
   * @param o     { onSelectGameObject(go), onChange() }
   */
  constructor(app, o = {}) {
    this.app = app;
    this.o = o;
    this.history = [];
    this.pos = -1;
    this.updaters = [];
    this.tab = 'fields';
    this.filter = '';
    this.live = true;

    this.backBtn = h('button.ue-ib', { title: 'Back', html: I.back, on: { click: () => this.go(-1) } });
    this.fwdBtn = h('button.ue-ib', { title: 'Forward', html: I.fwd, on: { click: () => this.go(1) } });
    this.crumbs = h('div.ins-crumbs');
    this.liveBtn = h('button.ue-ib.on', { title: 'Live values', html: I.clock, on: { click: () => this.setLive(!this.live) } });
    this.refreshBtn = h('button.ue-ib', { title: 'Refresh', html: I.refresh, on: { click: () => this.render() } });
    this.bar = h('div.ue-bar', this.backBtn, this.fwdBtn, this.crumbs, this.liveBtn, this.refreshBtn);
    this.head = h('div');
    this.tabs = h('div');
    this.body = h('div.ins-body');
    this.scroll = h('div.ue-scroll', this.body);
    this.el = h('div.ins', this.bar, this.head, this.tabs, this.scroll);
    this._empty();

    this._timer = setInterval(() => this.tick(), 400);
  }

  get il() { return this.app.il; }
  get unity() { return this.app.unity; }
  get fmt() { return this.app.fmt; }
  get target() { return this.history[this.pos]; }

  setLive(v) {
    this.live = v;
    this.liveBtn.classList.toggle('on', v);
  }

  _empty(msg) {
    this.head.replaceChildren();
    this.tabs.replaceChildren();
    this.body.replaceChildren(h('div.ue-empty', { html: msg || 'Select a GameObject in the hierarchy,<br>or a type in the class browser.' }));
    this.crumbs.replaceChildren();
    this.backBtn.disabled = this.pos <= 0;
    this.fwdBtn.disabled = this.pos >= this.history.length - 1;
  }

  /** target: { kind: 'go', go } | { kind: 'obj', ptr } | { kind: 'static', td } */
  show(target, push = true) {
    if (push) {
      const cur = this.target;
      if (!(cur && cur.kind === target.kind && cur.go === target.go && cur.ptr === target.ptr && cur.td === target.td)) {
        this.history = this.history.slice(0, this.pos + 1);
        this.history.push(target);
        if (this.history.length > 60) this.history.shift();
        this.pos = this.history.length - 1;
      }
    }
    if (target.kind !== 'go' && this.tab === 'go') this.tab = 'fields';
    this.scroll.scrollTop = 0;
    this.render();
  }

  go(d) {
    const p = this.pos + d;
    if (p < 0 || p >= this.history.length) return;
    this.pos = p;
    this.render();
    if (this.target.kind === 'go' && this.o.onSelectGameObject) this.o.onSelectGameObject(this.target.go, true);
  }

  label(t) {
    try {
      if (t.kind === 'go') return this.unity.name(t.go) ?? 'GameObject';
      if (t.kind === 'static') return this.il.tdShortName(t.td);
      if (t.kind === 'obj') {
        const k = this.il.klassOf(t.ptr);
        if (this.unity.isUnityObject(t.ptr)) { const nm = this.unity.name(t.ptr); return nm ? `${nm} (${this.il.klassName(k, false)})` : this.il.klassName(k, false); }
        return this.il.klassName(k, false);
      }
    } catch (_) { /* fall through */ }
    return '?';
  }

  _crumbs() {
    this.crumbs.replaceChildren();
    const start = Math.max(0, this.pos - 3);
    if (start > 0) this.crumbs.append(h('i', '…'));
    for (let i = start; i <= this.pos; i++) {
      if (i > start) this.crumbs.append(h('i', '›'));
      const a = h('a', { text: this.label(this.history[i]), title: this.label(this.history[i]) });
      if (i === this.pos) a.classList.add('cur');
      else a.onclick = () => { this.pos = i; this.render(); };
      this.crumbs.append(a);
    }
    this.backBtn.disabled = this.pos <= 0;
    this.fwdBtn.disabled = this.pos >= this.history.length - 1;
  }

  /** Is the object still the same object we were asked to inspect? */
  _valid(t) {
    const il = this.il;
    if (t.kind === 'static') return true;
    const p = t.kind === 'go' ? t.go : t.ptr;
    if (!p || !il.mem.valid(p)) return false;
    const k = il.klassOf(p);
    if (t.klass === undefined) t.klass = k;
    if (k !== t.klass) return false;
    if (t.kind === 'go' || this.unity.isUnityObject(p)) return this.unity.alive(p);
    return true;
  }

  render() {
    this.updaters = [];
    const t = this.target;
    if (!t) return this._empty();
    this._crumbs();
    if (!this._valid(t)) {
      this.head.replaceChildren();
      this.tabs.replaceChildren();
      this.body.replaceChildren(h('div.ue-empty', { html: 'This object no longer exists.<br>It was destroyed or garbage collected.' }));
      return;
    }
    try {
      if (t.kind === 'go') this._renderGo(t);
      else if (t.kind === 'obj') this._renderObj(t);
      else this._renderStatic(t);
    } catch (e) {
      console.error('[UnityExplorer]', e);
      // nothing half-built may keep running or show the previous object's tabs
      this.updaters = [];
      this.tabs.replaceChildren();
      this.body.replaceChildren(h('div.ue-note.warn', { html: `<b>Couldn't inspect this.</b><br>${esc(e.message || e)}` }));
    }
  }

  tick() {
    if (!this.live || !this.el.isConnected || !this.el.offsetParent) return;
    const t = this.target;
    if (!t) return;
    if (!this._valid(t)) { this.render(); return; }
    // rows that were collapsed or replaced stop updating (and are dropped)
    this.updaters = this.updaters.filter((u) => !u.cell || u.cell.isConnected);
    for (const u of this.updaters) {
      try { u(); } catch (_) { /* keep going */ }
    }
  }

  // ------------------------------------------------------------------ header

  _head({ ico, title, sub, chips = [], actions = [] }) {
    this.head.replaceChildren(h('div.ins-head',
      h('div.ins-title', h('div.big', { html: ico }), h('div', { style: { minWidth: 0, flex: 1 } }, title, h('div.tn', { text: sub, title: sub })), h('div.ins-actions', actions)),
      chips.length ? h('div.ins-meta', chips) : null,
    ));
  }

  _addrChip(p) {
    return h('span.chip.click.ue-addr', { title: 'Copy address', on: { click: async () => { const ok = await copy(hexAddr(p)); this.app.ui.notify(ok ? 'Address copied' : 'Couldn\'t copy: the page blocks the clipboard', ok ? 'success' : 'error', 1500); } } }, icon(I.copy, 'i'), hexAddr(p));
  }

  _typeChip(td, text) {
    return h('span.chip.click', { title: 'Show static members', on: { click: () => this.show({ kind: 'static', td }) } }, icon(I.klass, 'i'), text || this.il.tdShortName(td));
  }

  _tabs(defs) {
    if (!defs.some((d) => d[0] === this.tab)) this.tab = defs[0][0];
    const bar = h('div.ins-tabs');
    for (const [id, label, n] of defs) {
      const tb = h('div.ins-tab', label, n != null ? h('b', String(n)) : null);
      if (id === this.tab) tb.classList.add('on');
      tb.onclick = () => { this.tab = id; this.render(); };
      bar.append(tb);
    }
    const f = h('input.ue-in', { placeholder: 'Filter', value: this.filter, style: { height: '24px', margin: '5px 0 5px auto' } });
    f.addEventListener('input', () => { this.filter = f.value; this._applyFilter(); });
    bar.append(f);
    this.tabs.replaceChildren(bar);
  }

  _applyFilter() {
    const q = this.filter.trim().toLowerCase();
    this.body.querySelectorAll('.mrow[data-name]').forEach((r) => { r.style.display = !q || r.dataset.name.toLowerCase().includes(q) ? '' : 'none'; });
  }

  // ------------------------------------------------------------------ GameObject

  _renderGo(t) {
    const { il, unity } = this;
    const go = t.go;
    const name = unity.name(go) ?? '?';
    const active = unity.try('activeSelf', go);
    const tr = unity.try('transform', go);

    const nameIn = h('input.ue-in', { value: name, style: { fontSize: '14px', fontWeight: '700', height: '30px' } });
    nameIn.addEventListener('change', () => {
      try { unity.setName(go, nameIn.value); this.o.onChange && this.o.onChange(); } catch (e) { this._err(e); }
    });
    const sw = h('button.ue-sw', { title: 'Active' });
    sw.classList.toggle('on', !!active);
    sw.onclick = () => {
      try { unity.setActive(go, !sw.classList.contains('on')); sw.classList.toggle('on', !!unity.try('activeSelf', go)); this.o.onChange && this.o.onChange(); } catch (e) { this._err(e); }
    };
    this.updaters.push(() => { if (document.activeElement !== nameIn) sw.classList.toggle('on', !!unity.try('activeSelf', go)); });

    const chips = [this._addrChip(go)];
    const layer = unity.try('layer', go);
    if (layer != null) chips.push(h('span.chip', `Layer ${layer}`));
    const tag = unity.try('tag', go);
    if (tag) chips.push(h('span.chip', `Tag ${tag}`));
    if (unity.try('activeInHierarchy', go) === false && active) chips.push(h('span.chip.amber', 'Inactive parent'));

    this._head({
      ico: I.cube,
      title: h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } }, sw, nameIn),
      sub: 'GameObject',
      chips,
      actions: [
        h('button.ue-btn', { title: 'Inspect the GameObject object itself', on: { click: () => this.show({ kind: 'obj', ptr: go }) } }, icon(I.braces, 'i'), 'Object'),
        h('button.ue-btn.danger', { title: 'Destroy', on: { click: () => this._destroy(go) } }, icon(I.trash, 'i')),
      ],
    });
    this.tabs.replaceChildren();
    this.body.replaceChildren();

    // transform
    if (tr) this.body.append(this._transformEditor(tr));

    // components
    const comps = unity.components(go);
    this.body.append(this._groupHead('Components', comps.length));
    const list = h('div.comp-list');
    for (const c of comps) {
      const k = il.klassOf(c);
      const td = il.tdOfKlass(k);
      const d = td >= 0 ? il.md.typeDef(td) : null;
      const row = h('div.comp', { on: { click: () => this.show({ kind: 'obj', ptr: c }) } },
        icon(c === tr ? I.move : I.box),
        h('div.nm', il.klassName(k, false), d && d.namespace ? h('span.ns', d.namespace) : null));
      const en = this._enabledSwitch(c);
      if (en) row.append(en);
      list.append(row);
    }
    this.body.append(list);

    // children
    const kids = [];
    const n = unity.try('childCount', tr);
    if (n) for (let i = 0; i < Math.min(n, 500); i++) {
      const ct = unity.try('child', tr, i);
      const cg = ct && unity.gameObjectOf(ct);
      if (cg) kids.push(cg);
    }
    if (kids.length) {
      this.body.append(this._groupHead('Children', n));
      const cl = h('div.comp-list');
      for (const cg of kids) {
        cl.append(h('div.comp', { on: { click: () => this.o.onSelectGameObject ? this.o.onSelectGameObject(cg) : this.show({ kind: 'go', go: cg }) } },
          icon(I.cube), h('div.nm', unity.name(cg) ?? '?'), unity.try('activeSelf', cg) === false ? h('span.v-dim', 'inactive') : null));
      }
      this.body.append(cl);
    }
  }

  _enabledSwitch(c) {
    const { il, unity } = this;
    const bh = unity.td.Behaviour;
    if (bh < 0 || !il.isInstanceOf(c, bh)) return null;
    const get = il.findMethod(bh, 'get_enabled', 0);
    const set = il.findMethod(bh, 'set_enabled', 1);
    if (!get) return null;
    const sw = h('button.ue-sw', { title: 'Enabled' });
    const upd = () => { try { sw.classList.toggle('on', !!il.call(get, c)); } catch (_) { /* ignore */ } };
    upd();
    sw.onclick = (e) => {
      e.stopPropagation();
      if (!set) return this.app.ui.notify('set_enabled is not available in this build', 'warn');
      try { il.call(set, c, !sw.classList.contains('on')); upd(); } catch (err) { this._err(err); }
    };
    this.updaters.push(upd);
    return sw;
  }

  _groupHead(text, n) {
    return h('div.mgroup-h', { style: { cursor: 'default' } }, text, n != null ? h('span.n', String(n)) : null);
  }

  _transformEditor(tr) {
    const { il, unity } = this;
    const trTd = unity.td.Transform;
    const box = h('div.go-tf');
    const lines = [
      ['Position', 'get_position', 'set_position'],
      ['Local position', 'get_localPosition', 'set_localPosition'],
      ['Rotation', 'get_eulerAngles', 'set_eulerAngles'],
      ['Local rotation', 'get_localEulerAngles', 'set_localEulerAngles'],
      ['Scale', 'get_localScale', 'set_localScale'],
    ];
    for (const [label, g, s] of lines) {
      const get = il.findMethod(trTd, g, 0);
      if (!get || il.whyNotCallable(get)) continue;
      const set = il.findMethod(trTd, s, 1);
      const ins = ['x', 'y', 'z'].map((ax) => {
        const inp = h('input.ue-in', { spellcheck: false });
        if (!set) inp.readOnly = true;
        return [ax, inp];
      });
      const shown = {}; // the text each input got from the last read
      const read = (force) => {
        let v;
        try { v = il.call(get, tr); } catch (_) { return; }
        for (const [ax, inp] of ins) {
          if (!force && (document.activeElement === inp || this.app.shadowActive() === inp)) continue;
          inp.value = shown[ax] = fmtNumber(v[ax], T.R4);
        }
      };
      // only the axes the user edited change; the others keep their full precision
      const write = () => {
        let v;
        try { v = il.call(get, tr); } catch (e) { this._err(e); return; }
        let changed = false;
        for (const [ax, inp] of ins) {
          if (inp.value === shown[ax]) continue;
          const x = Number(String(inp.value).trim().replace(',', '.'));
          if (String(inp.value).trim() === '' || !Number.isFinite(x)) { this.app.ui.notify(`${label} ${ax.toUpperCase()}: "${inp.value}" isn't a number`, 'error'); read(true); return; }
          v[ax] = x;
          changed = true;
        }
        if (changed) { try { il.call(set, tr, { x: v.x, y: v.y, z: v.z }); } catch (e) { this._err(e); } }
        read(true);
      };
      if (set) {
        for (const [, inp] of ins) {
          inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { write(); inp.blur(); } else if (e.key === 'Escape') { read(true); inp.blur(); } });
          // after Enter the inputs already show the written value, so the blur's change event finds nothing to write
          inp.addEventListener('change', write);
        }
      }
      read();
      this.updaters.push(read);
      box.append(h('div.ln', h('span', label), ...ins.map(([ax, inp]) => h('div.ax.' + ax, h('i', ax.toUpperCase()), inp))));
    }
    return box.childElementCount ? box : h('div');
  }

  _destroy(obj) {
    this.app.ui.confirm('Destroy this object? This calls Object.Destroy in the game.', { title: 'Destroy' }).then((ok) => {
      if (!ok) return;
      try { this.unity.destroy(obj); this.app.ui.notify('Destroyed', 'success'); setTimeout(() => { this.o.onChange && this.o.onChange(); this.render(); }, 50); } catch (e) { this._err(e); }
    });
  }

  _err(e) {
    console.error('[UnityExplorer]', e);
    this.app.ui.notify(String(e.message || e), 'error', 4000);
  }

  // ------------------------------------------------------------------ objects

  _renderObj(t) {
    const { il, unity, fmt } = this;
    const obj = t.ptr;
    const k = il.klassOf(obj);
    const td = il.tdOfKlass(k);
    const d = td >= 0 ? il.md.typeDef(td) : null;
    const isValue = d && d.isValueType;
    const bt = il.typeInfo(k + il.layout.byval);
    const isArray = bt.kind === T.SZARRAY || bt.kind === T.ARRAY;
    const isUnity = unity.isUnityObject(obj);
    const chips = [this._addrChip(obj)];
    if (td >= 0) chips.push(this._typeChip(td, 'Static members'));
    const asm = td >= 0 ? il.md.images[il.md.imageOfType[td]] : null;
    if (asm) chips.push(h('span.chip', icon(I.lib, 'i'), asm.name.replace(/\.dll$/, '')));
    if (isValue) chips.push(h('span.chip.amber', 'Boxed value'));
    const actions = [];
    if (isUnity) {
      const go = il.isInstanceOf(obj, unity.td.Component) ? unity.gameObjectOf(obj) : (il.tdOfKlass(k) === unity.td.GameObject ? obj : 0);
      if (go && go !== obj) actions.push(h('button.ue-btn', { title: 'Show its GameObject', on: { click: () => this.o.onSelectGameObject ? this.o.onSelectGameObject(go) : this.show({ kind: 'go', go }) } }, icon(I.cube, 'i'), 'GameObject'));
      if (go === obj) actions.push(h('button.ue-btn', { title: 'GameObject view', on: { click: () => this.show({ kind: 'go', go }) } }, icon(I.cube, 'i'), 'Scene view'));
      actions.push(h('button.ue-btn.danger', { title: 'Destroy', on: { click: () => this._destroy(obj) } }, icon(I.trash, 'i')));
    }
    let title = il.klassName(k, false);
    if (isUnity) { const n = unity.name(obj); if (n != null) title = n; }
    else if (isArray || fmt.collectionCount(obj) != null) title = fmt.objectSummary(obj);
    else if (il.isString(obj)) title = JSON.stringify(il.readString(obj)).slice(0, 120);
    this._head({ ico: isArray ? I.enum : isValue ? I.struct : I.klass, title: h('h2', { text: title, title }), sub: il.klassName(k, true), chips, actions });

    const elems = fmt.elements(obj, 1);
    const fieldsAll = this._objFieldGroups(obj, k);
    const nFields = fieldsAll.reduce((a, g) => a + g.rows.length, 0);
    const props = this._propGroups(td, false);
    const nProps = props.reduce((a, g) => a + g.props.length, 0);
    const meths = this._methodGroups(td, false);
    const nMeth = meths.reduce((a, g) => a + g.methods.length, 0);
    const defs = [];
    if (elems) defs.push(['elements', 'Elements', elems.total]);
    defs.push(['fields', 'Fields', nFields], ['props', 'Properties', nProps], ['methods', 'Methods', nMeth]);
    if (elems && !t._seen) { this.tab = 'elements'; t._seen = true; }
    this._tabs(defs);
    this.body.replaceChildren();
    const self = isValue ? obj + 8 : obj;
    if (this.tab === 'elements' && elems) this._renderElements(obj);
    else if (this.tab === 'fields') this._renderFieldGroups(fieldsAll, isValue);
    else if (this.tab === 'props') this._renderProps(props, self, false);
    else if (this.tab === 'methods') this._renderMethods(meths, self, false);
    this._applyFilter();
  }

  /** Field groups for an object: one per class in its hierarchy (most derived first). */
  _objFieldGroups(obj, k) {
    const il = this.il;
    const groups = [];
    for (let c = k, g = 0; c && g < 32; c = il.parentKlass(c), g++) {
      const fields = il.runtimeFields(c);
      if (!fields.length) continue;
      const rows = [];
      const sbase = il.staticFieldsBase(c);
      for (const f of fields) {
        if (f.isConst) { rows.push({ f, kind: 'const' }); continue; }
        if (f.isStatic) {
          if (f.offset === -1) continue; // thread static
          rows.push({ f, kind: 'static', addr: sbase ? sbase + f.offset : 0 });
          continue;
        }
        rows.push({ f, kind: 'inst', addr: obj + f.offset });
      }
      const td = il.tdOfKlass(c);
      groups.push({ title: il.klassName(c, false), td, rows, dim: this._isEngine(td) });
    }
    return groups;
  }

  _isEngine(td) {
    if (td < 0) return false;
    const ns = this.il.md.typeDef(td).namespace;
    return /^(System|UnityEngine|Unity|TMPro)(\.|$)/.test(ns);
  }

  _renderFieldGroups(groups, isValue) {
    if (!groups.length) { this.body.append(h('div.ue-empty', 'No fields.')); return; }
    for (const g of groups) {
      const rows = h('div.mrows');
      for (const r of g.rows) rows.append(...this._fieldRow(r, 0));
      this.body.append(this._group(g.title, g.rows.length, rows, g.td));
    }
    void isValue;
  }

  _group(title, n, rows, td, closed = false) {
    const wrap = h('div.mgroup');
    const hd = h('div.mgroup-h', { html: I.chevD }, title, h('span.n', String(n)));
    if (td != null && td >= 0) {
      const lnk = h('span.mini-ib', { title: 'Static members of ' + title, html: I.klass, style: { marginLeft: '2px' } });
      lnk.onclick = (e) => { e.stopPropagation(); this.show({ kind: 'static', td }); };
      hd.append(lnk);
    }
    hd.onclick = () => wrap.classList.toggle('closed');
    if (closed) wrap.classList.add('closed');
    wrap.append(hd, rows);
    return wrap;
  }

  _fieldRow(r, depth) {
    const { il } = this;
    const f = r.f;
    const acc = ACCESS_NAME[f.attrs & FIELD.ACCESS] || '';
    const ico = r.kind === 'const' ? icon(I.bolt, 'ico c') : icon(I.field, 'ico f');
    const nm = h('div.nm', { title: `${acc} ${r.kind === 'static' ? 'static ' : ''}${r.kind === 'const' ? 'const ' : ''}${il.typeName(f.type, true)} ${f.name}` }, f.name);
    const ty = this._typeLabel(f.type, r.kind === 'static' ? 'static' : r.kind === 'const' ? 'const' : '');
    const val = h('div.val');
    const row = h('div.mrow' + (depth ? '.sub' + Math.min(depth, 3) : ''), { 'data-name': f.name }, ico, nm, ty, val);
    const out = [row];
    if (r.kind === 'const') {
      let v = null;
      try { v = il.constValue(f.metaIndex); } catch (_) { /* ignore */ }
      const tt = il.typeInfo(f.type);
      let text = v == null ? 'null' : typeof v === 'string' && tt.kind === T.STRING ? JSON.stringify(v) : String(v);
      if (tt.kind === T.VALUETYPE) { const etd = il._tdFromData(tt.data); if (il.md.typeDef(etd).isEnum) { let en = null; try { en = il.enumName(etd, v); } catch (_) { /* not a member */ } text = `${en || f.name} (${v})`; } }
      val.append(h('span.v-txt.v-num', { text, title: text }));
      return out;
    }
    if (r.kind === 'static' && !r.addr) {
      val.append(h('span.v-dim', 'class not initialized'));
      return out;
    }
    const sub = h('div');
    out.push(sub);
    this._valueCell(val, {
      type: f.type,
      read: () => this.fmt.describe(f.type, r.addr),
      write: (v) => il.writeValue(r.addr, f.type, v),
      sub,
      depth,
    });
    return out;
  }

  _typeLabel(p, mod = '') {
    const il = this.il;
    const name = il.typeName(p, false);
    const td = il.tdOfType(p);
    const ty = h('div.ty', { title: (mod ? mod + ' ' : '') + il.typeName(p, true) }, mod ? h('span.mod', mod + ' ') : null, name);
    if (td >= 0) {
      ty.classList.add('link');
      ty.onclick = () => this.show({ kind: 'static', td });
    }
    return ty;
  }

  /**
   * A value cell: shows the value, lets the user edit it, expands structs/collections.
   * spec: { type, read() -> desc, write?(value), sub (container for expansions), depth, readonly }
   */
  _valueCell(cell, spec) {
    const { il, fmt } = this;
    let desc = null;
    let input = null;
    let lastText = null;
    let expanded = false; // the expander's state survives rebuilds
    const writable = !!spec.write && !spec.readonly;
    const showErr = (e) => { input = null; lastText = null; cell.replaceChildren(h('span.v-err', { text: e.message || String(e), title: e.message })); };

    const commit = (text) => {
      try {
        const v = fmt.parse(spec.type, text);
        spec.write(v);
        if (input) input.classList.remove('bad', 'dirty');
        refresh(true);
      } catch (e) {
        if (input) input.classList.add('bad');
        this._err(e);
      }
    };

    const build = () => {
      cell.replaceChildren();
      input = null;
      const k = desc.kind;
      if (k === 'bool') {
        const sw = h('button.ue-sw');
        sw.classList.toggle('on', !!desc.raw);
        if (writable) sw.onclick = () => commit(sw.classList.contains('on') ? 'false' : 'true');
        else sw.disabled = true;
        cell.append(sw, h('span.v-txt.v-num', desc.text));
        return;
      }
      if (k === 'enum' && writable) {
        const members = il.enumMembers(desc.enumTd);
        if (members.length && members.length <= 80 && il.enumName(desc.enumTd, desc.raw) && !il.enumName(desc.enumTd, desc.raw).includes('|')) {
          const sel = h('select.ue-in');
          for (const [n, v] of members) sel.append(h('option', { value: String(v), text: `${n} (${v})` }));
          sel.value = String(desc.raw);
          sel.onchange = () => commit(sel.value);
          input = sel;
          cell.append(sel);
          return;
        }
      }
      if (!writable && (k === 'number' || k === 'char' || k === 'enum' || k === 'string')) {
        const txt = k === 'string' ? JSON.stringify(desc.text) : desc.text;
        cell.append(h('span.v-txt' + (k === 'string' ? '.v-str' : '.v-num'), { text: txt, title: txt }));
      } else if (k === 'number' || k === 'char' || k === 'enum' || k === 'string' || (k === 'null' && desc.refKind === T.STRING) || (k === 'struct' && writable && this._flatStruct(spec.type))) {
        input = h('input.ue-in', { spellcheck: false });
        input.value = k === 'null' ? 'null' : k === 'struct' ? desc.text.replace(/^\(|\)$/g, '') : desc.text;
        if (k === 'string') input.classList.add('v-str');
        if (k === 'null') input.classList.add('v-nullin');
        if (!writable) input.readOnly = true;
        input.addEventListener('input', () => input.classList.add('dirty'));
        input.addEventListener('keydown', (e) => {
          // dirty goes first so the blur that follows doesn't commit the same text again
          if (e.key === 'Enter') { const el = input; el.classList.remove('dirty'); commit(el.value); el.blur(); }
          if (e.key === 'Escape') { input.classList.remove('dirty', 'bad'); refresh(true); input.blur(); }
        });
        input.addEventListener('blur', () => { if (input && input.classList.contains('dirty')) commit(input.value); });
        cell.append(input);
        if (k === 'string' && desc.ref) cell.append(h('button.mini-ib', { title: 'Inspect string object', html: I.link, on: { click: () => this.show({ kind: 'obj', ptr: desc.ref }) } }));
      } else if (k === 'object') {
        cell.append(h('span.v-ref', { text: desc.text, title: desc.text + ' @ ' + hexAddr(desc.ref), on: { click: () => this._openRef(desc.ref) } }));
      } else if (k === 'null') {
        cell.append(h('span.v-null', 'null'));
      } else if (k === 'struct') {
        cell.append(h('span.v-txt', { text: desc.text, title: desc.text }));
      } else if (k === 'bad') {
        cell.append(h('span.v-err', desc.text));
      } else {
        cell.append(h('span.v-dim', desc.text));
      }
      if (writable && (desc.isRef && desc.refKind !== T.STRING)) {
        cell.append(h('button.mini-ib', { title: 'Set reference (null or @address)', html: I.edit, on: { click: () => this._editRef(cell, commit, desc, () => build()) } }));
      }
      // expanders
      const canExpand = (k === 'struct' && (desc.addr || desc.raw)) || (k === 'object' && fmt.elements(desc.ref, 0) != null);
      if (canExpand && spec.sub && (spec.depth || 0) < 4) {
        const ex = h('span.v-exp', { html: I.chevR, title: 'Expand' });
        const toggle = (open) => {
          expanded = open;
          ex.classList.toggle('open', open);
          spec.sub.replaceChildren();
          if (open) this._expand(spec.sub, spec.type, desc, (spec.depth || 0) + 1, spec);
        };
        ex.onclick = () => toggle(!expanded);
        cell.prepend(ex);
        // rebuilt while open: struct rows read live from memory and stay; anything else is re-expanded
        if (expanded) {
          if (k === 'struct' && desc.addr && spec.sub.childElementCount) ex.classList.add('open');
          else toggle(true);
        }
      } else if (expanded && spec.sub) { expanded = false; spec.sub.replaceChildren(); }
    };

    const refresh = (force) => {
      let d;
      try { d = spec.read(); } catch (e) { showErr(e); return; }
      const sig = d.kind + '|' + d.text + '|' + (d.ref || 0);
      if (!force && sig === lastText) return;
      const focused = input && (this.app.shadowActive() === input);
      if (focused && !force) return;
      lastText = sig;
      const same = desc && d.kind === desc.kind && input && !focused;
      desc = d;
      if (same && input.tagName === 'INPUT' && (d.kind === 'number' || d.kind === 'string' || d.kind === 'char' || d.kind === 'enum' || d.kind === 'struct')) {
        input.value = d.kind === 'struct' ? d.text.replace(/^\(|\)$/g, '') : d.text;
        return;
      }
      if (same && input.tagName === 'SELECT') { input.value = String(d.raw); return; }
      build();
    };
    try {
      desc = spec.read();
      lastText = desc.kind + '|' + desc.text + '|' + (desc.ref || 0);
      build();
    } catch (e) { showErr(e); } // a value that can't be read yet is retried by the live update
    if (!spec.noLive) {
      const u = () => refresh(false);
      u.cell = cell;
      this.updaters.push(u);
    }
  }

  _flatStruct(p) {
    const il = this.il;
    const fs = il.fieldsOfStructType(p);
    if (!fs || !fs.length || fs.length > 4) return false;
    // chars aren't in the struct summary text, so a struct with one can't round-trip as flat text
    return fs.every((f) => { const k = il.typeInfo(f.type).kind; return k !== T.CHAR && ((k >= T.BOOLEAN && k <= T.R8) || k === T.I || k === T.U); });
  }

  /** Inline editor for a reference. Enter writes; Escape (or leaving it) cancels and writes nothing. */
  _editRef(cell, commit, desc, cancel) {
    const inp = h('input.ue-in', { placeholder: 'null or @0x…', value: desc.ref ? '@' + hexAddr(desc.ref) : desc.kind === 'null' ? 'null' : '' });
    cell.replaceChildren(inp);
    inp.focus();
    inp.select();
    let done = false;
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { done = true; commit(inp.value); }
      else if (e.key === 'Escape') { done = true; cancel(); }
    });
    inp.addEventListener('blur', () => { if (!done) { done = true; cancel(); } });
  }

  _openRef(ptr) {
    const { il, unity } = this;
    if (unity.td.GameObject >= 0 && il.tdOfKlass(il.klassOf(ptr)) === unity.td.GameObject) {
      if (this.o.onSelectGameObject) return this.o.onSelectGameObject(ptr);
      return this.show({ kind: 'go', go: ptr });
    }
    this.show({ kind: 'obj', ptr });
  }

  _expand(container, type, desc, depth, parentSpec) {
    const { il, fmt } = this;
    if (desc.kind === 'struct') {
      const fs = il.fieldsOfStructType(desc.structType || type) || [];
      for (const f of fs) {
        const val = h('div.val');
        const sub = h('div');
        const row = h('div.mrow.sub' + Math.min(depth, 3), { 'data-name': f.name }, icon(I.field, 'ico f'), h('div.nm', f.name), this._typeLabel(f.type), val);
        container.append(row, sub);
        if (desc.addr) {
          this._valueCell(val, { type: f.type, read: () => fmt.describe(f.type, desc.addr + f.offset), write: parentSpec.write ? (v) => il.writeValue(desc.addr + f.offset, f.type, v) : null, sub, depth });
        } else {
          const v = desc.raw ? desc.raw[f.name] : undefined;
          this._valueCell(val, { type: f.type, read: () => fmt.describe(f.type, null, typeof v === 'object' && v !== null && !(typeof v === 'bigint') ? v : v), sub, depth, readonly: true, noLive: true });
        }
      }
      return;
    }
    const el = fmt.elements(desc.ref, 100);
    if (!el) return;
    for (const it of el.items) {
      const val = h('div.val');
      const sub = h('div');
      container.append(h('div.mrow.sub' + Math.min(depth, 3), { 'data-name': it.label }, icon(I.field, 'ico'), h('div.nm.ue-mono', it.label), this._typeLabel(it.type), val), sub);
      this._valueCell(val, { type: it.type, read: () => fmt.describe(it.type, it.addr), write: (v) => il.writeValue(it.addr, it.type, v), sub, depth });
    }
    if (el.total > el.items.length) container.append(h('div.mrow.sub' + Math.min(depth, 3), h('span'), h('div.v-dim', `… ${el.total - el.items.length} more (open the object to see all)`)));
  }

  _renderElements(obj) {
    const { il, fmt } = this;
    const page = 300;
    let start = 0;
    const box = h('div.mrows');
    const more = h('button.ue-btn', { style: { margin: '10px 14px' } }, 'Show more');
    const add = () => {
      const el = fmt.elements(obj, page, start);
      if (!el) return;
      for (const it of el.items) {
        const val = h('div.val');
        const sub = h('div');
        box.append(h('div.mrow', { 'data-name': it.label }, icon(I.field, 'ico'), h('div.nm.ue-mono', it.label), this._typeLabel(it.type), val), sub);
        this._valueCell(val, { type: it.type, read: () => fmt.describe(it.type, it.addr), write: (v) => il.writeValue(it.addr, it.type, v), sub, depth: 0 });
      }
      start += el.items.length;
      more.style.display = start < el.total ? '' : 'none';
      more.textContent = `Show more (${el.total - start} left)`;
    };
    more.onclick = add;
    this.body.append(box, more);
    add();
    if (!start) this.body.append(h('div.ue-empty', 'Empty.'));
  }

  // ------------------------------------------------------------------ properties

  _propGroups(td, statics) {
    const il = this.il;
    const groups = [];
    for (const t of il.hierarchy(td)) {
      const props = il.propertiesOf(t).filter((p) => {
        const acc = p.getter || p.setter;
        if (!acc) return false;
        const st = (acc.flags & METHOD.STATIC) !== 0;
        if (statics !== st) return false;
        if ((p.getter && p.getter.parameterCount > 0) || (!p.getter && p.setter.parameterCount > 1)) return false; // indexers
        return true;
      });
      if (props.length) groups.push({ td: t, title: il.tdShortName(t), props });
      if (statics) break;
    }
    return groups;
  }

  _autoEval(td) {
    if (this.app.settings.autoProps === 'all') return true;
    if (this.app.settings.autoProps === 'none') return false;
    return this._isEngine(td);
  }

  _renderProps(groups, self, statics) {
    const il = this.il;
    if (!groups.length) { this.body.append(h('div.ue-empty', 'No properties.')); return; }
    for (const g of groups) {
      const rows = h('div.mrows');
      const auto = this._autoEval(g.td);
      for (const p of g.props) {
        // a setter's value is its last parameter
        const type = p.getter ? il.typePtr(p.getter.returnType) : il.params(p.setter).at(-1).type;
        const val = h('div.val');
        const sub = h('div');
        const getterOk = p.getter && !il.whyNotCallable(p.getter);
        const setterOk = p.setter && !il.whyNotCallable(p.setter);
        const nm = h('div.nm', { title: `${p.getter ? 'get; ' : ''}${p.setter ? 'set;' : ''}` }, p.name);
        rows.append(h('div.mrow', { 'data-name': p.name }, icon(I.prop, 'ico p'), nm, this._typeLabel(type, statics ? 'static' : ''), val), sub);
        const spec = {
          type,
          read: () => {
            const r = il.invoke(p.getter, self, []);
            return this.fmt.describe(type, null, r.value);
          },
          write: setterOk ? (v) => il.invoke(p.setter, self, [v]) : null,
          sub,
          depth: 0,
        };
        if (!getterOk) {
          val.append(h('span.v-dim', p.getter ? `getter ${il.whyNotCallable(p.getter)}` : 'write-only'));
          continue;
        }
        if (auto) this._valueCell(val, spec);
        else {
          const btn = h('button.ue-btn.call', icon(I.play, 'i'), 'Get');
          btn.onclick = () => { val.replaceChildren(); this._valueCell(val, spec); };
          val.append(btn);
        }
      }
      this.body.append(this._group(g.title, g.props.length, rows, g.td, !statics && this._isEngine(g.td) && groups.length > 1 && g !== groups[0] && g.props.length > 12));
    }
  }

  // ------------------------------------------------------------------ methods

  _methodGroups(td, statics) {
    const il = this.il;
    const groups = [];
    if (td < 0) return groups;
    for (const t of il.hierarchy(td)) {
      const ms = il.methodsOf(t).filter((m) => {
        const st = (m.flags & METHOD.STATIC) !== 0;
        // constructors are listed with the statics (as "New"), for types that can be created
        if (statics && m.name === '.ctor' && !st) { const d = il.md.typeDef(t); return t === td && !d.isAbstract && !d.isInterface; }
        if (statics !== st) return false;
        if (m.name === '.cctor') return false;
        if (!statics && m.name === '.ctor') return false;
        if ((m.flags & METHOD.SPECIAL) && SPECIAL.test(m.name) && !this.app.settings.showAccessors) return false;
        return true;
      });
      if (ms.length) groups.push({ td: t, title: il.tdShortName(t), methods: ms });
      if (statics) break;
      if (il.md.typeDef(t).namespace === 'System' && il.md.typeDef(t).name === 'Object') break;
    }
    return groups;
  }

  _sig(m) {
    const il = this.il;
    const ps = il.params(m);
    const ret = il.typeName(il.typePtr(m.returnType));
    const acc = ACCESS_NAME[m.flags & METHOD.ACCESS] || '';
    return `<span class="kw">${esc(acc)}${m.flags & METHOD.STATIC ? ' static' : ''}${m.flags & METHOD.VIRTUAL ? ' virtual' : ''}</span> <span class="t">${esc(ret)}</span> <span class="n">${esc(m.name)}</span>(` +
      ps.map((p) => `<span class="t">${esc(il.typeName(p.type))}</span> <span class="pn">${esc(p.name)}</span>`).join(', ') + ')';
  }

  _renderMethods(groups, self, statics) {
    const il = this.il;
    if (!groups.length) { this.body.append(h('div.ue-empty', 'No methods.')); return; }
    groups.forEach((g, gi) => {
      const rows = h('div.mrows');
      for (const m of g.methods) {
        const why = il.whyNotCallable(m);
        const sig = h('div.msig', { html: this._sig(m), title: why ? `Can't call: ${why}` : '' });
        const callBtn = h('button.ue-btn.call', { disabled: !!why, title: why ? `Can't call: ${why}` : 'Call' }, icon(I.play, 'i'), m.name === '.ctor' ? 'New' : 'Call');
        const form = h('div');
        const row = h('div.mrow', { 'data-name': m.name }, icon(I.method, 'ico m'), sig, h('div.mcall', callBtn));
        row.style.gridTemplateColumns = '18px minmax(0, 1fr) minmax(0, 1fr) auto';
        callBtn.onclick = () => {
          if (form.firstChild) { form.replaceChildren(); return; }
          form.replaceChildren(this._callForm(m, self));
          const first = form.querySelector('input');
          if (first) first.focus();
        };
        rows.append(row, form);
      }
      this.body.append(this._group(g.title, g.methods.length, rows, g.td, !statics && gi > 0 && this._isEngine(g.td)));
    });
  }

  _callForm(m, self) {
    const il = this.il;
    const ps = il.params(m);
    const inputs = ps.map((p) => {
      const t = il.typeInfo(p.type);
      const ph = this._placeholder(p.type);
      const inp = h('input.ue-in', { placeholder: ph, spellcheck: false });
      if (t.kind === T.BOOLEAN) inp.value = 'false';
      return [p, inp];
    });
    const res = h('div.mres');
    const run = () => {
      try {
        const vals = inputs.map(([p, inp]) => {
          const t = il.typeInfo(p.type);
          if (t.byref && !inp.value.trim()) return null; // out param
          return this.fmt.parse(p.type, inp.value);
        });
        if (m.name === '.ctor') return this._construct(m, vals, res);
        const t0 = performance.now();
        const r = il.invoke(m, self, vals);
        const ms = (performance.now() - t0).toFixed(1);
        res.replaceChildren(h('span.lbl', `→ ${ms} ms`));
        const retType = il.typePtr(m.returnType);
        if (il.typeInfo(retType).kind === T.VOID) res.append(h('span.v-dim', 'void'));
        else {
          const cell = h('div.val', { style: { flex: 1, minWidth: 0 } });
          res.append(cell);
          this._valueCell(cell, { type: retType, read: () => this.fmt.describe(retType, null, r.value), readonly: true, noLive: true });
        }
        for (const o of r.outs) {
          const cell = h('div.val');
          res.append(h('span.lbl', o.name + ' ='), cell);
          this._valueCell(cell, { type: o.type, read: () => this.fmt.describe(o.type, null, o.value), readonly: true, noLive: true });
        }
      } catch (e) {
        res.replaceChildren(h('span.v-err', { text: String(e.message || e) }));
      }
    };
    for (const [, inp] of inputs) inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
    return h('div.mform',
      ...inputs.map(([p, inp]) => h('div.pr', h('label', { title: il.typeName(p.type, true) }, p.name, h('small', il.typeName(p.type))), inp)),
      h('div.go', h('button.ue-btn.pri', { on: { click: run } }, icon(I.play, 'i'), m.name === '.ctor' ? 'Create' : 'Invoke'), res));
  }

  _placeholder(p) {
    const il = this.il;
    const t = il.typeInfo(p);
    if (t.byref) return 'out/ref: leave empty or enter a value';
    switch (t.kind) {
      case T.BOOLEAN: return 'true / false';
      case T.STRING: return 'text (or null)';
      case T.R4: case T.R8: return '0.0';
      case T.CHAR: return 'a';
      case T.VALUETYPE: {
        const td = il._tdFromData(t.data);
        if (il.md.typeDef(td).isEnum) return il.enumMembers(td).slice(0, 4).map((x) => x[0]).join(' | ') + '…';
        const fs = il.structFields(td);
        return fs.length <= 6 ? fs.map((f) => f.name).join(', ') : '@0x… (address)';
      }
      default:
        if ((t.kind >= T.I1 && t.kind <= T.U8) || t.kind === T.I || t.kind === T.U) return '0';
        if (il.typeName(p, true) === 'System.Type') return 'Type name, e.g. UnityEngine.Camera';
        return 'null or @0x… (copy an address from the inspector)';
    }
  }

  _construct(m, vals, res) {
    // new T(...) = allocate via Activator.CreateInstance(Type) for the object, then call the ctor
    const il = this.il;
    const td = m.declaringType;
    const act = il.findMethod('System.Activator', 'CreateInstance', ['System.Type']);
    if (!act) throw new Error('Activator.CreateInstance(Type) is not available in this build');
    const obj = il.call(act, 0, il.typeObjectOfTd(td));
    if (m.parameterCount) il.invoke(m, il.md.typeDef(td).isValueType ? obj + 8 : obj, vals);
    res.replaceChildren(h('span.lbl', '→'), h('span.v-ref', { text: this.fmt.objectSummary(obj), on: { click: () => this.show({ kind: 'obj', ptr: obj }) } }));
  }

  // ------------------------------------------------------------------ static view

  _renderStatic(t) {
    const { il, unity } = this;
    const td = t.td;
    const d = il.md.typeDef(td);
    const k = il.klassOfTd(td);
    const kind = d.isEnum ? 'enum' : d.isInterface ? 'interface' : d.isValueType ? 'struct' : 'class';
    const chips = [h('span.chip.red', kind)];
    const asm = il.md.images[il.md.imageOfType[td]];
    if (asm) chips.push(h('span.chip', icon(I.lib, 'i'), asm.name.replace(/\.dll$/, '')));
    const ptd = il.parentTd(td);
    if (ptd >= 0) chips.push(h('span.chip.click', { on: { click: () => this.show({ kind: 'static', td: ptd }) } }, 'base: ', il.tdShortName(ptd)));
    if (d.declaringTypeIndex >= 0) { const dt = il.tdOfTypeIndex(d.declaringTypeIndex); if (dt >= 0) chips.push(h('span.chip.click', { on: { click: () => this.show({ kind: 'static', td: dt }) } }, 'in: ', il.tdShortName(dt))); }
    if (!d.isGeneric) { const ready = k && (il.staticFieldsBase(k) || !this._hasStatics(td)); chips.push(h('span.chip' + (ready ? '' : '.amber'), k ? (ready ? 'loaded' : 'statics not initialized') : 'not loaded')); }
    if (k) chips.push(this._addrChip(k));

    const actions = [];
    const isUnityType = unity.td.Object >= 0 && il.isSubclassOf(td, unity.td.Object);
    if (!d.isInterface && !d.isGeneric && !d.isAbstract || isUnityType) {
      actions.push(h('button.ue-btn', { title: 'Search the game for objects of this type', on: { click: () => this._findInstances(td, isUnityType) } }, icon(I.search, 'i'), 'Instances'));
    }
    if (!d.isGeneric && this._hasStatics(td)) {
      actions.push(h('button.ue-btn', { title: 'Load the class and run its static constructor', on: { click: () => { try { il.ensureClass(td, true); this.render(); } catch (e) { this._err(e); } } } }, icon(I.bolt, 'i'), 'Init'));
    }
    this._head({ ico: d.isEnum ? I.enum : d.isInterface ? I.iface : d.isValueType ? I.struct : I.klass, title: h('h2', { text: il.tdShortName(td) }), sub: il.tdFullName(td), chips, actions });

    const fields = il.fieldsOf(td).filter((f) => (f.attrs & FIELD.STATIC) || (f.attrs & FIELD.LITERAL));
    const props = this._propGroups(td, true);
    const meths = this._methodGroups(td, true);
    const nProps = props.reduce((a, g) => a + g.props.length, 0);
    const nMeth = meths.reduce((a, g) => a + g.methods.length, 0);
    const nested = [];
    for (let i = 0; i < d.nestedCount; i++) nested.push(il.md.nestedType(d.nestedTypesStart + i));
    const defs = [['fields', 'Static fields', fields.length], ['props', 'Properties', nProps], ['methods', 'Methods', nMeth]];
    if (nested.length) defs.push(['nested', 'Nested types', nested.length]);
    defs.push(['members', 'Layout', null]);
    this._tabs(defs);
    this.body.replaceChildren();
    if (d.isGeneric && this.tab !== 'members' && this.tab !== 'nested') this.body.append(h('div.ue-note', { html: 'This is a generic type definition. Static values live on each instantiation (e.g. <code>List&lt;int&gt;</code>) and are not shown here.' }));

    if (this.tab === 'fields') {
      const sbase = k ? il.staticFieldsBase(k) : 0;
      const rows = h('div.mrows');
      for (const f of fields) {
        const isConst = (f.attrs & FIELD.LITERAL) !== 0;
        const off = isConst ? 0 : il.metaFieldOffset(td, f.local);
        const rf = { name: f.name, type: f.type, attrs: f.attrs, metaIndex: f.index };
        if (isConst) rows.append(...this._fieldRow({ f: rf, kind: 'const' }, 0));
        else if (off === -1) continue;
        else rows.append(...this._fieldRow({ f: rf, kind: 'static', addr: sbase && !d.isGeneric ? sbase + off : 0 }, 0));
      }
      if (!fields.length) this.body.append(h('div.ue-empty', 'No static fields.'));
      else this.body.append(this._group(il.tdShortName(td), fields.length, rows, null));
    } else if (this.tab === 'props') this._renderProps(props, 0, true);
    else if (this.tab === 'methods') this._renderMethods(meths, 0, true);
    else if (this.tab === 'nested') {
      const rows = h('div.mrows');
      for (const n of nested) rows.append(h('div.mrow', { 'data-name': il.md.typeDef(n).name }, icon(I.klass, 'ico'), h('div.nm.v-ref', { text: il.tdShortName(n), on: { click: () => this.show({ kind: 'static', td: n }) } }), h('div.ty', il.md.typeDef(n).isValueType ? 'struct' : 'class'), h('div')));
      this.body.append(this._group('Nested', nested.length, rows, null));
    } else if (this.tab === 'members') {
      // declared instance members, without values
      const rows = h('div.mrows');
      for (const f of il.fieldsOf(td).filter((x) => !(x.attrs & FIELD.STATIC) && !(x.attrs & FIELD.LITERAL))) {
        const off = il.metaFieldOffset(td, f.local);
        rows.append(h('div.mrow', { 'data-name': f.name }, icon(I.field, 'ico f'), h('div.nm', f.name), this._typeLabel(f.type), h('div.v-dim.ue-mono', off >= 0 ? '+0x' + off.toString(16) : '')));
      }
      for (const p of il.propertiesOf(td).filter((x) => { const a = x.getter || x.setter; return a && !(a.flags & METHOD.STATIC); })) rows.append(h('div.mrow', { 'data-name': p.name }, icon(I.prop, 'ico p'), h('div.nm', p.name), p.getter ? this._typeLabel(il.typePtr(p.getter.returnType)) : h('div'), h('div.v-dim', (p.getter ? 'get; ' : '') + (p.setter ? 'set;' : ''))));
      for (const m of il.methodsOf(td).filter((x) => !(x.flags & METHOD.STATIC) && !(x.flags & METHOD.SPECIAL))) {
        rows.append(h('div.mrow', { 'data-name': m.name, style: { gridTemplateColumns: '18px 1fr' } }, icon(I.method, 'ico m'), h('div.msig', { html: this._sig(m), style: { gridColumn: 'auto' } })));
      }
      this.body.append(this._group('Declared instance members', rows.childElementCount, rows, null));
    }
    this._applyFilter();
  }

  _hasStatics(td) {
    return this.il.fieldsOf(td).some((f) => (f.attrs & FIELD.STATIC) && !(f.attrs & FIELD.LITERAL));
  }

  _findInstances(td, isUnityType) {
    const { il, unity } = this;
    let list = [];
    try {
      if (isUnityType) list = unity.objectsOfType(td);
      else {
        const k = il.klassOfTd(td);
        if (!k) { this.app.ui.notify('No instances: the class has not been loaded yet', 'info'); return; }
        // the type itself and loaded subclasses
        const ks = [k];
        if (il.classTable) for (let i = 0; i < il.md.typeCount; i++) {
          if (i === td) continue;
          const ck = il.klassOfTd(i);
          if (ck && il.isSubclassOf(i, td)) ks.push(ck);
        }
        for (const ck of ks) list.push(...il.findInstances(ck, { limit: 2000 }));
      }
    } catch (e) { this._err(e); return; }
    this.o.onInstances ? this.o.onInstances(td, list) : this._instancesInline(td, list);
  }

  _instancesInline(td, list) {
    this.tab = 'members';
    this.updaters = [];
    this.tabs.querySelectorAll('.ins-tab.on').forEach((x) => x.classList.remove('on'));
    this.body.replaceChildren();
    const rows = h('div.mrows');
    for (const p of list.slice(0, 1000)) rows.append(h('div.mrow', { style: { gridTemplateColumns: '18px 1fr auto' } }, icon(I.klass, 'ico'), h('div.v-ref', { text: this.fmt.objectSummary(p), on: { click: () => this._openRef(p) } }), h('div.v-dim.ue-mono', hexAddr(p))));
    this.body.append(this._group(`Instances of ${this.il.tdShortName(td)}`, list.length, rows, null));
    if (!list.length) this.body.append(h('div.ue-empty', 'No live instances found.'));
  }
}
