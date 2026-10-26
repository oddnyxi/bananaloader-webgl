import { el } from '../utils/dom.js';

export function createNumberInput(text, action, o = {}) {
  const num = (x, d) => (x == null || x === '' || !Number.isFinite(+x) ? d : +x);
  const min = num(o.min, -Infinity), max = num(o.max, Infinity);
  const step = num(o.step, 1) || 1;
  // decimals the step needs, also for exponent forms like 1e-7
  const dp = Math.min(20, Math.max(0, -Math.floor(Math.log10(Math.abs(step) - Math.floor(Math.abs(step)) || 1)), (String(step).split('.')[1] || '').length));
  let val = num(o.value, isFinite(min) ? min : 0);

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
  val = Math.min(max, Math.max(min, val));
  i.value = val;

  c.getValue = () => val;
  c.setValue = set;
  return this._reg(c, text, o);
}
