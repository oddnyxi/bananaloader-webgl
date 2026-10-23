// In-game picker: hover the game to see what's under the cursor, click to select it.
// Tries, in order: UI (RectTransforms of graphics on canvases), 3D physics raycast, 2D physics.

import { T } from '../il2cpp/types.js';

export class Picker {
  /**
   * @param app   explorer app ({ il, unity, ui, Module? })
   * @param o     { onPick(go), getCanvas() }
   */
  constructor(app, o = {}) {
    this.app = app;
    this.o = o;
    this.active = false;
    this._m = new Map();
    this._ui = null;
  }

  get il() { return this.app.il; }
  get unity() { return this.app.unity; }

  canvas() {
    if (this.o.getCanvas) { const c = this.o.getCanvas(); if (c) return c; }
    const M = this.app.Module;
    return (M && M.canvas) || document.querySelector('#unity-canvas, #unityContainer canvas, canvas');
  }

  // ------------------------------------------------------------------ method lookup

  m(key, cands) {
    if (this._m.has(key)) return this._m.get(key);
    let found = null;
    for (const [t, n, s] of cands) {
      const x = this.il.findMethod(t, n, s);
      if (x && !this.il.whyNotCallable(x)) { found = x; break; }
    }
    this._m.set(key, found);
    return found;
  }

  call(key, cands, self, ...args) {
    const m = this.m(key, cands);
    if (!m) return undefined;
    try { return this.il.invoke(m, self, args); } catch (_) { return undefined; }
  }

  camera() {
    const r = this.call('main', [['UnityEngine.Camera', 'get_main', 0]], 0);
    if (r && r.value) return r.value >>> 0;
    const td = this.il.findType('UnityEngine.Camera');
    const cams = td >= 0 ? this.unity.objectsOfType(td).filter((c) => this.unity.alive(c)) : [];
    return cams[0] || 0;
  }

  toScreen(cx, cy) {
    const c = this.canvas();
    const r = c.getBoundingClientRect();
    return { x: ((cx - r.left) * c.width) / r.width, y: ((r.bottom - cy) * c.height) / r.height };
  }

  toClient(sx, sy) {
    const c = this.canvas();
    const r = c.getBoundingClientRect();
    return { x: r.left + (sx * r.width) / c.width, y: r.bottom - (sy * r.height) / c.height };
  }

  worldToClient(cam, p) {
    const r = this.call('w2s', [['UnityEngine.Camera', 'WorldToScreenPoint', ['UnityEngine.Vector3']]], cam, p);
    if (!r || !r.value || r.value.z < 0) return null;
    return this.toClient(r.value.x, r.value.y);
  }

  // ------------------------------------------------------------------ probes

  probe(cx, cy) {
    const s = this.toScreen(cx, cy);
    const cam = this.camera();
    return this.probeUI(s) || (cam && this.probe3D(cam, s)) || (cam && this.probe2D(cam, s)) || null;
  }

