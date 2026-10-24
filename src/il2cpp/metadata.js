// global-metadata.dat reader (IL2CPP metadata v24.2 – v39), read straight out of the wasm heap
// (or out of a static image built by the dumper).
//
// The runtime keeps the whole file in memory after loading it, so we find it by its magic
// and read names, type definitions, methods, fields, parameters and properties from there.
//
// Record layouts are computed from the section sizes rather than hardcoded:
//  * v24.2 – v31 (Unity 2019.4 – 6000.2): (offset, size) section pairs, 32-bit indices.
//  * v38+ (Unity 6000.3+): (offset, size, count) triples, and the TypeIndex,
//    TypeDefinitionIndex and GenericContainerIndex fields shrink to 2 (or 1) bytes when the
//    counts allow it. Their widths are worked out from record sizes and cross-checked.

export const SANITY = 0xfab11baf;

// Header section order for v29+ (Unity 2021.2 – 6000.x).
const SECTIONS_V29 = [
  'stringLiteral', 'stringLiteralData', 'string', 'events', 'properties', 'methods',
  'parameterDefaultValues', 'fieldDefaultValues', 'fieldAndParameterDefaultValueData', 'fieldMarshaledSizes',
  'parameters', 'fields', 'genericParameters', 'genericParameterConstraints', 'genericContainers', 'nestedTypes',
  'interfaces', 'vtableMethods', 'interfaceOffsets', 'typeDefinitions', 'images', 'assemblies', 'fieldRefs',
  'referencedAssemblies', 'attributeData', 'attributeDataRange', 'unresolvedIndirectCallParameterTypes',
  'unresolvedIndirectCallParameterRanges', 'windowsRuntimeTypeNames', 'windowsRuntimeStrings', 'exportedTypeDefinitions',
];
// v24.2 – v27.x: metadataUsage* sections, attributesInfo/attributeTypes instead of attributeData.
const SECTIONS_V24 = [
  'stringLiteral', 'stringLiteralData', 'string', 'events', 'properties', 'methods',
  'parameterDefaultValues', 'fieldDefaultValues', 'fieldAndParameterDefaultValueData', 'fieldMarshaledSizes',
  'parameters', 'fields', 'genericParameters', 'genericParameterConstraints', 'genericContainers', 'nestedTypes',
  'interfaces', 'vtableMethods', 'interfaceOffsets', 'typeDefinitions', 'images', 'assemblies',
  'metadataUsageLists', 'metadataUsagePairs', 'fieldRefs', 'referencedAssemblies', 'attributesInfo', 'attributeTypes',
  'unresolvedIndirectCallParameterTypes', 'unresolvedIndirectCallParameterRanges', 'windowsRuntimeTypeNames',
  'windowsRuntimeStrings', 'exportedTypeDefinitions',
];

// Type definition bitfield
const TD_VALUETYPE = 1;
const TD_ENUM = 2;

export class MetadataError extends Error {}

export class Metadata {
  /** Locate global-metadata in the heap. Returns the base address or -1. */
  static locate(mem) {
    mem.views();
    const u32 = mem.u32;
    for (let i = 0; i < u32.length - 8; i++) {
      if (u32[i] !== SANITY) continue;
      const v = u32[i + 1];
      if (v < 24 || v > 255) continue;
      const first = u32[i + 2]; // first section offset == header size
      if (first < 0xb0 || first > 0x400) continue;
      return i * 4;
    }
    return -1;
  }

