import { el } from '../utils/dom.js';

/** Spinning ring while active, green tick when done. */
export function createSpinner(text, active = true) {
  const n = el('div', 'card left');
  const ring = el('span', 'ring');
  const l = el('span', 'lbl');
  l.textContent = text;
  n.append(ring, l);
  const c = this._ctl(n);

  const set = (v) => { ring.className = 'ring ' + (v ? 'on' : 'ok'); return c; };
  set(active);

  c.setActive = set;
  c.setText = (t) => { l.textContent = t; return c; };
  return c;
}
