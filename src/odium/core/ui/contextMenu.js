import { el, safe } from '../../utils/dom.js';
import { MenuBuilder } from '../MenuBuilder.js';
import { renderMenuRows } from './menuRows.js';

/** Shortcut: window-wide right-click menu builder, created on first use. */
export function ctx(items) {
  if (!this._wctx) {
    this._wctx = this.createContextMenu(items || []);
    this.setWindowContextMenu(this._wctx);
  }
  return this._wctx;
}

export function createContextMenu(items = []) {
  return new MenuBuilder(this, items);
}

export function setWindowContextMenu(menu) {
  this._wmenu = menu || null;
  return this;
}

/**
 * Open a menu at (x, y).
 * items: array | function returning array | ui.createContextMenu() builder.
 * Item types: button (default), toggle, checkbox, radio, label, accordion, '-' separator.
 */
export function contextMenu(items, x, y) {
  this.closeMenu();
  const src = typeof items === 'function' ? safe(items) : items;
  const list = Array.isArray(src) ? src : (src && src.items) || [];

  const m = el('div', 'menu');
  m.oncontextmenu = (e) => e.preventDefault();
  m.style.maxHeight = Math.max(120, innerHeight - 12) + 'px';

  const place = () => {
    const w = m.offsetWidth, h = m.offsetHeight;
    m.style.left = Math.max(6, Math.min(x, innerWidth - w - 6)) + 'px';
    m.style.top = Math.max(6, Math.min(y, innerHeight - h - 6)) + 'px';
  };

  renderMenuRows(this, m, list, place);
  if (!m.children.length) return;
  this.root.appendChild(m);
  place();
  this._menu = m;
  this._inside = false;

  // clicks outside our shadow root close the menu (clicks inside are handled in createWindow)
  this._mc = () => {
    if (this._inside) { this._inside = false; return; }
    this.closeMenu();
  };
  setTimeout(() => window.addEventListener('pointerdown', this._mc), 0);
}

export function closeMenu() {
  if (this._menu) this._menu.remove();
  this._menu = null;
  if (this._mc) window.removeEventListener('pointerdown', this._mc);
  this._mc = null;
}
