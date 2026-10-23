import { el } from '../utils/dom.js';

export function createColorPicker(text, action, o = {}) {
  const n = el('div', 'card row');
  const l = el('span', 'lbl');
  l.textContent = text;
  const w = el('div', 'clr');
  const hex = el('span', 'val');
  const i = el('input');
  i.type = 'color';
  i.value = o.value || '#e11d2e';
  hex.textContent = i.value.toUpperCase();
  w.append(hex, i);
  n.append(l, w);
  const c = this._ctl(n);

  i.oninput = () => { hex.textContent = i.value.toUpperCase(); c._out(action, i.value); };
  c.getValue = () => i.value;
  c.setValue = (v, silent) => { i.value = v; hex.textContent = i.value.toUpperCase(); if (!silent) c._out(action, i.value); return c; };
  return this._reg(c, text, o);
}
