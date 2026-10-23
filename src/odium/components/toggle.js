import { el } from '../utils/dom.js';

export function createToggle(text, action, initial = false, o = {}) {
  if (initial && typeof initial === 'object') { o = initial; initial = !!o.value; }
  const n = el('div', 'card tg row');
  const l = el('span', 'lbl');
  l.textContent = text;
  n.append(l, el('span', 'sw'));
  let st = !!initial;
  const paint = () => n.classList.toggle('on', st);
  const c = this._ctl(n);

  n.onclick = () => { st = !st; paint(); c._out(action, st); };
  c.getValue = () => st;
  c.setValue = (v, silent) => { st = !!v; paint(); if (!silent) c._out(action, st); return c; };
  c.setText = (t) => { l.textContent = t; return c; };
  paint();
  return this._reg(c, text, o);
}
