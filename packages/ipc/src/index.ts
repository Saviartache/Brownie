/**
 * `@brownie/ipc` — the contract between the Node runtime and the injected
 * native module.
 *
 * Like `@brownie/protocol`, this package is pure: framing, message codecs and
 * handshake arithmetic, with no sockets and no pipe. The transport lives in the
 * runtime, which is what lets every rule in here be tested against a hostile
 * peer without one.
 *
 * The C++ side implements the same contract by hand. `docs/ipc.md` is the
 * document both implementations answer to.
 */

export { AuthError, IpcError, LinkError, MessageError } from './errors.js';

export {
  FrameFlags,
  HEADER_BYTES,
  IPC_MAGIC,
  IPC_VERSION,
  MAX_PAYLOAD_BYTES,
  readHeader,
  writeHeader,
  type FrameHeader,
} from './frame/header.js';
export {
  FrameReader,
  SequenceGuard,
  SequenceSource,
  nextSeq,
  type Frame,
} from './frame/FrameReader.js';

export {
  decodeMessage,
  encodeMessage,
  framedSize,
  prepareMessage,
  writeMessage,
  type PreparedMessage,
} from './messages/codec.js';
export { TELEMETRY_BYTES, decodeTelemetry, encodeTelemetry } from './messages/telemetry.js';
export {
  MESSAGE_ORIGIN,
  MessageType,
  Origin,
  type AuthChallengeMessage,
  type AuthResultMessage,
  type ControlActionMessage,
  type ControlRecordMessage,
  type HelloMessage,
  type HotkeyEventMessage,
  type IpcMessage,
  type OffsetHealthMessage,
  type PingMessage,
  type PlayerTelemetryMessage,
  type PongMessage,
  type SetFeatureMessage,
  type UnknownMessage,
} from './messages/types.js';

export { RuntimeHandshake, normaliseUserId } from './handshake/Handshake.js';
export {
  NONCE_BYTES,
  createNonce,
  isNonce,
  macEquals,
  requireStrongSecret,
  sign,
} from './handshake/crypto.js';

export {
  buildRecord,
  decimalField,
  encodeField,
  encodeList,
  encodeOptions,
  intField,
  parseList,
  parseRecord,
  recordKind,
  type RecordField,
} from './overlay/RecordCodec.js';
