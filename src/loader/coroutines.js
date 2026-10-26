// Coroutines for Banans (MelonCoroutines): generators stepped once per game frame.
//   this.startCoroutine(function* () { yield 2; /* seconds */ yield; /* next frame */ yield fetch(url); })
// Async generators work too: each step waits for the previous one to settle.

export class Coroutines {
  constructor(loader) {
    this.loader = loader;
    this.list = [];
  }

  start(owner, gen) {
    const it = typeof gen === 'function' ? gen.call(owner) : gen;
    if (!it || typeof it.next !== 'function') throw new TypeError('startCoroutine expects a generator');
    const async = typeof it[Symbol.asyncIterator] === 'function' && typeof it[Symbol.iterator] !== 'function';
    const c = { owner, it, async, until: 0, frames: 0, promise: null, settled: true, value: undefined, done: false };
    this.list.push(c);
    this._step(c);
    return c;
  }

  stop(c) { if (c) { c.done = true; this.list = this.list.filter((x) => x !== c); } }
  stopOwner(owner) { for (const c of this.list) if (c.owner === owner) c.done = true; this.list = this.list.filter((c) => !c.done); }

  _fail(c, e) {
    c.done = true;
    const log = c.owner && c.owner.logger ? c.owner.logger : this.loader.log;
    log.error('coroutine threw:', e && e.stack || e);
  }

  _step(c) {
    let r;
    try { r = c.it.next(c.value); } catch (e) { this._fail(c, e); return; }
    c.value = undefined;
    if (c.async) {
      // the step itself is a promise: wait for it, then handle what it yielded
      c.settled = false; c.until = 0; c.frames = 0;
      Promise.resolve(r).then((res) => { if (!c.done) this._result(c, res); }, (e) => { if (!c.done) this._fail(c, e); });
      return;
    }
    this._result(c, r);
  }

  _result(c, r) {
    if (!r || typeof r !== 'object') { this._fail(c, new TypeError(`iterator result is not an object (${r === null ? 'null' : typeof r})`)); return; }
    let y;
    try {
      if (r.done) { c.done = true; return; }
      y = r.value;
    } catch (e) { this._fail(c, e); return; }
    c.until = 0; c.frames = 0; c.promise = null; c.settled = true;
    if (typeof y === 'number') { c.until = performance.now() + y * 1000; return; }
    let then = null;
    try { then = y && (typeof y === 'object' || typeof y === 'function') ? y.then : null; } catch (e) { this._fail(c, e); return; }
    if (typeof then === 'function') {
      c.settled = false;
      c.promise = y;
      const ok = (v) => { c.value = v; c.settled = true; };
      const bad = (e) => { c.value = e; c.settled = true; };
      // a throwing then() is treated like a rejection
      try { then.call(y, ok, bad); } catch (e) { bad(e); }
      return;
    }
    try { if (y && typeof y === 'object' && y.frames) c.frames = y.frames; } catch (_) { /* ignore */ }
  }

  tick() {
    const now = performance.now();
    for (const c of this.list.slice()) {
      if (c.done) continue;
      if (!c.settled) continue;
      if (c.until && now < c.until) continue;
      if (c.frames > 1) { c.frames--; continue; }
      try { this._step(c); } catch (e) { this._fail(c, e); }
    }
    this.list = this.list.filter((c) => !c.done);
  }
}
