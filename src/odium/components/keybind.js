import { el, safe } from '../utils/dom.js';

/** Click, press a key combo to bind. Esc cancels, Backspace/Delete clears. */
export function createKeybind(text, action, o = {}) {
  const n = el('div', 'card row');
  const l = el('span', 'lbl');
  l.textContent = text;
  const b = el('button', 'kbd');
  n.append(l, b);
  const c = this._ctl(n);

  let spec = o.value || '';
  let bound = null;
  const show = () => { b.textContent = spec || 'None'; };
  const rebind = () => {
    if (bound) this.ui.unbindKey(bound);
    bound = spec && o.onPress ? this.ui.bindKey(spec, () => safe(o.onPress)) : null;
  };
  const set = (v, silent) => { spec = v || ''; show(); rebind(); if (!silent) c._out(action, spec); return c; };

  b.onclick = () => {
    if (b.classList.contains('listen')) { this.ui.cancelCapture(); return; }
    b.classList.add('listen');
    b.textContent = 'Press a key…';
    this.ui.captureKey((v) => {
      b.classList.remove('listen');
      b.blur();
      if (v === undefined) show(); else set(v);
    });
  };

  c.getValue = () => spec;
  c.setValue = set;
  show();
  rebind();
  return this._reg(c, text, o);
}
