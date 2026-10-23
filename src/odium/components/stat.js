import { el } from '../utils/dom.js';

export function createStat(text, value = '', o = {}) {
  const n = el('div', 'card row');
  const l = el('span', 'lbl');
  l.textContent = text;
  const v = el('span', 'val');
  v.textContent = value;
  n.append(l, v);
  const c = this._ctl(n);

  c.getValue = () => v.textContent;
  c.setValue = (x) => { v.textContent = x; return c; };
  c.setText = (t) => { l.textContent = t; return c; };
  if (o.icon) c.setIcon(o.icon);
  return c;
}
