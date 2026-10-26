import { safe } from '../../utils/dom.js';
import { keySpec } from '../../utils/keys.js';
import { listen, unlisten } from '../../utils/listen.js';

export function bindKey(spec, fn) {
  const k = { spec, fn };
  this.keys.push(k);
  return k;
}

export function unbindKey(k) {
  this.keys = this.keys.filter((x) => x !== k);
}

/** Wait for the next key combo. cb(spec) | cb('') when cleared | cb(undefined) when cancelled. */
export function captureKey(cb) {
  this.cancelCapture();
  const done = (v) => {
    unlisten(window, 'keydown', h, true);
    this._cap = null;
    cb(v);
  };
  const h = (e) => {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    if (e.key === 'Escape') { done(undefined); return; }
    if (e.key === 'Backspace' || e.key === 'Delete') { done(''); return; }
    const s = keySpec(e);
    if (s) done(s);
  };
  this._cap = { done };
  listen(window, 'keydown', h, true);
}

export function cancelCapture() {
  if (this._cap) this._cap.done(undefined);
}

export function setToggleKey(spec) {
  if (this._tk) this.unbindKey(this._tk);
  this.toggleKey = spec;
  this._tk = this.bindKey(spec, () => this.toggle());
  const tk = this.win && this.win.querySelector('.tk');
  if (tk) tk.textContent = spec;
  if (this._tkCtl) this._tkCtl.setValue(spec, true);
  return this;
}

/** Global key handling: keep keystrokes inside the UI from leaking to the page, and dispatch hotkeys. */
export function _installKeys() {
  ['keydown', 'keyup', 'keypress'].forEach((t) => this.host.addEventListener(t, (e) => e.stopPropagation()));

  this.root.addEventListener('focusin', (e) => {
    this._typing = !!(e.target.matches && e.target.matches('input:not([type=range]):not([type=color]),textarea,[contenteditable="true"]'));
  });
  this.root.addEventListener('focusout', () => { this._typing = false; });

  this._kh = (e) => {
    if (this._cap) return;
    if (e.key === 'Escape' && this._menu) { this.closeMenu(); return; }
    const s = keySpec(e);
    if (!s) return;
    // plain letters shouldn't fire hotkeys while the user is typing somewhere
    const plain = !e.ctrlKey && !e.altKey && !e.metaKey && e.key.length === 1; // keySpec() is null when there's no key
    const t = e.target;
    if (plain && (this._typing || (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))))) return;
    let hit = false;
    for (const k of this.keys.slice()) if (k.spec === s) { hit = true; safe(k.fn); }
    if (hit) e.preventDefault();
  };
  listen(window, 'keydown', this._kh, true);
}
