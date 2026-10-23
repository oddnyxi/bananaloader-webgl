// Banan: the base class every mod extends (MelonMod / MelonPlugin for JS).

export class Banan {
  // ---- lifecycle, all optional (same order as MelonLoader)
  /** Plugins: before the game's code runs (the wasm is instantiated, IL2CPP isn't). */
  onPreInitialize() {}
  /** Plugins: IL2CPP and the engine are ready, before mods initialize. */
  onApplicationStarted() {}
  /** IL2CPP is ready. Patch, read types, set up preferences here. */
  onInitializeBanan() {}
  /** After every Banan initialized and the first scene is up. */
  onLateInitializeBanan() {}
  /** onSceneWasLoaded(buildIndex, sceneName) */
  onSceneWasLoaded() {}
  /** One frame after a scene loaded (its Awake/Start have run). */
  onSceneWasInitialized() {}
  onSceneWasUnloaded() {}
  /** Every frame, after Unity's frame. */
  onUpdate() {}
  /** At Time.fixedDeltaTime steps. */
  onFixedUpdate() {}
  /** After every Banan's onUpdate. */
  onLateUpdate() {}
  /** onGUI(gui): draw on the overlay; gui.ctx is a CanvasRenderingContext2D. */
  onGUI() {}
  onPreferencesSaved() {}
  onPreferencesLoaded() {}
  /** The Banan is being unloaded (disabled, reloaded or deleted). Clean up here. */
  onDeinitializeBanan() {}
  onApplicationQuit() {}

  // ---- helpers (the loader fills in info, logger, loader before onPreInitialize)

  get il() { return this.loader.il; }
  get unity() { return this.loader.unity; }
  get Il2Cpp() { return this.loader.Il2Cpp; }

  /** This Banan's preference category. */
  get prefs() {
    if (!this._prefs) this._prefs = this.loader.prefs.createCategory(this.info.id, this.info.name, this);
    return this._prefs;
  }

  /** Shorthand for this.prefs.createEntry(...) */
  pref(id, def, name, o) { return this.prefs.createEntry(id, def, name, o); }

  /**
   * Harmony-style patch. target: 'Namespace.Type::Method'.
   * hooks: { prefix(ctx) -> false skips the original, postfix(ctx), sig: paramCount | ['System.String', ...], priority }
   */
  patch(target, hooks) {
    const p = this.loader.patcher.patch(this, target, hooks);
    return p;
  }

  unpatchAll() { this.loader.patcher.unpatchOwner(this); }

  /** Run a generator across frames. yield: nothing = next frame, a number = seconds, a Promise = until it settles. */
  startCoroutine(gen) { return this.loader.coroutines.start(this, gen); }
  stopCoroutine(c) { this.loader.coroutines.stop(c); }

  /** An Odium UI tab in the loader window, removed when the Banan unloads. */
  createTab(name, o = {}) { return this.loader.app.createBananTab(this, name, o); }

  /** A keyboard shortcut ('F5', 'Ctrl+K'), removed on unload. Works while the game has focus. */
  onKey(spec, fn) { return this.loader.app.bindKey(this, spec, fn); }

  /**
   * Another Banan's API (its `api` property, or the instance itself). Declare it with
   * `// @require Name` so it loads first; throws if it isn't loaded.
   */
  require(name) {
    const e = this.loader._entry(name);
    if (!e || e.state !== 'loaded') throw new Error(`${this.info.name} requires ${name}, which isn't loaded`);
    return e.instance.api !== undefined ? e.instance.api : e.instance;
  }

  /** Like require(), but returns null when the Banan isn't there (`// @optional Name`). */
  optional(name) {
    const e = this.loader._entry(name);
    return e && e.state === 'loaded' ? (e.instance.api !== undefined ? e.instance.api : e.instance) : null;
  }

  /** A toast in the loader window. */
  notify(text, type = 'info') { this.loader.app.notify(text, type); }

  /** setInterval / setTimeout that are cleared when the Banan unloads. */
  setInterval(fn, ms) { const id = setInterval(() => this.loader.safe(this, 'interval', fn), ms); this._timers.push(id); return id; }
  setTimeout(fn, ms) { const id = setTimeout(() => this.loader.safe(this, 'timeout', fn), ms); this._timers.push(id); return id; }
}

/** Plugins load first and get onPreInitialize / onApplicationStarted (MelonPlugin). */
export class BananPlugin extends Banan {}

// ---- source handling

/** Parse the // ==Banan== header. */
export function parseHeader(source) {
  const info = {};
  const m = /\/\/\s*==Banan==([\s\S]*?)\/\/\s*==\/Banan==/.exec(source);
  if (!m) return info;
  for (const line of m[1].split('\n')) {
    const x = /^\s*\/\/\s*@(\w+)\s+(.+?)\s*$/.exec(line);
    if (!x) continue;
    const k = x[1].toLowerCase();
    if (k === 'game' || k === 'require' || k === 'optional') (info[k] ||= []).push(x[2]);
    else info[k] = x[2];
  }
  return info;
}

export const slug = (s) => String(s || 'banan').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'banan';

/**
 * Evaluate Banan source. The code sees: module, exports, Banan, BananPlugin, BananaLoader,
 * Il2Cpp, il, unity, logger. It sets module.exports to a class (or an object of callbacks).
 */
export function compile(source, id, scope) {
  const module = { exports: {} };
  const names = ['module', 'exports', ...Object.keys(scope)];
  // eslint-disable-next-line no-new-func
  const fn = new Function(...names, `"use strict";\n${source}\n//# sourceURL=banan://${id}.js`);
  fn(module, module.exports, ...Object.values(scope));
  let ex = module.exports;
  if (ex && typeof ex === 'object' && typeof ex.default === 'function') ex = ex.default;
  return ex;
}

/** Turn whatever the source exported into a Banan instance. */
export function instantiate(ex) {
  if (typeof ex === 'function') {
    if (ex.prototype instanceof Banan || ex === Banan) return new ex();
    // a plain class or factory
    try { const o = new ex(); return adopt(o); } catch (_) { return adopt(ex()); }
  }
  if (ex && typeof ex === 'object' && Object.keys(ex).length) return adopt(ex);
  throw new Error('the Banan did not export anything (set module.exports = class extends Banan { ... })');
}

function adopt(o) {
  if (o instanceof Banan) return o;
  const b = new Banan();
  for (const k of Object.keys(o)) b[k] = typeof o[k] === 'function' ? o[k].bind(b) : o[k];
  // copy prototype methods of plain classes
  let proto = Object.getPrototypeOf(o);
  while (proto && proto !== Object.prototype) {
    for (const k of Object.getOwnPropertyNames(proto)) if (k !== 'constructor' && typeof o[k] === 'function' && !(k in b && b[k] !== Banan.prototype[k])) b[k] = o[k].bind(b);
    proto = Object.getPrototypeOf(proto);
  }
  return b;
}
