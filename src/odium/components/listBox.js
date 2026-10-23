import { el, safe } from '../utils/dom.js';
import { makeIcon } from '../utils/icons.js';

/**
 * Scrollable single/multi select list with keyboard nav, optional filter box,
 * item icons/hints and per-row context menus.
 * An item is a string, or { text, icon, value, hint }.
 */
export function createListBox(text, items = [], action, o = {}) {
  const { multi = false, height = 140, search = false } = o;

  const n = el('div', 'card');
  const row = el('div', 'row');
  const l = el('span', 'lbl');
  l.textContent = text;
  const cnt = el('span', 'val');
  row.append(l, cnt);
  n.appendChild(row);

  let q = '';
  let si = null;
  if (search) {
    si = el('input', 'in');
    si.type = 'text';
    si.placeholder = o.searchPlaceholder || 'Filter…';
    n.appendChild(si);
  }
  const box = el('div', 'lb');
  box.tabIndex = 0;
  box.style.height = height + 'px';
  n.appendChild(box);
  const c = this._ctl(n);

  const norm = (x) =>
    x && typeof x === 'object'
      ? { label: String(x.text ?? x.label ?? x.value ?? ''), icon: x.icon, hint: x.hint, value: x.value !== undefined ? x.value : x.text ?? x.label }
      : { label: String(x), value: x };

  let data = items.map(norm);
  let sel = new Set();
  let anchor = null;
  let cursor = null;
  let itemMenu = o.itemMenu || null;

  [].concat(o.selected == null ? [] : o.selected).forEach((s) => {
    const it = typeof s === 'number' ? data[s] : data.find((d) => d.value === s);
    if (it) sel.add(it);
  });
  if (!multi && sel.size > 1) sel = new Set([[...sel][0]]);

  const vis = () => data.filter((d) => !q || d.label.toLowerCase().includes(q));
  const picked = () => data.filter((d) => sel.has(d));
  const val = () => (multi ? picked().map((d) => d.value) : sel.size ? [...sel][0].value : undefined);
  const emit = (it) => c._out(action, val(), it ? data.indexOf(it) : -1);

  const draw = (reveal) => {
    const st = box.scrollTop;
    box.innerHTML = '';
    const v = vis();
    cnt.textContent = multi && sel.size ? `${sel.size}/${data.length}` : String(data.length);
    if (!v.length) {
      const e = el('div', 'lb-empty');
      e.textContent = data.length ? 'No matches' : 'No items';
      box.appendChild(e);
      return;
    }
    v.forEach((it) => {
      const r = el('div', 'lb-i' + (sel.has(it) ? ' on' : '') + (it === cursor ? ' cur' : ''));
      if (it.icon) r.appendChild(makeIcon(it.icon, 'ico'));
      const t = el('span', 'lb-t');
      t.textContent = it.label;
      r.appendChild(t);
      if (it.hint) { const h = el('span', 'lb-h'); h.textContent = it.hint; r.appendChild(h); }

      r.onclick = (e) => pick(it, e);
      r.ondblclick = () => safe(o.onActivate, it.value, data.indexOf(it));
      r.oncontextmenu = (e) => {
        if (!itemMenu) return;
        e.preventDefault();
        e.stopPropagation();
        if (!sel.has(it)) { sel = new Set([it]); anchor = cursor = it; draw(); emit(it); }
        this.ui.contextMenu(() => itemMenu(it.value, data.indexOf(it)), e.clientX, e.clientY);
      };
      box.appendChild(r);
    });
    box.scrollTop = st;
    if (reveal) {
      const cr = box.querySelector('.cur');
      if (cr && cr.scrollIntoView) cr.scrollIntoView({ block: 'nearest' });
    }
  };

  const pick = (it, e = {}) => {
    box.focus({ preventScroll: true });
    if (multi) {
      if (e.shiftKey && anchor) {
        const v = vis(), a = v.indexOf(anchor), b = v.indexOf(it);
        if (a >= 0 && b >= 0) {
          if (!(e.ctrlKey || e.metaKey)) sel = new Set();
          v.slice(Math.min(a, b), Math.max(a, b) + 1).forEach((d) => sel.add(d));
        }
      } else {
        if (sel.has(it)) sel.delete(it); else sel.add(it);
        anchor = it;
      }
    } else {
      sel = new Set([it]);
      anchor = it;
    }
    cursor = it;
    draw();
    emit(it);
  };

  box.onkeydown = (e) => {
    const v = vis();
    if (!v.length) return;
    let i = v.indexOf(cursor);
    if (e.key === 'ArrowDown') i = Math.min(v.length - 1, i + 1);
    else if (e.key === 'ArrowUp') i = Math.max(0, i < 0 ? 0 : i - 1);
    else if (e.key === 'Enter' && cursor) { safe(o.onActivate, cursor.value, data.indexOf(cursor)); return; }
    else if (e.key === ' ' && multi && cursor) { e.preventDefault(); pick(cursor); return; }
    else if ((e.key === 'a' || e.key === 'A') && (e.ctrlKey || e.metaKey) && multi) {
      e.preventDefault();
      v.forEach((d) => sel.add(d));
      draw();
      emit(cursor);
      return;
    } else return;
    e.preventDefault();
    const it = v[i < 0 ? 0 : i];
    if (multi) { cursor = it; draw(true); } else { pick(it); draw(true); }
  };
  if (si) si.oninput = () => { q = si.value.trim().toLowerCase(); draw(); };

  c.getValue = val;
  c.getSelected = () => picked().map((d) => d.value);
  c.getIndex = () => (multi ? picked().map((d) => data.indexOf(d)) : sel.size ? data.indexOf([...sel][0]) : -1);
  c.getItems = () => data.map((d) => d.value);
  c.setValue = (v, silent) => {
    sel = new Set();
    [].concat(v == null ? [] : v).forEach((x) => { const it = data.find((d) => d.value === x); if (it) sel.add(it); });
    if (!multi && sel.size > 1) sel = new Set([[...sel][0]]);
    draw();
    if (!silent) emit();
    return c;
  };
  c.addItem = (x) => { data.push(norm(x)); draw(); return c; };
  // v: number = index, otherwise matched against value or label
  c.removeItem = (v) => {
    const it = typeof v === 'number' ? data[v] : data.find((d) => d.value === v || d.label === v);
    if (it) {
      data = data.filter((d) => d !== it);
      sel.delete(it);
      if (cursor === it) cursor = null;
      if (anchor === it) anchor = null;
      draw();
    }
    return c;
  };
  c.removeSelected = () => { data = data.filter((d) => !sel.has(d)); sel = new Set(); anchor = cursor = null; draw(); return c; };
  c.setItems = (arr) => { data = arr.map(norm); sel = new Set(); anchor = cursor = null; draw(); return c; };
  c.clear = () => c.setItems([]);
  c.selectAll = () => { if (multi) { data.forEach((d) => sel.add(d)); draw(); emit(); } return c; };
  c.clearSelection = () => { sel = new Set(); draw(); emit(); return c; };
  c.setFilter = (s) => { q = String(s || '').trim().toLowerCase(); if (si) si.value = s || ''; draw(); return c; };
  c.setText = (t) => { l.textContent = t; return c; };
  c.setItemMenu = (fn) => { itemMenu = fn; return c; }; // fn(value, index) -> array | builder
  // Builder shown when right-clicking a row; builder.target = { value, index } of that row.
  c.itemCtx = () => {
    const b = this.ui.createContextMenu();
    itemMenu = (v, i) => { b.target = { value: v, index: i }; return b; };
    return b;
  };

  draw();
  return this._reg(c, text, o);
}
