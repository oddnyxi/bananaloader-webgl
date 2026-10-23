/** Create an element with an optional class name and innerHTML. */
export const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
};

/** Escape a string for safe use inside innerHTML. */
export const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Call fn(...args), logging instead of throwing. Used for every user callback. */
export const safe = (fn, ...args) => {
  try { return fn && fn(...args); } catch (e) { console.error('[OdiumUI]', e); }
};
