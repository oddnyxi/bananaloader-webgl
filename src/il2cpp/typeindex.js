// Name index over the metadata: every type by full name, short names for bare `Camera.main`
// access in the consoles and Banans, and the namespace tree for `UnityEngine.` completion.
//
// Built lazily (one pass over the type definitions, a few ms even on big games).

/** ECMAScript built-ins and the handful of web globals scripts rely on: these always keep their JS meaning. */
export const CORE_GLOBALS = new Set(`Object Function Array Number Boolean String Symbol BigInt Math JSON Date RegExp Error
TypeError RangeError SyntaxError ReferenceError EvalError URIError AggregateError Promise Proxy Reflect Map Set WeakMap WeakSet
WeakRef FinalizationRegistry ArrayBuffer SharedArrayBuffer DataView Atomics Int8Array Uint8Array Uint8ClampedArray Int16Array
Uint16Array Int32Array Uint32Array Float32Array Float64Array BigInt64Array BigUint64Array Intl globalThis Infinity NaN undefined
eval isFinite isNaN parseFloat parseInt decodeURI decodeURIComponent encodeURI encodeURIComponent escape unescape
window self document console setTimeout setInterval clearTimeout clearInterval requestAnimationFrame cancelAnimationFrame
queueMicrotask structuredClone fetch location navigator performance localStorage sessionStorage alert confirm prompt
URL URLSearchParams Blob File FileReader TextEncoder TextDecoder WebAssembly atob btoa crypto Worker AbortController
Headers Request Response FormData XMLHttpRequest WebSocket BroadcastChannel MessageChannel CustomEvent EventTarget
HTMLElement HTMLCanvasElement HTMLImageElement Node Element getComputedStyle Audio AudioContext OffscreenCanvas
arguments this module exports Banan BananPlugin BananaLoader Il2Cpp il unity logger`.split(/\s+/));

const RESERVED = new Set(`break case catch class const continue debugger default delete do else enum export extends false finally
for function if import in instanceof let new null return static super switch this throw true try typeof var void while with yield
await async of get set`.split(/\s+/));

export class TypeIndex {
  constructor(il) {
    this.il = il;
    this._built = false;
  }

