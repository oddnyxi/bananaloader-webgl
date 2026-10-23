import { el } from '../utils/dom.js';

export function createSection(text) {
  const n = el('div', 'section');
  n.textContent = text;
  const c = this._ctl(n);
  c.setText = (t) => { n.textContent = t; return c; };
  return c;
}
