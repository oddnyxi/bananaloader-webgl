export const hexToRgb = (h) => {
  h = String(h).replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

export const toHex = (r, g, b) =>
  '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

/** Linear blend of two rgb arrays. t=0 -> a, t=1 -> b. */
export const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
