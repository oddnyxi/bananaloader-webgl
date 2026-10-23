/** h('div.cls.cls2', { attr, on: { click } }, ...children) */
export function h(sel, props, ...kids) {
  const [tag, ...cls] = sel.split('.');
  const e = document.createElement(tag || 'div');
  if (cls.length) e.className = cls.join(' ');
  if (props && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) { kids.unshift(props); props = null; }
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'on') for (const [ev, fn] of Object.entries(v)) e.addEventListener(ev, fn);
      else if (k === 'html') e.innerHTML = v;
      else if (k === 'text') e.textContent = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
      else if (k in e && typeof v !== 'string') e[k] = v;
      else e.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const c of kids.flat(Infinity)) {
    if (c == null || c === false) continue;
    e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return e;
}

export const icon = (svg, cls = 'ico') => h('span.' + cls, { html: svg });

export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Highlight `q` (case-insensitive) inside text, returns HTML. */
export function mark(text, q) {
  if (!q) return esc(text);
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return esc(text);
  return esc(text.slice(0, i)) + '<mark>' + esc(text.slice(i, i + q.length)) + '</mark>' + esc(text.slice(i + q.length));
}

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function copy(text) {
  try { navigator.clipboard.writeText(text); return true; } catch (_) {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (__) { /* ignore */ }
    ta.remove();
    return true;
  }
}

/** Draggable splitter between the first column and the rest of a .ue-split grid. */
export function splitter(split, gut, key) {
  let saved = null;
  try { saved = localStorage.getItem('ue-split:' + key); } catch (_) { /* ignore */ }
  if (saved) split.style.setProperty('--ue-left', saved);
  gut.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    gut.setPointerCapture(e.pointerId);
    gut.classList.add('drag');
    const x0 = e.clientX;
    const w0 = split.firstElementChild.getBoundingClientRect().width;
    const move = (ev) => {
      const w = Math.max(180, Math.min(split.clientWidth - 260, w0 + ev.clientX - x0));
      split.style.setProperty('--ue-left', w + 'px');
    };
    const up = () => {
      gut.classList.remove('drag');
      gut.removeEventListener('pointermove', move);
      gut.removeEventListener('pointerup', up);
      try { localStorage.setItem('ue-split:' + key, split.style.getPropertyValue('--ue-left')); } catch (_) { /* ignore */ }
    };
    gut.addEventListener('pointermove', move);
    gut.addEventListener('pointerup', up);
  });
}
