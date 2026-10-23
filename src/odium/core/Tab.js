import { Container } from './Container.js';
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
    this.setIcon(o.icon);
  }

  setVisible(v) { this.btn.style.display = v ? '' : 'none'; return this; }

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

  destroy() {
    this.btn.remove();
    this.page.remove();
    this.ui.tabs = this.ui.tabs.filter((t) => t !== this);
    if (this.ui.active === this && this.ui.tabs[0]) this.ui.selectTab(this.ui.tabs[0]);
  }
}
