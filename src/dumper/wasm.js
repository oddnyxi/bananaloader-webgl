// Just enough of the WebAssembly binary format to dump an IL2CPP build:
// sections, imports/exports, function types, the function table (element segments),
// a static memory image from the data segments, and writing a "name" section.

const td = new TextDecoder();
const te = new TextEncoder();

export class Reader {
  constructor(b, p = 0) { this.b = b; this.p = p; }
  u8() { return this.b[this.p++]; }
  leb() {
    let r = 0, s = 0, x;
    do { x = this.b[this.p++]; r += (x & 0x7f) * 2 ** s; s += 7; } while (x & 0x80);
    return r;
  }
  sleb() {
    let r = 0, s = 0, x;
    do { x = this.b[this.p++]; r += (x & 0x7f) * 2 ** s; s += 7; } while (x & 0x80);
    if (x & 0x40) r -= 2 ** s;
    return r;
  }
  name() { const n = this.leb(); const s = td.decode(this.b.subarray(this.p, this.p + n)); this.p += n; return s; }
  /** A constant expression (i32.const N / global.get G) ending in `end`. Returns the number or null. */
  constExpr() {
    const op = this.u8();
    let v = null;
    if (op === 0x41) v = this.sleb() >>> 0;
    else if (op === 0x42) v = this.sleb();
    else if (op === 0x23) this.leb();
    else throw new Error(`unsupported constant expression opcode 0x${op.toString(16)}`);
    if (this.u8() !== 0x0b) throw new Error('bad constant expression');
    return v;
  }
}

const uleb = (n, out = []) => { do { let b = n % 128; n = Math.floor(n / 128); if (n) b |= 0x80; out.push(b); } while (n); return out; };

export const isWasm = (b) => b.length > 8 && b[0] === 0 && b[1] === 0x61 && b[2] === 0x73 && b[3] === 0x6d;

const VAL = { 0x7f: 'i', 0x7e: 'j', 0x7d: 'f', 0x7c: 'd', 0x7b: 'V', 0x70: 'r', 0x6f: 'r' };

export class WasmModule {
  constructor(bytes) {
    if (!isWasm(bytes)) throw new Error('not a WebAssembly module (missing \\0asm header)');
    this.bytes = bytes;
    this.sections = [];
    const r = new Reader(bytes, 8);
    while (r.p < bytes.length) {
      const headerStart = r.p;
      const id = r.u8();
      const size = r.leb();
      const s = { id, start: r.p, end: r.p + size, headerStart };
      if (id === 0) s.name = new Reader(bytes, r.p).name();
      this.sections.push(s);
      r.p += size;
    }
    this._types();
    this._imports();
    this._functions();
    this._exports();
  }

  section(id) { return this.sections.find((s) => s.id === id); }
  custom(name) { return this.sections.find((s) => s.id === 0 && s.name === name); }

  _types() {
    this.types = [];
    const s = this.section(1);
    if (!s) return;
    const r = new Reader(this.bytes, s.start);
    const n = r.leb();
    for (let i = 0; i < n; i++) {
      const form = r.u8();
      if (form !== 0x60) throw new Error(`type form 0x${form.toString(16)} not supported`);
      const params = []; const results = [];
      for (let k = r.leb(); k > 0; k--) params.push(VAL[r.u8()] || '?');
      for (let k = r.leb(); k > 0; k--) results.push(VAL[r.u8()] || '?');
      this.types.push({ params, results, sig: (results[0] || 'v') + params.join('') });
    }
  }

  _imports() {
    this.imports = [];
    this.importedFuncs = 0;
    this.funcType = [];
    const s = this.section(2);
    if (!s) return;
    const r = new Reader(this.bytes, s.start);
    const n = r.leb();
    for (let i = 0; i < n; i++) {
      const module = r.name(); const field = r.name(); const kind = r.u8();
      if (kind === 0) { const t = r.leb(); this.imports.push({ module, field, kind, func: this.importedFuncs++ }); this.funcType.push(t); }
      else if (kind === 1) { r.u8(); const fl = r.leb(); r.leb(); if (fl & 1) r.leb(); this.imports.push({ module, field, kind }); }
      else if (kind === 2) { const fl = r.leb(); r.leb(); if (fl & 1) r.leb(); this.imports.push({ module, field, kind }); }
      else if (kind === 3) { r.u8(); r.u8(); this.imports.push({ module, field, kind }); }
      else if (kind === 4) { r.u8(); r.leb(); this.imports.push({ module, field, kind }); }
      else throw new Error(`import kind ${kind} not supported`);
    }
  }

  _functions() {
    const s = this.section(3);
    if (!s) { this.funcCount = this.importedFuncs; return; }
    const r = new Reader(this.bytes, s.start);
    const n = r.leb();
    for (let i = 0; i < n; i++) this.funcType.push(r.leb());
    this.funcCount = this.importedFuncs + n;
  }

  _exports() {
    this.exports = [];
    const s = this.section(7);
    if (!s) return;
    const r = new Reader(this.bytes, s.start);
    for (let n = r.leb(); n > 0; n--) { const name = r.name(); const kind = r.u8(); const index = r.leb(); this.exports.push({ name, kind, index }); }
  }

  /** "viii"-style signature of a function (return first, then params). */
  sigOf(func) { const t = this.types[this.funcType[func]]; return t ? t.sig : '?'; }

