import {
  type MutablePacket,
  type SessionApi,
  type SessionView,
  type Unsubscribe,
} from '@brownie/plugin-api';
import type { PacketRegistry } from '@brownie/protocol';
import { createServer, type Server, type Socket } from 'node:net';
import type { Logger } from '../core/logging/Logger.js';
import {
  PacketPipeline,
  type PipelineStage,
  type StageFailure,
} from '../pipeline/PacketPipeline.js';
import { OutboundQueueStage } from '../pipeline/stages/OutboundQueueStage.js';
import { StateStage } from '../pipeline/stages/StateStage.js';
import { WorldState, type WorldStateOptions } from '../state/WorldState.js';
import { ProxySession, type ServerConnector, type ServerTarget } from './ProxySession.js';
import { SessionContext } from './SessionContext.js';
import { SocketTransport } from './Transport.js';

/** Decides which game server a session may connect to. */
export interface TargetResolver {
  /** `undefined` refuses the session — we open no connection nothing vouched for. */
  resolve(packet: MutablePacket): ServerTarget | undefined;
}

/**
 * What an embedded Flash client asks before it will open a game socket.
 *
 * A browser-embedded SWF (Ruffle and the like) opens one connection, sends
 * `<policy-file-request/>\0`, and only dials the game on a second one if the
 * first answered with a policy that allows it. The standalone projector asks
 * nothing — but answering costs one branch, and the probe is the difference
 * between "works everywhere" and "works in the projector only".
 */
const POLICY_PROBE = '<policy-file-request/>';

/** What the probe is answered with: everything, to the proxy's own port. */
const POLICY_REPLY = Buffer.from(
  '<?xml version="1.0"?>' +
    '<!DOCTYPE cross-domain-policy SYSTEM "http://www.adobe.com/xml/dtds/cross-domain-policy.dtd">' +
    '<cross-domain-policy><allow-access-from domain="*" to-ports="*"/></cross-domain-policy>\0',
);

export interface ProxyServerOptions {
  readonly registry: PacketRegistry;
  readonly log: Logger;
  readonly connector: ServerConnector;
  readonly targets: TargetResolver;
  readonly worldOptions?: WorldStateOptions;
  /**
   * Extra stages, appended after the state stage.
   *
   * Built per session because a stage may hold session-scoped state — the
   * plugin stage binds to that session's view.
   */
  readonly buildStages?: (session: SessionView, world: WorldState) => readonly PipelineStage[];
  readonly onStageFailure?: (failure: StageFailure) => void;
}

/**
 * Accepts game clients and gives each one a session.
 *
 * Everything a session needs is built here, in one place and in a fixed order:
 * the world model, the pipeline with the state stage first, the plugin stage
 * after it, and the view a plugin sees. The reference implementation spread
 * this across a 336-line `Proxy` that also held the hook registry, the command
 * registry and a state map that was never cleaned out.
 */
export class ProxyServer implements SessionApi {
  readonly #options: ProxyServerOptions;
  readonly #log: Logger;
  readonly #sessions = new Map<string, { session: ProxySession; view: SessionView }>();
  readonly #connected = new Set<(session: SessionView) => void>();
  readonly #disconnected = new Set<(session: SessionView) => void>();

  #listener: Server | undefined;
  #nextId = 0;

  constructor(options: ProxyServerOptions) {
    this.#options = options;
    this.#log = options.log.child('proxy');
  }

  get sessionCount(): number {
    return this.#sessions.size;
  }

  get listening(): boolean {
    return this.#listener?.listening ?? false;
  }

  /**
   * The address actually bound, or `undefined` when not listening.
   *
   * Needed because binding to port 0 is the only way to take a free port from
   * the OS, and the caller then has to be able to find out which one it got.
   */
  get address(): { host: string; port: number } | undefined {
    const address = this.#listener?.address();
    if (address === null || address === undefined || typeof address === 'string') return undefined;
    return { host: address.address, port: address.port };
  }

