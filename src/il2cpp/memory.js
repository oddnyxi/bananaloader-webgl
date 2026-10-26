// Typed views over the WebAssembly heap. The heap can grow (the old ArrayBuffer is then
// detached), so every view is re-created lazily whenever the buffer changes.

const td8 = new TextDecoder('utf-8');
const td16 = new TextDecoder('utf-16le');
// threaded builds use a SharedArrayBuffer heap, and TextDecoder rejects views of shared memory
const SAB = typeof SharedArrayBuffer === 'function' ? SharedArrayBuffer : null;

export class Memory {
  constructor(memory) {
    this.memory = memory;
    this._buf = null;
  }

  _sync() {
    const b = this.memory.buffer;
    if (b === this._buf) return;
    this._buf = b;
    this.shared = !!(SAB && b instanceof SAB);
    this.u8 = new Uint8Array(b);
    this.i8 = new Int8Array(b);
    this.u16 = new Uint16Array(b);
    this.i16 = new Int16Array(b);
    this.u32 = new Uint32Array(b);
    this.i32 = new Int32Array(b);
    this.f32 = new Float32Array(b);
    this.f64 = new Float64Array(b);
    this.dv = new DataView(b);
  }

  get size() { return this.memory.buffer.byteLength; }
  views() { this._sync(); return this; }

  /** True if `p` is a plausible, 4-byte aligned heap address. */
  valid(p) { return p > 0x1000 && p < this.size - 4 && (p & 3) === 0; }

  u8At(p) { this._sync(); return this.u8[p]; }
  i8At(p) { this._sync(); return this.i8[p]; }
  u16At(p) { this._sync(); return this.dv.getUint16(p, true); }
  i16At(p) { this._sync(); return this.dv.getInt16(p, true); }
  u32At(p) { this._sync(); return this.dv.getUint32(p, true); }
  i32At(p) { this._sync(); return this.dv.getInt32(p, true); }
  i64At(p) { this._sync(); return this.dv.getBigInt64(p, true); }
  u64At(p) { this._sync(); return this.dv.getBigUint64(p, true); }
  f32At(p) { this._sync(); return this.dv.getFloat32(p, true); }
  f64At(p) { this._sync(); return this.dv.getFloat64(p, true); }

  setU8(p, v) { this._sync(); this.dv.setUint8(p, v); }
  setI8(p, v) { this._sync(); this.dv.setInt8(p, v); }
  setU16(p, v) { this._sync(); this.dv.setUint16(p, v, true); }
  setI16(p, v) { this._sync(); this.dv.setInt16(p, v, true); }
  setU32(p, v) { this._sync(); this.dv.setUint32(p, v >>> 0, true); }
  setI32(p, v) { this._sync(); this.dv.setInt32(p, v | 0, true); }
  setI64(p, v) { this._sync(); this.dv.setBigInt64(p, BigInt.asIntN(64, BigInt(v)), true); }
  setU64(p, v) { this._sync(); this.dv.setBigUint64(p, BigInt.asUintN(64, BigInt(v)), true); }
  setF32(p, v) { this._sync(); this.dv.setFloat32(p, v, true); }
  setF64(p, v) { this._sync(); this.dv.setFloat64(p, v, true); }

  /** Null-terminated UTF-8 string. */
  cstr(p, max = 4096) {
    if (!p) return '';
    this._sync();
    const u8 = this.u8;
    let e = p;
    const lim = Math.min(u8.length, p + max);
    while (e < lim && u8[e]) e++;
    return td8.decode(this.shared ? u8.slice(p, e) : u8.subarray(p, e));
  }

  /** `len` UTF-16 code units starting at p. */
  utf16(p, len) {
    this._sync();
    return td16.decode(this.shared ? this.u8.slice(p, p + len * 2) : this.u8.subarray(p, p + len * 2));
  }

  bytes(p, n) { this._sync(); return this.u8.slice(p, p + n); }
  copy(dst, src, n) { this._sync(); this.u8.copyWithin(dst, src, src + n); }
  fill(p, v, n) { this._sync(); this.u8.fill(v, p, p + n); }

  /** Address of the first occurrence of a byte pattern in [from, to). */
  find(bytes, from = 0, to = this.size) {
    this._sync();
    const u8 = this.u8;
    const first = bytes[0];
    const n = bytes.length;
    to = Math.min(to, u8.length) - n;
    for (let i = u8.indexOf(first, from); i !== -1 && i <= to; i = u8.indexOf(first, i + 1)) {
      let k = 1;
      while (k < n && u8[i + k] === bytes[k]) k++;
      if (k === n) return i;
    }
    return -1;
  }

  /** Every 4-byte aligned address in [from, to) whose u32 equals `value`. */
  refs(value, from = 0, to = this.size, limit = Infinity) {
    this._sync();
    const u32 = this.u32;
    const out = [];
    const end = Math.min(Math.floor(to / 4), u32.length); // `to >>> 2` wraps to 0 on a 4 GiB heap
    value >>>= 0;
    for (let i = Math.floor(from / 4); i < end; i++) {
      if (u32[i] === value) {
        out.push(i * 4); // i << 2 goes negative above 2 GiB
        if (out.length >= limit) break;
      }
    }
    return out;
  }
}

export const utf8Bytes = (s) => new TextEncoder().encode(s);
