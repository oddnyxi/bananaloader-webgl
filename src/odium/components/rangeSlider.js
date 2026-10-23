import { el } from '../utils/dom.js';

/** Two-handle slider. Value is [low, high]. */
export function createRangeSlider(text, action, o = {}) {
  const { min = 0, max = 100, step = 1, suffix = '' } = o;
  let lo = o.low ?? min;
  let hi = o.high ?? max;

  const n = el('div', 'card');
  const row = el('div', 'row');
  const l = el('span', 'lbl');
  l.textContent = text;
  const v = el('span', 'val');
  row.append(l, v);

  const track = el('div', 'rs');
  const fill = el('i'), t1 = el('b'), t2 = el('b');
  track.append(fill, t1, t2);
  n.append(row, track);
  const c = this._ctl(n);

  const snap = (x) => Math.min(max, Math.max(min, Math.round((x - min) / step) * step + min));
  const pct = (x) => ((x - min) / ((max - min) || 1)) * 100;
  const paint = () => {
    v.textContent = `${lo}${suffix} – ${hi}${suffix}`;
    t1.style.left = pct(lo) + '%';
    t2.style.left = pct(hi) + '%';
    fill.style.left = pct(lo) + '%';
    fill.style.width = pct(hi) - pct(lo) + '%';
  };
  const fromX = (x) => {
    const r = track.getBoundingClientRect();
    return snap(min + ((x - r.left) / (r.width || 1)) * (max - min));
  };

  let which = 0; // 0 = idle, 1 = dragging low, 2 = dragging high
  const move = (e) => {
    if (!which) return;
    const val = fromX(e.clientX);
    if (which === 1) lo = Math.min(val, hi); else hi = Math.max(val, lo);
    paint();
    c._out(action, [lo, hi]);
  };
  track.onpointerdown = (e) => {
    track.setPointerCapture(e.pointerId);
    const val = fromX(e.clientX);
    if (e.target === t1) which = 1;
    else if (e.target === t2) which = 2;
    else if (lo === hi) which = val > hi ? 2 : 1;
    else which = Math.abs(val - lo) <= Math.abs(val - hi) ? 1 : 2;
    move(e);
  };
  track.onpointermove = move;
  track.onpointerup = () => { which = 0; };
  paint();

  c.getValue = () => [lo, hi];
  c.setValue = (a, silent) => { lo = snap(a[0]); hi = snap(a[1]); paint(); if (!silent) c._out(action, [lo, hi]); return c; };
  return this._reg(c, text, o);
}
