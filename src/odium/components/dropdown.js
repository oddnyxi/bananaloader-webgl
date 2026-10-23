import { el } from '../utils/dom.js';
import { openPopup } from '../utils/dismiss.js';

export function createDropdown(options = [], action, o = {}) {
  const label = o.label || 'Select';
  let opts = options.slice();
  let idx = -1;

  const n = el('div', 'card dd');
  const head = el('div', 'row dd-head');
  const l = el('span', 'lbl');
  l.textContent = label;
  const cur = el('span', 'dd-cur');
  const ct = el('span');
  ct.textContent = '—';
  cur.append(ct, el('span', 'chev'));
  head.append(l, cur);
  const list = el('div', 'dd-list');
  n.append(head, list);
  const c = this._ctl(n);

  const build = () => {
    list.innerHTML = '';
    opts.forEach((opt, i) => {
      const it = el('div', 'dd-item' + (i === idx ? ' on' : ''));
      it.textContent = opt;
      it.onclick = (e) => { e.stopPropagation(); pick(i); n.classList.remove('open'); };
      list.appendChild(it);
    });
  };
  const pick = (i, silent) => {
    if (typeof i === 'string') i = opts.indexOf(i);
    if (i == null) i = -1;
    idx = i;
    ct.textContent = opts[i] ?? '—';
    build();
    if (!silent && i >= 0) c._out(action, opts[i], i);
  };

  head.onclick = () => openPopup(this.ui, n);
  c.getValue = () => opts[idx];
  c.getIndex = () => idx;
  c.setValue = (v, silent) => { pick(v, silent); return c; };
  c.setOptions = (arr) => { opts = arr.slice(); idx = -1; ct.textContent = '—'; build(); return c; };

  build();
  if ((o.selected ?? -1) >= 0) pick(o.selected, true);
  return this._reg(c, label, o);
}
