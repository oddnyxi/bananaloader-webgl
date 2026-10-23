import { el, safe } from '../utils/dom.js';

export function createTextInput(text, action, o = {}) {
  const n = el('div', 'card');
  const l = el('span', 'lbl');
  l.textContent = text;
  const i = el('input', 'in');
  i.type = 'text';
  i.placeholder = o.placeholder || '';
  i.value = o.value || '';
  n.append(l, i);
  const c = this._ctl(n);

  i.oninput = () => c._out(action, i.value);
  i.onkeydown = (e) => { if (e.key === 'Enter') safe(o.onEnter, i.value); };

  c.getValue = () => i.value;
  c.setValue = (v, silent) => { i.value = v ?? ''; if (!silent) c._out(action, i.value); return c; };
  c.focus = () => i.focus();
  return this._reg(c, text, o);
}
