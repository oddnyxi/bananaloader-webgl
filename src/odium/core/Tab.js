import { Container } from './Container.js';
import { releaseInside } from './Handle.js';
import { el } from '../utils/dom.js';
import { makeIcon } from '../utils/icons.js';

/** A sidebar tab and its page. */
export class Tab extends Container {
  constructor(ui, name, o = {}) {
    const page = el('div', 'page');
    super(ui, page, name);
    this.name = name;
    this.group = o.group;
    this.btn = el('button', 'tab');
    const s = el('span');
    s.textContent = name;
    this.btn.appendChild(s);
    this.btn.onclick = () => ui.selectTab(this);
    this._hotkeyAction = () => { ui.show && ui.show(); ui.selectTab(this); };
    this.setIcon(o.icon);
  }

  setVisible(v) {
    this.btn.style.display = v ? '' : 'none';
    // hiding the open tab moves to the first visible one, so its page doesn't linger
    if (!v && this.ui.active === this) {
      const next = this.ui.tabs.find((t) => t !== this && t.btn.style.display !== 'none');
      if (next) this.ui.selectTab(next); else this.page.classList.remove('on');
    }
    return this;
  }

  setIcon(icon) {
    if (this._ic) { this._ic.remove(); this._ic = null; }
    if (icon) {
      this._ic = makeIcon(icon, 'ic');
      this.btn.insertBefore(this._ic, this.btn.firstChild);
    }
    return this;
  }

  /** Shortcut: right-click menu builder attached to the sidebar button. */
  tabCtx(items) {
    if (!this._tctxb) {
      this._tctxb = this.ui.createContextMenu(items || []);
      this.setTabContextMenu(this._tctxb);
    }
    return this._tctxb;
  }

  setTabContextMenu(items) {
    if (this._tcm) this.btn.removeEventListener('contextmenu', this._tcm);
    this._tcm = items
      ? (e) => { e.preventDefault(); e.stopPropagation(); this.ui.contextMenu(items, e.clientX, e.clientY); }
      : null;
    if (this._tcm) this.btn.addEventListener('contextmenu', this._tcm);
    return this;
  }

  /** Remove the tab, its page, and every control on it (config keys, hotkeys, keybinds). */
  destroy() {
    const ui = this.ui;
    releaseInside(ui, this.page);
    this._release();
    // a group heading left with no tabs under it goes too
    const prev = this.btn.previousElementSibling;
    const next = this.btn.nextElementSibling;
    this.btn.remove();
    this.page.remove();
    if (prev && prev.classList.contains('sgroup') && (!next || next.classList.contains('sgroup'))) {
      prev.remove();
      if (ui._lastGroup === this.group && !next) ui._lastGroup = undefined;
    }
    ui.tabs = ui.tabs.filter((t) => t !== this);
    if (ui.active === this) {
      ui.active = null;
      const first = ui.tabs.find((t) => t.btn.style.display !== 'none') || ui.tabs[0];
      if (first) ui.selectTab(first);
    }
  }
}