  /** Table slot -> function index, from the active element segments of table 0. */
  table() {
    if (this._table) return this._table;
    const map = new Map();
    const s = this.section(9);
    if (s) {
      const r = new Reader(this.bytes, s.start);
      for (let n = r.leb(); n > 0; n--) {
        const flags = r.leb();
        const exprs = (flags & 4) !== 0;
        let offset = null; let table = 0;
        if ((flags & 1) === 0) { // active
          if (flags & 2) table = r.leb();
          offset = r.constExpr();
        }
        if ((flags & 3) !== 0) r.u8(); // elemkind (0x00) or reftype
        const cnt = r.leb();
        for (let k = 0; k < cnt; k++) {
          let f;
          if (exprs) { const op = r.u8(); if (op === 0xd2) f = r.leb(); else if (op === 0xd0) { r.u8(); f = -1; } else throw new Error('bad element expression'); if (r.u8() !== 0x0b) throw new Error('bad element expression'); }
          else f = r.leb();
          if (offset !== null && table === 0 && f >= 0) map.set(offset + k, f);
        }
      }
    }
    this._table = map;
    return map;
  }

  /**
   * The module's initial linear memory, built from its data segments. Active segments are
   * placed at their offsets; passive ones (bulk memory, e.g. pthread builds) are placed where
   * the module's memory.init calls put them, found by scanning the code section.
   * @returns {{ bytes: Uint8Array, end: number }}
   */
  memoryImage() {
    const s = this.section(11);
    if (!s) throw new Error('the module has no data section');
    const r = new Reader(this.bytes, s.start);
    const segs = [];
    for (let n = r.leb(), i = 0; i < n; i++) {
      const flags = r.leb();
      let offset = null;
      if (flags === 0) offset = r.constExpr();
      else if (flags === 2) { r.leb(); offset = r.constExpr(); }
      const len = r.leb();
      segs.push({ index: i, offset, at: r.p, len });
      r.p += len;
    }
    if (segs.some((g) => g.offset === null)) {
      const inits = this._memoryInits();
      for (const g of segs) if (g.offset === null && inits.has(g.index)) g.offset = inits.get(g.index);
    }
    const placed = segs.filter((g) => g.offset !== null);
    if (!placed.length) throw new Error('could not place any data segment');
    const end = Math.max(...placed.map((g) => g.offset + g.len));
    const bytes = new Uint8Array(end);
    for (const g of placed) bytes.set(this.bytes.subarray(g.at, g.at + g.len), g.offset);
    return { bytes, end, segments: segs.length, unplaced: segs.length - placed.length };
  }

  // i32.const dst; i32.const 0; i32.const len; memory.init seg 0
  _memoryInits() {
    const out = new Map();
    const s = this.section(10);
    if (!s) return out;
    const b = this.bytes;
    for (let p = s.start; p < s.end - 6; p++) {
      if (b[p] !== 0xfc || b[p + 1] !== 0x08) continue;
      // walk back over three i32.const immediates
      const consts = [];
      let q = p;
      for (let k = 0; k < 3; k++) {
        let st = q - 1;
        while (st > q - 6 && b[st - 1] & 0x80) st--;
        if (b[st - 1] !== 0x41) break;
        consts.unshift(new Reader(b, st).sleb() >>> 0);
        q = st - 1;
      }
      if (consts.length !== 3 || consts[1] !== 0) continue;
      const rr = new Reader(b, p + 2);
      const seg = rr.leb();
      if (!out.has(seg)) out.set(seg, consts[0]);
    }
    return out;
  }

  /** Function names from an existing "name" section. */
  names() {
    const out = new Map();
    const s = this.custom('name');
    if (!s) return out;
    const r = new Reader(this.bytes, s.start);
    r.name();
    while (r.p < s.end) {
      const id = r.u8(); const size = r.leb(); const end = r.p + size;
      if (id === 1) for (let n = r.leb(); n > 0; n--) { const i = r.leb(); out.set(i, r.name()); }
      r.p = end;
    }
    return out;
  }

  /**
   * A copy of the module with its "name" section replaced by `names` (Map funcIndex -> name).
   * Other custom sections are kept; the name section goes at the end, where tools expect it.
   */
  withNames(names, moduleName) {
    const body = [];
    const sub = (id, bytes) => { body.push(id, ...uleb(bytes.length)); for (const x of bytes) body.push(x); };
    if (moduleName) { const n = te.encode(moduleName); sub(0, [...uleb(n.length), ...n]); }
    const entries = [...names.entries()].filter(([i]) => i < this.funcCount).sort((a, b) => a[0] - b[0]);
    const fn = uleb(entries.length);
    for (const [i, name] of entries) { const n = te.encode(name); uleb(i, fn); uleb(n.length, fn); for (const x of n) fn.push(x); }
    sub(1, fn);
    const title = te.encode('name');
    const content = [...uleb(title.length), ...title, ...body];
    const header = [0, ...uleb(content.length)];

    const keep = this.sections.filter((s) => !(s.id === 0 && s.name === 'name'));
    let size = 8 + header.length + content.length;
    for (const s of keep) size += s.end - s.headerStart;
    const out = new Uint8Array(size);
    out.set(this.bytes.subarray(0, 8), 0);
    let p = 8;
    for (const s of keep) { out.set(this.bytes.subarray(s.headerStart, s.end), p); p += s.end - s.headerStart; }
    out.set(header, p); p += header.length;
    out.set(content, p);
    return out;
  }
}
