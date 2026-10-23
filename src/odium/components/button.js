import { el, safe } from '../utils/dom.js';

/** If `action` returns a promise, the button shows a spinner until it settles. */
export function createButton(text, action, o = {}) {
  const n = el('button', 'btn');
  const lab = el('span');
  lab.textContent = text;
  n.appendChild(lab);
  const c = this._ctl(n);
  let loading = false;

  n.onclick = () => {
    if (loading) return;
    const r = safe(action);
    if (r && typeof r.then === 'function') {
      c.setLoading(true);
      r.then(() => c.setLoading(false), () => c.setLoading(false));
    }
  };

  c.setText = (t) => { lab.textContent = t; return c; };
  c.setLoading = (v) => { loading = !!v; n.classList.toggle('loading', loading); return c; };
  if (o.icon) c.setIcon(o.icon);
  return c;
}