  /** Binds the listener. Resolves once it is accepting, or rejects. */
  async listen(host: string, port: number): Promise<void> {
    if (this.#listener !== undefined) throw new Error('proxy is already listening');

    const server = createServer((socket) => {
      this.#accept(socket);
    });
    this.#listener = server;

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.removeListener('listening', onListening);
        this.#listener = undefined;
        reject(error);
      };
      const onListening = (): void => {
        server.removeListener('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    });

    // Past the initial bind, an error is a runtime condition rather than a
    // startup failure, and must not become an unhandled 'error' event.
    server.on('error', (error) => {
      this.#log.error('listener error', error);
    });
    // The address it *got*, not the one it was asked for: port 0 means "any
    // free port", and logging the request would print a port nothing is on.
    const bound = this.address;
    this.#log.info(`listening on ${bound?.host ?? host}:${String(bound?.port ?? port)}`);
  }

  /**
   * Stops accepting and closes every live session.
   *
   * In that order: a session that starts while we are shutting down would keep
   * the process alive past the point where everything it needs has been
   * disposed.
   */
  async close(): Promise<void> {
    const listener = this.#listener;
    this.#listener = undefined;

    // `close()` stops accepting at once but only calls back when the last
    // connection has gone, so the promise is created *before* the sessions are
    // closed and awaited after. Awaiting it first deadlocks: nothing would ever
    // close the connections it is waiting on.
    const drained =
      listener === undefined
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            listener.close(() => {
              resolve();
            });
          });

    for (const { session } of [...this.#sessions.values()]) session.close('runtime shutting down');
    this.#sessions.clear();
    await drained;
  }

  /**
   * Holds, or releases, everything every live session carries.
   *
   * Across all of them rather than one, because the thing that asks for this is
   * a switch on a feature and not a statement about a session — and a hold left
   * on a session nobody was looking at is a session that gets dropped. A
   * session that connects while this is on is *not* held: it is a new
   * connection, and whoever wanted the hold gets told the old one ended.
   *
   * See {@link ProxySession.holdTraffic} for what a hold is and is not.
   */
  holdTraffic(held: boolean): void {
    for (const { session } of this.#sessions.values()) session.holdTraffic(held);
  }

  // ── SessionApi ────────────────────────────────────────────────────────────

  current(): SessionView | undefined {
    // The game client is one process with one connection; "current" is the
    // most recent, which is the only one a plugin could mean.
    let latest: SessionView | undefined;
    for (const { view } of this.#sessions.values()) latest = view;
    return latest;
  }

  all(): Iterable<SessionView> {
    return [...this.#sessions.values()].map((entry) => entry.view);
  }

  onConnected(listener: (session: SessionView) => void): Unsubscribe {
    this.#connected.add(listener);
    return () => {
      this.#connected.delete(listener);
    };
  }

  onDisconnected(listener: (session: SessionView) => void): Unsubscribe {
    this.#disconnected.add(listener);
    return () => {
      this.#disconnected.delete(listener);
    };
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  #accept(socket: Socket): void {
    // The first bytes decide what kind of client this is. A game client's
    // opening bytes are a frame length — big-endian, so a leading byte of `<`
    // is not one — while an embedded Flash client's are the policy probe
    // above. The probe is answered and the connection dropped without a
    // session; anything else is put back on the socket (`unshift`, the
    // standard idiom for sniffing a stream's first bytes) and the session
    // reads it as though it had never been looked at.
    //
    // The probe is asked for in one write, but TCP does not promise one
    // `data` event per write, so a partial prefix waits for the rest rather
    // than being mistaken for either kind of client.
    const probe = (seen: string): void => {
      socket.once('data', (chunk: Buffer) => {
        const text = seen + chunk.toString('latin1');
        if (POLICY_PROBE.startsWith(text)) {
          probe(text);
          return;
        }
        if (text.startsWith(POLICY_PROBE)) {
          this.#log.debug('answered a Flash socket policy probe');
          socket.end(POLICY_REPLY);
          return;
        }
        socket.unshift(chunk);
        const id = `s${String(++this.#nextId)}`;
        this.#openSession(id, new SocketTransport(socket));
      });
    };
    probe('');
  }

  #openSession(id: string, transport: SocketTransport): void {
    const world = new WorldState(this.#options.worldOptions ?? {});
    let context: SessionContext | undefined;

    const session = new ProxySession({
      id,
      registry: this.#options.registry,
      clientTransport: transport,
      connector: this.#options.connector,
      resolveTarget: (packet) => this.#options.targets.resolve(packet),
      buildPipeline: (built) => {
        const view = new SessionContext(
          built,
          world,
          this.#options.registry,
          this.#log.forSession(id),
        );
        context = view;
        // The order is fixed here, not by whoever registers first: state is
        // current before anything else sees the packet, and the outbound queue
        // has seen a refusal before a plugin can react to it.
        const stages: PipelineStage[] = [
          new StateStage(world),
          new OutboundQueueStage(view.outbound),
          ...(this.#options.buildStages?.(view, world) ?? []),
        ];
        return new PacketPipeline(stages, (failure) => {
          this.#log.warn(`stage "${failure.stage}" failed on ${failure.packetName}`);
          this.#options.onStageFailure?.(failure);
        });
      },
      log: this.#options.log,
      onServerOpened: () => {
        world.markConnected();
      },
      onClosed: (closed) => {
        this.#sessions.delete(closed.id);
        // Before the listeners: a plugin told the session has gone must not be
        // able to queue anything into what is left of it, and a queue still
        // holding a timer would keep the process alive past shutdown.
        context?.outbound.dispose();
        if (context !== undefined) {
          for (const listener of this.#disconnected) listener(context);
        }
      },
    });

    const view: SessionView | undefined = context;
    if (view === undefined) throw new Error('pipeline builder did not produce a session view');
    this.#sessions.set(id, { session, view });
    this.#log.info(`session ${id} accepted (${String(this.#sessions.size)} live)`);
    for (const listener of this.#connected) listener(view);
  }
}
