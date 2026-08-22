import { MutablePacket, Verdict } from '@brownie/plugin-api';
import {
  CLIENT_KEY,
  SERVER_KEY,
  decodeFrame,
  encodePacket,
  type DecodedPacket,
  type PacketRegistry,
} from '@brownie/protocol';
import { LogLevel, type Logger } from '../core/logging/Logger.js';
import {
  PacketOrigin,
  type PacketContext,
  type PacketPipeline,
} from '../pipeline/PacketPipeline.js';
import { PeerLink } from './PeerLink.js';
import type { Transport } from './Transport.js';

export interface ServerTarget {
  readonly host: string;
  readonly port: number;
}

export interface ServerConnector {
  /**
   * Opens a transport to a game server.
   *
   * The returned transport must start paused and resume itself once the TCP
   * connection is established, so packets the game client sends during the
   * connect window are held rather than dropped. Dropping one desynchronises
   * RC4 permanently.
   */
  connect(target: ServerTarget): Transport;
}

export interface ProxySessionOptions {
  readonly id: string;
  readonly registry: PacketRegistry;
  readonly clientTransport: Transport;
  readonly connector: ServerConnector;
  /**
   * Decides where the first client packet should be sent.
   *
   * Returning `undefined` closes the session: we will not open a connection to
   * a host nothing vouched for.
   */
  readonly resolveTarget: (packet: MutablePacket) => ServerTarget | undefined;
  /**
   * Builds the pipeline for this session.
   *
   * A callback rather than a ready-made pipeline because a stage may need the
   * session it belongs to — the plugin stage binds to this session's view — and
   * the session cannot exist before its own constructor. It is invoked once,
   * as the last thing the constructor does, and is expected only to *store* the
   * reference it is given.
   */
  readonly buildPipeline: (session: ProxySession) => PacketPipeline;
  readonly log: Logger;
  /** Called once the server link is opened, with the target it went to. */
  readonly onServerOpened?: (target: ServerTarget) => void;
  readonly onClosed: (session: ProxySession) => void;
}

/**
 * One client connection and its server connection, with the pipeline between.
 *
 * The session owns both links and disposes them together, once. It knows
 * nothing about plugins, state or the overlay — those are stages in the
 * pipeline it was handed. The reference implementation's equivalent class also
 * held the hook registry, the HELLO retry timer, a lag-switch queue, teleport
 * timestamps and a game clock.
 */
export class ProxySession {
  readonly id: string;
  readonly #registry: PacketRegistry;
  readonly #connector: ServerConnector;
  readonly #resolveTarget: (packet: MutablePacket) => ServerTarget | undefined;
  readonly #log: Logger;
  readonly #onServerOpened: ((target: ServerTarget) => void) | undefined;
  readonly #onClosed: (session: ProxySession) => void;
  readonly #pipeline: PacketPipeline;

  readonly #client: PeerLink;
  #server: PeerLink | undefined;
  #target: ServerTarget | undefined;
  #closed = false;

  /**
   * The two contexts a packet can travel with, built once.
   *
   * Both of their fields are fixed for the life of the session and every stage
   * only reads them, so building one per packet was an allocation per packet on
   * the busiest path in the process — a realm sends thousands a minute.
   */
  readonly #clientContext: PacketContext;
  readonly #serverContext: PacketContext;

