// Il2CppTypeEnum and attribute constants.
export const T = {
  END: 0x00, VOID: 0x01, BOOLEAN: 0x02, CHAR: 0x03, I1: 0x04, U1: 0x05, I2: 0x06, U2: 0x07,
  I4: 0x08, U4: 0x09, I8: 0x0a, U8: 0x0b, R4: 0x0c, R8: 0x0d, STRING: 0x0e, PTR: 0x0f,
  BYREF: 0x10, VALUETYPE: 0x11, CLASS: 0x12, VAR: 0x13, ARRAY: 0x14, GENERICINST: 0x15,
  TYPEDBYREF: 0x16, I: 0x18, U: 0x19, FNPTR: 0x1b, OBJECT: 0x1c, SZARRAY: 0x1d, MVAR: 0x1e,
};

export const PRIM_NAME = {
  [T.VOID]: 'void', [T.BOOLEAN]: 'bool', [T.CHAR]: 'char', [T.I1]: 'sbyte', [T.U1]: 'byte',
  [T.I2]: 'short', [T.U2]: 'ushort', [T.I4]: 'int', [T.U4]: 'uint', [T.I8]: 'long', [T.U8]: 'ulong',
  [T.R4]: 'float', [T.R8]: 'double', [T.STRING]: 'string', [T.I]: 'IntPtr', [T.U]: 'UIntPtr',
  [T.OBJECT]: 'object', [T.TYPEDBYREF]: 'TypedReference',
};

/** Size in bytes of a primitive stored inline (fields, array elements). */
export const PRIM_SIZE = {
  [T.BOOLEAN]: 1, [T.I1]: 1, [T.U1]: 1, [T.CHAR]: 2, [T.I2]: 2, [T.U2]: 2, [T.I4]: 4, [T.U4]: 4,
  [T.R4]: 4, [T.I8]: 8, [T.U8]: 8, [T.R8]: 8, [T.I]: 4, [T.U]: 4, [T.PTR]: 4, [T.FNPTR]: 4,
  [T.STRING]: 4, [T.CLASS]: 4, [T.OBJECT]: 4, [T.SZARRAY]: 4, [T.ARRAY]: 4,
};

/** Kinds that are a single pointer to a managed object. */
export const REF_KINDS = new Set([T.STRING, T.CLASS, T.OBJECT, T.SZARRAY, T.ARRAY]);

// FieldAttributes (stored in the field type's attrs)
export const FIELD = { ACCESS: 0x7, PRIVATE: 1, PUBLIC: 6, STATIC: 0x10, INIT_ONLY: 0x20, LITERAL: 0x40 };
// MethodAttributes
export const METHOD = { ACCESS: 0x7, PRIVATE: 1, PUBLIC: 6, STATIC: 0x10, VIRTUAL: 0x40, ABSTRACT: 0x400, SPECIAL: 0x800 };
export const ACCESS_NAME = ['', 'private', 'private protected', 'internal', 'protected', 'protected internal', 'public'];
