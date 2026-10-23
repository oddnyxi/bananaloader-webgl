import { el } from '../utils/dom.js';

export function createProgressbar(text, value = 0, o = {}) {
  const n = el('div', 'card');
  const row = el('div', 'row');
  const l = el('span', 'lbl');
  l.textContent = text;
  const v = el('span', 'val');
  row.append(l, v);
  const bar = el('div', 'bar'), fill = el('i');
  bar.appendChild(fill);
  n.append(row, bar);
  const c = this._ctl(n);

  let cur = 0;
  const set = (x) => {
    cur = Math.max(0, Math.min(100, +x || 0));
    fill.style.width = cur + '%';
    v.textContent = Math.round(cur) + '%';
    return c;
  };
  set(value);

  c.getValue = () => cur;
  c.setValue = set;
  c.setText = (t) => { l.textContent = t; return c; };
  if (o.icon) c.setIcon(o.icon);
  return c;
}
