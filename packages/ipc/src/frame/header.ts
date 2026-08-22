import { LinkError } from '../errors.js';

/**
 * The IPC frame header.
 *
 * ```
 *  0   u32  magic      'BRWN'
 *  4   u16  version    protocol version; a mismatch closes the connection
 *  6   u16  type       message type
 *  8   u16  flags      bit 0 = binary payload (otherwise UTF-8 JSON)
 * 10   u16  reserved   must be zero
 * 12   u32  seq        monotonic, per direction
 * 16   u32  length     payload byte count
 * ```
 *
 * Little-endian — the peer is a C++ module on x86-64, so this costs it nothing
 * and the runtime pays a byte swap it would not notice. (The *game* protocol in
 * `@brownie/protocol` is big-endian; the two are unrelated wire formats and the
 * difference is deliberate rather than an oversight.)
 *
 * The reference implementation framed with a bare 4-byte length and put the
 * version inside the handshake JSON, which meant a version mismatch was only
 * detectable after successfully parsing a message from a peer that might not
 * speak the same format at all.
 */

/** `BRWN` read as a little-endian u32. */
export const IPC_MAGIC = 0x4e57_5242;

export const IPC_VERSION = 1;

export const HEADER_BYTES = 20;

/** Payload cap. Overlay sprite chunks are the largest legitimate payload. */
export const MAX_PAYLOAD_BYTES = 256 * 1024;

export const FrameFlags = {
  None: 0,
  /** Payload is opaque bytes rather than UTF-8 JSON. */
  Binary: 1 << 0,
} as const;

export interface FrameHeader {
  readonly version: number;
  readonly type: number;
  readonly flags: number;
  readonly seq: number;
  readonly length: number;
}

export function writeHeader(target: Buffer, header: FrameHeader, offset = 0): void {
  if (target.length - offset < HEADER_BYTES) throw new LinkError('header buffer too small');
  target.writeUInt32LE(IPC_MAGIC, offset);
  target.writeUInt16LE(header.version, offset + 4);
  target.writeUInt16LE(header.type, offset + 6);
  target.writeUInt16LE(header.flags, offset + 8);
  target.writeUInt16LE(0, offset + 10);
  target.writeUInt32LE(header.seq >>> 0, offset + 12);
  target.writeUInt32LE(header.length, offset + 16);
}

/**
 * Validates and decodes a header.
 *
 * @throws {LinkError} on anything that means the peer is not speaking this
 *   protocol, or is speaking a version of it we cannot parse.
 */
export function readHeader(source: Buffer, offset = 0): FrameHeader {
  if (source.length - offset < HEADER_BYTES) {
    throw new LinkError('not enough bytes for a header');
  }

  const magic = source.readUInt32LE(offset);
  if (magic !== IPC_MAGIC) {
    throw new LinkError(
      `bad frame magic 0x${magic.toString(16)} — the peer is not speaking this protocol`,
    );
  }

  const version = source.readUInt16LE(offset + 4);
  if (version !== IPC_VERSION) {
    throw new LinkError(
      `peer speaks IPC version ${String(version)}, this build speaks ${String(IPC_VERSION)}`,
    );
  }

  // Reserved bits are checked rather than ignored: they are the only way a
  // future version can add a field and know that older builds refused the frame
  // instead of silently misreading it.
  const reserved = source.readUInt16LE(offset + 10);
  if (reserved !== 0) throw new LinkError('reserved header field is not zero');

  const length = source.readUInt32LE(offset + 16);
  if (length > MAX_PAYLOAD_BYTES) {
    throw new LinkError(
      `payload of ${String(length)} bytes exceeds the ${String(MAX_PAYLOAD_BYTES)}-byte cap`,
    );
  }

  return {
    version,
    type: source.readUInt16LE(offset + 6),
    flags: source.readUInt16LE(offset + 8),
    seq: source.readUInt32LE(offset + 12),
    length,
  };
}
