import {
  FrameReader,
  LinkError,
  MessageError,
  Origin,
  RuntimeHandshake,
  SequenceGuard,
  SequenceSource,
  decodeMessage,
  framedSize,
  prepareMessage,
  writeMessage,
  type HotkeyEventMessage,
  type IpcMessage,
  type OffsetHealthMessage,
  type PlayerTelemetryMessage,
  type PreparedMessage,
} from '@brownie/ipc';
import { isIPv4 } from 'node:net';
import type { NativeApi, Unsubscribe } from '@brownie/plugin-api';
import { toError, type Logger } from '../core/logging/Logger.js';
import type { Transport } from '../proxy/Transport.js';

/** How often we prove the link is alive, and how many misses end it. */
export const HEARTBEAT_INTERVAL_MS = 5000;
export const HEARTBEAT_MAX_MISSES = 3;

/**
 * How much may accumulate in one batch before it goes out without waiting for
 * the turn to end.
 *
 * A bound rather than a target: messages are gathered until the current turn of
 * the event loop finishes, and this only decides what happens when one turn
 * produces an unusual amount — a class dump, or a settings replay across a lot
 * of plugins. Well under the frame cap so that a batch is many frames rather
 * than one enormous one.
 */
const MAX_BATCH_BYTES = 64 * 1024;

export interface NativeLinkOptions {
  readonly log: Logger;
  /** Shared secret both sides sign with. */
  readonly secret: Buffer;
  readonly userId: string;
  readonly pid?: number;
  readonly heartbeatIntervalMs?: number;
  readonly maxMisses?: number;
}

export interface NativeEvents {
  onControlAction(listener: (action: string) => void): Unsubscribe;
  onHotkey(listener: (event: HotkeyEventMessage) => void): Unsubscribe;
  onTelemetry(listener: (telemetry: PlayerTelemetryMessage) => void): Unsubscribe;
  onOffsetHealth(listener: (health: OffsetHealthMessage) => void): Unsubscribe;
}

/**
 * The runtime's half of the link to the injected native module.
 *
 * Takes a {@link Transport} rather than opening a pipe itself, so the whole
 * protocol — handshake, sequencing, heartbeat, feature replay — is testable
 * against a hostile peer with no pipe, no game and no timing.
 *
 * One connection at a time: the peer is a DLL inside one game process. A second
 * connection while one is live is refused rather than silently replacing it.
 */
export class NativeLink implements NativeApi, NativeEvents {
  readonly #log: Logger;
  readonly #secret: Buffer;
  readonly #userId: string;
  readonly #pid: number;
  readonly #heartbeatMs: number;
  readonly #maxMisses: number;

  #transport: Transport | undefined;
  #reader = new FrameReader();
  #inbound = new SequenceGuard();
  #outbound = new SequenceSource();
  #handshake: RuntimeHandshake | undefined;
  #authenticated = false;

  #heartbeat: ReturnType<typeof setInterval> | undefined;
  #pendingPong: string | undefined;
  #misses = 0;

