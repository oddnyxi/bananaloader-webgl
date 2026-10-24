// Direct-call patching: rewrite the game's wasm before it's compiled so that direct calls to
// chosen functions go through their function-table slot instead:
//
//     call $f           ->   i32.const <slot>  call_indirect (type $f)
//
// Behaviour is identical while nothing is patched (the slot holds $f), but once the patcher
// swaps the slot, every call site — direct ones included — reaches the hook.

const td = new TextDecoder();

class Reader {
  constructor(b, p = 0) { this.b = b; this.p = p; }
  u8() { return this.b[this.p++]; }
  leb() {
    let r = 0, s = 0, x;
    do { x = this.b[this.p++]; r |= (x & 0x7f) << s; s += 7; } while (x & 0x80 && s < 35);
    if (x & 0x80) { while (this.b[this.p++] & 0x80); } // tolerate over-long encodings
    return r >>> 0;
  }
  skipLeb() { while (this.b[this.p++] & 0x80); }
  name() { const n = this.leb(); const s = td.decode(this.b.subarray(this.p, this.p + n)); this.p += n; return s; }
}

const uleb = (n, out) => { n >>>= 0; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; out.push(b); } while (n); return out; };
const sleb = (n, out) => {
  n |= 0;
  for (;;) {
    const b = n & 0x7f;
    n >>= 7;
    if ((n === 0 && (b & 0x40) === 0) || (n === -1 && (b & 0x40) !== 0)) { out.push(b); return out; }
    out.push(b | 0x80);
  }
};

/** Section table of a module: [{ id, start, end, name? }] */
export function sections(bytes) {
  const r = new Reader(bytes, 8);
  const out = [];
  while (r.p < bytes.length) {
    const headerStart = r.p;
    const id = r.u8();
    const size = r.leb();
    const start = r.p;
    const s = { id, start, end: start + size, headerStart };
    if (id === 0) s.name = new Reader(bytes, start).name();
    out.push(s);
    r.p = start + size;
  }
  return out;
}

/** Map table slot -> function index from active element segments of table 0. */
export function slotMap(bytes, secs) {
  const map = new Map();
  const es = secs.find((s) => s.id === 9);
  if (!es) return map;
  const r = new Reader(bytes, es.start);
  const n = r.leb();
  for (let i = 0; i < n; i++) {
    const flags = r.leb();
    let offset = 0;
    const readOffset = () => {
      const op = r.u8();
      // fastcomp builds (Unity 2018 – 2021.1) place their one segment at the imported tableBase, which is 0
      if (op === 0x41) { offset = readSleb(r); } else if (op === 0x23) { r.leb(); offset = 0; } else throw new Error('unsupported element offset');
      if (r.u8() !== 0x0b) throw new Error('bad element offset');
    };
    if (flags === 0) { readOffset(); const cnt = r.leb(); for (let k = 0; k < cnt; k++) { const f = r.leb(); if (offset >= 0) map.set(offset + k, f); } }
    else if (flags === 2) { r.leb(); readOffset(); r.u8(); const cnt = r.leb(); for (let k = 0; k < cnt; k++) { const f = r.leb(); if (offset >= 0) map.set(offset + k, f); } }
    else if (flags === 1 || flags === 3) { r.u8(); const cnt = r.leb(); for (let k = 0; k < cnt; k++) r.leb(); }
    else throw new Error(`element segment flags ${flags} not supported`);
  }
  return map;
}

function readSleb(r) {
  let result = 0, shift = 0, b;
  do { b = r.u8(); result |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80);
  if (shift < 32 && (b & 0x40)) result |= -1 << shift;
  return result | 0;
}

/** Function index -> type index for defined functions (offset by imported functions). */
function funcTypes(bytes, secs) {
  let imported = 0;
  const imp = secs.find((s) => s.id === 2);
  const importTypes = [];
  if (imp) {
    const r = new Reader(bytes, imp.start);
    const n = r.leb();
    for (let i = 0; i < n; i++) {
      r.name(); r.name();
      const kind = r.u8();
      if (kind === 0) { importTypes.push(r.leb()); imported++; }
      else if (kind === 1) { r.u8(); const fl = r.leb(); r.leb(); if (fl & 1) r.leb(); }
      else if (kind === 2) { const fl = r.leb(); r.leb(); if (fl & 1) r.leb(); }
      else if (kind === 3) { r.u8(); r.u8(); }
      else if (kind === 4) { r.u8(); r.leb(); }
    }
  }
  const fs = secs.find((s) => s.id === 3);
  const r = new Reader(bytes, fs.start);
  const n = r.leb();
  const types = new Uint32Array(imported + n);
  types.set(importTypes, 0);
  for (let i = 0; i < n; i++) types[imported + i] = r.leb();
  return { types, imported };
}

/**
 * Rewrite direct calls to the functions behind `slots` (table indices).
 * @returns {{ bytes: Uint8Array, rewritten: number, sites: number, skipped: number, missing: number[] }}
 */
