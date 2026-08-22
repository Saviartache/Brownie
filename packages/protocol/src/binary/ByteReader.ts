import { DecodeError } from '../errors.js';

/**
 * Bounds-checked big-endian reader over a packet body.
 *
 * Every read is guarded before it happens, so a truncated or hostile packet
 * produces a {@link DecodeError} naming the offset instead of a `RangeError`
 * from deep inside `Buffer`. This class is the only place in the package that
 * touches raw bytes for reading, which is what makes "the parser cannot crash
 * the runtime" a property we can actually test.
 *
 * The reader borrows its buffer and never copies it; `bytes()` is the one
 * method that allocates, because the caller keeps what it returns.
 */
export class ByteReader {
  readonly #buf: Buffer;
  readonly #end: number;
  #pos: number;

  constructor(buffer: Buffer, offset = 0, end = buffer.length) {
    if (offset < 0 || end > buffer.length || offset > end) {
      throw new DecodeError('reader window outside buffer', { offset });
    }
    this.#buf = buffer;
    this.#pos = offset;
    this.#end = end;
  }

  get position(): number {
    return this.#pos;
  }

  get remaining(): number {
    return this.#end - this.#pos;
  }

  get exhausted(): boolean {
    return this.#pos >= this.#end;
  }

  #need(count: number): number {
    const at = this.#pos;
    if (count > this.#end - at) {
      throw new DecodeError(
        `unexpected end of packet: need ${String(count)} byte(s), have ${String(this.#end - at)}`,
        { offset: at },
      );
    }
    this.#pos = at + count;
    return at;
  }

  u8(): number {
    return this.#buf.readUInt8(this.#need(1));
  }

  i8(): number {
    return this.#buf.readInt8(this.#need(1));
  }

  bool(): boolean {
    return this.u8() !== 0;
  }

  i16(): number {
    return this.#buf.readInt16BE(this.#need(2));
  }

  u16(): number {
    return this.#buf.readUInt16BE(this.#need(2));
  }

  i32(): number {
    return this.#buf.readInt32BE(this.#need(4));
  }

  u32(): number {
    return this.#buf.readUInt32BE(this.#need(4));
  }

  f32(): number {
    return this.#buf.readFloatBE(this.#need(4));
  }

  /** UTF-8 string behind a signed 16-bit length. */
  string16(): string {
    return this.#stringOfLength(this.i16());
  }

  /** UTF-8 string behind a signed 32-bit length. */
  string32(): string {
    return this.#stringOfLength(this.i32());
  }

  #stringOfLength(length: number): string {
    if (length < 0) {
      throw new DecodeError(`negative string length ${String(length)}`, { offset: this.#pos });
    }
    const at = this.#need(length);
    return this.#buf.toString('utf8', at, at + length);
  }

  /** Copies `count` bytes out; the result is owned by the caller. */
  bytes(count: number): Buffer {
    if (count < 0) {
      throw new DecodeError(`negative byte count ${String(count)}`, { offset: this.#pos });
    }
    const at = this.#need(count);
    return Buffer.from(this.#buf.subarray(at, at + count));
  }

  /** Copies everything left; used to preserve bytes we could not describe. */
  rest(): Buffer {
    return this.bytes(this.remaining);
  }

  /**
   * Variable-length integer.
   *
   * First byte: bit 7 = continuation, bit 6 = sign, bits 0-5 = payload.
   * Continuation bytes: bit 7 = continuation, bits 0-6 = payload.
   *
   * Accumulation is arithmetic rather than `|=` on purpose: `<<` in JavaScript
   * truncates to 32 bits, so a malformed run of continuation bytes would
   * silently wrap into a plausible-looking negative number instead of being
   * rejected. Values are range-checked against int32, which is what the game
   * actually sends.
   */
  compressedInt(): number {
    const start = this.#pos;
    let byte = this.u8();
    const negative = (byte & 0b0100_0000) !== 0;
    let value = byte & 0b0011_1111;
    let shift = 6;

    while ((byte & 0b1000_0000) !== 0) {
      if (shift > 34) {
        throw new DecodeError('compressed int longer than int32 can hold', { offset: start });
      }
      byte = this.u8();
      value += (byte & 0b0111_1111) * 2 ** shift;
      shift += 7;
    }

    if (value > 0x7fff_ffff) {
      throw new DecodeError(`compressed int out of int32 range: ${String(value)}`, {
        offset: start,
      });
    }
    return negative ? -value : value;
  }
}
