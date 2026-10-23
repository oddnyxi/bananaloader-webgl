import { el } from '../utils/dom.js';

export function createMultiLineLabel(text) {
  const n = el('div', 'card text multi');
  n.textContent = text;
  const c = this._ctl(n);
  c.setText = (t) => { n.textContent = t; return c; };
  c.getText = () => n.textContent;
  return c;
}