  constructor(mem, base) {
    this.mem = mem;
    this.base = base;
    const m = mem.views();
    this.version = m.i32At(base + 4);
    this.headerSize = m.u32At(base + 8);
    if (this.version > 39) throw new MetadataError(`IL2CPP metadata v${this.version} isn't supported yet (newest supported: v39, Unity 6000.3)`);
    // v38+ sections carry a record count
    this.counted = this.version >= 38;
    const stride = this.counted ? 12 : 8;
    const names = this.version >= 29 ? SECTIONS_V29 : SECTIONS_V24;
    this.sec = {};
    for (let k = 0; k < names.length; k++) {
      const off = 8 + k * stride;
      if (off + stride > this.headerSize) break;
      this.sec[names[k]] = {
        off: base + m.u32At(base + off),
        size: m.u32At(base + off + 4),
        count: this.counted ? m.u32At(base + off + 8) : -1,
      };
    }
    this._str = new Map();
    this._layout();

    // ---- images
    this.images = [];
    const im = this.sec.images;
    const L = this.L.image;
    for (let i = 0; i < im.size / L.size; i++) {
      const p = im.off + i * L.size;
      this.images.push({
        index: i,
        name: this.str(m.u32At(p)),
        assemblyIndex: m.i32At(p + 4),
        typeStart: this._idx(p + 8, this.w.TD),
        typeCount: m.u32At(p + L.typeCount),
        token: m.u32At(p + L.token),
      });
    }
    this.typeCount = this.images.reduce((a, b) => Math.max(a, b.typeStart + b.typeCount), 0);
    this.tdBase = this.sec.typeDefinitions.off;
    const tdActual = Math.round(this.sec.typeDefinitions.size / this.typeCount);
    if (tdActual !== this.tdSize) throw new MetadataError(`unexpected type definition size ${tdActual} (expected ${this.tdSize})`);

    let methodTotal = 0;
    for (let i = 0; i < this.typeCount; i++) { const t = this._tdRaw(i); if (t.methodStart >= 0) methodTotal = Math.max(methodTotal, t.methodStart + t.methodCount); }
    this.methodCount = this.counted ? this.sec.methods.count : methodTotal;
    if (!this.counted) {
      const mdSize = methodTotal ? Math.round(this.sec.methods.size / methodTotal) : 32;
      if (mdSize !== this.L.method.size) throw new MetadataError(`unexpected method definition size ${mdSize} (expected ${this.L.method.size})`);
    }

    this.imageOfType = new Int32Array(this.typeCount).fill(-1);
    for (const img of this.images) for (let t = img.typeStart; t < img.typeStart + img.typeCount; t++) this.imageOfType[t] = img.index;
  }

  /** Field offsets and index widths of every record we read. */
  _layout() {
    const s = this.sec;
    const rec = (x) => (x && x.count > 0 ? x.size / x.count : 0);
    const w = { T: 4, TD: 4, GC: 4, P: 4 };
    if (this.counted) {
      w.T = rec(s.fields) ? rec(s.fields) - 8 : rec(s.interfaces) || 4;
      w.GC = rec(s.genericParameters) ? rec(s.genericParameters) - 12 : 4;
      w.TD = rec(s.images) ? (rec(s.images) - 32) / 2 : 4;
      w.P = rec(s.methods) - 20 - w.TD - w.T - w.GC;
      for (const [k, v] of Object.entries(w)) if (![1, 2, 4].includes(v)) throw new MetadataError(`metadata v${this.version}: can't work out the ${k} index width (${v})`);
    }
    this.w = w;

    // ---- type definitions
    const td = []; let o = 0;
    const add = (name, size) => { td.push([name, o, size]); o += Math.abs(size); };
    add('nameIndex', 4); add('namespaceIndex', 4); add('byvalTypeIndex', w.T);
    const tdSizeV = this.counted ? rec(s.typeDefinitions) : null;
    if (!this.counted && this.version < 27) {
      // v24.x has byrefTypeIndex (92-byte records)
      const n = this._typeCountGuess();
      if (n && Math.round(s.typeDefinitions.size / n) === 92) add('byrefTypeIndex', 4);
    }
    add('declaringTypeIndex', w.T); add('parentIndex', w.T);
    // elementTypeIndex was dropped in v38+; keep it when the record size says it's there
    const restSize = w.GC + 4 + 32 + 16 + 8;
    if (!this.counted || tdSizeV === o + w.T + restSize) add('elementTypeIndex', w.T);
    add('genericContainerIndex', w.GC); add('flags', 4);
    for (const n of ['fieldStart', 'methodStart', 'eventStart', 'propertyStart', 'nestedTypesStart', 'interfacesStart', 'vtableStart', 'interfaceOffsetsStart']) add(n, 4);
    for (const n of ['methodCount', 'propertyCount', 'fieldCount', 'eventCount', 'nestedCount', 'vtableCount', 'interfacesCount', 'interfaceOffsetsCount']) add(n, -2);
    add('bitfield', 4); add('token', 4);
    this.tdSize = o;
    if (this.counted && tdSizeV !== o) throw new MetadataError(`metadata v${this.version}: type definitions are ${tdSizeV} bytes, expected ${o}`);
    this.L = { td };

    // ---- methods
    const mf = []; o = 0;
    const addM = (name, size) => { mf.push([name, o, size]); o += Math.abs(size); };
    addM('nameIndex', 4); addM('declaringType', w.TD); addM('returnType', w.T);
    if (this.version >= 31) addM('returnParameterToken', 4);
    addM('parameterStart', w.P); addM('genericContainerIndex', w.GC); addM('token', 4);
    addM('flags', -2); addM('iflags', -2); addM('slot', -2); addM('parameterCount', -2);
    this.L.method = { fields: mf, size: o };
    if (this.counted && rec(s.methods) !== o) throw new MetadataError(`metadata v${this.version}: methods are ${rec(s.methods)} bytes, expected ${o}`);

    this.L.param = { size: 8 + w.T };       // nameIndex, token, typeIndex
    this.L.field = { size: 8 + w.T };       // nameIndex, typeIndex, token
    this.L.prop = { size: 20 };             // nameIndex, get, set, attrs, token
    this.L.gparam = { size: w.GC + 12 };    // ownerIndex, nameIndex, constraintsStart, constraintsCount, num, flags
    this.L.gcontainer = { size: 16 };       // ownerIndex, type_argc, is_method, genericParameterStart
    this.L.fieldDefault = { size: 8 + w.T };
    this.L.image = this.counted
      ? { size: 32 + 2 * w.TD, typeCount: 8 + w.TD, token: 20 + 2 * w.TD }
      : { size: 40, typeCount: 12, token: 28 };
    // string literals: { length, dataIndex } until v35; just dataIndex (with a sentinel) after
    const lit = s.stringLiteral;
    this.L.literal = this.counted && rec(lit) === 4 ? { size: 4, packed: true } : { size: 8, packed: false };
    this.paramSize = this.L.param.size;
    this.fieldSize = this.L.field.size;
    this.propSize = this.L.prop.size;
    this.mdSize = this.L.method.size;
  }