  build() {
    if (this._built) return this;
    const il = this.il;
    const md = il.md;
    const t0 = performance.now();
    this.types = [];            // [{ td, full, short, ns, generic, arity, nested, rank }]
    this.byShort = new Map();   // short name -> td (best ranked, top-level, non-generic)
    this.shortAll = new Map();  // short name -> [td] (every candidate, for the disambiguation note)
    this.namespaces = new Set();
    this.roots = new Set();
    this.children = new Map();  // namespace -> Set(child namespace segment)
    this.nsTypes = new Map();   // namespace -> [entry]
    for (let td = 0; td < md.typeCount; td++) {
      const d = md.typeDef(td);
      if (!d.name || d.name.includes('<') || d.name === '<Module>') continue;
      const nested = d.declaringTypeIndex >= 0;
      const full = il.tdFullName(td);
      if (full.includes('<')) continue;
      const short = d.name.replace(/`\d+$/, '');
      const arity = d.isGeneric ? md.genericParamNames(d.genericContainerIndex).length : 0;
      const e = { td, full, short, ns: d.namespace, generic: d.isGeneric, arity, nested, rank: this._rank(d) };
      this.types.push(e);
      if (nested) continue;
      if (d.namespace) {
        const parts = d.namespace.split('.');
        let acc = '';
        for (const p of parts) {
          const parent = acc;
          acc = acc ? `${acc}.${p}` : p;
          if (!this.namespaces.has(acc)) {
            this.namespaces.add(acc);
            if (!this.children.has(parent)) this.children.set(parent, new Set());
            this.children.get(parent).add(p);
          }
        }
        this.roots.add(parts[0]);
      }
      if (!this.nsTypes.has(d.namespace)) this.nsTypes.set(d.namespace, []);
      this.nsTypes.get(d.namespace).push(e);
      if (d.isGeneric || !/^[A-Za-z_$][\w$]*$/.test(short)) continue;
      if (!this.shortAll.has(short)) this.shortAll.set(short, []);
      this.shortAll.get(short).push(td);
      const cur = this.byShort.get(short);
      if (cur === undefined || e.rank < this._entryRank(cur)) this.byShort.set(short, td);
    }
    this.byTd = new Map(this.types.map((e) => [e.td, e]));
    this._rankOf = new Map(this.types.map((e) => [e.td, e.rank]));
    this.ms = Math.round(performance.now() - t0);
    this._built = true;
    return this;
  }

  _entryRank(td) { return this._rankOf ? this._rankOf.get(td) : this._rank(this.il.md.typeDef(td)); }

  /** Lower is preferred when several types share a short name: UnityEngine, then the game, then System. */
  _rank(d) {
    const ns = d.namespace || '';
    const img = (this.il.md.images[d.image] || {}).name || '';
    let r;
    if (ns === 'UnityEngine') r = 0;
    else if (ns.startsWith('UnityEngine.')) r = 1;
    else if (/^Assembly-CSharp/i.test(img)) r = 2;
    else if (ns === 'System') r = 3;
    else if (ns.startsWith('System.')) r = 5;
    else if (/^(mscorlib|System|Mono\.|netstandard)/.test(img)) r = 6;
    else r = 4;
    if ((d.flags & 0x7) !== 1) r += 10; // not public
    return r;
  }

  entry(td) { this.build(); return this.byTd.get(td); }

  /**
   * Can `name` be used bare? Core JS names always win; other browser globals (Screen, Image, Event…)
   * win too unless `unityFirst` is set (the consoles), so existing Banans keep working.
   */
  bareKind(name, unityFirst) {
    if (typeof name !== 'string' || RESERVED.has(name) || CORE_GLOBALS.has(name)) return null;
    if (!unityFirst && name in globalThis) return null;
    this.build();
    if (this.byShort.has(name)) return 'type';
    if (this.roots.has(name)) return 'ns';
    return null;
  }

  /** Types and child namespaces of a namespace ('' = global namespace). */
  namespaceMembers(ns) {
    this.build();
    return { namespaces: [...(this.children.get(ns) || [])], types: this.nsTypes.get(ns) || [] };
  }

  isNamespace(ns) { this.build(); return this.namespaces.has(ns); }

  /**
   * A `with` scope object that maps bare type names to Il2Cpp.type proxies and root namespaces to
   * namespace proxies. Identifiers it doesn't know fall through to the enclosing scope as usual.
   */
  scope(interop, { unityFirst = false } = {}) {
    const self = this;
    const nsCache = new Map();
    // a type in namespace ns by its short name; generic types by arity-stripped name ("List" → List`1)
    const typeIn = (ns, k) => {
      const td = self.il.findType(`${ns}.${k}`);
      if (td >= 0) return td;
      const cands = (self.namespaceMembers(ns).types || []).filter((e) => e.short === k);
      cands.sort((a, b) => a.arity - b.arity);
      return cands.length ? cands[0].td : -1;
    };
    const nsProxy = (ns) => {
      if (nsCache.has(ns)) return nsCache.get(ns);
      const p = new Proxy(Object.create(null), {
        get(_, k) {
          if (typeof k !== 'string') return undefined;
          if (k === 'toString') return () => `[Il2Cpp namespace ${ns}]`;
          if (k === 'then') return undefined;
          const td = typeIn(ns, k);
          if (td >= 0) return interop.typeProxy(td);
          if (self.isNamespace(`${ns}.${k}`)) return nsProxy(`${ns}.${k}`);
          return undefined;
        },
        has(_, k) { return typeof k === 'string' && (typeIn(ns, k) >= 0 || self.isNamespace(`${ns}.${k}`)); },
        ownKeys() { const m = self.namespaceMembers(ns); return [...new Set([...m.namespaces, ...m.types.map((e) => e.short)])]; },
        getOwnPropertyDescriptor(_, k) {
          if (!this.has(_, k)) return undefined;
          return { configurable: true, enumerable: true, value: this.get(_, k) };
        },
        set() { return false; },
      });
      nsCache.set(ns, p);
      return p;
    };
    return new Proxy(Object.create(null), {
      has(_, k) { return !!self.bareKind(k, unityFirst); },
      get(_, k) {
        if (k === Symbol.unscopables || typeof k !== 'string') return undefined;
        const kind = self.bareKind(k, unityFirst);
        if (kind === 'type') return interop.typeProxy(self.byShort.get(k));
        if (kind === 'ns') return nsProxy(k);
        return undefined;
      },
      set() { return false; },
    });
  }
}
