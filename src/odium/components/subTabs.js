import { Container } from '../core/Container.js';
import { el } from '../utils/dom.js';

/** Horizontal tab strip inside a page. addTab(name) returns a Container. */
export function createSubTabs() {
  const wrap = el('div');
  const strip = el('div', 'strip');
  const panes = el('div');
  wrap.append(strip, panes);
  this.page.appendChild(wrap);

  const list = [];
  const select = (t) =>
    list.forEach((x) => {
      x.b.classList.toggle('on', x === t);
      x.p.style.display = x === t ? 'flex' : 'none';
    });

  return {
    el: wrap,
    addTab: (name) => {
      const b = el('button', 'stab');
      b.textContent = name;
      const p = el('div', 'sub-pane');
      const cont = new Container(this.ui, p, `${this.path}/${name}`);
      const t = { b, p };
      b.onclick = () => select(t);
      list.push(t);
      strip.appendChild(b);
      panes.appendChild(p);
      if (list.length === 1) select(t); else p.style.display = 'none';
      return cont;
    },
  };
}
