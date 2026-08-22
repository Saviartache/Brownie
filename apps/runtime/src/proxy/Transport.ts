import type { Socket } from 'node:net';

/**
 * A byte pipe with the four things the proxy needs from one.
 *
 * Named separately from `net.Socket` so a session can be driven end to end in a
 * test without a network, and so backpressure has exactly one implementation
 * instead of being re-derived at each `write` call site. The reference
 * implementation called `socket.write()` and ignored its result everywhere,
 * which means a slow consumer accumulated in Node's internal buffer with no
 * bound and no signal.
 */
export interface Transport {
  /**
   * Queues bytes. Takes ownership of `data` — the caller must not touch it
   * afterwards, because it may be held until the peer drains.
   */
  send(data: Buffer): void;
  onData(listener: (chunk: Buffer) => void): void;
  onClose(listener: () => void): void;
  onError(listener: (error: Error) => void): void;
  close(): void;
  readonly closed: boolean;
  /** Bytes waiting because the peer has not drained. */
  readonly pending: number;

  /**
   * Stops sending. Everything handed over meanwhile is kept, in order, and goes
   * out on {@link resume}.
   *
   * **Held, never dropped**, and that distinction is the whole of it. RC4 is a
   * stream: a frame that is enciphered and then thrown away advances our cipher
   * without advancing the peer's, and everything after it is noise. It is also
   * what the game's own protocol needs — the client answers every server tick
   * with a `MOVE` carrying that tick's number, so a gap in them is a gap the
   * server counts and disconnects over. Player noclip found that out by
   * dropping them and being kicked the moment it stopped.
   */
  pause(): void;

  /** Sends whatever queued up, in order, and stops holding. */
  resume(): void;
}

/**
 * How much may pile up before we give up on a peer.
 *
 * A game connection that is this far behind is not going to catch up, and
 * holding more only turns a stalled session into an out-of-memory process.
 */
export const MAX_PENDING_BYTES = 4 * 1024 * 1024;

export interface SocketTransportOptions {
  /**
   * Start paused, flushing once {@link SocketTransport.resume} is called.
   *
   * This is how the server side is created: packets that arrive from the game
   * client during the ~50 ms TCP connect must be held, not dropped. Dropping
   * one desynchronises RC4 for the rest of the connection, which the reference
   * implementation discovered the hard way and fixed with a second, parallel
   * queue next to the backpressure path. One queue does both.
   */
  readonly startPaused?: boolean;
  readonly maxPendingBytes?: number;
}

export class SocketTransport implements Transport {
  readonly #socket: Socket;
  readonly #maxPending: number;
  readonly #queue: Buffer[] = [];
  /**
   * How far into {@link #queue} the flush has got.
   *
   * An index rather than `shift()`, which moves every remaining element on
   * every call — quadratic in the length of the queue, and the queue is only
   * long when the peer is already struggling. The array is emptied and the
   * index reset together, once it has been drained.
   */
  #head = 0;
  #pending = 0;
  /**
   * Whether sends go out or queue up.
   *
   * Closed at birth for the server side, and closed again by `pause()` for as
   * long as something wants the uplink held. Either way what is behind it is
   * one queue with one bound.
   */
  #gateOpen: boolean;
  /** Set while Node has told us to wait for `drain`. */
  #backpressured = false;
  #closed = false;

  #onData: ((chunk: Buffer) => void) | undefined;
  #onClose: (() => void) | undefined;
  #onError: ((error: Error) => void) | undefined;

  constructor(socket: Socket, options: SocketTransportOptions = {}) {
    this.#socket = socket;
    this.#maxPending = options.maxPendingBytes ?? MAX_PENDING_BYTES;
    this.#gateOpen = !(options.startPaused ?? false);

    socket.setNoDelay(true);
    socket.on('data', (chunk: Buffer) => this.#onData?.(chunk));
    socket.on('drain', () => {
      this.#flush();
    });
    socket.on('error', (error: Error) => this.#onError?.(error));
    socket.on('close', () => {
      this.#closed = true;
      this.#clearQueue();
      this.#pending = 0;
      this.#onClose?.();
    });
  }

  get closed(): boolean {
    return this.#closed || this.#socket.destroyed;
  }

  get pending(): number {
    return this.#pending;
  }

  /**
   * Holds everything from here on. Nothing already written to the socket comes
   * back, so this stops the next byte and not the last one.
   */
  pause(): void {
    this.#gateOpen = false;
  }

  /**
   * Releases a transport created paused, or held since. Sends whatever queued
   * up, in order.
   */
  resume(): void {
    if (this.#gateOpen) return;
    this.#gateOpen = true;
    this.#flush();
  }

  send(data: Buffer): void {
    if (this.closed) return;

    if (!this.#gateOpen || this.#backpressured || this.#head < this.#queue.length) {
      this.#enqueue(data);
      return;
    }
    // `write` returning false means Node buffered it and wants us to wait.
    // Queueing from that point keeps our own ordering intact: a later `send`
    // must not overtake the bytes Node is still holding.
    if (!this.#socket.write(data)) this.#backpressured = true;
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
    this.#clearQueue();
    this.#pending = 0;
    this.#socket.destroy();
  }

  #enqueue(data: Buffer): void {
    this.#queue.push(data);
    this.#pending += data.length;
    if (this.#pending > this.#maxPending) {
      // Closing is the only honest option: we cannot drop a packet without
      // desynchronising the cipher, and we cannot hold this much forever.
      this.#onError?.(
        new Error(
          `peer is ${String(this.#pending)} bytes behind — closing rather than buffering more`,
        ),
      );
      this.close();
    }
  }

  #flush(): void {
    this.#backpressured = false;
    if (!this.#gateOpen) return;

    while (this.#head < this.#queue.length && !this.closed) {
      const next = this.#queue[this.#head];
      if (next === undefined) break;
      this.#head++;
      this.#pending -= next.length;
      if (!this.#socket.write(next)) {
        this.#backpressured = true;
        break;
      }
    }
    // Emptied only once it is drained, so the index and the array are reset
    // together and neither can be left describing the other wrongly.
    if (this.#head >= this.#queue.length) this.#clearQueue();
  }

  #clearQueue(): void {
    this.#queue.length = 0;
    this.#head = 0;
  }
}
