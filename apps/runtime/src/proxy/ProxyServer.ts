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
   * Holds, or releases, what every live session sends to its game server.
   *
   * Across all of them rather than one, because the thing that asks for this is
   * a switch on a feature and not a statement about a session — and a hold left
   * on a session nobody was looking at is a session that gets dropped. A
   * session that connects while this is on is *not* held: it is a new
   * connection, and whoever wanted the hold gets told the old one ended.
   *
   * See {@link ProxySession.holdClientTraffic} for what a hold is and is not.
   */
  holdClientTraffic(held: boolean): void {
    for (const { session } of this.#sessions.values()) session.holdClientTraffic(held);
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
    const id = `s${String(++this.#nextId)}`;
    const world = new WorldState(this.#options.worldOptions ?? {});
    let view: SessionView | undefined;

    const session = new ProxySession({
      id,
      registry: this.#options.registry,
      clientTransport: new SocketTransport(socket),
      connector: this.#options.connector,
      resolveTarget: (packet) => this.#options.targets.resolve(packet),
      buildPipeline: (built) => {
        view = new SessionContext(built, world, this.#options.registry, this.#log.forSession(id));
        // The order is fixed here, not by whoever registers first: state is
        // current before anything else sees the packet.
        const stages: PipelineStage[] = [
          new StateStage(world),
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
        if (view !== undefined) {
          for (const listener of this.#disconnected) listener(view);
        }
      },
    });

    if (view === undefined) throw new Error('pipeline builder did not produce a session view');
    this.#sessions.set(id, { session, view });
    this.#log.info(`session ${id} accepted (${String(this.#sessions.size)} live)`);
    for (const listener of this.#connected) listener(view);
  }
}
