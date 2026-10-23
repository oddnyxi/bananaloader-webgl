import { el, safe } from '../utils/dom.js';

export function createTable(headers = [], rows = [], o = {}) {
  const wrap = el('div', 'tbl-wrap');
  const t = el('table');
  const th = el('thead'), trh = el('tr');
  headers.forEach((h) => { const x = el('th'); x.textContent = h; trh.appendChild(x); });
  th.appendChild(trh);
  const tb = el('tbody');
  t.append(th, tb);
  wrap.appendChild(t);
  if (o.onRowClick) wrap.classList.add('clickable');
  if (o.height) wrap.style.maxHeight = o.height + 'px';

  let data = [];
  const add = (r) => {
    data.push(r);
    const tr = el('tr');
    r.forEach((v) => { const td = el('td'); td.textContent = v; tr.appendChild(td); });
    tr.onclick = () => safe(o.onRowClick, r, data.indexOf(r));
    tb.appendChild(tr);
  };
  rows.forEach(add);

  const c = this._ctl(wrap);
  c.addRow = (r) => { add(r); return c; };
  c.setRows = (rs) => { tb.innerHTML = ''; data = []; rs.forEach(add); return c; };
  c.clear = () => { tb.innerHTML = ''; data = []; return c; };
  c.getValue = () => data.slice();
  return c;
}
