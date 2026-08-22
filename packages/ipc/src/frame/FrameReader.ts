import { LinkError } from '../errors.js';
import { HEADER_BYTES, readHeader, type FrameHeader } from './header.js';

const INITIAL_CAPACITY = 8 * 1024;
const COMPACT_THRESHOLD = 4 * 1024;

export interface Frame {
  readonly header: FrameHeader;
  /** Owned by the caller; safe to keep past the call that produced it. */
  readonly payload: Buffer;
}

/**
 * Turns the pipe's byte stream into whole frames.
 *
 * Same shape and the same reason as `PacketFramer` in `@brownie/protocol`: a
 * pipe read is not a message boundary, so framing is a component with its own
 * tests. The reference implementation re-sliced its accumulator per message
 * (`readBuf = readBuf.subarray(...)`), which keeps the original allocation
 * alive behind every slice for as long as any message is in flight.
 */
export class FrameReader {
  #buf: Buffer;
  #start = 0;
  #end = 0;

  constructor(initialCapacity = INITIAL_CAPACITY) {
    this.#buf = Buffer.allocUnsafe(Math.max(initialCapacity, HEADER_BYTES));
  }

  get buffered(): number {
    return this.#end - this.#start;
  }

  push(chunk: Buffer): void {
    if (chunk.length === 0) return;
    this.#makeRoom(chunk.length);
    chunk.copy(this.#buf, this.#end);
    this.#end += chunk.length;
  }

  /**
   * @returns the next complete frame, or `null` when more bytes are needed.
   * @throws {LinkError} when the header is not one of ours.
   */
  next(): Frame | null {
    if (this.#end - this.#start < HEADER_BYTES) return null;

    const header = readHeader(this.#buf, this.#start);
    const total = HEADER_BYTES + header.length;
    if (this.#end - this.#start < total) return null;

    const payloadStart = this.#start + HEADER_BYTES;
    const payload = Buffer.allocUnsafe(header.length);
    this.#buf.copy(payload, 0, payloadStart, payloadStart + header.length);
    this.#start += total;

    if (this.#start === this.#end) {
      this.#start = 0;
      this.#end = 0;
    } else if (this.#start >= COMPACT_THRESHOLD) {
      this.#compact();
    }
    return { header, payload };
  }

  *drain(): Generator<Frame> {
    for (let frame = this.next(); frame !== null; frame = this.next()) {
      yield frame;
    }
  }

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

/**
 * Detects dropped or replayed frames.
 *
 * The reference implementation signed every message with an HMAC to get this
 * property. On a point-to-point named pipe that has already completed a mutual
 * challenge, no third party can insert a frame — so what a per-message MAC
 * actually detected was *loss and reordering*, at the price of a SHA-256 per
 * frame including per-frame telemetry. A counter detects the same thing for
 * nothing. See `docs/ipc.md`.
 */
export class SequenceGuard {
  #last = 0;

  /** @throws {LinkError} on a gap or a replay. */
  accept(seq: number): void {
    const expected = nextSeq(this.#last);
    if (seq !== expected) {
      throw new LinkError(
        `sequence gap: expected ${String(expected)}, got ${String(seq)} — frames were lost or replayed`,
      );
    }
    this.#last = seq;
  }

  reset(): void {
    this.#last = 0;
  }
}

/** Sequence numbers start at 1 and wrap back to 1, never to 0. */
export function nextSeq(previous: number): number {
  return previous >= 0xffff_ffff ? 1 : previous + 1;
}

/** Hands out the next sequence number for one direction. */
export class SequenceSource {
  #last = 0;

  take(): number {
    this.#last = nextSeq(this.#last);
    return this.#last;
  }

  reset(): void {
    this.#last = 0;
  }
}
