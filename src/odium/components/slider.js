import { el } from '../utils/dom.js';

export function createSlider(text, action, o = {}) {
  const { min = 0, max = 100, value = min, step = 1, suffix = '' } = o;
  const n = el('div', 'card');
  const row = el('div', 'row');
  const l = el('span', 'lbl');
  l.textContent = text;
  const v = el('span', 'val');
  row.append(l, v);

  const r = el('input');
  r.type = 'range';
  Object.assign(r, { min, max, step, value });

  const paint = () => {
    v.textContent = r.value + suffix;
    r.style.setProperty('--pct', ((r.value - min) / ((max - min) || 1)) * 100 + '%');
  };

  const c = this._ctl(n);
  r.oninput = () => { paint(); c._out(action, parseFloat(r.value)); };
  n.append(row, r);
  paint();

  c.getValue = () => parseFloat(r.value);
  c.setValue = (x, silent) => { r.value = x; paint(); if (!silent) c._out(action, parseFloat(r.value)); return c; };
  return this._reg(c, text, o);
}
