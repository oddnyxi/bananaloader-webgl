// BananaPreferences: MelonPreferences for Banans. Categories of typed entries, saved to
// localStorage and shown as controls in the loader's Preferences tab.

const KEY = 'bananaloader:prefs';

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
/** Stored prefs as prototype-free maps (a Banan or entry called "constructor" or "keys" is just a name). */
function clean(raw) {
  const out = Object.create(null);
  if (!isObj(raw)) return out;
  for (const id of Object.keys(raw)) {
    if (!isObj(raw[id])) continue;
    const c = (out[id] = Object.create(null));
    for (const k of Object.keys(raw[id])) c[k] = raw[id][k];
  }
  return out;
}
function readStored() {
  try { return clean(JSON.parse(localStorage.getItem(KEY) || '{}')); } catch (_) { return Object.create(null); }
}
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

export class Entry {
  constructor(cat, id, def, name, o = {}) {
    this.category = cat;
    this.id = id;
    this.name = name || id;
    this.default = def;
    this.description = o.description || '';
    this.min = o.min;
    this.max = o.max;
    this.step = o.step;
    this.options = o.options;      // string[] -> dropdown
    // 'key' | 'color' too; objects and arrays are kept as JSON (hidden prefs a Banan manages itself)
    this.kind = o.kind || (typeof def === 'boolean' ? 'bool' : typeof def === 'number' ? 'number' : def && typeof def === 'object' ? 'json' : 'string');
    this.hidden = !!o.hidden;
    this._listeners = [];
    const store = cat.prefs._stored[cat.id];
    const stored = store && own(store, id) ? this._coerce(store[id]) : undefined;
    this._value = stored !== undefined ? stored : this._coerce(def) ?? def;
    if (this.kind === 'json') { try { this._json = JSON.stringify(this._value); } catch (_) { this._json = ''; } }
  }

  /** v as this entry's type (numbers clamped), or undefined when it can't be. */
  _coerce(v) {
    switch (this.kind) {
      case 'number': {
        if (v === null || v === undefined || v === '' || typeof v === 'boolean') return undefined;
        let n = Number(v);
        if (!Number.isFinite(n)) return undefined;
        if (this.min != null) n = Math.max(this.min, n);
        if (this.max != null) n = Math.min(this.max, n);
        return n;
      }
      case 'bool': return typeof v === 'string' ? v === 'true' || v === '1' : !!v;
      case 'json': return v && typeof v === 'object' && Array.isArray(v) === Array.isArray(this.default) ? v : undefined;
      default: return v === null || v === undefined ? undefined : typeof v === 'object' ? undefined : String(v);
    }
  }

  get value() { return this._value; }
  set value(v) { this.set(v); }

  set(v, silent = false) { this._apply(v, { silent, persist: true }); }

  _apply(v, { silent = false, persist = true } = {}) {
    const c = this._coerce(v);
    if (c === undefined) return; // not a valid value for this entry: keep the current one
    const old = this._value;
    if (this.kind === 'json') {
      // objects can be changed in place and set again, so compare their contents
      let j;
      try { j = JSON.stringify(c); } catch (_) { return; }
      if (j === this._json) return;
      this._json = j;
    } else if (old === c) return;
    this._value = c;
    if (persist) this.category.prefs._dirty();
    if (!silent) for (const fn of this._listeners) { try { fn(c, old); } catch (e) { console.error('[BananaLoader] pref listener', e); } }
    this.category.prefs.emit('change', this);
  }

  reset() { this.set(this.default); }

  /** fn(newValue, oldValue) */
  onChange(fn) { this._listeners.push(fn); return () => { this._listeners = this._listeners.filter((x) => x !== fn); }; }
}

export class Category {
  constructor(prefs, id, name, owner) {
    this.prefs = prefs;
    this.id = id;
    this.name = name || id;
    this.owner = owner || null;
    this.entries = new Map();
  }

  /** createEntry('speed', 1, 'Game speed', { min: 0, max: 5, step: 0.1, description }) */
  createEntry(id, def, name, o) {
    if (this.entries.has(id)) return this.entries.get(id);
    const e = new Entry(this, id, def, name, o);
    this.entries.set(id, e);
    this.prefs.emit('layout');
    return e;
  }

  getEntry(id) { return this.entries.get(id); }
  get(id) { const e = this.entries.get(id); return e ? e.value : undefined; }
  set(id, v) { const e = this.entries.get(id); if (e) e.value = v; }
}

export class Preferences {
  constructor() {
    this.categories = new Map();
    this._ev = {};
    this._stored = readStored();
    this._t = null;
  }

  on(ev, fn) { (this._ev[ev] ||= []).push(fn); }
  emit(ev, ...a) { for (const fn of this._ev[ev] || []) { try { fn(...a); } catch (_) { /* ignore */ } } }

  createCategory(id, name, owner) {
    if (this.categories.has(id)) return this.categories.get(id);
    const c = new Category(this, id, name, owner);
    this.categories.set(id, c);
    this.emit('layout');
    return c;
  }

  getCategory(id) { return this.categories.get(id); }

  /** Move stored values to a new category id (a Banan whose id changed keeps its settings). */
  renameCategory(from, to) {
    if (from === to) return;
    if (own(this._stored, from) && !own(this._stored, to)) { this._stored[to] = this._stored[from]; delete this._stored[from]; }
    const c = this.categories.get(from);
    if (c && !this.categories.has(to)) { this.categories.delete(from); c.id = to; this.categories.set(to, c); }
    this._write();
  }

  removeOwner(owner) {
    for (const [id, c] of this.categories) if (c.owner === owner) this.categories.delete(id);
    this.emit('layout');
  }

  _dirty() {
    clearTimeout(this._t);
    this._t = setTimeout(() => this.save(), 400);
  }

  _write() {
    try { localStorage.setItem(KEY, JSON.stringify(this._stored)); } catch (_) { /* ignore */ }
  }

  /** Write every value to storage. silent: without the onPreferencesSaved event. */
  save(silent = false) {
    clearTimeout(this._t);
    for (const [id, c] of this.categories) {
      const o = own(this._stored, id) ? this._stored[id] : (this._stored[id] = Object.create(null));
      for (const [eid, e] of c.entries) o[eid] = e.value;
    }
    this._write();
    if (!silent) this.emit('saved');
  }

  /** Re-read values from storage (e.g. after editing them elsewhere). Doesn't write anything back. */
  load() {
    this._stored = readStored();
    for (const [id, c] of this.categories) {
      const store = own(this._stored, id) ? this._stored[id] : null;
      for (const [eid, e] of c.entries) if (store && own(store, eid)) e._apply(store[eid], { persist: false });
    }
    this.emit('loaded');
  }
}
