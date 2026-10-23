import { el } from '../utils/dom.js';
import { choiceList } from '../utils/choiceList.js';

export function createRadioGroup(text, options = [], action, o = {}) {
  const n = el('div', 'card');
  const l = el('span', 'lbl');
  l.textContent = text;
  const c = this._ctl(n);

  const s = o.selected ?? 0;
  const init = typeof s === 'number' ? options[s] : s;
  const cl = choiceList(options, false, init == null ? [] : [init], 'opts',
    () => c._out(action, cl.get(), options.indexOf(cl.get())));
  n.append(l, cl.node);

  c.getValue = () => cl.get();
  c.setValue = (v, silent) => { cl.set(v); if (!silent) c._out(action, cl.get(), options.indexOf(cl.get())); return c; };
  c.setOptions = (a) => { options = a.slice(); cl.setOptions(a); return c; };
  return this._reg(c, text, o);
}
