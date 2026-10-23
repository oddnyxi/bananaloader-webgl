import { el, safe } from '../utils/dom.js';
import { makeIcon } from '../utils/icons.js';

/**
 * Wraps a single control. Every create*() call returns one of these, so the
 * methods below are available on every component (visibility, tooltip, hotkey, ...).
 */
export class Handle {
  constructor(ui, node) {
    this.ui = ui;
    this.el = node;
    this._sig = [];
    this._cm = null;
    this._hk = null;
    this._key = null;
  }

  setVisible(v) { this.el.style.display = v ? '' : 'none'; return this; }

  setEnabled(v) {
    this.el.classList.toggle('disabled', !v);
    if ('disabled' in this.el) this.el.disabled = !v;
    this.el.querySelectorAll('input,button,textarea').forEach((i) => { i.disabled = !v; });
    this.el.querySelectorAll('[contenteditable]').forEach((i) => { i.contentEditable = v ? 'true' : 'false'; });
    return this;
  }

  setTooltip(t) {
    if (t) this.el.dataset.tip = t; else delete this.el.dataset.tip;
    return this;
  }

  /** Shortcut: returns a right-click menu builder already attached to this component. */
  ctx(items) {
    if (!this._ctxb) {
      this._ctxb = this.ui.createContextMenu(items || []);
      this.setContextMenu(this._ctxb);
    }
    return this._ctxb;
  }

  setIcon(icon) {
    const n = this.el;
    if (this._ico) { this._ico.remove(); this._ico = null; }
    if (!icon) return this;
    let host, ref;
    if (n.classList.contains('btn')) {
      host = n; ref = n.firstChild;
    } else {
      const l = n.querySelector('.lbl');
      if (!l) return this;
      host = l.parentElement; ref = l;
      if (!host.classList.contains('lw')) {
        const w = el('span', 'left lw');
        host.insertBefore(w, l);
        w.appendChild(l);
        host = w;
      }
    }
    this._ico = makeIcon(icon, 'ico');
    host.insertBefore(this._ico, ref);
    return this;
  }

  setContextMenu(items) {
    if (this._cm) this.el.removeEventListener('contextmenu', this._cm);
    this._cm = items
      ? (e) => { e.preventDefault(); e.stopPropagation(); this.ui.contextMenu(items, e.clientX, e.clientY); }
      : null;
    if (this._cm) this.el.addEventListener('contextmenu', this._cm);
    return this;
  }

  setHotkey(spec) {
    if (this._hk) this.ui.unbindKey(this._hk);
    this._hk = spec
      ? this.ui.bindKey(spec, () => { if (!this.el.classList.contains('disabled')) this.el.click(); })
      : null;
    return this;
  }

  onChange(fn) { this._sig.push(fn); return this; }

  _out(action, ...a) { safe(action, ...a); this._fire(); }
  _fire() { const v = this.getValue && this.getValue(); this._sig.forEach((f) => safe(f, v)); }

  /** Show this component only while pred(src.getValue()) is truthy. */
  showWhen(src, pred = (v) => !!v) {
    const apply = () => this.setVisible(!!pred(src.getValue()));
    src.onChange(apply);
    apply();
    return this;
  }

  /** Enable this component only while pred(src.getValue()) is truthy. */
  enableWhen(src, pred = (v) => !!v) {
    const apply = () => this.setEnabled(!!pred(src.getValue()));
    src.onChange(apply);
    apply();
    return this;
  }

  destroy() {
    if (this._hk) this.ui.unbindKey(this._hk);
    if (this._key) this.ui.reg.delete(this._key);
    this.el.remove();
  }
}
