import { el } from '../utils/dom.js';
import { NS } from '../constants.js';

/** Tiny live line/bar chart. Feed it with c.push(value). */
export function createChart(text, o = {}) {
  const { type = 'line', points = 40, min, max, height = 64, suffix = '' } = o;
  let data = (o.data || []).slice(-points);

  const n = el('div', 'card');
  const row = el('div', 'row');
  const l = el('span', 'lbl');
  l.textContent = text;
  const v = el('span', 'val');
  row.append(l, v);

  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 200 60');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('class', 'chart');
  svg.style.height = height + 'px';
  n.append(row, svg);
  const c = this._ctl(n);

  const draw = () => {
    if (!data.length) { svg.innerHTML = ''; v.textContent = ''; return; }
    const lo = min ?? Math.min(...data);
    const hi = max ?? Math.max(...data);
    const rg = hi - lo || 1;
    const y = (d) => 56 - ((d - lo) / rg) * 50;
    const off = points - data.length;

    if (type === 'bar') {
      const w = 200 / points;
      svg.innerHTML = data
        .map((d, i) => `<rect x="${((off + i) * w + 0.5).toFixed(2)}" y="${y(d).toFixed(2)}" width="${Math.max(w - 1, 1).toFixed(2)}" height="${(60 - y(d)).toFixed(2)}" rx="1" style="fill:var(--red)"/>`)
        .join('');
    } else {
      const pts = data.map((d, i) => [((off + i) / Math.max(points - 1, 1)) * 200, y(d)]);
      const ln = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
      svg.innerHTML =
        `<path d="${ln} L${pts[pts.length - 1][0].toFixed(1)} 60 L${pts[0][0].toFixed(1)} 60 Z" style="fill:rgba(var(--rgb),.16)"/>` +
        `<path d="${ln}" style="fill:none;stroke:var(--red);stroke-width:2;vector-effect:non-scaling-stroke;stroke-linejoin:round"/>`;
    }
    v.textContent = Math.round(data[data.length - 1] * 100) / 100 + suffix;
  };
  draw();

  c.push = (x) => { data.push(+x); if (data.length > points) data.shift(); draw(); return c; };
  c.setData = (a) => { data = a.slice(-points); draw(); return c; };
  c.clear = () => { data = []; draw(); return c; };
  c.getValue = () => data.slice();
  return c;
}