  constructor(options: ProxySessionOptions) {
    this.id = options.id;
    this.#clientContext = { origin: PacketOrigin.Client, sessionId: options.id };
    this.#serverContext = { origin: PacketOrigin.Server, sessionId: options.id };
    this.#registry = options.registry;
    this.#connector = options.connector;
    this.#resolveTarget = options.resolveTarget;
    this.#log = options.log.forSession(options.id);
    this.#onServerOpened = options.onServerOpened;
    this.#onClosed = options.onClosed;

    // The game client sends with the client key and expects the server key
    // back; we are the server as far as it is concerned.
    this.#client = new PeerLink({
      transport: options.clientTransport,
      receiveKey: CLIENT_KEY,
      sendKey: SERVER_KEY,
    });
    this.#client.onFrame((frame) => {
      this.#handleFrame(PacketOrigin.Client, frame);
    });
    this.#client.onError((error) => {
      this.#fail('client', error);
    });
    this.#client.onClose(() => {
      this.close('client disconnected');
    });

    // Last, so the callback sees a fully constructed session.
    this.#pipeline = options.buildPipeline(this);
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** The game server this session is talking to, once it is known. */
  get target(): ServerTarget | undefined {
    return this.#target;
  }

  /** Sends a packet to the game server as though the client had sent it. */
  injectToServer(packet: DecodedPacket): void {
    this.#inject(this.#server, packet, 'server');
  }

  /** Sends a packet to the game client as though the server had sent it. */
  injectToClient(packet: DecodedPacket): void {
    this.#inject(this.#client, packet, 'client');
  }

  /**
   * Holds everything the client sends, or lets it go again.
   *
   * A lag switch, and the one thing in this class that is a *gameplay*
   * capability rather than plumbing — player noclip needs it, because silencing
   * the client's own walkability check leaves the server to pull the player
   * back, and the only way to stop that is for the server not to hear about the
   * move. See `features/noclip`.
   *
   * **One direction only.** What the server sends still arrives, so the client
   * keeps ticking, keeps rendering and keeps queueing its answers; it is our
   * answers the server does not get. Held, never dropped — see
   * {@link Transport.pause}.
   *
   * Held traffic goes out in order the moment this is called with `false`, and
   * the session closing throws it away with everything else. There is no cap
   * here beyond the transport's own: how long a hold the *server* will tolerate
   * is not something this layer can know, and it is whoever asked for the hold
   * that has to keep an eye on the clock.
   */
  holdClientTraffic(held: boolean): void {
    const uplink = this.#server?.transport;
    if (uplink === undefined) return;
    if (held) uplink.pause();
    else uplink.resume();
  }

  #inject(link: PeerLink | undefined, packet: DecodedPacket, side: string): void {
    if (this.#closed) return;
    if (link === undefined) {
      this.#log.warn(`dropped injected ${packet.name}: no ${side} link yet`);
      return;
    }
    link.sendOwned(encodePacket(this.#registry, packet));
  }

  /** Closes both links, once. Safe to call from anywhere, including a listener. */
  close(reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#log.info(`session closed: ${reason}`);
    this.#client.close();
    this.#server?.close();
    this.#onClosed(this);
  }

  #fail(side: string, error: Error): void {
    if (this.#closed) return;
    this.#log.warn(`${side} link failed: ${error.message}`);
    this.close(`${side} link failed`);
  }

  #handleFrame(origin: PacketOrigin, frame: Buffer): void {
    if (this.#closed) return;

    const packet = new MutablePacket(decodeFrame(this.#registry, frame));

    // One line per packet, at **trace**. What went past, in which direction,
    // and whether we understood it is worth being able to ask — a packet the
    // registry could not describe is forwarded untouched, so without this the
    // difference between "we saw it" and "we understood it" leaves no record
    // at all. But a realm sends thousands of these a minute, and at any level
    // the runtime ordinarily runs at they bury everything else in the log,
    // including what a plugin has to say. It is a question to go looking for,
    // not one the log should answer unprompted.
    if (this.#log.isEnabled(LogLevel.Trace)) {
      const arrow = origin === PacketOrigin.Client ? '->' : '<-';
      const opaque =
        packet.decoded.schema === undefined
          ? ` (opaque${packet.decoded.error === undefined ? '' : `: ${packet.decoded.error.message}`})`
          : '';
      this.#log.trace(
        `${arrow} ${packet.name}#${String(packet.decoded.id)} ${String(frame.length)}b${opaque}`,
      );
    }

    // The first packet from the client names the server it wants. Opening the
    // link here — before the pipeline runs — means a stage can already inject
    // toward the server, and means the connect window is covered by the
    // transport's own queue rather than a second one.
    if (origin === PacketOrigin.Client && this.#server === undefined) {
      if (!this.#openServer(packet)) return;
    }

    this.#pipeline.run(
      packet,
      origin === PacketOrigin.Client ? this.#clientContext : this.#serverContext,
    );

    if (packet.verdict === Verdict.Drop) return;

    const destination = origin === PacketOrigin.Client ? this.#server : this.#client;
    if (destination === undefined) return;

    // Untouched packets forward their original bytes. Rebuilding one from
    // fields would let a definition that has drifted from the live game turn a
    // packet we merely failed to *describe* into a packet we corrupted.
    if (packet.modified) {
      destination.sendOwned(encodePacket(this.#registry, packet.decoded));
    } else {
      destination.send(packet.frame);
    }
  }

  #openServer(packet: MutablePacket): boolean {
    const target = this.#resolveTarget(packet);
    if (target === undefined) {
      this.close(`no allowed server target for ${packet.name}`);
      return false;
    }

    this.#target = target;
    this.#log.info(`connecting to ${target.host}:${String(target.port)}`);

    const transport = this.#connector.connect(target);
    const link = new PeerLink({
      transport,
      receiveKey: SERVER_KEY,
      sendKey: CLIENT_KEY,
    });
    link.onFrame((frame) => {
      this.#handleFrame(PacketOrigin.Server, frame);
    });
    link.onError((error) => {
      this.#fail('server', error);
    });
    link.onClose(() => {
      this.close('server disconnected');
    });
    this.#server = link;
    this.#onServerOpened?.(target);
    return true;
  }
}
