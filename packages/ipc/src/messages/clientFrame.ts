import { MessageError } from '../errors.js';
import type { BornShot, ClientFrameMessage, GoneShot } from './types.js';

/**
 * One frame of what the client sees, packed. Sent by the native module on
 * every game frame while the dodge asks for it — see `docs/ipc.md`.
 *
 * ```
 *  0  u8   flags       bit 0 = player, bit 1 = clock, bit 2 = shots scanned
 *  1  u8   reserved
 *  2  u16  born        shots the client made since the last frame
 *  4  u16  gone        shots the client destroyed since the last frame
 *  6  u16  reserved
 *  8  i32  frameTimeMs the client's frame clock
 * 12  f32  x           where the player is on this frame
 * 16  f32  y
 * 20  born × 36 bytes, then gone × 8 bytes:
 *
 *   born  0 i32 ownerId   4 u16 bulletId   6 u16 reserved   8 i32 ageMs
 *        12 f32 x        16 f32 y         20 f32 angle     24 f32 speedMultiplier
 *        28 f32 lifetimeMs                32 f32 halfTiles
 *   gone  0 i32 ownerId   4 u16 bulletId   6 u16 reserved
 * ```
 *
 * Binary because it arrives every frame, and fixed-width so a frame's length is
 * a function of its two counts: anything else is a frame this side refuses
 * rather than half-reads. What the numbers *mean* is checked by whoever uses
 * them — a shot the client says is not a number is its reader's to drop — so
 * this is framing and nothing more.
 */
export const CLIENT_FRAME_HEADER_BYTES = 20;
export const CLIENT_FRAME_BORN_BYTES = 36;
export const CLIENT_FRAME_GONE_BYTES = 8;

const FLAG_PLAYER = 1 << 0;
const FLAG_CLOCK = 1 << 1;
const FLAG_SCANNED = 1 << 2;

export function encodeClientFrame(message: ClientFrameMessage): Buffer {
  const born = message.scanned ? message.born : [];
  const gone = message.scanned ? message.gone : [];
  const buf = Buffer.alloc(
    CLIENT_FRAME_HEADER_BYTES +
      born.length * CLIENT_FRAME_BORN_BYTES +
      gone.length * CLIENT_FRAME_GONE_BYTES,
  );

  let flags = 0;
  if (message.player !== undefined) flags |= FLAG_PLAYER;
  if (message.frameTimeMs !== undefined) flags |= FLAG_CLOCK;
  if (message.scanned) flags |= FLAG_SCANNED;
  buf.writeUInt8(flags, 0);
  buf.writeUInt16LE(born.length, 2);
  buf.writeUInt16LE(gone.length, 4);
  buf.writeInt32LE(message.frameTimeMs ?? 0, 8);
  buf.writeFloatLE(message.player?.x ?? 0, 12);
  buf.writeFloatLE(message.player?.y ?? 0, 16);

  let at = CLIENT_FRAME_HEADER_BYTES;
  for (const shot of born) {
    buf.writeInt32LE(shot.ownerId, at);
    buf.writeUInt16LE(shot.bulletId, at + 4);
    buf.writeInt32LE(shot.ageMs, at + 8);
    buf.writeFloatLE(shot.x, at + 12);
    buf.writeFloatLE(shot.y, at + 16);
    buf.writeFloatLE(shot.angle, at + 20);
    buf.writeFloatLE(shot.speedMultiplier, at + 24);
    buf.writeFloatLE(shot.lifetimeMs, at + 28);
    buf.writeFloatLE(shot.halfTiles, at + 32);
    at += CLIENT_FRAME_BORN_BYTES;
  }
  for (const shot of gone) {
    buf.writeInt32LE(shot.ownerId, at);
    buf.writeUInt16LE(shot.bulletId, at + 4);
    at += CLIENT_FRAME_GONE_BYTES;
  }
  return buf;
}

export function decodeClientFrame(payload: Buffer): ClientFrameMessage {
  if (payload.length < CLIENT_FRAME_HEADER_BYTES) {
    throw new MessageError(
      `a client frame is ${String(payload.length)} bytes, shorter than its own header`,
    );
  }
  const flags = payload.readUInt8(0);
  const bornCount = payload.readUInt16LE(2);
  const goneCount = payload.readUInt16LE(4);
  const expected =
    CLIENT_FRAME_HEADER_BYTES +
    bornCount * CLIENT_FRAME_BORN_BYTES +
    goneCount * CLIENT_FRAME_GONE_BYTES;
  if (payload.length !== expected) {
    throw new MessageError(
      `a client frame of ${String(bornCount)} + ${String(goneCount)} shots is ` +
        `${String(expected)} bytes, not ${String(payload.length)}`,
    );
  }

  const clock = (flags & FLAG_CLOCK) !== 0;
  const scanned = (flags & FLAG_SCANNED) !== 0;
  // A scan is its shots' ages measured against the clock, so one without the
  // other is not a frame the module sends.
  if (scanned && !clock) throw new MessageError('a client frame scanned shots without a clock');
  if (!scanned && (bornCount > 0 || goneCount > 0)) {
    throw new MessageError('a client frame carries shots it says it did not scan');
  }

  const born: BornShot[] = [];
  let at = CLIENT_FRAME_HEADER_BYTES;
  for (let index = 0; index < bornCount; index++) {
    born.push({
      ownerId: payload.readInt32LE(at),
      bulletId: payload.readUInt16LE(at + 4),
      ageMs: payload.readInt32LE(at + 8),
      x: payload.readFloatLE(at + 12),
      y: payload.readFloatLE(at + 16),
      angle: payload.readFloatLE(at + 20),
      speedMultiplier: payload.readFloatLE(at + 24),
      lifetimeMs: payload.readFloatLE(at + 28),
      halfTiles: payload.readFloatLE(at + 32),
    });
    at += CLIENT_FRAME_BORN_BYTES;
  }
  const gone: GoneShot[] = [];
  for (let index = 0; index < goneCount; index++) {
    gone.push({ ownerId: payload.readInt32LE(at), bulletId: payload.readUInt16LE(at + 4) });
    at += CLIENT_FRAME_GONE_BYTES;
  }

  return {
    kind: 'clientFrame',
    player:
      (flags & FLAG_PLAYER) !== 0
        ? { x: payload.readFloatLE(12), y: payload.readFloatLE(16) }
        : undefined,
    frameTimeMs: clock ? payload.readInt32LE(8) : undefined,
    scanned,
    born,
    gone,
  };
}
