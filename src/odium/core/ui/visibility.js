import { unlisten } from '../../utils/listen.js';
export function show() { this.win && this.win.classList.remove('hidden'); }

export function hide() {
  this.closeMenu();
  this.win && this.win.classList.add('hidden');
}

export function toggle() {
  this.win && (this.win.classList.contains('hidden') ? this.show() : this.hide());
}

/** Remove the UI and every listener it installed on the page. */
export function destroy() {
  unlisten(window, 'keydown', this._kh, true);
  this.cancelCapture();
  this.closeMenu();
  this.host && this.host.remove();
  this.win = null;
  this.tabs = [];
  this.reg.clear();
  this.keys = [];
  this._lastGroup = undefined;
}
