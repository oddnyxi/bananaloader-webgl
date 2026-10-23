import { el } from '../utils/dom.js';
import { choiceList } from '../utils/choiceList.js';

export function createCheckboxGroup(text, options = [], action, o = {}) {
  const n = el('div', 'card');
  const l = el('span', 'lbl');
  l.textContent = text;
  const c = this._ctl(n);

  const sel = (o.selected || []).map((x) => (typeof x === 'number' ? options[x] : x));
  const cl = choiceList(options, true, sel, 'opts', () => c._out(action, cl.get()));
  n.append(l, cl.node);

  c.getValue = () => cl.get();
  c.setValue = (v, silent) => { cl.set(v); if (!silent) c._out(action, cl.get()); return c; };
  c.setOptions = (a) => { cl.setOptions(a); return c; };
  return this._reg(c, text, o);
}
