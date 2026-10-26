// The onGUI overlay: a transparent canvas over the page that Banans draw on each frame.

export class Overlay {
  constructor(loader) {
    this.loader = loader;
    this.canvas = null;
  }

  _ensure() {
    if (this.canvas) return;
    const c = (this.canvas = document.createElement('canvas'));
    c.id = 'bananaloader-gui';
    c.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:2147483646;';
    (document.body || document.documentElement).appendChild(c);
    this.ctx = c.getContext('2d');
    const self = this;
    this.gui = {
      get ctx() { return self.ctx; },
      get width() { return innerWidth; },
      get height() { return innerHeight; },
      text(str, x, y, o = {}) {
        const g = self.ctx;
        g.font = `${o.weight || 600} ${o.size || 13}px ${o.font || 'Inter, system-ui, sans-serif'}`;
        g.textAlign = o.align || 'left';
        g.textBaseline = o.baseline || 'top';
        x = Number(x) || 0; y = Number(y) || 0;
        if (o.shadow !== false) { g.fillStyle = 'rgba(0,0,0,.75)'; g.fillText(String(str), x + 1, y + 1); }
        g.fillStyle = o.color || '#ececf1';
        g.fillText(String(str), x, y);
      },
      box(x, y, w, h, o = {}) {
        const g = self.ctx;
        const r = o.radius ?? 8;
        g.beginPath();
        g.roundRect ? g.roundRect(x, y, w, h, r) : g.rect(x, y, w, h);
        if (o.fill !== false) { g.fillStyle = o.fill || 'rgba(9,9,11,.82)'; g.fill(); }
        if (o.stroke) { g.strokeStyle = o.stroke; g.lineWidth = o.lineWidth || 1; g.stroke(); }
      },
      line(x1, y1, x2, y2, o = {}) {
        const g = self.ctx;
        g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2);
        g.strokeStyle = o.color || '#e11d2e'; g.lineWidth = o.width || 1.5; g.stroke();
      },
      /** World position -> screen pixels using a Camera proxy (null if behind the camera). */
      worldToScreen(camera, pos) {
        const p = camera.WorldToScreenPoint(pos);
        if (!p || p.z < 0) return null;
        const cv = self.loader.Module && self.loader.Module.canvas;
        if (!cv) return { x: p.x / devicePixelRatio, y: innerHeight - p.y / devicePixelRatio };
        const r = cv.getBoundingClientRect();
        return { x: r.left + (p.x * r.width) / cv.width, y: r.top + r.height - (p.y * r.height) / cv.height };
      },
    };
  }

  frame() {
    const users = this.loader.loaded().filter((e) => this.loader._overrides(e.instance, 'onGUI'));
    if (!users.length) { if (this.canvas) this.canvas.style.display = 'none'; return; }
    this._ensure();
    const c = this.canvas;
    c.style.display = '';
    const dpr = devicePixelRatio || 1;
    const w = Math.round(innerWidth * dpr);
    const h = Math.round(innerHeight * dpr);
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, w, h);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (const e of users) {
      this.ctx.save();
      this.loader.safe(e.instance, 'onGUI', this.gui);
      this.ctx.restore();
    }
  }
}
