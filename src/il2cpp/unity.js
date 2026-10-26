// UnityEngine helpers on top of the IL2CPP bridge: finding GameObjects, building the scene
// hierarchy, components, names and active state. Every engine API is looked up by name with
// fallbacks, because builds strip whatever the game never calls.

import { T } from './types.js';

export class UnityApi {
  constructor(il) {
    this.il = il;
    this._m = new Map();
    const td = (n) => il.findType(n);
    this.td = {
      Object: td('UnityEngine.Object'),
      GameObject: td('UnityEngine.GameObject'),
      Component: td('UnityEngine.Component'),
      Transform: td('UnityEngine.Transform'),
      MonoBehaviour: td('UnityEngine.MonoBehaviour'),
      Behaviour: td('UnityEngine.Behaviour'),
    };
    if (this.td.GameObject < 0) throw new Error('UnityEngine.GameObject not in metadata');
    // UnityEngine.Object.m_CachedPtr: non-zero while the native object is alive
    const f = il.fieldsOf(this.td.Object).find((x) => x.name === 'm_CachedPtr');
    this.cachedPtrOffset = f ? il.metaFieldOffset(this.td.Object, f.local) : 8;
  }

  /** First available method among candidates: [typeName, methodName, sig] */
  m(key, ...cands) {
    if (this._m.has(key)) return this._m.get(key);
    let found = null;
    for (const [t, n, s] of cands) {
      found = this.il.findMethod(t, n, s);
      if (found && !this.il.whyNotCallable(found)) break;
      found = null;
    }
    this._m.set(key, found);
    return found;
  }

  has(key) { return !!this._resolve(key); }

  _resolve(key) {
    const C = UnityApi.CANDIDATES[key];
    return C ? this.m(key, ...C) : null;
  }

  call(key, self, ...args) {
    const m = this._resolve(key);
    if (!m) throw new Error(`${key} is not available in this build`);
    return this.il.call(m, self, ...args);
  }

  try(key, self, ...args) {
    try { return this._resolve(key) ? this.il.call(this._resolve(key), self, ...args) : undefined; } catch (_) { return undefined; }
  }

  alive(obj) {
    const il = this.il;
    if (!obj || !il.mem.valid(obj)) return false;
    const k = il.klassOf(obj);
    if (!il.mem.valid(k)) return false;
    return il.mem.u32At(obj + this.cachedPtrOffset) !== 0;
  }

  isUnityObject(obj) { return this.td.Object >= 0 && this.il.isInstanceOf(obj, this.td.Object); }

  /**
   * Stricter than alive(), for objects found by scanning the heap: the native object must point
   * back at its managed wrapper (Unity keeps it in the native object's scripting handle). Stale
   * memory that merely looks like an object fails this, and calling the engine with one aborts
   * the game. The back-reference offset is learned from the first objects that have one.
   */
  verified(obj) {
    if (!this.alive(obj)) return false;
    const m = this.il.mem;
    const cp = m.u32At(obj + this.cachedPtrOffset);
    if (!m.valid(cp)) return false;
    if (this._backOff !== undefined) return m.u32At(cp + this._backOff) === obj;
    for (let o = 0; o < 160; o += 4) {
      if (m.u32At(cp + o) !== obj) continue;
      this._backVotes ||= new Map();
      const v = (this._backVotes.get(o) || 0) + 1;
      this._backVotes.set(o, v);
      if (v >= 3) this._backOff = o;
      return true;
    }
    return false;
  }

  name(obj) {
    if (!this.alive(obj)) return null;
    const n = this.try('name', obj);
    return n == null ? null : n;
  }

  typeObj(td) { return this.il.typeObjectOfTd(td); }

  /** Every GameObject the build lets us find. Returns { list, source }. */
  allGameObjects() {
    const il = this.il;
    const goTd = this.td.GameObject;
    const tries = [
      ['FindObjectsOfType(Type, bool)', () => this.call('findAllInactive', 0, this.typeObj(goTd), true)],
      ['FindObjectsByType', () => this.call('findByType', 0, this.typeObj(goTd), 1, 0)],
      ['Resources.FindObjectsOfTypeAll', () => this.call('findAllResources', 0, this.typeObj(goTd))],
      ['FindObjectsOfType(Type)', () => this.call('findActive', 0, this.typeObj(goTd))],
    ];
    for (const [source, fn] of tries) {
      try {
        const key = source;
        void key;
        const arr = fn();
        if (!arr) continue;
        const a = il.arrayInfo(arr);
        const list = [];
        for (let i = 0; i < a.length; i++) list.push(il.mem.u32At(a.data + i * 4));
        return { list, source };
      } catch (_) { /* try next */ }
    }
    // last resort: scan the heap for GameObject instances
    const k = il.klassOfTd(goTd);
    if (!k) return { list: [], source: 'none' };
    return { list: il.findInstances(k, { limit: 200000, validate: (a) => this.verified(a) }), source: 'heap scan' };
  }

