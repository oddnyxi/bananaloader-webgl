// Window layouts, switchable at any time:
//   window  one window, tabs in a sidebar (the default)
//   tabs    one window, tabs as a strip of dock tabs along the top
//   panels  no single window: a floating top bar, and each opened tab in its own floating panel
// Pages are moved between the window and the panels; their controls, hotkeys and config stay as
// they are, so a layout change never rebuilds anything.

import { el, esc } from '../../utils/dom.js';
import { enableDrag } from './drag.js';
import { enableResize } from './resize.js';
import { makeIcon } from '../../utils/icons.js';

const LAYOUTS = ['window', 'tabs', 'panels'];
const STORE = 'odium:panels';

function readPlaces() {
  try { const o = JSON.parse(localStorage.getItem(STORE) || '{}'); return o && typeof o === 'object' ? o : {}; } catch (_) { return {}; }
}

export function setLayout(mode) {
  mode = LAYOUTS.includes(mode) ? mode : 'window';
  if (!this.win || this.layout === mode) { this.layout = mode; return this; }
  const was = this.layout || 'window';
  if (was === 'panels') this._leavePanels();
  this.layout = mode;
  for (const m of LAYOUTS) this.root.classList.toggle(`lay-${m}`, m === mode);
  if (mode === 'panels') this._enterPanels();
  else if (this.active) this.selectTab(this.active);
  for (const fn of this._layoutFns || []) { try { fn(mode, was); } catch (e) { console.error('[Odium] layout listener', e); } }
  return this;
}

/** fn(layout, previous) after every layout change. */
export function onLayout(fn) { (this._layoutFns ||= []).push(fn); return this; }

// ------------------------------------------------------------------ panels

export function _enterPanels() {
  this._places = readPlaces();
  this._panels = new Map();   // tab -> panel
  this._companions ||= [];    // extra panels that open with a tab (Scene's Inspector)
  this._z = 10;
  const bar = (this.pbar = el('div', 'pbar'));
  const logo = this.win.querySelector('.logo');
  bar.innerHTML = `<div class="logo pb-logo">${logo ? logo.innerHTML : ''}</div><span class="pb-title">${esc(this.barTitle || this.win.querySelector('.title').textContent)}</span><span class="pb-sep"></span><div class="pb-tabs"></div><span class="pb-sep"></span><span class="pb-hint"><b class="tk">${esc(this.toggleKey || '')}</b></span><button class="wbtn x" title="Hide"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button>`;
  bar.querySelector('.x').onclick = () => this.hide();
  this.pbarTabs = bar.querySelector('.pb-tabs');
  this.root.appendChild(bar);
  let group;
  for (const t of this.tabs) {
    if (t.group !== group && group !== undefined) this.pbarTabs.appendChild(el('span', 'pb-gap'));
    group = t.group;
    this._barButton(t);
  }
  const open = Array.isArray(this._places.$open) ? this._places.$open : null;
  const want = open ? this.tabs.filter((t) => open.includes(t.name)) : [];
  if (want.length) want.forEach((t) => this.openPanel(t));
  else if (this.active || this.tabs[0]) this.openPanel(this.active || this.tabs[0]);
}

export function _leavePanels() {
  this._savePlaces();
  for (const c of this._companions || []) c.restore();
  for (const [t, p] of this._panels || []) {
    this.content.appendChild(t.page);
    p.el.remove();
  }
  this._panels = null;
  if (this.pbar) { this.pbar.remove(); this.pbar = null; }
  // window order: the sidebar's order is the tabs' order
  for (const t of this.tabs) this.content.appendChild(t.page);
}

export function _barButton(tab) {
  if (!this.pbarTabs) return;
  const b = el('button', 'pbtn');
  b.title = tab.name;
  const ic = tab.btn.querySelector('.ic');
  if (ic) b.appendChild(ic.cloneNode(true));
  else b.appendChild(el('span', 'pbtn-l', tab.name.slice(0, 2)));
  b.onclick = () => {
    const p = this._panels.get(tab);
    if (p && p.open && p.el.style.zIndex == this._z) this.closePanel(tab); else this.openPanel(tab);
  };
  b.style.display = tab.btn.style.display;
  tab._pbtn = b;
  this.pbarTabs.appendChild(b);
}

function frame(ui, title, icon) {
  const p = el('div', 'pwin');
  p.innerHTML = `<div class="phead"><span class="ptitle">${esc(title)}</span><span class="spacer"></span><button class="wbtn x" title="Close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button></div><div class="pbody"></div><div class="grip"></div>`;
  if (icon) p.querySelector('.phead').insertBefore(icon, p.querySelector('.ptitle'));
  enableDrag(ui, p, p.querySelector('.phead'));
  enableResize(p, p.querySelector('.grip'));
  p.addEventListener('pointerdown', () => ui._front(p), true);
  p.addEventListener('pointerup', () => ui._savePlaces());
  ui.root.appendChild(p);
  return p;
}