  _typeCountGuess() {
    const im = this.sec.images;
    let n = 0;
    for (let i = 0; i < im.size / 40; i++) { const p = im.off + i * 40; n = Math.max(n, this.mem.i32At(p + 8) + this.mem.u32At(p + 12)); }
    return n;
  }

  /** Signed index of 1, 2 or 4 bytes (all-ones = -1). */
  _idx(p, w) {
    const m = this.mem;
    if (w === 4) return m.i32At(p);
    if (w === 2) { const v = m.u16At(p); return v === 0xffff ? -1 : v; }
    const v = m.u8At(p); return v === 0xff ? -1 : v;
  }

  _read(p, size) {
    if (size === 4) return this.mem.i32At(p);
    if (size === -2) return this.mem.u16At(p);
    return this._idx(p, size);
  }

  str(idx) {
    let s = this._str.get(idx);
    if (s === undefined) {
      s = this.mem.cstr(this.sec.string.off + idx, 2048);
      this._str.set(idx, s);
    }
    return s;
  }

  /** Address of a metadata string (useful because Il2CppClass.name points straight into it). */
  strAddr(idx) { return this.sec.string.off + idx; }

  _tdRaw(i) {
    const p = this.sec.typeDefinitions.off + i * this.tdSize;
    const r = { elementTypeIndex: -1 };
    for (const [name, off, size] of this.L.td) r[name] = this._read(p + off, size);
    r.nameIndex >>>= 0; r.namespaceIndex >>>= 0; r.flags >>>= 0; r.bitfield >>>= 0; r.token >>>= 0;
    return r;
  }

  typeDef(i) {
    if (!this._tdCache) this._tdCache = new Map();
    let t = this._tdCache.get(i);
    if (t) return t;
    const r = this._tdRaw(i);
    t = {
      index: i,
      ...r,
      name: this.str(r.nameIndex),
      namespace: this.str(r.namespaceIndex),
      image: this.imageOfType[i],
      isValueType: (r.bitfield & TD_VALUETYPE) !== 0,
      isEnum: (r.bitfield & TD_ENUM) !== 0,
      isGeneric: r.genericContainerIndex !== -1,
      isInterface: (r.flags & 0x20) !== 0,
      isAbstract: (r.flags & 0x80) !== 0,
      isSealed: (r.flags & 0x100) !== 0,
    };
    this._tdCache.set(i, t);
    return t;
  }

  /** Address of the type definition record (Il2CppClass.typeMetadataHandle points here). */
  typeDefAddr(i) { return this.tdBase + i * this.tdSize; }
  typeDefFromAddr(p) {
    const d = p - this.tdBase;
    if (d < 0 || d % this.tdSize) return -1;
    const i = d / this.tdSize;
    return i < this.typeCount ? i : -1;
  }

