import { MessageError } from '../errors.js';
import type { PlayerTelemetryMessage } from './types.js';

/**
 * Player telemetry, packed.
 *
 * ```
 *  0  u8   flags      bit 0 = alive, bit 1 = defense is known
 *  1  u8   reserved
 *  2  i16  defense
 *  4  f32  x
 *  8  f32  y
 * 12  i32  hp
 * 16  i32  maxHp
 * 20  u32  uptimeMs
 * ```
 *
 * Binary rather than JSON because this arrives on every game frame. The
 * reference implementation sent it as JSON *and* signed it with an HMAC over a
 * string rebuilt from the same fields — including `posX.toFixed(3)`, so the
 * signature depended on decimal formatting and any change to it silently
 * dropped every telemetry frame.
 */
export const TELEMETRY_BYTES = 24;

const FLAG_ALIVE = 1 << 0;
const FLAG_HAS_DEFENSE = 1 << 1;

export function encodeTelemetry(message: PlayerTelemetryMessage): Buffer {
  const buf = Buffer.allocUnsafe(TELEMETRY_BYTES);
  let flags = 0;
  if (message.alive) flags |= FLAG_ALIVE;
  if (message.defense !== undefined) flags |= FLAG_HAS_DEFENSE;

  buf.writeUInt8(flags, 0);
  buf.writeUInt8(0, 1);
  buf.writeInt16LE(clampInt16(message.defense ?? 0), 2);
  buf.writeFloatLE(message.x, 4);
  buf.writeFloatLE(message.y, 8);
  buf.writeInt32LE(clampInt32(message.hp), 12);
  buf.writeInt32LE(clampInt32(message.maxHp), 16);
  buf.writeUInt32LE(message.uptimeMs >>> 0, 20);
  return buf;
}

export function decodeTelemetry(payload: Buffer): PlayerTelemetryMessage {
  if (payload.length !== TELEMETRY_BYTES) {
    throw new MessageError(
      `player telemetry is ${String(payload.length)} bytes, expected ${String(TELEMETRY_BYTES)}`,
    );
  }
  const flags = payload.readUInt8(0);
  return {
    kind: 'playerTelemetry',
    alive: (flags & FLAG_ALIVE) !== 0,
    defense: (flags & FLAG_HAS_DEFENSE) !== 0 ? payload.readInt16LE(2) : undefined,
    x: payload.readFloatLE(4),
    y: payload.readFloatLE(8),
    hp: payload.readInt32LE(12),
    maxHp: payload.readInt32LE(16),
    uptimeMs: payload.readUInt32LE(20),
  };
}

function clampInt16(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-0x8000, Math.min(0x7fff, Math.trunc(value)));
}

function clampInt32(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-0x8000_0000, Math.min(0x7fff_ffff, Math.trunc(value)));
}