export function _front(p) {
  if (p.style.zIndex != this._z) p.style.zIndex = ++this._z;
  for (const [t, x] of this._panels || []) if (t._pbtn) t._pbtn.classList.toggle('front', x.el === p && x.open);
}

function place(ui, p, key, def) {
  const s = ui._places[key];
  const W = innerWidth, H = innerHeight;
  const r = s && s.w ? s : def;
  const w = Math.min(Math.max(260, r.w), W - 16), h = Math.min(Math.max(160, r.h), H - 16);
  p.style.width = w + 'px';
  p.style.height = h + 'px';
  p.style.left = Math.min(Math.max(0, r.x), W - w) + 'px';
  p.style.top = Math.min(Math.max(0, r.y), H - h) + 'px';
}

/** Open (or bring to front) a tab's panel. */
export function openPanel(tab) {
  if (this.layout !== 'panels' || !this._panels) return this.selectTab(tab);
  let p = this._panels.get(tab);
  if (!p) {
    const ic = tab.btn.querySelector('.ic');
    p = { el: frame(this, tab.name, ic ? ic.cloneNode(true) : null), open: false };
    p.el.querySelector('.phead .x').onclick = () => this.closePanel(tab);
    p.el.querySelector('.pbody').appendChild(tab.page);
    const n = this._panels.size;
    const def = (tab.panelDefault && tab.panelDefault()) || { x: 40 + n * 28, y: 86 + n * 24, w: Math.min(820, innerWidth - 80), h: Math.min(560, innerHeight - 130) };
    place(this, p.el, tab.name, def);
    this._panels.set(tab, p);
  }
  p.open = true;
  p.el.style.display = '';
  tab.page.classList.add('on');
  this.active = tab;
  if (tab._pbtn) tab._pbtn.classList.add('on');
  this._front(p.el);
  for (const c of this._companions || []) if (c.tab === tab) c.open();
  this._savePlaces();
  return this;
}

export function closePanel(tab) {
  const p = this._panels && this._panels.get(tab);
  if (!p) return this;
  p.open = false;
  p.el.style.display = 'none';
  tab.page.classList.remove('on');
  if (tab._pbtn) tab._pbtn.classList.remove('on', 'front');
  for (const c of this._companions || []) if (c.tab === tab) c.close();
  if (this.active === tab) {
    const open = [...this._panels].filter(([, x]) => x.open).sort((a, b) => b[1].el.style.zIndex - a[1].el.style.zIndex);
    this.active = open.length ? open[0][0] : tab;
  }
  this._savePlaces();
  return this;
}

/**
 * An extra panel that opens and closes with `tab` in the panels layout (the Scene tab's Inspector).
 * `node` is moved into it while the layout is active, and put back where it was afterwards.
 */
export function addCompanion(tab, name, node, o = {}) {
  this._companions ||= [];
  const ui = this;
  const c = {
    tab, name, node, el: null, home: null, next: null,
    open() {
      if (!c.el) {
        c.home = node.parentNode; c.next = node.nextSibling;
        c.el = frame(ui, name, o.icon ? makeIcon(o.icon, 'ic') : null);
        c.el.querySelector('.phead .x').onclick = () => { c.el.style.display = 'none'; ui._savePlaces(); };
        c.el.querySelector('.pbody').appendChild(node);
        place(ui, c.el, `${tab.name}/${name}`, (o.defaultPlace && o.defaultPlace()) || { x: innerWidth - 400, y: 86, w: 370, h: innerHeight - 120 });
        if (o.onMove) o.onMove(true);
      }
      c.el.style.display = '';
      ui._front(c.el);
    },
    close() { if (c.el) c.el.style.display = 'none'; },
    restore() {
      if (!c.el) return;
      if (c.home) c.home.insertBefore(node, c.next && c.next.parentNode === c.home ? c.next : null);
      c.el.remove();
      c.el = null;
      if (o.onMove) o.onMove(false);
    },
  };
  this._companions.push(c);
  if (this.layout === 'panels' && this._panels && this._panels.get(tab) && this._panels.get(tab).open) c.open();
  return c;
}

export function _savePlaces() {
  if (!this._panels) return;
  const out = { ...this._places };
  const rec = (key, p) => { const r = p.getBoundingClientRect(); if (r.width) out[key] = { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; };
  for (const [t, p] of this._panels) rec(t.name, p.el);
  for (const c of this._companions || []) if (c.el) rec(`${c.tab.name}/${c.name}`, c.el);
  out.$open = [...this._panels].filter(([, p]) => p.open).map(([t]) => t.name);
  this._places = out;
  try { localStorage.setItem(STORE, JSON.stringify(out)); } catch (_) { /* ignore */ }
}

/** A tab removed while the panels layout is active. */
export function _dropPanel(tab) {
  if (tab._pbtn) { tab._pbtn.remove(); tab._pbtn = null; }
  const p = this._panels && this._panels.get(tab);
  if (p) { p.el.remove(); this._panels.delete(tab); }
}