  probe3D(cam, s) {
    const ray = this.call('s2r', [['UnityEngine.Camera', 'ScreenPointToRay', ['UnityEngine.Vector3']]], cam, { x: s.x, y: s.y, z: 0 });
    if (!ray || !ray.value) return null;
    const R = ray.value;
    const origin = R.m_Origin || R.origin;
    const dir = R.m_Direction || R.direction;
    const cands = [
      [['UnityEngine.Ray', 'UnityEngine.RaycastHit&', 'float'], () => [R, null, 100000]],
      [['UnityEngine.Ray', 'UnityEngine.RaycastHit&'], () => [R, null]],
      [['UnityEngine.Ray', 'UnityEngine.RaycastHit&', 'float', 'int'], () => [R, null, 100000, -5]],
      [['UnityEngine.Vector3', 'UnityEngine.Vector3', 'UnityEngine.RaycastHit&', 'float'], () => [origin, dir, null, 100000]],
      [['UnityEngine.Vector3', 'UnityEngine.Vector3', 'UnityEngine.RaycastHit&', 'float', 'int'], () => [origin, dir, null, 100000, -5]],
      [['UnityEngine.Vector3', 'UnityEngine.Vector3', 'UnityEngine.RaycastHit&'], () => [origin, dir, null]],
    ];
    let hit = null;
    for (const [sig, args] of cands) {
      const m = this.m('ray:' + sig.join(','), [['UnityEngine.Physics', 'Raycast', sig]]);
      if (!m) continue;
      try {
        const r = this.il.invoke(m, 0, args());
        if (r.value) hit = r.outs[0] && r.outs[0].value;
      } catch (_) { continue; }
      break;
    }
    if (!hit) {
      const all = this.call('rayall', [['UnityEngine.Physics', 'RaycastAll', ['UnityEngine.Ray']], ['UnityEngine.Physics', 'RaycastAll', ['UnityEngine.Ray', 'float']]], 0, R, 100000);
      if (all && all.value) {
        const a = this.il.arrayInfo(all.value >>> 0);
        for (let i = 0; i < a.length; i++) {
          const h = this.il.readDeep(a.data + i * a.elemSize, a.elemType);
          if (!hit || h.m_Distance < hit.m_Distance) hit = h;
        }
      }
    }
    if (!hit) return null;
    const col = this._colliderOf(hit);
    const go = col && this.unity.gameObjectOf(col);
    if (!go) return null;
    return { go, kind: '3D', detail: this.il.klassName(this.il.klassOf(col), false), point: hit.m_Point, distance: hit.m_Distance, box: this._bounds(cam, go) };
  }

  _colliderOf(hit) {
    const v = hit.m_Collider !== undefined ? hit.m_Collider : hit.collider;
    if (typeof v !== 'number' || !v) return 0;
    if (this.il.mem.valid(v) && this.il.mem.valid(this.il.klassOf(v)) && this.unity.isUnityObject(v)) return v; // older Unity: a reference
    const r = this.call('fromId', [['UnityEngine.Object', 'FindObjectFromInstanceID', 1]], 0, v);
    return r && r.value ? r.value >>> 0 : 0;
  }

  probe2D(cam, s) {
    const w = this.call('s2w', [['UnityEngine.Camera', 'ScreenToWorldPoint', ['UnityEngine.Vector3']]], cam, { x: s.x, y: s.y, z: 0 });
    if (!w || !w.value) return null;
    const r = this.call('ov2d', [['UnityEngine.Physics2D', 'OverlapPoint', ['UnityEngine.Vector2']]], 0, { x: w.value.x, y: w.value.y });
    const col = r && r.value ? r.value >>> 0 : 0;
    const go = col && this.unity.gameObjectOf(col);
    if (!go) return null;
    return { go, kind: '2D', detail: this.il.klassName(this.il.klassOf(col), false), box: this._bounds(cam, go) };
  }

  /** Screen-space box of a GameObject's renderer (or collider) bounds. */
  _bounds(cam, go) {
    const il = this.il;
    for (const c of this.unity.components(go)) {
      const td = il.tdOfKlass(il.klassOf(c));
      const m = il.findMethod(td, 'get_bounds', 0);
      if (!m || il.whyNotCallable(m)) continue;
      let b;
      try { b = il.invoke(m, c, []).value; } catch (_) { continue; }
      if (!b) continue;
      const ctr = b.m_Center;
      const ext = b.m_Extents;
      if (!ctr || !ext) continue;
      const pts = [];
      for (const dx of [-1, 1]) for (const dy of [-1, 1]) for (const dz of [-1, 1]) {
        const p = this.worldToClient(cam, { x: ctr.x + dx * ext.x, y: ctr.y + dy * ext.y, z: ctr.z + dz * ext.z });
        if (p) pts.push(p);
      }
      if (pts.length < 2) continue;
      const xs = pts.map((p) => p.x);
      const ys = pts.map((p) => p.y);
      return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
    }
    return null;
  }