  /** Objects of any UnityEngine.Object type (by type definition). */
  objectsOfType(td) {
    const il = this.il;
    const t = this.typeObj(td);
    for (const key of ['findAllInactive', 'findByType', 'findAllResources', 'findActive']) {
      if (!this._resolve(key)) continue;
      try {
        const arr = key === 'findAllInactive' ? this.call(key, 0, t, true) : key === 'findByType' ? this.call(key, 0, t, 1, 0) : this.call(key, 0, t);
        if (!arr) continue;
        const a = il.arrayInfo(arr);
        const list = [];
        for (let i = 0; i < a.length; i++) list.push(il.mem.u32At(a.data + i * 4));
        return list;
      } catch (_) { /* next */ }
    }
    const k = il.ensureClass(td);
    // heap scan: this class and everything derived from it (find('UnityEngine.Collider') finds BoxColliders)
    const klasses = il.subKlasses(td, [k]);
    return klasses.size ? il.findInstances(k, { validate: (a) => this.verified(a), klasses }) : [];
  }

  /**
   * Build the scene tree.
   * Returns { roots: Node[], byGo: Map, source }
   * Node = { go, tr, name, active, activeInHierarchy, children: Node[], parent, scene, hidden }
   */
  hierarchy() {
    const { list: found, source } = this.allGameObjects();
    // builds that can only list active objects would drop the ones turned off here; keep them
    let list = found;
    if (this._kept && this._kept.size) {
      const seen = new Set(found);
      const extra = [...this._kept].filter((go) => !seen.has(go) && this.alive(go));
      if (extra.length) list = found.concat(extra);
    }
    const byTr = new Map();
    const byGo = new Map();
    const nodes = [];
    // builds that stripped GameObject.get_transform: pair each Transform (found the same way) with its GameObject
    let trOf = null;
    if (!this.has('transform') && this.td.Transform >= 0) {
      trOf = new Map();
      try { for (const t of this.objectsOfType(this.td.Transform)) { const g = this.try('gameObject', t); if (g) trOf.set(g >>> 0, t); } } catch (_) { /* none */ }
      this._trOf = trOf; // components() falls back to it on the same builds
    }
    for (const go of list) {
      if (!this.alive(go)) continue;
      const tr = trOf ? trOf.get(go >>> 0) || 0 : this.try('transform', go);
      if (!tr && !trOf) continue;
      const n = {
        go, tr,
        name: this.name(go) ?? '?',
        active: this.isActive(go) ?? true,
        activeInHierarchy: this.try('activeInHierarchy', go),
        hideFlags: this.try('hideFlags', go) ?? 0,
        children: [],
        parent: null,
        scene: undefined,
      };
      if (tr) byTr.set(tr, n);
      byGo.set(go, n);
      nodes.push(n);
    }
    const roots = [];
    for (const n of nodes) {
      const p = n.tr ? this.try('parent', n.tr) : null;
      const pn = p ? byTr.get(p) : null;
      if (pn) { n.parent = pn; pn.children.push(n); } else roots.push(n);
    }
    // sibling order
    const order = (arr) => {
      if (this.has('siblingIndex')) {
        for (const n of arr) n._si = (n.tr && this.try('siblingIndex', n.tr)) ?? 0;
        arr.sort((a, b) => a._si - b._si);
      }
      arr.forEach((n) => order(n.children));
    };
    order(roots);
    // scenes
    for (const r of roots) {
      const s = this.try('scene', r.go);
      r.scene = s && typeof s === 'object' ? Object.values(s)[0] : s;
    }
    return { roots, byGo, source, count: nodes.length };
  }

  sceneName(handle) {
    if (handle == null) return null;
    if (this._sceneNames && this._sceneNames.has(handle)) return this._sceneNames.get(handle);
    let name = null;
    try {
      const m = this._resolve('sceneNameInternal');
      if (m) name = this.il.call(m, 0, handle);
    } catch (_) { /* ignore */ }
    if (!name) {
      // Scene.get_name is an instance method on the struct: pass the address of the handle
      const m = this._resolve('sceneName');
      if (m) {
        const buf = this.il.malloc(4);
        try { this.il.mem.setI32(buf, handle); name = this.il.call(m, buf); } catch (_) { /* ignore */ } finally { this.il.free(buf); }
      }
    }
    (this._sceneNames ||= new Map()).set(handle, name);
    return name;
  }

