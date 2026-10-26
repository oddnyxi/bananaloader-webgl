// Unity WebGL data files and compression.
//
// Build/*.data is "UnityWebData1.0\0" followed by a file table (offset, size, path). Older
// Emscripten builds pack files without a table (the table lives in the loader JS), so as a
// fallback global-metadata.dat is found by its magic number and its size by its header.

const td = new TextDecoder();
export const METADATA_MAGIC = 0xfab11baf;

export const isGzip = (b) => b.length > 2 && b[0] === 0x1f && b[1] === 0x8b;
export const isUnityWebData = (b) => b.length > 16 && td.decode(b.subarray(0, 15)) === 'UnityWebData1.0';
export const isMetadata = (b) => b.length > 8 && new DataView(b.buffer, b.byteOffset, 8).getUint32(0, true) === METADATA_MAGIC;

/** Files inside a UnityWebData container: [{ path, offset, size }] */
export function unityWebDataFiles(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const headerSize = dv.getUint32(16, true);
  const out = [];
  for (let p = 20; p < headerSize;) {
    const offset = dv.getUint32(p, true);
    const size = dv.getUint32(p + 4, true);
    const len = dv.getUint32(p + 8, true);
    const path = td.decode(b.subarray(p + 12, p + 12 + len));
    out.push({ path, offset, size });
    p += 12 + len;
  }
  return out;
}

/** Size of a global-metadata.dat from its header (the end of its last section). */
export function metadataSize(b, at = 0) {
  const dv = new DataView(b.buffer, b.byteOffset + at, Math.min(0x200, b.byteLength - at));
  const headerSize = dv.getUint32(8, true);
  // v38+ sections are (offset, size, count) triples; before, (offset, size) pairs
  const stride = dv.getUint32(4, true) >= 38 ? 12 : 8;
  let end = headerSize;
  for (let off = 8; off + 8 <= headerSize && off + 8 <= dv.byteLength; off += stride) {
    const o = dv.getUint32(off, true);
    const s = dv.getUint32(off + 4, true);
    if (o && o + s > end && o < 0x40000000) end = o + s;
  }
  return end;
}

/** global-metadata.dat out of a .data file (or the bytes themselves if they already are one). */
export function extractMetadata(b) {
  if (isMetadata(b)) return b.subarray(0, metadataSize(b));
  if (isUnityWebData(b)) {
    const f = unityWebDataFiles(b).find((x) => /global-metadata\.dat$/i.test(x.path));
    if (f) return b.subarray(f.offset, f.offset + f.size);
  }
  // raw scan for the magic + a sane version
  for (let i = b.indexOf(0xaf); i !== -1 && i < b.length - 16; i = b.indexOf(0xaf, i + 1)) {
    if (b[i + 1] !== 0x1b || b[i + 2] !== 0xb1 || b[i + 3] !== 0xfa) continue;
    const v = b[i + 4] | (b[i + 5] << 8);
    if (v < 24 || v > 99) continue;
    const size = metadataSize(b, i);
    if (i + size <= b.length) return b.subarray(i, i + size);
  }
  return null;
}

/**
 * Decompress if needed. `brotli` is an optional (Uint8Array) => Uint8Array decoder;
 * gzip uses `gunzip` (sync, Node) or DecompressionStream (browser).
 */
export async function inflate(b, { gunzip, brotli } = {}) {
  if (isGzip(b)) {
    if (gunzip) return gunzip(b);
    const s = new Blob([b]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(s).arrayBuffer());
  }
  if (b[0] === 0 && b[1] === 0x61 && b[2] === 0x73 && b[3] === 0x6d) return b; // wasm
  if (isUnityWebData(b) || isMetadata(b)) return b;
  if (brotli) {
    try { return brotli(b); } catch (_) { /* not brotli */ }
  }
  return b;
}

/** Looks brotli-compressed (Unity marks its brotli output with a metadata comment). */
export const looksBrotli = (b) => {
  const head = td.decode(b.subarray(0, 64));
  return /UnityWeb Compressed Content \(brotli\)/.test(head) || (!isGzip(b) && !isUnityWebData(b) && !isMetadata(b) && !(b[0] === 0 && b[1] === 0x61));
};
