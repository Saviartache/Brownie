import { LinkError, MessageError } from '../errors.js';
import { FrameFlags, HEADER_BYTES, IPC_VERSION, writeHeader } from '../frame/header.js';
import type { Frame } from '../frame/FrameReader.js';
import { decodeTelemetry, encodeTelemetry } from './telemetry.js';
import { MESSAGE_ORIGIN, MessageType, Origin, type IpcMessage } from './types.js';

/**
 * A message whose payload is ready to write, and whose framed size is known.
 *
 * Separate from writing it so a caller can size a batch before allocating one
 * buffer for the whole of it. A full overlay sync is a hundred-odd frames, and
 * one buffer and one write for the lot is a hundred allocations and a hundred
 * pipe writes fewer than one each.
 *
 * The JSON stays a string until it is written: `Buffer.write` encodes UTF-8
 * straight into the destination, so the intermediate buffer the old encoder
 * built and immediately copied out of never exists.
 */
export interface PreparedMessage {
  readonly type: number;
  readonly binary: boolean;
  /** Set for JSON payloads; `bytes` is set instead for binary ones. */
  readonly json: string | undefined;
  readonly bytes: Buffer | undefined;
  /** Payload size in bytes, header excluded. */
  readonly length: number;
}

/** What one prepared message occupies on the wire. */
export function framedSize(prepared: PreparedMessage): number {
  return HEADER_BYTES + prepared.length;
}

/**
 * Prepares a message for writing.
 *
 * JSON for control traffic and binary for telemetry: control messages are rare
 * and benefit enormously from being readable in a log, telemetry arrives every
 * frame and benefits from not being parsed at all.
 */
export function prepareMessage(message: IpcMessage): PreparedMessage {
  return encodePayload(message);
}

/**
 * Writes one prepared message at `offset`.
 *
 * @returns the number of bytes written.
 * @throws {LinkError} if the target cannot hold the frame.
 */
export function writeMessage(
  target: Buffer,
  offset: number,
  prepared: PreparedMessage,
  seq: number,
): number {
  const total = framedSize(prepared);
  if (target.length - offset < total) throw new LinkError('frame buffer too small');

  writeHeader(
    target,
    {
      version: IPC_VERSION,
      type: prepared.type,
      flags: prepared.binary ? FrameFlags.Binary : FrameFlags.None,
      seq,
      length: prepared.length,
    },
    offset,
  );
  if (prepared.json !== undefined) {
    target.write(prepared.json, offset + HEADER_BYTES, 'utf8');
  } else if (prepared.bytes !== undefined) {
    prepared.bytes.copy(target, offset + HEADER_BYTES);
  }
  return total;
}

/** Serialises one message into its own frame. */
export function encodeMessage(message: IpcMessage, seq: number): Buffer {
  const prepared = prepareMessage(message);
  const frame = Buffer.allocUnsafe(framedSize(prepared));
  writeMessage(frame, 0, prepared, seq);
  return frame;
}

function encodePayload(message: IpcMessage): PreparedMessage {
  switch (message.kind) {
    case 'hello':
      return json(MessageType.Hello, { pid: message.pid, challenge: message.challenge });
    case 'authChallenge':
      return json(MessageType.AuthChallenge, {
        userId: message.userId,
        pid: message.pid,
        response: message.response,
        challenge: message.challenge,
      });
    case 'authResult':
      return json(MessageType.AuthResult, { ok: message.ok, response: message.response });
    case 'ping':
      return json(MessageType.Ping, { nonce: message.nonce });
    case 'pong':
      return json(MessageType.Pong, { response: message.response });
    case 'setFeature':
      return json(MessageType.SetFeature, { key: message.key, value: message.value });
    case 'controlRecord':
      return json(MessageType.ControlRecord, { record: message.record });
    case 'controlAction':
      return json(MessageType.ControlAction, { action: message.action });
    case 'hotkeyEvent':
      return json(MessageType.HotkeyEvent, {
        pluginId: message.pluginId,
        action: message.action,
        value: message.value,
      });
    case 'offsetHealth':
      return json(MessageType.OffsetHealth, { unresolved: [...message.unresolved] });
    case 'serverTarget':
      return json(MessageType.ServerTarget, { host: message.host, port: message.port });
    case 'playerTelemetry':
      return binary(MessageType.PlayerTelemetry, encodeTelemetry(message));
    case 'unknown':
      return binary(message.type, message.payload);
  }
}

function json(type: number, body: Readonly<Record<string, unknown>>): PreparedMessage {
  const text = JSON.stringify(body);
  return { type, binary: false, json: text, bytes: undefined, length: Buffer.byteLength(text) };
}

