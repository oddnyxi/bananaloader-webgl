import { el, safe } from '../../utils/dom.js';
import { makeIcon } from '../../utils/icons.js';

/**
 * Renders menu item descriptors into `parent`. `place` re-positions the menu
 * after layout changes (accordions opening/closing).
 */
export function renderMenuRows(ui, parent, items, place) {
  items.forEach((it) => {
    if (it === '-' || (it && it.type === 'separator')) { parent.appendChild(el('div', 'm-sep')); return; }
    if (!it || it.hidden) return;

    const type = it.type || 'button';
    // checkbox-style items may use `checked` instead of `value`; either can be a getter function
    const key = 'checked' in it && !('value' in it) ? 'checked' : 'value';
    const read = () => (typeof it[key] === 'function' ? it[key]() : it[key]);
    const write = (v) => { if (typeof it[key] !== 'function') it[key] = v; };

    const row = (cls) => {
      const r = el('div', 'm-item' + (cls ? ' ' + cls : '') + (it.danger ? ' danger' : '') + (it.disabled ? ' off' : ''));
      if (it.icon) r.appendChild(makeIcon(it.icon, 'ico'));
      return r;
    };
    const txt = (s) => { const t = el('span', 'm-t'); t.textContent = s == null ? '' : s; return t; };

    if (type === 'label' || type === 'header') {
      const d = el('div', 'm-label');
      d.textContent = it.text || '';
      parent.appendChild(d);
      return;
    }

    if (type === 'toggle') {
      let st = !!read();
      const r = row('tg' + (st ? ' on' : ''));
      r.append(txt(it.text), el('span', 'sw'));
      r.onclick = () => { st = !st; r.classList.toggle('on', st); write(st); safe(it.onChange, st); };
      parent.appendChild(r);
      return;
    }

    if (type === 'checkbox') {
      let st = !!read();
      const r = row('cb' + (st ? ' on' : ''));
      r.insertBefore(el('span', 'chk'), r.firstChild);
      r.appendChild(txt(it.text));
      r.onclick = () => { st = !st; r.classList.toggle('on', st); write(st); safe(it.onChange, st); };
      parent.appendChild(r);
      return;
    }

    if (type === 'radio') {
      const opts = it.options || [];
      let cur = read();
      if (it.text) {
        const d = el('div', 'm-label');
        d.textContent = it.text;
        parent.appendChild(d);
      }
      const grp = el('div');
      const paint = () => [...grp.children].forEach((c) => c.classList.toggle('on', c._o === cur));
      opts.forEach((o, i) => {
        const r = el('div', 'm-item' + (it.disabled ? ' off' : ''));
        r._o = o;
        r.append(el('span', 'rad'), txt(o));
        r.onclick = () => { cur = o; paint(); write(o); safe(it.onChange, o, i); };
        grp.appendChild(r);
      });
      paint();
      parent.appendChild(grp);
      return;
    }

    if (type === 'accordion') {
      const w = el('div', 'm-acc' + (it.open ? ' open' : ''));
      const h = row('acc');
      h.insertBefore(el('span', 'chev'), h.firstChild);
      h.appendChild(txt(it.text));
      const body = el('div', 'm-acc-body');
      renderMenuRows(ui, body, it.items || [], place);
      h.onclick = () => { w.classList.toggle('open'); it.open = w.classList.contains('open'); place(); };
      w.append(h, body);
      parent.appendChild(w);
      return;
    }

    // default: button
    const r = row();
    r.appendChild(txt(it.text));
    if (it.hint) {
      const hh = el('span', 'm-hint');
      hh.textContent = it.hint;
      r.appendChild(hh);
    }
    r.onclick = () => { if (!it.keepOpen) ui.closeMenu(); safe(it.action); };
    parent.appendChild(r);
  });
}
