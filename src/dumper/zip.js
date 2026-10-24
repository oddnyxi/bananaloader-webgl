// Minimal ZIP writer (stored, no compression) so a dump downloads as one file.

const te = new TextEncoder();
let CRC;
function crc32(b) {
  if (!CRC) {
    CRC = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC[n] = c >>> 0; }
  }
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * @param {{ name: string, data: Uint8Array | string }[]} files
 * @returns {Uint8Array}
 */
export function zip(files) {
  const entries = files.map((f) => {
    const data = typeof f.data === 'string' ? te.encode(f.data) : f.data;
    return { name: te.encode(f.name), data, crc: crc32(data) };
  });
  let size = 22;
  for (const e of entries) size += 30 + e.name.length + e.data.length + 46 + e.name.length;
  if (size > 0xffffffff) throw new Error('dump too large for a zip without zip64');
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  const now = new Date();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  let p = 0;
  const offsets = [];
  for (const e of entries) {
    offsets.push(p);
    dv.setUint32(p, 0x04034b50, true); dv.setUint16(p + 4, 20, true); dv.setUint16(p + 6, 0x0800, true); dv.setUint16(p + 8, 0, true);
    dv.setUint16(p + 10, time, true); dv.setUint16(p + 12, date, true); dv.setUint32(p + 14, e.crc, true);
    dv.setUint32(p + 18, e.data.length, true); dv.setUint32(p + 22, e.data.length, true);
    dv.setUint16(p + 26, e.name.length, true); dv.setUint16(p + 28, 0, true);
    out.set(e.name, p + 30); out.set(e.data, p + 30 + e.name.length);
    p += 30 + e.name.length + e.data.length;
  }
  const cd = p;
  entries.forEach((e, i) => {
    dv.setUint32(p, 0x02014b50, true); dv.setUint16(p + 4, 20, true); dv.setUint16(p + 6, 20, true); dv.setUint16(p + 8, 0x0800, true);
    dv.setUint16(p + 10, 0, true); dv.setUint16(p + 12, time, true); dv.setUint16(p + 14, date, true); dv.setUint32(p + 16, e.crc, true);
    dv.setUint32(p + 20, e.data.length, true); dv.setUint32(p + 24, e.data.length, true); dv.setUint16(p + 28, e.name.length, true);
    dv.setUint32(p + 42, offsets[i], true);
    out.set(e.name, p + 46);
    p += 46 + e.name.length;
  });
  dv.setUint32(p, 0x06054b50, true); dv.setUint16(p + 8, entries.length, true); dv.setUint16(p + 10, entries.length, true);
  dv.setUint32(p + 12, p - cd, true); dv.setUint32(p + 16, cd, true);
  return out;
}

/** Trigger a browser download. */
export function download(name, data, type = 'application/octet-stream') {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
