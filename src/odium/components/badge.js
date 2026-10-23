import { el } from '../utils/dom.js';
import { BADGE_TYPES } from '../constants.js';

/** type: red | green | amber | blue | gray (aliases: accent, error, success, warn, info). */
export function createBadge(text, type = 'red') {
  const n = el('div');
  const b = el('span', 'badge');
  n.appendChild(b);
  const c = this._ctl(n);

  const paint = () => {
    b.textContent = text;
    b.className = 'badge b-' + (BADGE_TYPES[type] || 'red');
  };
  paint();

  c.setText = (t) => { text = t; paint(); return c; };
  c.setType = (t) => { type = t; paint(); return c; };
  return c;
}
