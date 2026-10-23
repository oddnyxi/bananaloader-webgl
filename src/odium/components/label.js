import { el } from '../utils/dom.js';

export function createLabel(text) {
  const n = el('div', 'text');
  n.textContent = text;
  const c = this._ctl(n);
  c.setText = (t) => { n.textContent = t; return c; };
  c.getText = () => n.textContent;
  return c;
}