  /**
   * Messages waiting to go out together.
   *
   * One turn of the event loop is the batch boundary: an overlay sync publishes
   * a record per plugin and per setting, and writing each one on its own put a
   * hundred-odd pipe writes — and three allocations each — through for a single
   * logical change. Sequence numbers are taken at write time, so the order on
   * the wire is the order they were queued in.
   */
  readonly #pending: PreparedMessage[] = [];
  #pendingBytes = 0;
  #flushQueued = false;
  readonly #flush = (): void => {
    this.#flushQueued = false;
    this.#writeBatch();
  };

  /**
   * The last value pushed for each feature key.
   *
   * The native module stores nothing, so this is the runtime's copy of what it
   * should be doing, replayed in full whenever it (re)connects. A plugin sets a
   * key once and never has to watch the connection.
   */
  readonly #features = new Map<string, boolean | number | string>();

  readonly #connectedListeners = new Set<() => void>();
  readonly #actionListeners = new Set<(action: string) => void>();
  readonly #hotkeyListeners = new Set<(event: HotkeyEventMessage) => void>();
  readonly #telemetryListeners = new Set<(telemetry: PlayerTelemetryMessage) => void>();
  readonly #offsetListeners = new Set<(health: OffsetHealthMessage) => void>();
  readonly #targetListeners = new Set<(host: string, port: number) => void>();
  #requestedHost: string | undefined;

  constructor(options: NativeLinkOptions) {
    this.#log = options.log.child('native');
    this.#secret = options.secret;
    this.#userId = options.userId;
    this.#pid = options.pid ?? process.pid;
    this.#heartbeatMs = options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
    this.#maxMisses = options.maxMisses ?? HEARTBEAT_MAX_MISSES;
  }

  get connected(): boolean {
    return this.#authenticated && this.#transport !== undefined && !this.#transport.closed;
  }

  /**
   * Adopts a newly accepted connection.
   *
   * @returns false if one is already live. The module reconnects on its own, so
   *   refusing is safer than dropping a link that may still be working.
   */
  accept(transport: Transport): boolean {
    if (this.#transport !== undefined && !this.#transport.closed) {
      this.#log.warn('refused a second native connection — one is already live');
      transport.close();
      return false;
    }

    this.#transport = transport;
    this.#reader = new FrameReader();
    this.#inbound = new SequenceGuard();
    this.#outbound = new SequenceSource();
    this.#handshake = new RuntimeHandshake(this.#secret, this.#userId, this.#pid);
    this.#authenticated = false;
    this.#misses = 0;
    this.#pendingPong = undefined;
    this.#discardPending();

    transport.onData((chunk) => {
      this.#consume(chunk);
    });
    transport.onError((error) => {
      this.#log.warn(`native transport error: ${error.message}`);
      this.disconnect('transport error');
    });
    transport.onClose(() => {
      this.disconnect('peer closed');
    });

    this.#log.info('native module connected — waiting for hello');
    return true;
  }

  /** Closes the link and forgets everything about the peer, but not the features. */
  disconnect(reason: string): void {
    const transport = this.#transport;
    if (transport === undefined) return;

    this.#transport = undefined;
    this.#authenticated = false;
    this.#handshake = undefined;
    this.#stopHeartbeat();
    // Nothing queued survives the connection it was queued on: a reconnecting
    // module starts from a full resync, so a replayed batch would be both stale
    // and out of sequence.
    this.#discardPending();
    transport.close();
    this.#log.info(`native link closed: ${reason}`);
  }

  #discardPending(): void {
    this.#pending.length = 0;
    this.#pendingBytes = 0;
  }

  // ── NativeApi ─────────────────────────────────────────────────────────────

  /**
   * Sets a gameplay feature.
   *
   * Remembered whether or not the module is connected: a plugin enabled before
   * the game launched must still take effect when it does.
   */
  setFeature(key: string, value: boolean | number | string): void {
    this.#features.set(key, value);
    this.#send({ kind: 'setFeature', key, value });
  }

  onConnected(listener: () => void): Unsubscribe {
    return subscribe(this.#connectedListeners, listener);
  }

  // ── NativeEvents ──────────────────────────────────────────────────────────

  onControlAction(listener: (action: string) => void): Unsubscribe {
    return subscribe(this.#actionListeners, listener);
  }

  onHotkey(listener: (event: HotkeyEventMessage) => void): Unsubscribe {
    return subscribe(this.#hotkeyListeners, listener);
  }

  onTelemetry(listener: (telemetry: PlayerTelemetryMessage) => void): Unsubscribe {
    return subscribe(this.#telemetryListeners, listener);
  }

  onOffsetHealth(listener: (health: OffsetHealthMessage) => void): Unsubscribe {
    return subscribe(this.#offsetListeners, listener);
  }

  /**
   * Where the game was heading when the module redirected it here, or
   * `undefined` if it has not said yet.
   *
   * A single value rather than a list: the game connects to one server at a
   * time, and the newest interception is the one the next session belongs to.
   * `AllowlistTargets` reads it and decides — this is a report, not an order.
   */
  get requestedHost(): string | undefined {
    return this.#requestedHost;
  }

  /** Fires each time the module intercepts a connection to a game server. */
  onServerTarget(listener: (host: string, port: number) => void): Unsubscribe {
    return subscribe(this.#targetListeners, listener);
  }

  /** Publishes one overlay record. Dropped silently when nothing is connected. */
  publishRecord(record: string): void {
    this.#send({ kind: 'controlRecord', record });
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  #send(message: IpcMessage): void {
    const transport = this.#transport;
    if (transport === undefined || transport.closed) return;
    // Only the handshake may travel before authentication.
    if (!this.#authenticated && message.kind !== 'authChallenge') return;

    const prepared = prepareMessage(message);
    this.#pending.push(prepared);
    this.#pendingBytes += framedSize(prepared);

    if (this.#pendingBytes >= MAX_BATCH_BYTES) {
      this.#writeBatch();
      return;
    }
    if (this.#flushQueued) return;
    this.#flushQueued = true;
    queueMicrotask(this.#flush);
  }

  /** Writes everything queued as one frame stream, in one allocation. */
  #writeBatch(): void {
    if (this.#pending.length === 0) return;

    const total = this.#pendingBytes;
    this.#pendingBytes = 0;
    const transport = this.#transport;
    if (transport === undefined || transport.closed) {
      this.#pending.length = 0;
      return;
    }

    const batch = Buffer.allocUnsafe(total);
    let offset = 0;
    for (const prepared of this.#pending) {
      offset += writeMessage(batch, offset, prepared, this.#outbound.take());
    }
    this.#pending.length = 0;
    transport.send(batch);
  }

  #consume(chunk: Buffer): void {
    this.#reader.push(chunk);
    try {
      for (let frame = this.#reader.next(); frame !== null; frame = this.#reader.next()) {
        this.#inbound.accept(frame.header.seq);
        this.#dispatch(decodeMessage(frame, Origin.Native));
      }
    } catch (cause) {
      if (cause instanceof MessageError) {
        // One malformed payload. The stream is still aligned, so the link lives
        // and only this message is lost.
        this.#log.warn(`dropped a malformed native message: ${cause.message}`);
        return;
      }
      const error = toError(cause);
      this.#log.warn(`native link failed: ${error?.message ?? 'unknown'}`);
      this.disconnect(cause instanceof LinkError ? 'protocol error' : 'unexpected error');
      return;
    } finally {
      // Answers leave with the chunk that prompted them rather than waiting for
      // the microtask: a pong the peer is timing must not be held behind
      // whatever else this turn of the loop decides to say.
      this.#writeBatch();
    }
  }

  #dispatch(message: IpcMessage): void {
    switch (message.kind) {
      case 'hello':
        this.#onHello(message);
        return;
      case 'authResult':
        this.#onAuthResult(message);
        return;
      case 'ping':
        this.#onPing(message);
        return;
      case 'pong':
        this.#onPong(message);
        return;
      case 'controlAction':
        this.#requireAuth(() => {
          for (const listener of this.#actionListeners) listener(message.action);
        });
        return;
      case 'hotkeyEvent':
        this.#requireAuth(() => {
          for (const listener of this.#hotkeyListeners) listener(message);
        });
        return;
      case 'playerTelemetry':
        this.#requireAuth(() => {
          for (const listener of this.#telemetryListeners) listener(message);
        });
        return;
      case 'offsetHealth':
        this.#requireAuth(() => {
          for (const listener of this.#offsetListeners) listener(message);
        });
        return;
      case 'serverTarget':
        this.#requireAuth(() => {
          this.#onServerTarget(message);
        });
        return;
      case 'unknown':
        // A newer module may send types this build predates. Ignoring one is
        // the contract; failing on it would make the two sides lockstep.
        this.#log.debug(`ignored unknown native message type 0x${message.type.toString(16)}`);
        return;
      default:
        this.#log.warn(`native module sent ${message.kind}, which only the runtime sends`);
        this.disconnect('peer sent a runtime-only message');
    }
  }

  #requireAuth(fn: () => void): void {
    if (!this.#authenticated) {
      this.#log.warn('native module sent data before authenticating');
      this.disconnect('data before authentication');
      return;
    }
    fn();
  }

  #onServerTarget(message: Extract<IpcMessage, { kind: 'serverTarget' }>): void {
    // Validated here rather than trusted: this reaches the allowlist, and a
    // module that has been tampered with could name anything. A malformed value
    // is dropped with a word about it, not passed on for something downstream
    // to be surprised by.
    if (!isIPv4(message.host)) {
      this.#log.warn(`native module reported a server target that is not IPv4: ${message.host}`);
      return;
    }
    this.#requestedHost = message.host;
    this.#log.info(`game is heading for ${message.host}:${String(message.port)}`);
    for (const listener of this.#targetListeners) listener(message.host, message.port);
  }

  #onHello(message: Extract<IpcMessage, { kind: 'hello' }>): void {
    const handshake = this.#handshake;
    if (handshake === undefined || this.#authenticated) {
      this.disconnect('unexpected hello');
      return;
    }
    try {
      this.#send(handshake.begin(message));
    } catch (cause) {
      this.#log.warn(`rejected native hello: ${toError(cause)?.message ?? 'unknown'}`);
      this.disconnect('bad hello');
    }
  }

  #onAuthResult(message: Extract<IpcMessage, { kind: 'authResult' }>): void {
    const handshake = this.#handshake;
    if (handshake === undefined) {
      this.disconnect('unexpected authResult');
      return;
    }
    try {
      handshake.finish(message);
    } catch (cause) {
      this.#log.warn(`native authentication failed: ${toError(cause)?.message ?? 'unknown'}`);
      this.disconnect('authentication failed');
      return;
    }

    this.#authenticated = true;
    this.#log.info(`native module authenticated (game pid ${String(handshake.peerPid ?? 0)})`);

    // The module starts from its own defaults and stores nothing, so everything
    // the runtime believes must be re-stated now.
    for (const [key, value] of this.#features) {
      this.#send({ kind: 'setFeature', key, value });
    }
    this.#startHeartbeat();
    for (const listener of this.#connectedListeners) listener();
  }

  #onPing(message: Extract<IpcMessage, { kind: 'ping' }>): void {
    const handshake = this.#handshake;
    if (handshake === undefined || !this.#authenticated) return;
    try {
      this.#send(handshake.answerPing(message));
    } catch {
      this.disconnect('malformed ping');
    }
  }

  #onPong(message: Extract<IpcMessage, { kind: 'pong' }>): void {
    const handshake = this.#handshake;
    const expected = this.#pendingPong;
    if (handshake === undefined || expected === undefined) return;
    if (!handshake.verifyPong(message, expected)) {
      this.#log.warn('native module answered a liveness challenge incorrectly');
      this.disconnect('bad heartbeat response');
      return;
    }
    this.#pendingPong = undefined;
    this.#misses = 0;
  }

  #startHeartbeat(): void {
    this.#stopHeartbeat();
    this.#heartbeat = setInterval(() => {
      const handshake = this.#handshake;
      if (handshake === undefined || !this.#authenticated) return;

      if (this.#pendingPong !== undefined) {
        this.#misses++;
        if (this.#misses >= this.#maxMisses) {
          this.disconnect(`${String(this.#misses)} unanswered heartbeats`);
          return;
        }
      }

      const { message, expected } = handshake.createPing();
      this.#pendingPong = expected;
      this.#send(message);
    }, this.#heartbeatMs);
    // A heartbeat must never be the reason the process stays alive.
    this.#heartbeat.unref();
  }

  #stopHeartbeat(): void {
    if (this.#heartbeat === undefined) return;
    clearInterval(this.#heartbeat);
    this.#heartbeat = undefined;
    this.#pendingPong = undefined;
    this.#misses = 0;
  }
}

function subscribe<T>(set: Set<T>, listener: T): Unsubscribe {
  set.add(listener);
  return () => {
    set.delete(listener);
  };
}
