import { el } from '../utils/dom.js';

export function createNumberInput(text, action, o = {}) {
  const { min = -Infinity, max = Infinity, step = 1 } = o;
  let val = o.value ?? (isFinite(min) ? min : 0);
  const dp = (String(step).split('.')[1] || '').length;

  const n = el('div', 'card row');
  const l = el('span', 'lbl');
  l.textContent = text;
  const w = el('div', 'num');
  const dec = el('button', 'mini');
  dec.textContent = '−';
  const inc = el('button', 'mini');
  inc.textContent = '+';
  const i = el('input', 'in');
  i.type = 'number';
  w.append(dec, i, inc);
  n.append(l, w);
  const c = this._ctl(n);

  const set = (v, silent) => {
    v = Math.min(max, Math.max(min, +v || 0));
    val = +v.toFixed(dp);
    i.value = val;
    if (!silent) c._out(action, val);
    return c;
  };
  dec.onclick = () => set(val - step);
  inc.onclick = () => set(val + step);
  i.onchange = () => set(i.value);
  i.value = val;

  c.getValue = () => val;
  c.setValue = set;
  return this._reg(c, text, o);
}
