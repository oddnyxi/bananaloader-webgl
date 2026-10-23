import { Container } from '../core/Container.js';
import { el } from '../utils/dom.js';
import { makeIcon } from '../utils/icons.js';

/** Collapsible card that holds more controls. Returns a Container. */
export function createGroup(title, o = {}) {
  const wrap = el('div', 'group' + (o.collapsed ? ' closed' : ''));
  const head = el('div', 'g-head');
  const t = el('span');
  t.textContent = title;
  head.append(el('span', 'chev'), t);
  const body = el('div', 'g-body');
  wrap.append(head, body);
  this.page.appendChild(wrap);

  const g = new Container(this.ui, body, `${this.path}/${title}`, wrap);
  g.collapse = () => { wrap.classList.add('closed'); return g; };
  g.expand = () => {
    wrap.classList.remove('closed');
    if (g._acc) g._acc.forEach((x) => x !== g && x.collapse()); // accordion: only one open
    return g;
  };
  g.toggle = () => (wrap.classList.contains('closed') ? g.expand() : g.collapse());
  g.setTitle = (x) => { t.textContent = x; return g; };

  let gi = null;
  g.setIcon = (v) => {
    if (gi) { gi.remove(); gi = null; }
    if (v) { gi = makeIcon(v, 'ico'); head.insertBefore(gi, t); }
    return g;
  };
  g.setIcon(o.icon);

  head.onclick = () => g.toggle();
  return g;
}
