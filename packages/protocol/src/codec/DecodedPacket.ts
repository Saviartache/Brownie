import type { DecodeError } from '../errors.js';
import type { PacketDirection, PacketFields, PacketSchema } from '../schema/types.js';

/**
 * One packet as it exists between decode and encode.
 *
 * `frame` is always the exact deciphered bytes that arrived, header included.
 * Keeping it is what lets an untouched packet forward byte-for-byte instead of
 * being rebuilt from fields — the only way a definition that has drifted from
 * the live game can degrade to "we do not understand this packet" rather than
 * "we corrupted this packet".
 */
export interface DecodedPacket {
  readonly id: number;
  /** Defined name, or `UNKNOWN_<id>`. */
  readonly name: string;
  readonly direction: PacketDirection | undefined;
  /**
   * `undefined` when the packet is opaque — either no definition exists for
   * this id, or its body failed to decode. An opaque packet must be forwarded
   * from `frame`; it cannot be re-encoded.
   */
  readonly schema: PacketSchema | undefined;
  readonly frame: Buffer;
  /** Mutable by design: pipeline stages edit fields, then flag the packet modified. */
  fields: PacketFields;
  /** Bytes the schema did not describe. Preserved so re-encoding round-trips. */
  readonly trailing: Buffer;
  /** Set when the body failed to decode; the packet is opaque but the reason is kept. */
  readonly error: DecodeError | undefined;
}

/** Whether this packet must be forwarded as raw bytes rather than re-encoded. */
export function isOpaque(packet: DecodedPacket): boolean {
  return packet.schema === undefined;
}
