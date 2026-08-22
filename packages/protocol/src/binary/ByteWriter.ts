import { EncodeError } from '../errors.js';

const DEFAULT_CAPACITY = 512;

/**
 * Growable big-endian writer.
 *
 * Backed by one buffer that doubles on demand, rather than by a list of chunks
 * joined with `Buffer.concat` at the end: a packet is written once and handed
 * to the cipher, so the extra copy bought nothing.
 *
 * A writer is single-use. {@link finish} seals it and returns a view of the
 * bytes written — no copy — which is safe precisely because no further write
 * can reach that memory. Reusing a sealed writer is a programming error and
 * throws rather than corrupting a packet already queued on a socket.
 */
export class ByteWriter {
  #buf: Buffer;
  #len = 0;
  #sealed = false;

  constructor(initialCapacity = DEFAULT_CAPACITY) {
    this.#buf = Buffer.allocUnsafe(Math.max(initialCapacity, 16));
  }

  get length(): number {
    return this.#len;
  }

  #reserve(count: number): number {
    if (this.#sealed) throw new EncodeError('writer already finished');
    const at = this.#len;
    const needed = at + count;
    if (needed > this.#buf.length) {
      let capacity = this.#buf.length * 2;
      while (capacity < needed) capacity *= 2;
      const next = Buffer.allocUnsafe(capacity);
      this.#buf.copy(next, 0, 0, at);
      this.#buf = next;
    }
    this.#len = needed;
    return at;
  }

  // Every writer below takes the same shape on purpose:
  //
  //   validate → reserve → write
  //
  // `#reserve` may replace `#buf` when the buffer grows, so the target buffer
  // must be read *after* reserving. Writing it as
  // `this.#buf.write…(value, this.#reserve(n))` evaluates `this.#buf` first and
  // therefore writes into the buffer that was just discarded — silently, for
  // every packet large enough to trigger a growth.

  u8(value: number): this {
    const at = this.#reserve(1);
    this.#buf.writeUInt8(value & 0xff, at);
    return this;
  }

  i8(value: number): this {
    const checked = clampInt(value, -0x80, 0x7f, 'sbyte');
    const at = this.#reserve(1);
    this.#buf.writeInt8(checked, at);
    return this;
  }

  bool(value: boolean): this {
    return this.u8(value ? 1 : 0);
  }

  i16(value: number): this {
    const checked = clampInt(value, -0x8000, 0x7fff, 'int16');
    const at = this.#reserve(2);
    this.#buf.writeInt16BE(checked, at);
    return this;
  }

  u16(value: number): this {
    const checked = clampInt(value, 0, 0xffff, 'uint16');
    const at = this.#reserve(2);
    this.#buf.writeUInt16BE(checked, at);
    return this;
  }

  i32(value: number): this {
    const checked = clampInt(value, -0x8000_0000, 0x7fff_ffff, 'int32');
    const at = this.#reserve(4);
    this.#buf.writeInt32BE(checked, at);
    return this;
  }

  u32(value: number): this {
    const checked = clampInt(value, 0, 0xffff_ffff, 'uint32');
    const at = this.#reserve(4);
    this.#buf.writeUInt32BE(checked, at);
    return this;
  }

  f32(value: number): this {
    const at = this.#reserve(4);
    this.#buf.writeFloatBE(value, at);
    return this;
  }

  string16(value: string): this {
    return this.#writeString(value, 2);
  }

  string32(value: string): this {
    return this.#writeString(value, 4);
  }

  #writeString(value: string, prefixBytes: 2 | 4): this {
    const byteLength = Buffer.byteLength(value, 'utf8');
    const max = prefixBytes === 2 ? 0x7fff : 0x7fff_ffff;
    if (byteLength > max) {
      throw new EncodeError(`string of ${String(byteLength)} bytes exceeds its length prefix`);
    }
    if (prefixBytes === 2) this.i16(byteLength);
    else this.i32(byteLength);
    const at = this.#reserve(byteLength);
    this.#buf.write(value, at, byteLength, 'utf8');
    return this;
  }

  bytes(value: Uint8Array): this {
    const at = this.#reserve(value.length);
    this.#buf.set(value, at);
    return this;
  }

  /** Mirror of {@link ByteReader.compressedInt}. */
  compressedInt(value: number): this {
    if (!Number.isInteger(value)) {
      throw new EncodeError(`compressed int must be an integer, got ${String(value)}`);
    }
    const negative = value < 0;
    let magnitude = Math.abs(value);
    if (magnitude > 0x7fff_ffff) {
      throw new EncodeError(`compressed int out of int32 range: ${String(value)}`);
    }

    let first = magnitude % 64;
    magnitude = Math.floor(magnitude / 64);
    if (negative) first |= 0b0100_0000;
    if (magnitude > 0) first |= 0b1000_0000;
    this.u8(first);

    while (magnitude > 0) {
      let next = magnitude % 128;
      magnitude = Math.floor(magnitude / 128);
      if (magnitude > 0) next |= 0b1000_0000;
      this.u8(next);
    }
    return this;
  }

  /** Overwrite four bytes already written — used to stamp the frame length. */
  patchU32(offset: number, value: number): void {
    if (this.#sealed) throw new EncodeError('writer already finished');
    if (offset < 0 || offset + 4 > this.#len) {
      throw new EncodeError(`patch at ${String(offset)} is outside the written region`);
    }
    this.#buf.writeUInt32BE(value >>> 0, offset);
  }

  /** Seals the writer and returns the bytes written. Does not copy. */
  finish(): Buffer {
    if (this.#sealed) throw new EncodeError('writer already finished');
    this.#sealed = true;
    return this.#buf.subarray(0, this.#len);
  }
}

function clampInt(value: number, min: number, max: number, type: string): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new EncodeError(`value ${String(value)} is not a valid ${type}`);
  }
  return value;
}