  // ---- UI

  _uiRects() {
    const now = performance.now();
    if (this._ui && now - this._ui.t < 700) return this._ui.list;
    const il = this.il;
    const u = this.unity;
    const rtTd = il.findType('UnityEngine.RectTransform');
    const graphicTd = il.findType('UnityEngine.UI.Graphic');
    const canvasTd = il.findType('UnityEngine.Canvas');
    const list = [];
    if (rtTd < 0 || canvasTd < 0) { this._ui = { t: now, list }; return list; }
    const h = u.hierarchy();
    const canvasOf = new Map(); // go -> canvas info
    const cam = this.camera();
    let order = 0;
    const walk = (n, canvas) => {
      if (n.activeInHierarchy === false || n.active === false) return;
      const comps = u.components(n.go);
      const cv = comps.find((c) => il.isInstanceOf(c, canvasTd));
      if (cv) {
        const mode = this.call('rm', [['UnityEngine.Canvas', 'get_renderMode', 0]], cv);
        const sort = this.call('so', [['UnityEngine.Canvas', 'get_sortingOrder', 0]], cv);
        const wc = this.call('wc', [['UnityEngine.Canvas', 'get_worldCamera', 0]], cv);
        canvas = { mode: mode ? mode.value : 0, sort: sort ? sort.value : 0, cam: wc && wc.value ? wc.value >>> 0 : cam };
        canvasOf.set(n.go, canvas);
      }
      if (canvas && il.tdOfKlass(il.klassOf(n.tr)) === rtTd) {
        const g = graphicTd >= 0 ? comps.find((c) => il.isInstanceOf(c, graphicTd)) : null;
        if (g) {
          const box = this._rectBox(n.tr, canvas);
          if (box) list.push({ go: n.go, box, canvas, order: order++, detail: il.klassName(il.klassOf(g), false) });
        }
      }
      for (const c of n.children) walk(c, canvas);
    };
    for (const r of h.roots) walk(r, null);
    this._ui = { t: now, list };
    return list;
  }

  _rectBox(tr, canvas) {
    const r = this.call('rect', [['UnityEngine.RectTransform', 'get_rect', 0]], tr);
    if (!r || !r.value) return null;
    const R = r.value;
    const x0 = R.m_XMin;
    const y0 = R.m_YMin;
    const x1 = x0 + R.m_Width;
    const y1 = y0 + R.m_Height;
    const pts = [];
    for (const [x, y] of [[x0, y0], [x1, y0], [x0, y1], [x1, y1]]) {
      const w = this.call('tp', [['UnityEngine.Transform', 'TransformPoint', ['UnityEngine.Vector3']]], tr, { x, y, z: 0 });
      if (!w || !w.value) return null;
      const p = canvas.mode === 0 ? this.toClient(w.value.x, w.value.y) : this.worldToClient(canvas.cam, w.value);
      if (!p) return null;
      pts.push(p);
    }
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  }

  probeUI(s) {
    const c = this.toClient(s.x, s.y);
    let best = null;
    for (const e of this._uiRects()) {
      const b = e.box;
      if (c.x < b.x || c.x > b.x + b.w || c.y < b.y || c.y > b.y + b.h) continue;
      const rank = [e.canvas.mode === 0 ? 1 : 0, e.canvas.sort, e.order];
      if (!best || cmp(rank, best.rank) > 0) best = { ...e, rank };
    }
    return best ? { go: best.go, kind: 'UI', detail: best.detail, box: best.box } : null;
  }

  // ------------------------------------------------------------------ interaction

