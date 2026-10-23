// global-metadata.dat reader (IL2CPP metadata v24.2 – v31), read straight out of the wasm heap.
//
// The runtime keeps the whole file in memory after loading it, so we find it by its magic
// and read names, type definitions, methods, fields, parameters and properties from there.
// Record sizes are derived from section sizes where possible, so small layout changes
// between Unity versions are detected instead of silently misread.

export const SANITY = 0xfab11baf;

// Header section order for v29+ (Unity 2021.2 – 6000.x). Each entry is an (offset, size) pair.
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

export class Metadata {
  /** Locate global-metadata in the heap. Returns the base address or -1. */
  static locate(mem) {
    mem.views();
    const u32 = mem.u32;
    for (let i = 0; i < u32.length - 8; i++) {
      if (u32[i] !== SANITY) continue;
      const v = u32[i + 1];
      if (v < 24 || v > 99) continue;
      const first = u32[i + 2]; // first section offset == header size
      if (first < 0xb0 || first > 0x200) continue;
      return i * 4;
    }
    return -1;
  }

  constructor(mem, base) {
    this.mem = mem;
    this.base = base;
    const m = mem.views();
    this.version = m.i32At(base + 4);
    const names = this.version >= 29 ? SECTIONS_V29 : SECTIONS_V24;
    this.headerSize = m.u32At(base + 8);
    this.sec = {};
    for (let k = 0; k < names.length; k++) {
      const off = 8 + k * 8;
      if (off + 8 > this.headerSize) break;
      this.sec[names[k]] = { off: base + m.u32At(base + off), size: m.u32At(base + off + 4) };
    }
    this._str = new Map();

    // ---- images (40 bytes in v24.1+)
    this.imageSize = 40;
    this.images = [];
    const im = this.sec.images;
    for (let i = 0; i < im.size / this.imageSize; i++) {
      const p = im.off + i * this.imageSize;
      this.images.push({
        index: i,
        name: this.str(m.u32At(p)),
        assemblyIndex: m.i32At(p + 4),
        typeStart: m.i32At(p + 8),
        typeCount: m.u32At(p + 12),
        token: m.u32At(p + 28),
      });
    }

    // ---- type definitions: size = section size / sum(typeCount)
    this.typeCount = this.images.reduce((a, b) => Math.max(a, b.typeStart + b.typeCount), 0);
    this.tdSize = Math.round(this.sec.typeDefinitions.size / this.typeCount);
    if (this.tdSize !== 88 && this.tdSize !== 92) throw new Error(`unexpected type definition size ${this.tdSize}`);
    // v24.x has byrefTypeIndex after byvalTypeIndex (92 bytes)
    this._tdShift = this.tdSize === 92 ? 4 : 0;
    this.tdBase = this.sec.typeDefinitions.off;

    // ---- methods: 32 bytes (v24.2–v29), 36 bytes (v31+: returnParameterToken)
    let methodTotal = 0;
    for (let i = 0; i < this.typeCount; i++) methodTotal = Math.max(methodTotal, this._tdRaw(i).methodStart + this._tdRaw(i).methodCount);
    this.methodCount = methodTotal;
    this.mdSize = methodTotal ? Math.round(this.sec.methods.size / methodTotal) : 32;
    if (this.mdSize !== 32 && this.mdSize !== 36) throw new Error(`unexpected method definition size ${this.mdSize}`);
    this._mdShift = this.mdSize === 36 ? 4 : 0;

    this.fieldSize = 12; // nameIndex, typeIndex, token
    this.paramSize = 12; // nameIndex, token, typeIndex
    this.propSize = 20;  // nameIndex, get, set, attrs, token

    this.imageOfType = new Int32Array(this.typeCount).fill(-1);
    for (const img of this.images) for (let t = img.typeStart; t < img.typeStart + img.typeCount; t++) this.imageOfType[t] = img.index;
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
    const m = this.mem;
    const p = this.tdBase + i * this.tdSize;
    const s = this._tdShift;
    return {
      nameIndex: m.u32At(p),
      namespaceIndex: m.u32At(p + 4),
      byvalTypeIndex: m.i32At(p + 8),
      declaringTypeIndex: m.i32At(p + 12 + s),
      parentIndex: m.i32At(p + 16 + s),
      elementTypeIndex: m.i32At(p + 20 + s),
      genericContainerIndex: m.i32At(p + 24 + s),
      flags: m.u32At(p + 28 + s),
      fieldStart: m.i32At(p + 32 + s),
      methodStart: m.i32At(p + 36 + s),
      eventStart: m.i32At(p + 40 + s),
      propertyStart: m.i32At(p + 44 + s),
      nestedTypesStart: m.i32At(p + 48 + s),
      interfacesStart: m.i32At(p + 52 + s),
      vtableStart: m.i32At(p + 56 + s),
      interfaceOffsetsStart: m.i32At(p + 60 + s),
      methodCount: m.u16At(p + 64 + s),
      propertyCount: m.u16At(p + 66 + s),
      fieldCount: m.u16At(p + 68 + s),
      eventCount: m.u16At(p + 70 + s),
      nestedCount: m.u16At(p + 72 + s),
      vtableCount: m.u16At(p + 74 + s),
      interfacesCount: m.u16At(p + 76 + s),
      interfaceOffsetsCount: m.u16At(p + 78 + s),
      bitfield: m.u32At(p + 80 + s),
      token: m.u32At(p + 84 + s),
    };
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
    let n = arity ? t.name : t.name.replace(/`\d+$/, '');
    if (t.declaringTypeIndex >= 0 && this._declTd) {
      const d = this._declTd(t.declaringTypeIndex);
      if (d >= 0) return this.fullName(d, { arity }) + '+' + n;
    }
    return t.namespace ? t.namespace + '.' + n : n;
  }

  method(i) {
    const m = this.mem;
    const p = this.sec.methods.off + i * this.mdSize;
    const s = this._mdShift;
    return {
      index: i,
      nameIndex: m.u32At(p),
      name: this.str(m.u32At(p)),
      declaringType: m.i32At(p + 4),
      returnType: m.i32At(p + 8),
      parameterStart: m.i32At(p + 12 + s),
      genericContainerIndex: m.i32At(p + 16 + s),
      token: m.u32At(p + 20 + s),
      flags: m.u16At(p + 24 + s),
      iflags: m.u16At(p + 26 + s),
      slot: m.u16At(p + 28 + s),
      parameterCount: m.u16At(p + 30 + s),
    };
  }

  param(i) {
    const m = this.mem;
    const p = this.sec.parameters.off + i * this.paramSize;
    return { index: i, name: this.str(m.u32At(p)), token: m.u32At(p + 4), typeIndex: m.i32At(p + 8) };
  }

  field(i) {
    const m = this.mem;
    const p = this.sec.fields.off + i * this.fieldSize;
    return { index: i, name: this.str(m.u32At(p)), nameIndex: m.u32At(p), typeIndex: m.i32At(p + 4), token: m.u32At(p + 8) };
  }

  property(i) {
    const m = this.mem;
    const p = this.sec.properties.off + i * this.propSize;
    return { index: i, name: this.str(m.u32At(p)), get: m.i32At(p + 4), set: m.i32At(p + 8), attrs: m.u32At(p + 12), token: m.u32At(p + 16) };
  }

  nestedType(i) { return this.mem.i32At(this.sec.nestedTypes.off + i * 4); }

  /** Default value record for a field (constants and enum members): { typeIndex, dataAddr } */
  fieldDefault(fieldIndex) {
    if (!this._fdv) {
      this._fdv = new Map();
      const s = this.sec.fieldDefaultValues;
      const m = this.mem;
      for (let p = s.off; p < s.off + s.size; p += 12) this._fdv.set(m.i32At(p), [m.i32At(p + 4), m.i32At(p + 8)]);
    }
    const r = this._fdv.get(fieldIndex);
    if (!r) return null;
    return { typeIndex: r[0], dataAddr: r[1] < 0 ? 0 : this.sec.fieldAndParameterDefaultValueData.off + r[1] };
  }

  stringLiteral(i) {
    const m = this.mem;
    const p = this.sec.stringLiteral.off + i * 8;
    const len = m.u32At(p);
    const data = m.i32At(p + 4);
    return new TextDecoder().decode(m.bytes(this.sec.stringLiteralData.off + data, len));
  }
}
