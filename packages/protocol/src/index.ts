/**
 * `@brownie/protocol` — the RotMG wire protocol, and nothing else.
 *
 * This package is pure: no file system, no sockets, no clock, no logger, no
 * configuration. It turns bytes into packets and packets into bytes. That
 * constraint is what makes it exhaustively testable against malformed input,
 * which is the whole point of isolating it.
 *
 * File I/O lives in `@brownie/protocol/bundled`, which is the single exception
 * and does nothing but read the two definition files shipped with the package.
 */

export { ByteReader } from './binary/ByteReader.js';
export { ByteWriter } from './binary/ByteWriter.js';
export { Rc4 } from './crypto/Rc4.js';

export {
  CIPHER_OFFSET,
  CLIENT_KEY,
  HEADER_BYTES,
  MAX_FRAME_BYTES,
  MIN_FRAME_BYTES,
  SERVER_KEY,
  frameId,
  frameLength,
} from './framing/frame.js';
export { PacketFramer } from './framing/PacketFramer.js';

export { PacketRegistry } from './registry/PacketRegistry.js';
export { loadDefinitions, type LoadedDefinitions } from './schema/loadDefinitions.js';
export { fieldDefault, fieldOr } from './schema/fields.js';
export {
  PacketDirection,
  type FieldSchema,
  type FieldValue,
  type LengthType,
  type ObjectSchema,
  type PacketFields,
  type PacketSchema,
  type PrimitiveType,
  type ValueSchema,
} from './schema/types.js';

export { isOpaque, type DecodedPacket } from './codec/DecodedPacket.js';
export { decodeBody, decodeFrame } from './codec/decode.js';
export { createPacket, encodePacket, type EncodablePacket } from './codec/encode.js';

export { DecodeError, EncodeError, FrameError, ProtocolError, SchemaError } from './errors.js';
