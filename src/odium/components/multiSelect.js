import { el } from '../utils/dom.js';
import { openPopup } from '../utils/dismiss.js';
import { choiceList } from '../utils/choiceList.js';

export function createMultiSelect(options = [], action, o = {}) {
  const label = o.label || 'Select';
  const n = el('div', 'card dd');
  const head = el('div', 'row dd-head');
  const l = el('span', 'lbl');
  l.textContent = label;
  const cur = el('span', 'dd-cur');
  const ct = el('span');
  cur.append(ct, el('span', 'chev'));
  head.append(l, cur);
  const list = el('div', 'dd-list');
  n.append(head, list);
  const c = this._ctl(n);

  const sel = (o.selected || []).map((x) => (typeof x === 'number' ? options[x] : x));
  const summary = () => {
    const v = cl.get();
    ct.textContent = v.length ? (v.length > 2 ? `${v.length} selected` : v.join(', ')) : 'None';
  };
  const cl = choiceList(options, true, sel, 'opts', () => { summary(); c._out(action, cl.get()); });
  list.appendChild(cl.node);

  head.onclick = () => openPopup(this.ui, n);
  c.getValue = () => cl.get();
  c.setValue = (v, silent) => { cl.set(v); summary(); if (!silent) c._out(action, cl.get()); return c; };
  c.setOptions = (a) => { cl.setOptions(a); summary(); return c; };
  summary();
  return this._reg(c, label, o);
}
