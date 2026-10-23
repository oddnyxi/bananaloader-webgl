import css from '../../styles/index.js';
import { el, esc } from '../../utils/dom.js';
import { enableDrag } from './drag.js';
import { enableResize } from './resize.js';
import { enableTooltips } from './tooltips.js';

/**
 * Builds the shadow-DOM host and the window chrome (header, sidebar, content, footer).
 * Call once; later calls are ignored.
 */
export function createWindow(title = 'ODIUM', o = {}) {
  if (this.win) return this;
  const { width = 580, height = 420, subtitle = 'v1.0', toggleKey = 'Insert', snap = true } = o;
  this._snap = snap;

  // closed shadow root keeps page CSS/JS out and ours in
  this.host = document.createElement('div');
  this.host.id = 'odium-ui-host';
  this.host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
  const shadow = this.host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = css;
  this.root = el('div', 'root');
  shadow.append(style, this.root);

  const win = (this.win = el('div', 'win'));
  win.style.cssText =
    `width:${width}px;height:${height}px;` +
    `left:${o.x ?? Math.max(20, (innerWidth - width) / 2)}px;` +
    `top:${o.y ?? Math.max(20, (innerHeight - height) / 3)}px;`;
  win.innerHTML = `
    <div class="head">
      <div class="logo">O</div>
      <span class="title">${esc(title)}</span><span class="sub">${esc(subtitle)}</span>
      <span class="spacer"></span>
      <button class="wbtn m" title="Minimize"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 12h14"/></svg></button>
      <button class="wbtn x" title="Hide"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button>
    </div>
    <div class="body"><div class="side"></div><div class="content"></div></div>
    <div class="foot"><span>Odium UI</span><span>Toggle: <b class="tk"></b></span></div>
    <div class="grip"></div>`;

  this.side = win.querySelector('.side');
  this.content = win.querySelector('.content');
  this.toasts = el('div', 'toasts');
  this.tip = el('div', 'tip');
  this.root.append(win, this.toasts, this.tip);

  win.querySelector('.m').onclick = () => win.classList.toggle('min');
  win.querySelector('.x').onclick = () => this.hide();

  // window-wide right-click menu (skipped over text inputs so paste/copy still work)
  win.addEventListener('contextmenu', (e) => {
    if (!this._wmenu) return;
    const t = e.target;
    if (t && t.closest && t.closest('input,textarea,[contenteditable="true"]')) return;
    e.preventDefault();
    e.stopPropagation();
    this.contextMenu(this._wmenu, e.clientX, e.clientY);
  });

  // clicking inside the UI closes an open menu unless the click was on the menu itself
  this.root.addEventListener('pointerdown', (e) => {
    this._inside = true;
    if (this._menu && !e.target.closest('.menu')) this.closeMenu();
  });

  enableDrag(this, win, win.querySelector('.head'));
  enableResize(win, win.querySelector('.grip'));
  enableTooltips(this);
  this._installKeys();

  this.setToggleKey(toggleKey);
  this.setAccent(this.accent);
  this.setOpacity(this._opacity);
  this.setWindowIcon(o.icon !== undefined ? o.icon : this._icon);

  (document.body || document.documentElement).appendChild(this.host);
  this.tabs.forEach((t) => this._mount(t));
  if (this.tabs[0]) this.selectTab(this.tabs[0]);
  return this;
}