  /** Namespace-qualified name, with nesting as Outer+Inner and generic arity stripped of `N. */
  fullName(i, { arity = false } = {}) {
    const t = this.typeDef(i);
    const n = arity ? t.name : t.name.replace(/`\d+$/, '');
    if (t.declaringTypeIndex >= 0 && this._declTd) {
      const d = this._declTd(t.declaringTypeIndex);
      if (d >= 0) return this.fullName(d, { arity }) + '+' + n;
    }
    return t.namespace ? t.namespace + '.' + n : n;
  }

  method(i) {
    const p = this.sec.methods.off + i * this.mdSize;
    const r = { index: i, returnParameterToken: 0 };
    for (const [name, off, size] of this.L.method.fields) r[name] = this._read(p + off, size);
    r.nameIndex >>>= 0; r.token >>>= 0;
    r.name = this.str(r.nameIndex);
    return r;
  }

  param(i) {
    const m = this.mem;
    const p = this.sec.parameters.off + i * this.paramSize;
    return { index: i, name: this.str(m.u32At(p)), token: m.u32At(p + 4), typeIndex: this._idx(p + 8, this.w.T) };
  }

  field(i) {
    const m = this.mem;
    const p = this.sec.fields.off + i * this.fieldSize;
    return { index: i, name: this.str(m.u32At(p)), nameIndex: m.u32At(p), typeIndex: this._idx(p + 4, this.w.T), token: m.u32At(p + 4 + this.w.T) };
  }

  property(i) {
    const m = this.mem;
    const p = this.sec.properties.off + i * this.propSize;
    return { index: i, name: this.str(m.u32At(p)), get: m.i32At(p + 4), set: m.i32At(p + 8), attrs: m.u32At(p + 12), token: m.u32At(p + 16) };
  }

  nestedType(i) { return this.mem.i32At(this.sec.nestedTypes.off + i * 4); }

  /** Type index of the i-th entry of the interfaces table. */
  interfaceType(i) { return this._idx(this.sec.interfaces.off + i * this.w.T, this.w.T); }

  /** Il2CppGenericContainer: { ownerIndex, argc, isMethod, paramStart } */
  genericContainer(i) {
    const m = this.mem;
    const c = this.sec.genericContainers.off + i * this.L.gcontainer.size;
    return { ownerIndex: m.i32At(c), argc: m.i32At(c + 4), isMethod: m.i32At(c + 8) !== 0, paramStart: m.i32At(c + 12) };
  }

  /** Address of a generic parameter record. */
  genericParamAddr(i) { return this.sec.genericParameters.off + i * this.L.gparam.size; }
  get genericParamCount() { return Math.floor(this.sec.genericParameters.size / this.L.gparam.size); }
  /** Name of a generic parameter by index, or by record address (runtime Il2CppType data). */
  genericParamName(d) {
    const sec = this.sec.genericParameters;
    const addr = d < this.genericParamCount ? this.genericParamAddr(d) : d;
    if (addr < sec.off || addr >= sec.off + sec.size) return 'T';
    return this.str(this.mem.u32At(addr + this.w.GC));
  }
  /** Names of a generic container's parameters: ['TKey', 'TValue'] */
  genericParamNames(containerIndex) {
    if (containerIndex < 0) return [];
    const c = this.genericContainer(containerIndex);
    const out = [];
    for (let k = 0; k < c.argc && k < 64; k++) out.push(this.genericParamName(c.paramStart + k));
    return out;
  }

  /** Default value record for a field (constants and enum members): { typeIndex, dataAddr } */
  fieldDefault(fieldIndex) {
    if (!this._fdv) {
      this._fdv = new Map();
      const s = this.sec.fieldDefaultValues;
      const m = this.mem;
      const sz = this.L.fieldDefault.size;
      for (let p = s.off; p + sz <= s.off + s.size; p += sz) this._fdv.set(m.i32At(p), [this._idx(p + 4, this.w.T), m.i32At(p + 4 + this.w.T)]);
    }
    const r = this._fdv.get(fieldIndex);
    if (!r) return null;
    return { typeIndex: r[0], dataAddr: r[1] < 0 ? 0 : this.sec.fieldAndParameterDefaultValueData.off + r[1] };
  }

  get stringLiteralCount() {
    const s = this.sec.stringLiteral;
    return this.L.literal.packed ? Math.max(0, s.size / 4 - 1) : Math.floor(s.size / 8);
  }

  stringLiteral(i) {
    const m = this.mem;
    const s = this.sec.stringLiteral;
    let start; let len;
    if (this.L.literal.packed) {
      start = m.u32At(s.off + i * 4);
      len = m.u32At(s.off + (i + 1) * 4) - start;
    } else {
      len = m.u32At(s.off + i * 8);
      start = m.i32At(s.off + i * 8 + 4);
    }
    return new TextDecoder().decode(m.bytes(this.sec.stringLiteralData.off + start, len));
  }
}
