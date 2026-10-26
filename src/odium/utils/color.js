/** '#rgb', '#rgba', '#rrggbb', '#rrggbbaa' or a CSS colour name → [r, g, b] (alpha ignored). */
export const hexToRgb = (h) => {
  h = String(h ?? '').trim().replace(/^#/, '');
  if (!/^[0-9a-f]+$/i.test(h) || ![3, 4, 6, 8].includes(h.length)) return cssRgb(h);
  if (h.length <= 4) h = h.split('').map((c) => c + c).join('');
  h = h.slice(0, 6);
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
};

// named colours and rgb() strings, through the browser's own parser
let probe = null;
const cssRgb = (s) => {
  try {
    probe ||= document.createElement('canvas').getContext('2d');
    probe.fillStyle = '#000';
    probe.fillStyle = s;
    const v = String(probe.fillStyle);
    if (v[0] === '#') return hexToRgb(v);
    const m = /(\d+)\D+(\d+)\D+(\d+)/.exec(v);
    if (m) return [+m[1], +m[2], +m[3]];
  } catch (_) { /* no canvas */ }
  return [0, 0, 0];
};

export const toHex = (r, g, b) =>
  '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

/** Linear blend of two rgb arrays. t=0 -> a, t=1 -> b. */
export const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
