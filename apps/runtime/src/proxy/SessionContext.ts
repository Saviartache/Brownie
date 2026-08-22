import type { SelfView, SessionView, WorldView } from '@brownie/plugin-api';
import { createPacket, encodePacket, type PacketRegistry } from '@brownie/protocol';
import type { Logger } from '../core/logging/Logger.js';
import type { WorldState } from '../state/WorldState.js';
import type { ProxySession, ServerTarget } from './ProxySession.js';

const NO_TARGET: ServerTarget = { host: '', port: 0 };

/**
 * What a plugin sees of a session.
 *
 * A deliberate narrowing: it exposes the world, the player, where we are
 * connected, and the three things a plugin could legitimately want to *do* —
 * send toward the server, send toward the client, and say something locally.
 * The session's sockets, ciphers, framers and pipeline are not reachable from
 * here, which is the whole point of the type existing separately from
 * {@link ProxySession}.
 */
export class SessionContext implements SessionView {
  readonly #session: ProxySession;
  readonly #world: WorldState;
  readonly #registry: PacketRegistry;
  readonly #log: Logger;

  constructor(session: ProxySession, world: WorldState, registry: PacketRegistry, log: Logger) {
    this.#session = session;
    this.#world = world;
    this.#registry = registry;
    this.#log = log;
  }

  get id(): string {
    return this.#session.id;
  }

  get self(): SelfView {
    return this.#world.self;
  }

  get world(): WorldView {
    return this.#world;
  }

  get server(): ServerTarget {
    return this.#session.target ?? NO_TARGET;
  }

  sendToServer(packetName: string, fields: Readonly<Record<string, unknown>>): void {
    this.#send(packetName, fields, true);
  }

  sendToClient(packetName: string, fields: Readonly<Record<string, unknown>>): void {
    this.#send(packetName, fields, false);
  }

  /**
   * Shows a line in the game's own chat, locally.
   *
   * Sent to the client only — it never reaches the server, so it cannot be
   * mistaken for the player saying something. `objectId: -1` is how the game
   * marks a line with no speaker behind it.
   */
  notify(text: string, from = 'Brownie'): void {
    this.sendToClient('TEXT', {
      name: from,
      objectId: -1,
      numStars: 0,
      bubbleTime: 0,
      recipient: '',
      text,
      cleanText: text,
      isSupporter: false,
      starBg: 0,
    });
  }

  /**
   * Builds and injects a packet.
   *
   * A plugin naming a packet that does not exist, or a field that does not
   * type-check, is a bug in the plugin — but it must not take the session down
   * with it, so the failure is logged and the packet dropped.
   */
  #send(packetName: string, fields: Readonly<Record<string, unknown>>, toServer: boolean): void {
    try {
      const packet = createPacket(this.#registry, packetName);
      packet.fields = { ...fields } as typeof packet.fields;
      // Encode here rather than inside the session so a malformed field is
      // caught before anything touches a cipher: a half-written packet would
      // desynchronise the keystream for the rest of the connection.
      encodePacket(this.#registry, packet);
      if (toServer) this.#session.injectToServer(packet);
      else this.#session.injectToClient(packet);
    } catch (cause) {
      this.#log.error(`could not send ${packetName}`, cause);
    }
  }
}
