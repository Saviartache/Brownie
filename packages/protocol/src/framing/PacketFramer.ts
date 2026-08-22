import { FrameError } from '../errors.js';
import { MAX_FRAME_BYTES, MIN_FRAME_BYTES } from './frame.js';

const INITIAL_CAPACITY = 16 * 1024;
/** Compact once the dead prefix is worth more than the copy that removes it. */
const COMPACT_THRESHOLD = 8 * 1024;

/**
 * Turns a TCP byte stream into whole packet frames.
 *
 * A socket `data` event has no relationship to a packet boundary: it can carry
 * half a header, six packets, or the tail of one packet and the head of the
 * next. Framing is therefore its own component with its own tests, rather than
 * a loop inside the connection class — which is where the reference
 * implementation kept it, and where it accumulated with `Buffer.concat` per
 * chunk plus a fresh `Buffer.from` per extracted packet, making a busy
 * connection quadratic in the amount of data in flight.
 *
 * Here, bytes land in one growable buffer between a read and a write cursor.
 * The cursor pair is advanced, never re-allocated; the dead prefix is reclaimed
 * by a single `copy` once it is large enough to be worth reclaiming.
 *
 * Each completed frame is copied out exactly once. That copy is deliberate and
 * unavoidable: the caller deciphers in place and may hand the buffer to a
 * plugin that outlives the call, so it cannot be a view into memory the framer
 * will overwrite.
 */
export class PacketFramer {
  #buf: Buffer;
  #start = 0;
  #end = 0;

  constructor(initialCapacity = INITIAL_CAPACITY) {
    this.#buf = Buffer.allocUnsafe(Math.max(initialCapacity, MIN_FRAME_BYTES));
  }

  /** Bytes received but not yet consumed by a completed frame. */
  get buffered(): number {
    return this.#end - this.#start;
  }

  /** Appends received bytes. Does not parse; call {@link next} to drain. */
  push(chunk: Buffer): void {
    if (chunk.length === 0) return;
    this.#makeRoom(chunk.length);
    chunk.copy(this.#buf, this.#end);
    this.#end += chunk.length;
  }

  /**
   * Returns the next complete frame, or `null` when more bytes are needed.
   *
   * @throws {FrameError} when the declared length is structurally impossible.
   *   The stream cannot be resynchronised after that, so the caller must close
   *   the session rather than skip the frame.
   */
  next(): Buffer | null {
    const available = this.#end - this.#start;
    if (available < 4) return null;

    const length = this.#buf.readInt32BE(this.#start);
    if (length < MIN_FRAME_BYTES || length > MAX_FRAME_BYTES) {
      throw new FrameError(
        `frame length ${String(length)} outside [${String(MIN_FRAME_BYTES)}, ${String(MAX_FRAME_BYTES)}] — stream desynchronised`,
      );
    }
    if (available < length) return null;

    const frame = Buffer.allocUnsafe(length);
    this.#buf.copy(frame, 0, this.#start, this.#start + length);
    this.#start += length;

    if (this.#start === this.#end) {
      this.#start = 0;
      this.#end = 0;
    } else if (this.#start >= COMPACT_THRESHOLD) {
      this.#compact();
    }
    return frame;
  }

  /** Convenience for `while ((f = next()) !== null)`. */
  *drain(): Generator<Buffer> {
    for (let frame = this.next(); frame !== null; frame = this.next()) {
      yield frame;
    }
  }

  /** Drops everything buffered. Used when a direction's connection restarts. */
  reset(): void {
    this.#start = 0;
    this.#end = 0;
  }

  #makeRoom(count: number): void {
    if (this.#end + count <= this.#buf.length) return;

    const live = this.#end - this.#start;
    if (live + count <= this.#buf.length) {
      this.#compact();
      return;
    }

    let capacity = this.#buf.length * 2;
    while (capacity < live + count) capacity *= 2;
    const next = Buffer.allocUnsafe(capacity);
    this.#buf.copy(next, 0, this.#start, this.#end);
    this.#buf = next;
    this.#start = 0;
    this.#end = live;
  }

  #compact(): void {
    this.#buf.copy(this.#buf, 0, this.#start, this.#end);
    this.#end -= this.#start;
    this.#start = 0;
  }
}
