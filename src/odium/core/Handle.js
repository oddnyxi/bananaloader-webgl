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
    track(ui, this);
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
    // tabs and groups have no click behaviour of their own: they say what their hotkey does
    this._hk = spec
      ? this.ui.bindKey(spec, () => { if (this.el.classList.contains('disabled')) return; if (this._hotkeyAction) this._hotkeyAction(); else this.el.click(); })
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

  /** Run fn when this control is destroyed (keybinds release their onPress binding with it). */
  _onDestroy(fn) { (this._cleanup ||= []).push(fn); return this; }

  /** Unregister without touching the DOM: hotkeys, config key, cleanup hooks. */
  _release() {
    if (this._hk) { this.ui.unbindKey(this._hk); this._hk = null; }
    if (this._key && this.ui.reg.get(this._key) === this) this.ui.reg.delete(this._key);
    this._key = null;
    for (const f of this._cleanup || []) safe(f);
    this._cleanup = null;
    if (this.ui._handles) this.ui._handles.delete(this);
  }

  destroy() {
    this._release();
    this.el.remove();
  }
}

/** Every handle the UI made, so destroying a tab can release the controls inside it. */
export function track(ui, h) {
  if (!ui) return;
  (ui._handles ||= new Set()).add(h);
}

/** Release every control whose element sits inside `node` (call before removing node). */
export function releaseInside(ui, node) {
  for (const h of [...(ui._handles || [])]) if (h.el !== node && node.contains(h.el)) h._release();
}
