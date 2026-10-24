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
    return k ? il.findInstances(k, { validate: (a) => this.verified(a) }) : [];
  }

  /**
   * Build the scene tree.
   * Returns { roots: Node[], byGo: Map, source }
   * Node = { go, tr, name, active, activeInHierarchy, children: Node[], parent, scene, hidden }
   */
  hierarchy() {
    const { list, source } = this.allGameObjects();
    const byTr = new Map();
    const byGo = new Map();
    const nodes = [];
    for (const go of list) {
      if (!this.alive(go)) continue;
      const tr = this.try('transform', go);
      if (!tr) continue;
      const n = {
        go, tr,
        name: this.name(go) ?? '?',
        active: this.try('activeSelf', go) ?? true,
        activeInHierarchy: this.try('activeInHierarchy', go),
        hideFlags: this.try('hideFlags', go) ?? 0,
        children: [],
        parent: null,
        scene: undefined,
      };
      byTr.set(tr, n);
      byGo.set(go, n);
      nodes.push(n);
    }
    const roots = [];
    for (const n of nodes) {
      const p = this.try('parent', n.tr);
      const pn = p ? byTr.get(p) : null;
      if (pn) { n.parent = pn; pn.children.push(n); } else roots.push(n);
    }
    // sibling order
    const order = (arr) => {
      if (this.has('siblingIndex')) {
        for (const n of arr) n._si = this.try('siblingIndex', n.tr) ?? 0;
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
      return out;
    }
    // fallback: at least the transform
    const tr = this.try('transform', go);
    return tr ? [tr] : [];
  }

  setActive(go, v) { return this.call('setActive', go, !!v); }
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
