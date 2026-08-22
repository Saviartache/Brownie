import { CIPHER_OFFSET, CLIENT_KEY, Rc4, SERVER_KEY } from '@brownie/protocol';
import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
import { LogLevel, Logger, type LogRecord, type LogSink } from '../src/core/logging/Logger.js';
import type { Transport } from '../src/proxy/Transport.js';

/** A transport with no network behind it. */
export class FakeTransport implements Transport {
  readonly sent: Buffer[] = [];
  /** Held by `pause`, in order, and appended to `sent` by `resume`. */
  readonly #held: Buffer[] = [];
  #paused = false;
  #closed = false;
  #onData: ((chunk: Buffer) => void) | undefined;
  #onClose: (() => void) | undefined;
  #onError: ((error: Error) => void) | undefined;

  get closed(): boolean {
    return this.#closed;
  }

  get pending(): number {
    return this.#held.reduce((total, held) => total + held.length, 0);
  }

  /** Everything sent so far, concatenated — convenient for framing assertions. */
  get sentBytes(): Buffer {
    return Buffer.concat(this.sent);
  }

  send(data: Buffer): void {
    if (this.#closed) return;
    if (this.#paused) {
      this.#held.push(data);
      return;
    }
    this.sent.push(data);
  }

  // A real gate, not a no-op: a fake that sent while it claimed to be holding
  // would let a test pass over the bug the hold exists to prevent.
  pause(): void {
    this.#paused = true;
  }

  resume(): void {
    this.#paused = false;
    this.sent.push(...this.#held.splice(0));
  }

  onData(listener: (chunk: Buffer) => void): void {
    this.#onData = listener;
  }

  onClose(listener: () => void): void {
    this.#onClose = listener;
  }

  onError(listener: (error: Error) => void): void {
    this.#onError = listener;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#onClose?.();
  }

  // ── Test-side controls ────────────────────────────────────────────────────

  /** Simulates bytes arriving from the peer. */
  receive(chunk: Buffer): void {
    this.#onData?.(chunk);
  }

  /** Simulates a transport-level failure. */
  fail(error: Error): void {
    this.#onError?.(error);
  }
}

/**
 * A `net.Socket` stand-in.
 *
 * Only the surface `SocketTransport` touches is implemented; `writeAccepts`
 * drives the backpressure path, which is otherwise impossible to reach without
 * an actually-slow peer.
 */
export class FakeSocket extends EventEmitter {
  readonly written: Buffer[] = [];
  destroyed = false;
  /** When false, `write` reports that Node has buffered the data. */
  writeAccepts = true;

  setNoDelay(): this {
    return this;
  }

  write(data: Buffer): boolean {
    this.written.push(data);
    return this.writeAccepts;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit('close');
  }

  /** Signals that the peer caught up. */
  drain(): void {
    this.writeAccepts = true;
    this.emit('drain');
  }

  /** The cast is safe because `SocketTransport` uses nothing else. */
  asSocket(): Socket {
    return this as unknown as Socket;
  }
}

/** Captures log records instead of printing them. */
export class RecordingSink implements LogSink {
  readonly records: LogRecord[] = [];

  write(record: LogRecord): void {
    this.records.push(record);
  }

  messages(): string[] {
    return this.records.map((r) => r.message);
  }
}

export function testLogger(sink: LogSink = new RecordingSink()): Logger {
  return Logger.create(sink, 'test', LogLevel.Trace);
}

/** Builds a plaintext frame: int32 length (inclusive) + id byte + body. */
export function frameOf(id: number, body: Buffer = Buffer.alloc(0)): Buffer {
  const out = Buffer.alloc(5 + body.length);
  out.writeInt32BE(out.length, 0);
  out.writeUInt8(id, 4);
  body.copy(out, 5);
  return out;
}

/**
 * The cipher pair one peer of a session uses.
 *
 * Written from the protocol document rather than from `PeerLink`, so a change
 * that flips a key would fail here rather than pass by symmetry.
 */
export class PeerCiphers {
  readonly #send: Rc4;
  readonly #receive: Rc4;

  private constructor(sendKey: string, receiveKey: string) {
    this.#send = new Rc4(sendKey);
    this.#receive = new Rc4(receiveKey);
  }

  /** The game client: sends with the client key, receives with the server key. */
  static gameClient(): PeerCiphers {
    return new PeerCiphers(CLIENT_KEY, SERVER_KEY);
  }

  /** The game server: sends with the server key, receives with the client key. */
  static gameServer(): PeerCiphers {
    return new PeerCiphers(SERVER_KEY, CLIENT_KEY);
  }

  /** Enciphers a plaintext frame for sending. Returns a new buffer. */
  encipher(frame: Buffer): Buffer {
    const copy = Buffer.from(frame);
    this.#send.process(copy, CIPHER_OFFSET);
    return copy;
  }

  /** Deciphers a received frame. Returns a new buffer. */
  decipher(frame: Buffer): Buffer {
    const copy = Buffer.from(frame);
    this.#receive.process(copy, CIPHER_OFFSET);
    return copy;
  }
}