  components(go) {
    const il = this.il;
    const ct = this.typeObj(this.td.Component);
    let arr = 0;
    if (this.has('componentsInternal')) arr = this.try('componentsInternal', go, ct, false, false, true, false, 0);
    if (!arr && this.has('getComponents')) arr = this.try('getComponents', go, ct);
    if (arr) {
      const a = il.arrayInfo(arr);
      const out = [];
      for (let i = 0; i < a.length; i++) out.push(il.mem.u32At(a.data + i * 4));
      if (out.length) return out; // a GameObject always has a Transform: an empty list means the call didn't work
    }
    // fallback: at least the transform
    const tr = this.try('transform', go) || (this._trOf && this._trOf.get(go >>> 0)) || 0;
    return tr ? [tr] : [];
  }

  /**
   * Active state for display. Uses get_activeSelf when the build has it, else what we last set,
   * else activeInHierarchy; null when nothing can tell.
   */
  isActive(go) {
    if (this._soft && this._soft.has(go)) return false;
    const v = this.try('activeSelf', go);
    if (v !== undefined && v !== null) return !!v;
    if (this._state && this._state.has(go)) return this._state.get(go);
    const hi = this.try('activeInHierarchy', go);
    return hi === undefined || hi === null ? null : !!hi;
  }

  /**
   * Turn a GameObject on or off. Returns { mode, count? }:
   *   'native' — GameObject.SetActive (or the old `active` setter)
   *   'soft'   — the build has no SetActive (Unity strips it when the game never calls it), so the
   *              Renderers, Colliders and Behaviours on the object and its children were disabled
   *              instead (restored exactly when it's turned back on)
   * Throws with a readable reason when neither is possible, or when Unity didn't apply it.
   */
  setActive(go, v) {
    v = !!v;
    if (v && this._soft && this._soft.has(go)) return this._softRestore(go);
    const key = this.has('setActive') ? 'setActive' : this.has('setActiveObsolete') ? 'setActiveObsolete' : null;
    if (key) {
      // remember the subtree so the scene tree can still show it once it's inactive
      if (!v) { const kept = (this._kept ||= new Set()); for (const g of this._subtree(go)) kept.add(g); }
      this.call(key, go, v);
      (this._state ||= new Map()).set(go, v);
      const now = this.try('activeSelf', go);
      if (now !== undefined && now !== null && !!now !== v) {
        throw new Error(`Unity kept "${this.name(go) ?? 'the object'}" ${now ? 'active' : 'inactive'}: the game changed it back right away`);
      }
      return { mode: 'native' };
    }
    if (!v) return this._softDisable(go);
    return { mode: 'none' }; // nothing of ours to turn back on
  }

  /** The GameObject and every descendant, via Transform children or the scene tree. */
  _subtree(go) {
    const out = new Set([go]);
    const tr = this.try('transform', go);
    if (tr && this.has('childCount') && this.has('child') && this.has('gameObject')) {
      const walk = (t, d) => {
        const n = this.try('childCount', t) || 0;
        for (let i = 0; i < n && d < 64; i++) {
          const c = this.try('child', t, i);
          if (!c) continue;
          const g = this.try('gameObject', c);
          if (g) out.add(g);
          walk(c, d + 1);
        }
      };
      walk(tr, 0);
      return out;
    }
    try {
      const { byGo } = this.hierarchy();
      const n = byGo.get(go);
      const walk = (x) => { for (const c of x.children) { out.add(c.go); walk(c); } };
      if (n) walk(n);
    } catch (_) { /* just the object itself */ }
    return out;
  }

  _softDisable(go) {
    const il = this.il;
    const gos = this._subtree(go);
    const entries = [];
    const kinds = [
      ['UnityEngine.Renderer', 'rendererSet', 'rendererGet'],
      ['UnityEngine.Collider', 'colliderSet', 'colliderGet'],
      ['UnityEngine.Behaviour', 'behaviourSet', 'behaviourGet'],
    ];
    let comps = null;
    const compsOf = () => {
      if (comps) return comps;
      comps = [];
      if (this.has('componentsInternal') || this.has('getComponents')) for (const g of gos) comps.push(...this.components(g));
      return comps;
    };
    let setters = 0;
    for (const [type, set, get] of kinds) {
      if (!this.has(set)) continue;
      setters++;
      const td = il.findType(type);
      if (td < 0) continue;
      let list = compsOf().filter((c) => il.isInstanceOf(c, td));
      if (!list.length && this.has('gameObject')) {
        // no GetComponents: find every component of the type and keep the ones in this subtree
        try { list = this.objectsOfType(td).filter((c) => gos.has(this.try('gameObject', c))); } catch (_) { list = []; }
      }
      for (const c of list) {
        if (entries.some((e) => e.c === c)) continue;
        if (this.has(get) && this.try(get, c) === false) continue; // already off: leave it off on restore
        try { this.call(set, c, false); entries.push({ c, set }); } catch (_) { /* skip this one */ }
      }
    }
    if (!entries.length) {
      const what = `"${this.name(go) ?? 'this object'}"`;
      throw new Error(!setters
        ? `Can't turn ${what} off in this build: Unity stripped GameObject.SetActive (the game never calls it), and Renderer, Collider and Behaviour.enabled too`
        : `Can't turn ${what} off in this build: Unity stripped GameObject.SetActive (the game never calls it), and no enabled renderer, collider or behaviour could be found on it${this.has('gameObject') || this.has('componentsInternal') || this.has('getComponents') ? '' : ' (GetComponents and Component.gameObject are stripped too)'}`);
    }
    (this._soft ||= new Map()).set(go, entries);
    return { mode: 'soft', count: entries.length };
  }

