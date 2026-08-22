import { CIPHER_OFFSET, PacketFramer, Rc4 } from '@brownie/protocol';
import { toError } from '../core/logging/Logger.js';
import type { Transport } from './Transport.js';

export interface PeerLinkOptions {
  readonly transport: Transport;
  /** Key that deciphers what this peer sends us. */
  readonly receiveKey: string;
  /** Key that enciphers what we send to this peer. */
  readonly sendKey: string;
}

/**
 * One side of a session: a transport, its two ciphers and its framer.
 *
 * Grouping them is not tidiness — they are one unit of state. The RC4
 * keystreams run continuously for the life of the connection, so a link that
 * reconnects must replace all three together. The reference implementation kept
 * four ciphers, two framers and two accumulators as flat fields on one class
 * and reset them in three different places, one of which missed the framer.
 *
 * Frames handed to {@link onFrame} are deciphered and owned by the callee.
 */
export class PeerLink {
  readonly #transport: Transport;
  readonly #receiveCipher: Rc4;
  readonly #sendCipher: Rc4;
  readonly #framer = new PacketFramer();

  #onFrame: ((frame: Buffer) => void) | undefined;
  #onError: ((error: Error) => void) | undefined;

  constructor(options: PeerLinkOptions) {
    this.#transport = options.transport;
    this.#receiveCipher = new Rc4(options.receiveKey);
    this.#sendCipher = new Rc4(options.sendKey);

    this.#transport.onData((chunk) => {
      this.#consume(chunk);
    });
    this.#transport.onError((error) => this.#onError?.(error));
  }

  get closed(): boolean {
    return this.#transport.closed;
  }

  get transport(): Transport {
    return this.#transport;
  }

  onFrame(listener: (frame: Buffer) => void): void {
    this.#onFrame = listener;
  }

  onClose(listener: () => void): void {
    this.#transport.onClose(listener);
  }

  /**
   * Reports a fatal condition: a desynchronised stream, or a transport error.
   * The session's only sane response is to close.
   */
  onError(listener: (error: Error) => void): void {
    this.#onError = listener;
  }

  /**
   * Sends a plaintext frame, copying it first.
   *
   * The copy is deliberate: enciphering happens in place, and the frame we are
   * forwarding is usually the packet's original bytes, which stages and the
   * diagnostics buffer may still be holding.
   */
  send(frame: Buffer): void {
    this.sendOwned(Buffer.from(frame));
  }

  /**
   * Sends a frame the caller has just built and will not touch again —
   * the encoder's output. Enciphers in place, so no copy is made.
   */
  sendOwned(frame: Buffer): void {
    this.#sendCipher.process(frame, CIPHER_OFFSET);
    this.#transport.send(frame);
  }

  close(): void {
    this.#transport.close();
  }

  #consume(chunk: Buffer): void {
    this.#framer.push(chunk);
    try {
      for (let frame = this.#framer.next(); frame !== null; frame = this.#framer.next()) {
        this.#receiveCipher.process(frame, CIPHER_OFFSET);
        this.#onFrame?.(frame);
      }
    } catch (cause) {
      // A framing error means the stream no longer starts at a packet
      // boundary. Nothing after this point is meaningful, and the cipher state
      // cannot be recovered, so the session must end.
      this.#onError?.(toError(cause) ?? new Error('unknown framing failure'));
    }
  }
}
