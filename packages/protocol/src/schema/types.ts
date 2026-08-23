/**
 * The normalised shape of a packet definition.
 *
 * Definitions arrive as JSON (`data/packet-definitions.json`) because the wire
 * format changes with the game, not with our release cycle: a patch that moves
 * a field is a data edit, not a code change. The JSON is validated once at
 * startup into the types below, and nothing downstream ever looks at the raw
 * document again.
 */

/** Which way a packet travels, named for its origin. */
export const PacketDirection = {
  ClientToServer: 'c2s',
  ServerToClient: 's2c',
} as const;

export type PacketDirection = (typeof PacketDirection)[keyof typeof PacketDirection];

export type PrimitiveType =
  | 'byte'
  | 'sbyte'
  | 'bool'
  | 'int16'
  | 'uint16'
  | 'int32'
  | 'uint32'
  | 'float'
  | 'string'
  | 'utf32string'
  | 'compressedInt'
  | 'byteArray16'
  | 'byteArray32';

/** Integer types that may prefix an array's element count. */
export type LengthType = 'byte' | 'int16' | 'uint16' | 'int32' | 'compressedInt';

/** A value's type, with no name attached — arrays reuse this for elements. */
export type ValueSchema =
  | { readonly kind: 'primitive'; readonly type: PrimitiveType }
  | { readonly kind: 'array'; readonly lengthType: LengthType; readonly element: ValueSchema }
  | { readonly kind: 'object'; readonly ref: string }
  /**
   * A stat's payload, whose type depends on the sibling `id` field in the same
   * object: string stats read a string, everything else a compressed int. The
   * dependency is scoped to the object being read — the reference
   * implementation tracked it in a variable that leaked across nested objects
   * and array elements, so a string stat inside one element could change how
   * the next element was read.
   */
  | { readonly kind: 'statValue' };

/**
 * A bit in an earlier field that says whether this one is on the wire.
 *
 * **The game omits what it does not need, and says so in a mask.** `SHOWEFFECT`
 * carries a byte whose bits name which of its nine fields follow; a packet
 * announcing a nova with no colour and no duration is four bytes shorter than
 * one that has them. A positional schema cannot describe that, and describing
 * it as "optional" — which means *trailing* — is worse than not describing it
 * at all: three quarters of the SHOWEFFECT packets in a capture failed to
 * decode, and the quarter that succeeded read a landing spot out of the middle
 * of somebody else's float.
 */
export interface PresenceBit {
  /** The field carrying the mask. Always an integer, always earlier. */
  readonly field: string;
  /** The single bit that names this field. */
  readonly bit: number;
}

export interface FieldSchema {
  readonly name: string;
  readonly value: ValueSchema;
  /**
   * True when the field may be absent because the packet ended. The loader
   * enforces that optional fields are *trailing*: fields are positional, so an
   * absent field in the middle would silently shift every field after it.
   */
  readonly optional: boolean;
  /**
   * Or absent because a mask said so, which needs no such rule.
   *
   * A conditional field may sit anywhere, because whether it is there is
   * *stated* rather than inferred from what is left. See {@link PresenceBit}.
   */
  readonly presentWhen: PresenceBit | undefined;
  /** Value to use when an optional field is absent. */
  readonly defaultValue: FieldValue | undefined;
}

export interface ObjectSchema {
  readonly name: string;
  readonly fields: readonly FieldSchema[];
}

export interface PacketSchema {
  readonly id: number;
  readonly name: string;
  readonly direction: PacketDirection;
  readonly fields: readonly FieldSchema[];
}

export type FieldValue =
  | number
  | boolean
  | string
  | Buffer
  | readonly FieldValue[]
  | { readonly [key: string]: FieldValue };

/** Decoded packet body: field name to value, in definition order. */
export type PacketFields = Record<string, FieldValue | undefined>;
