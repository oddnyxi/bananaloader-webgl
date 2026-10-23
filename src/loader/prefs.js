// BananaPreferences: MelonPreferences for Banans. Categories of typed entries, saved to
// localStorage and shown as controls in the loader's Preferences tab.

const KEY = 'bananaloader:prefs';

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
    this.kind = o.kind || (typeof def === 'boolean' ? 'bool' : typeof def === 'number' ? 'number' : 'string'); // 'key' | 'color' too
    this.hidden = !!o.hidden;
    this._listeners = [];
    const stored = cat.prefs._stored[cat.id] && cat.prefs._stored[cat.id][id];
    this._value = stored !== undefined && typeof stored === typeof def ? stored : def;
  }

  get value() { return this._value; }
  set value(v) { this.set(v); }

  set(v, silent = false) {
    if (this.kind === 'number') { v = Number(v); if (this.min != null) v = Math.max(this.min, v); if (this.max != null) v = Math.min(this.max, v); }
    if (this.kind === 'bool') v = !!v;
    const old = this._value;
    if (old === v) return;
    this._value = v;
    this.category.prefs._dirty();
    if (!silent) for (const fn of this._listeners) { try { fn(v, old); } catch (e) { console.error('[BananaLoader] pref listener', e); } }
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
    try { this._stored = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (_) { this._stored = {}; }
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

  removeOwner(owner) {
    for (const [id, c] of this.categories) if (c.owner === owner) this.categories.delete(id);
    this.emit('layout');
  }

  _dirty() {
    clearTimeout(this._t);
    this._t = setTimeout(() => this.save(), 400);
  }

  save() {
    clearTimeout(this._t);
    for (const [id, c] of this.categories) {
      const o = (this._stored[id] ||= {});
      for (const [eid, e] of c.entries) o[eid] = e.value;
    }
    try { localStorage.setItem(KEY, JSON.stringify(this._stored)); } catch (_) { /* ignore */ }
    this.emit('saved');
  }

  /** Re-read values from storage (e.g. after editing them elsewhere). */
  load() {
    try { this._stored = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (_) { return; }
    for (const [id, c] of this.categories) for (const [eid, e] of c.entries) {
      const v = this._stored[id] && this._stored[id][eid];
      if (v !== undefined) e.set(v);
    }
    this.emit('loaded');
  }
}