  _softRestore(go) {
    const entries = this._soft.get(go) || [];
    this._soft.delete(go);
    for (const { c, set } of entries) { try { if (this.alive(c)) this.call(set, c, true); } catch (_) { /* gone */ } }
    return { mode: 'soft', count: entries.length };
  }
  destroy(obj) { return this.call('destroy', 0, obj); }
  setName(obj, name) { return this.call('setName', obj, name); }
  gameObjectOf(comp) { return this.try('gameObject', comp); }
}

UnityApi.CANDIDATES = {
  name: [['UnityEngine.Object', 'get_name', 0]],
  setName: [['UnityEngine.Object', 'set_name', 1]],
  hideFlags: [['UnityEngine.Object', 'get_hideFlags', 0]],
  destroy: [['UnityEngine.Object', 'Destroy', ['UnityEngine.Object']], ['UnityEngine.Object', 'Destroy', 2]],
  findAllInactive: [['UnityEngine.Object', 'FindObjectsOfType', ['System.Type', 'System.Boolean']]],
  findByType: [['UnityEngine.Object', 'FindObjectsByType', ['System.Type', 'UnityEngine.FindObjectsInactive', 'UnityEngine.FindObjectsSortMode']]],
  findActive: [['UnityEngine.Object', 'FindObjectsOfType', ['System.Type']]],
  findAllResources: [['UnityEngine.Resources', 'FindObjectsOfTypeAll', ['System.Type']]],
  transform: [['UnityEngine.GameObject', 'get_transform', 0]],
  gameObject: [['UnityEngine.Component', 'get_gameObject', 0]],
  activeSelf: [['UnityEngine.GameObject', 'get_activeSelf', 0]],
  activeInHierarchy: [['UnityEngine.GameObject', 'get_activeInHierarchy', 0]],
  setActive: [['UnityEngine.GameObject', 'SetActive', 1]],
  setActiveObsolete: [['UnityEngine.GameObject', 'set_active', 1]],
  rendererSet: [['UnityEngine.Renderer', 'set_enabled', 1]],
  rendererGet: [['UnityEngine.Renderer', 'get_enabled', 0]],
  colliderSet: [['UnityEngine.Collider', 'set_enabled', 1]],
  colliderGet: [['UnityEngine.Collider', 'get_enabled', 0]],
  behaviourSet: [['UnityEngine.Behaviour', 'set_enabled', 1]],
  behaviourGet: [['UnityEngine.Behaviour', 'get_enabled', 0]],
  scene: [['UnityEngine.GameObject', 'get_scene', 0]],
  sceneName: [['UnityEngine.SceneManagement.Scene', 'get_name', 0]],
  sceneNameInternal: [['UnityEngine.SceneManagement.Scene', 'GetNameInternal', 1]],
  parent: [['UnityEngine.Transform', 'get_parent', 0], ['UnityEngine.Transform', 'GetParent', 0], ['UnityEngine.Transform', 'get_parentInternal', 0]],
  siblingIndex: [['UnityEngine.Transform', 'GetSiblingIndex', 0]],
  childCount: [['UnityEngine.Transform', 'get_childCount', 0]],
  child: [['UnityEngine.Transform', 'GetChild', 1]],
  layer: [['UnityEngine.GameObject', 'get_layer', 0]],
  tag: [['UnityEngine.GameObject', 'get_tag', 0]],
  componentsInternal: [['UnityEngine.GameObject', 'GetComponentsInternal', 6]],
  getComponents: [['UnityEngine.GameObject', 'GetComponents', ['System.Type']]],
};

export const isRefKind = (k) => k === T.CLASS || k === T.OBJECT || k === T.STRING || k === T.SZARRAY || k === T.ARRAY || k === T.GENERICINST;
