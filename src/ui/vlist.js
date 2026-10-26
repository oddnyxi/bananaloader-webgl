// Virtualised list: only the rows in view exist in the DOM, so 50k entries stay smooth.
import { h } from './dom.js';

export class VList {
  /**
   * @param {object} o
   * @param {number} o.rowHeight
   * @param {(item, el: HTMLElement, index: number) => void} o.render  fill a row element
   * @param {(item, ev: MouseEvent) => void} [o.onClick]
   * @param {(item, ev: MouseEvent) => void} [o.onContext]
   * @param {(item) => void} [o.onKey]  Enter on the focused row
   * @param {(item, ev) => void} [o.onSelect]  arrow-key moves (default: onClick)
   */
  constructor(o) {
    this.o = o;
    this.rh = o.rowHeight || 24;
    this.items = [];
    this.el = h('div.ue-list', { tabIndex: 0 });
    this.spacer = h('div.ue-spacer');
    this.el.append(this.spacer);
    this.pool = [];
    this.sel = -1;
    this.el.addEventListener('scroll', () => this.draw());
    this.el.addEventListener('keydown', (e) => this._key(e));
    new ResizeObserver(() => this.draw()).observe(this.el);
  }

  setItems(items, keepScroll = true) {
    this.items = items;
    if (this.sel >= items.length) this.sel = items.length - 1;
    if (!keepScroll) this.el.scrollTop = 0;
    this.spacer.style.height = items.length * this.rh + 'px';
    this.draw(true);
  }

  draw(force = false) {
    const top = this.el.scrollTop;
    const hgt = this.el.clientHeight || 400;
    const first = Math.max(0, Math.floor(top / this.rh) - 4);
    const last = Math.min(this.items.length, Math.ceil((top + hgt) / this.rh) + 4);
    if (!force && first === this._f && last === this._l) return;
    this._f = first;
    this._l = last;
    const need = last - first;
    while (this.pool.length < need) {
      const r = h('div.ue-row');
      r.addEventListener('click', (e) => { const it = this.items[r._i]; if (it) { this.sel = r._i; this.o.onClick && this.o.onClick(it, e); } });
      r.addEventListener('contextmenu', (e) => { const it = this.items[r._i]; if (it && this.o.onContext) { e.preventDefault(); this.o.onContext(it, e); } });
      r.addEventListener('dblclick', (e) => { const it = this.items[r._i]; if (it && this.o.onDbl) this.o.onDbl(it, e); });
      this.el.append(r);
      this.pool.push(r);
    }
    for (let k = 0; k < this.pool.length; k++) {
      const r = this.pool[k];
      const i = first + k;
      if (k >= need) { r.style.display = 'none'; r._i = -1; continue; }
      r.style.display = '';
      r.style.top = i * this.rh + 'px';
      r._i = i;
      r.className = 'ue-row';
      this.o.render(this.items[i], r, i);
      if (i === this.sel) r.classList.add('cur'); // keyboard position
    }
  }

  scrollToIndex(i) {
    // hidden (tab or window not shown): scroll once it has a size
    if (!this.el.clientHeight) { if (!this._pend) { this._pend = true; requestAnimationFrame(() => { this._pend = false; if (this.el.clientHeight) this.scrollToIndex(i); }); } return; }
    const y = i * this.rh;
    if (y < this.el.scrollTop || y + this.rh > this.el.scrollTop + this.el.clientHeight) this.el.scrollTop = y - this.el.clientHeight / 2;
    this.draw(true);
  }

  _key(e) {
    if (!this.items.length) return;
    let i = this.sel;
    const valid = i >= 0 && i < this.items.length;
    if (e.key === 'ArrowDown') i = valid ? Math.min(this.items.length - 1, i + 1) : 0;
    else if (e.key === 'ArrowUp') i = valid ? Math.max(0, i - 1) : 0;
    else if (e.key === 'Enter' || e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      if (valid && this.o.onKey) this.o.onKey(this.items[i], e);
      return;
    } else return;
    e.preventDefault();
    this.sel = i;
    const fn = this.o.onSelect || this.o.onClick;
    if (fn) fn(this.items[i], e);
    this.scrollToIndex(i);
    this.draw(true);
  }
}