function binary(type: number, payload: Buffer): PreparedMessage {
  return { type, binary: true, json: undefined, bytes: payload, length: payload.length };
}

/**
 * Decodes a frame into a typed message.
 *
 * @param from which side the frame arrived from, so a message can be rejected
 *   if it travelled the wrong way — the native module has no business sending
 *   `setFeature`, and accepting it would let a confused peer drive the runtime.
 * @throws {MessageError} when a known type carries a malformed payload.
 */
export function decodeMessage(frame: Frame, from: Origin): IpcMessage {
  const { type } = frame.header;
  const expected = MESSAGE_ORIGIN[type];

  if (expected === undefined) {
    // Forward compatibility: a newer peer may send types this build predates.
    return { kind: 'unknown', type, payload: frame.payload };
  }
  if (expected !== Origin.Either && expected !== from) {
    // A `LinkError`, not a `MessageError`: a malformed payload is one bad
    // message from a peer that is otherwise behaving, while a message sent in
    // the wrong direction means the peer is not the peer we think it is. The
    // link cannot be trusted after it, so it closes.
    throw new LinkError(
      `message type 0x${type.toString(16)} may only originate from the ${expected} side`,
    );
  }

  if (type === MessageType.PlayerTelemetry) return decodeTelemetry(frame.payload);

  const body = parseJson(frame.payload, type);
  switch (type) {
    case MessageType.Hello:
      return {
        kind: 'hello',
        pid: requireInt(body, 'pid'),
        challenge: requireString(body, 'challenge'),
      };
    case MessageType.AuthChallenge:
      return {
        kind: 'authChallenge',
        userId: requireString(body, 'userId'),
        pid: requireInt(body, 'pid'),
        response: requireString(body, 'response'),
        challenge: requireString(body, 'challenge'),
      };
    case MessageType.AuthResult:
      return {
        kind: 'authResult',
        ok: requireBoolean(body, 'ok'),
        response: requireString(body, 'response'),
      };
    case MessageType.Ping:
      return { kind: 'ping', nonce: requireString(body, 'nonce') };
    case MessageType.Pong:
      return { kind: 'pong', response: requireString(body, 'response') };
    case MessageType.SetFeature:
      return {
        kind: 'setFeature',
        key: requireString(body, 'key'),
        value: requireScalar(body, 'value'),
      };
    case MessageType.ControlRecord:
      return { kind: 'controlRecord', record: requireString(body, 'record') };
    case MessageType.ControlAction:
      return { kind: 'controlAction', action: requireString(body, 'action') };
    case MessageType.HotkeyEvent:
      return {
        kind: 'hotkeyEvent',
        pluginId: requireString(body, 'pluginId'),
        action: requireString(body, 'action'),
        value: requireBoolean(body, 'value'),
      };
    case MessageType.OffsetHealth:
      return { kind: 'offsetHealth', unresolved: requireStringArray(body, 'unresolved') };
    case MessageType.ServerTarget:
      return {
        kind: 'serverTarget',
        host: requireString(body, 'host'),
        port: requireInt(body, 'port'),
      };
    default:
      return { kind: 'unknown', type, payload: frame.payload };
  }
}

function parseJson(payload: Buffer, type: number): Readonly<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload.toString('utf8')) as unknown;
  } catch (cause) {
    throw new MessageError(`message 0x${type.toString(16)} is not valid JSON`, { cause });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new MessageError(`message 0x${type.toString(16)} is not a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function requireString(body: Readonly<Record<string, unknown>>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string') throw new MessageError(`field "${key}" must be a string`);
  return value;
}

function requireBoolean(body: Readonly<Record<string, unknown>>, key: string): boolean {
  const value = body[key];
  if (typeof value !== 'boolean') throw new MessageError(`field "${key}" must be a boolean`);
  return value;
}

function requireInt(body: Readonly<Record<string, unknown>>, key: string): number {
  const value = body[key];
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new MessageError(`field "${key}" must be an integer`);
  }
  return value;
}

function requireScalar(
  body: Readonly<Record<string, unknown>>,
  key: string,
): boolean | number | string {
  const value = body[key];
  if (typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  throw new MessageError(`field "${key}" must be a boolean, a finite number or a string`);
}

function requireStringArray(
  body: Readonly<Record<string, unknown>>,
  key: string,
): readonly string[] {
  const value = body[key];
  if (!Array.isArray(value)) throw new MessageError(`field "${key}" must be an array`);
  return value.map((entry, index) => {
    if (typeof entry !== 'string') {
      throw new MessageError(`field "${key}[${String(index)}]" must be a string`);
    }
    return entry;
  });
}
