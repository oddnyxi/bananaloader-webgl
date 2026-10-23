// Coroutines for Banans (MelonCoroutines): generators stepped once per game frame.
//   this.startCoroutine(function* () { yield 2; /* seconds */ yield; /* next frame */ yield fetch(url); })

export class Coroutines {
  constructor(loader) {
    this.loader = loader;
    this.list = [];
  }

  start(owner, gen) {
    const it = typeof gen === 'function' ? gen.call(owner) : gen;
    if (!it || typeof it.next !== 'function') throw new TypeError('startCoroutine expects a generator');
    const c = { owner, it, until: 0, frames: 0, promise: null, settled: true, value: undefined, done: false };
    this.list.push(c);
    this._step(c);
    return c;
  }

  stop(c) { if (c) { c.done = true; this.list = this.list.filter((x) => x !== c); } }
  stopOwner(owner) { for (const c of this.list) if (c.owner === owner) c.done = true; this.list = this.list.filter((c) => !c.done); }

  _step(c) {
    let r;
    try { r = c.it.next(c.value); } catch (e) {
      c.done = true;
      const log = c.owner && c.owner.logger ? c.owner.logger : this.loader.log;
      log.error('coroutine threw:', e && e.stack || e);
      return;
    }
    c.value = undefined;
    if (r.done) { c.done = true; return; }
    const y = r.value;
    c.until = 0; c.frames = 0; c.promise = null; c.settled = true;
    if (typeof y === 'number') c.until = performance.now() + y * 1000;
    else if (y && typeof y.then === 'function') {
      c.settled = false;
      c.promise = y;
      y.then((v) => { c.value = v; c.settled = true; }, (e) => { c.value = e; c.settled = true; });
    } else if (y && typeof y === 'object' && y.frames) c.frames = y.frames;
  }

  tick() {
    const now = performance.now();
    for (const c of this.list.slice()) {
      if (c.done) continue;
      if (!c.settled) continue;
      if (c.until && now < c.until) continue;
      if (c.frames > 1) { c.frames--; continue; }
      this._step(c);
    }
    this.list = this.list.filter((c) => !c.done);
  }
}