  start() {
    if (this.active) return;
    const cv = this.canvas();
    if (!cv) { this.app.ui.notify('No game canvas found', 'warn'); return; }
    this.active = true;
    this._ui = null;
    try { document.exitPointerLock && document.exitPointerLock(); } catch (_) { /* ignore */ }
    const wasVisible = this.app.ui.win && !this.app.ui.win.classList.contains('hidden');
    this._restore = wasVisible;
    this.app.ui.hide();
    const ov = (this.ov = document.createElement('div'));
    ov.style.cssText = 'position:fixed;inset:0;z-index:2147483646;cursor:crosshair;';
    const g = (this.g = document.createElement('canvas'));
    g.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;';
    const tip = (this.tip = document.createElement('div'));
    tip.style.cssText = 'position:absolute;pointer-events:none;padding:7px 10px;border-radius:8px;background:rgba(9,9,11,.92);border:1px solid #e11d2e;color:#ececf1;font:600 12px Inter,system-ui,sans-serif;white-space:nowrap;box-shadow:0 8px 24px rgba(0,0,0,.5);display:none;';
    const hint = document.createElement('div');
    hint.style.cssText = 'position:absolute;left:50%;top:14px;transform:translateX(-50%);padding:8px 14px;border-radius:9px;background:rgba(9,9,11,.9);border:1px solid #26262d;color:#ececf1;font:600 12.5px Inter,system-ui,sans-serif;pointer-events:none;';
    hint.innerHTML = '<span style="color:#ff3d4d">●</span>&nbsp; Click an object to select it · <b>Esc</b> to cancel';
    ov.append(g, tip, hint);
    document.body.appendChild(ov);
    let pending = null;
    let last = 0;
    this._move = (e) => {
      pending = [e.clientX, e.clientY];
      const now = performance.now();
      if (now - last < 90) return;
      last = now;
      this._hover(...pending);
    };
    this._click = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const hit = this._probeSafe(e.clientX, e.clientY);
      this.stop();
      if (hit && this.o.onPick) this.o.onPick(hit.go, hit);
      else if (!hit) this.app.ui.notify('Nothing there to select', 'info', 1500);
    };
    this._key = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.stop(); } };
    ov.addEventListener('mousemove', this._move);
    ov.addEventListener('click', this._click);
    ov.addEventListener('contextmenu', (e) => { e.preventDefault(); this.stop(); });
    window.addEventListener('keydown', this._key, true);
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    window.removeEventListener('keydown', this._key, true);
    if (this.ov) this.ov.remove();
    this.ov = null;
    if (this._restore) this.app.ui.show();
  }

  _probeSafe(x, y) {
    try { return this.probe(x, y); } catch (e) { console.warn('[picker]', e); return null; }
  }

  _hover(x, y) {
    if (!this.active) return;
    const hit = this._probeSafe(x, y);
    const g = this.g;
    const dpr = devicePixelRatio || 1;
    g.width = innerWidth * dpr;
    g.height = innerHeight * dpr;
    const ctx = g.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    if (!hit) { this.tip.style.display = 'none'; return; }
    if (hit.box) {
      const b = hit.box;
      ctx.fillStyle = 'rgba(225,29,46,.14)';
      ctx.strokeStyle = '#ff3d4d';
      ctx.lineWidth = 1.5;
      ctx.fillRect(b.x, b.y, b.w, b.h);
      ctx.strokeRect(b.x + 0.5, b.y + 0.5, b.w, b.h);
    }
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fillStyle = '#ff3d4d';
    ctx.fill();
    const name = this.unity.name(hit.go) ?? '?';
    this.tip.innerHTML = `${esc(name)} <span style="color:#8a8a96;font-weight:500">· ${hit.kind} · ${esc(hit.detail || '')}${hit.distance != null ? ` · ${hit.distance.toFixed(1)}m` : ''}</span>`;
    this.tip.style.display = '';
    const tx = Math.min(x + 14, innerWidth - this.tip.offsetWidth - 8);
    const ty = Math.min(y + 16, innerHeight - this.tip.offsetHeight - 8);
    this.tip.style.left = tx + 'px';
    this.tip.style.top = ty + 'px';
  }
}

function cmp(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
void T;
