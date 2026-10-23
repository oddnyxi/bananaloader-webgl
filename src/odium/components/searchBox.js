import { el, safe } from '../utils/dom.js';

/** Filters every other control on the same page by its text content. */
export function createSearchBox(placeholder = 'Search…', onSearch) {
  const n = el('div', 'search');
  const i = el('input', 'in');
  i.type = 'text';
  i.placeholder = placeholder;
  n.appendChild(i);
  const c = this._ctl(n);

  i.oninput = () => {
    const q = i.value.trim().toLowerCase();
    [...this.page.children].forEach((ch) => {
      if (ch === n) return;
      const hide = q && (ch.classList.contains('section') || ch.classList.contains('divider') || !ch.textContent.toLowerCase().includes(q));
      ch.classList.toggle('filtered', !!hide);
    });
    safe(onSearch, i.value);
  };

  c.getValue = () => i.value;
  c.setValue = (v) => { i.value = v; i.oninput(); return c; };
  return c;
}
