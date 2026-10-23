import { el } from '../utils/dom.js';

/** Scrolling timestamped log. c.log(message, 'info' | 'success' | 'warn' | 'error'). */
export function createLog(title = 'Log', o = {}) {
  const { max = 200, height = 110 } = o;
  const n = el('div', 'card');
  const row = el('div', 'row');
  const l = el('span', 'lbl');
  l.textContent = title;
  const clr = el('button', 'mini');
  clr.textContent = 'Clear';
  row.append(l, clr);
  const area = el('div', 'log-area');
  area.style.height = height + 'px';
  n.append(row, area);
  const c = this._ctl(n);

  c.log = (msg, type = 'info') => {
    const d = el('div', 'll ' + type);
    const t = el('i');
    t.textContent = new Date().toTimeString().slice(0, 8);
    d.append(t, document.createTextNode(String(msg)));
    area.appendChild(d);
    while (area.children.length > max) area.firstChild.remove();
    area.scrollTop = area.scrollHeight;
    return c;
  };
  c.clear = () => { area.innerHTML = ''; return c; };
  clr.onclick = () => c.clear();
  return c;
}