export function rewriteDirectCalls(bytes, slots) {
  const secs = sections(bytes);
  const smap = slotMap(bytes, secs);
  const { types, imported } = funcTypes(bytes, secs);
  const targets = new Map(); // funcIndex -> { slot, type }
  const missing = [];
  for (const slot of slots) {
    const f = smap.get(slot);
    if (f === undefined || f < imported) { missing.push(slot); continue; }
    targets.set(f, { slot, type: types[f] });
  }
  if (!targets.size) return { bytes, rewritten: 0, sites: 0, skipped: 0, missing };

  const code = secs.find((s) => s.id === 10);
  const r = new Reader(bytes, code.start);
  const count = r.leb();
  const parts = [];   // Uint8Array chunks of the new code section body
  let total = 0;
  const push = (u8) => { parts.push(u8); total += u8.length; };
  const head = uleb(count, []);
  push(new Uint8Array(head));
  let sites = 0;
  let skipped = 0;
  let rewritten = 0;

  for (let i = 0; i < count; i++) {
    const sizeStart = r.p;
    const size = r.leb();
    const bodyStart = r.p;
    const bodyEnd = bodyStart + size;
    const edits = scanBody(bytes, bodyStart, bodyEnd, targets);
    if (edits === null) skipped++;
    if (!edits || !edits.length) {
      push(bytes.subarray(sizeStart, bodyEnd));
    } else {
      // rebuild: copy between edits, replace each `call f` with the indirect form
      const chunks = [];
      let len = 0;
      let cur = bodyStart;
      for (const e of edits) {
        const a = bytes.subarray(cur, e.at);
        chunks.push(a); len += a.length;
        const t = targets.get(e.func);
        const rep = [0x41];
        sleb(t.slot, rep);
        rep.push(0x11);
        uleb(t.type, rep);
        rep.push(0x00);
        const ru = new Uint8Array(rep);
        chunks.push(ru); len += ru.length;
        cur = e.end;
        sites++;
      }
      const tail = bytes.subarray(cur, bodyEnd);
      chunks.push(tail); len += tail.length;
      push(new Uint8Array(uleb(len, [])));
      for (const c of chunks) push(c);
      rewritten++;
    }
    r.p = bodyEnd;
  }

  // assemble: everything before the code section, new code section, everything after
  const before = bytes.subarray(0, code.headerStart);
  const after = bytes.subarray(code.end);
  const secHead = new Uint8Array([10, ...uleb(total, [])]);
  const out = new Uint8Array(before.length + secHead.length + total + after.length);
  let o = 0;
  out.set(before, o); o += before.length;
  out.set(secHead, o); o += secHead.length;
  for (const p of parts) { out.set(p, o); o += p.length; }
  out.set(after, o);
  return { bytes: out, rewritten, sites, skipped, missing };
}

const BLOCK_TYPES = new Set([0x40, 0x7f, 0x7e, 0x7d, 0x7c, 0x7b, 0x70, 0x6f]);

/** Return [{ at, end, func }] for direct calls to targets, [] if none, or null if the body can't be decoded. */
function scanBody(b, p, end, targets) {
  // locals
  let n = 0, s = 0, x;
  do { x = b[p++]; n |= (x & 0x7f) << s; s += 7; } while (x & 0x80);
  for (let i = 0; i < n; i++) { while (b[p++] & 0x80); p++; }
  let edits = null;
  const leb = () => { let r = 0, sh = 0, y; do { y = b[p++]; r |= (y & 0x7f) << sh; sh += 7; } while (y & 0x80); return r >>> 0; };
  const skip = () => { while (b[p++] & 0x80); };
  while (p < end) {
    const at = p;
    const op = b[p++];
    if (op === 0x10) {
      const f = leb();
      if (targets.has(f)) (edits ||= []).push({ at, end: p, func: f });
      continue;
    }
    if (op >= 0x20 && op <= 0x26) { skip(); continue; }          // local/global/table get/set
    if (op >= 0x28 && op <= 0x3e) { skip(); skip(); continue; }  // loads/stores: memarg
    if (op >= 0x45 && op <= 0xc4) continue;                      // numeric
    switch (op) {
      case 0x00: case 0x01: case 0x05: case 0x0b: case 0x0f: case 0x1a: case 0x1b: case 0xd1: case 0x19:
        break;
      case 0x02: case 0x03: case 0x04: case 0x06:
        if (BLOCK_TYPES.has(b[p])) p++; else skip();
        break;
      case 0x0c: case 0x0d: case 0x12: case 0xd2: case 0x07: case 0x08: case 0x09: case 0x18:
        skip();
        break;
      case 0x0e: { const c = leb(); for (let i = 0; i <= c; i++) skip(); break; }
      case 0x11: case 0x13: skip(); skip(); break;
      case 0x1c: { const c = leb(); p += c; break; }
      case 0x3f: case 0x40: p++; break;
      case 0x41: case 0x42: skip(); break;
      case 0x43: p += 4; break;
      case 0x44: p += 8; break;
      case 0xd0: p++; break;
      case 0xfc: {
        const sub = leb();
        if (sub <= 7) break;
        if (sub === 8) { skip(); p++; break; }
        if (sub === 9 || sub === 13 || sub === 15 || sub === 16 || sub === 17) { skip(); break; }
        if (sub === 10) { p += 2; break; }
        if (sub === 11) { p += 1; break; }
        if (sub === 12 || sub === 14) { skip(); skip(); break; }
        return null;
      }
      case 0xfe: {
        const sub = leb();
        if (sub === 0x03) { p++; break; }
        skip(); skip();
        break;
      }
      default:
        return null; // SIMD or something unknown: leave this function as it is
    }
  }
  return edits || [];
}
