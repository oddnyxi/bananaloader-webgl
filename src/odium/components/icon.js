import { el } from '../utils/dom.js';
import { fillIcon } from '../utils/icons.js';

/** Icon tile with a title and optional subtitle. glyph = emoji/char or an image URL. */
export function createIcon(glyph, text, o = {}) {
  const n = el('div', 'card left');
  const i = el('span', 'icn');
  fillIcon(i, glyph);
  const w = el('div');
  const t = el('div', 'lbl');
  t.textContent = text;
  const s = el('div', 'sublbl');
  s.textContent = o.sub || '';
  if (!o.sub) s.style.display = 'none';
  w.append(t, s);
  n.append(i, w);
  const c = this._ctl(n);

  c.setText = (x) => { t.textContent = x; return c; };
  c.setSub = (x) => { s.textContent = x; s.style.display = x ? '' : 'none'; return c; };
  c.setGlyph = (x) => { fillIcon(i, x); return c; };
  return c;
}
