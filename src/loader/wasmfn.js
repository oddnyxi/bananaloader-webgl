// Turn a JS function into a wasm function with an exact signature, so it can be placed in
// the game's function table (same technique as Emscripten's convertJsFunctionToWasm):
// a tiny module imports the JS function and re-exports it with the declared type.

const CODE = { i32: 0x7f, i64: 0x7e, f32: 0x7d, f64: 0x7c };

const leb = (n) => {
  const o = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n) b |= 0x80;
    o.push(b);
  } while (n);
  return o;
};
const section = (id, body) => [id, ...leb(body.length), ...body];

const cache = new Map();

/**
 * @param {Function} js          the implementation
 * @param {string[]} params      wasm param types: 'i32' | 'i64' | 'f32' | 'f64'
 * @param {string|null} result   wasm result type or null for void
 */
export function wasmFunction(js, params, result) {
  const key = params.join(',') + '>' + (result || '');
  let mod = cache.get(key);
  if (!mod) {
    for (const p of params) if (!CODE[p]) throw new Error('bad wasm type ' + p);
    if (result && !CODE[result]) throw new Error('bad wasm type ' + result);
    const type = [0x01, 0x60, ...leb(params.length), ...params.map((p) => CODE[p]), ...(result ? [1, CODE[result]] : [0])];
    const imp = [0x01, 0x01, 0x65, 0x01, 0x66, 0x00, 0x00]; // (import "e" "f" (func (type 0)))
    const exp = [0x01, 0x01, 0x66, 0x00, 0x00]; // (export "f" (func 0))
    mod = new WebAssembly.Module(new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, ...section(1, type), ...section(2, imp), ...section(7, exp)]));
    cache.set(key, mod);
  }
  return new WebAssembly.Instance(mod, { e: { f: js } }).exports.f;
}
