import { el } from '../utils/dom.js';

export function createImage(src, o = {}) {
  const n = el('img', 'img');
  n.src = src;
  n.alt = o.alt || '';
  if (o.height) {
    n.style.height = o.height + 'px';
    n.style.objectFit = o.fit || 'cover';
  }
  const c = this._ctl(n);
  c.setSrc = (s) => { n.src = s; return c; };
  return c;
}
