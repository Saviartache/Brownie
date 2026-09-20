import type { SelfView, SendOptions, SessionView, WorldView } from '@brownie/plugin-api';
import { createPacket, encodePacket, type PacketRegistry } from '@brownie/protocol';
import type { Logger } from '../core/logging/Logger.js';
import type { RefreshedField } from '../outbound/actionLanes.js';
import { ServerActionQueue } from '../outbound/ServerActionQueue.js';
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
 *
 * It also owns the session's {@link ServerActionQueue}, because "send toward
 * the server" is not a free action: several plugins reach for the same rate
 * limit without knowing the others exist, and the queue is what makes that one
 * conversation instead of several. It is owned here rather than beside here so
 * there is exactly one door, and nothing can be sent around it.
 */
export class SessionContext implements SessionView {
  readonly #session: ProxySession;
  readonly #world: WorldState;
  readonly #registry: PacketRegistry;
  readonly #log: Logger;
  readonly #outbound: ServerActionQueue;

  constructor(session: ProxySession, world: WorldState, registry: PacketRegistry, log: Logger) {
    this.#session = session;
    this.#world = world;
    this.#registry = registry;
    this.#log = log;
    this.#outbound = new ServerActionQueue({
      send: (packetName, fields) => this.#send(packetName, fields, true),
      refresh: (fields, which) => {
        this.#refresh(fields, which);
      },
      log: log.child('outbound'),
    });
  }

  /**
   * The queue everything server-bound passes through.
   *
   * Not on {@link SessionView}: a plugin takes part in it through
   * {@link SessionContext.sendToServer}, while the proxy has to *drive* it —
   * show it the packet stream and shut it down with the session.
   */
  get outbound(): ServerActionQueue {
    return this.#outbound;
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

  sendToServer(
    packetName: string,
    fields: Readonly<Record<string, unknown>>,
    options?: SendOptions,
  ): void {
    // Copied once here rather than at every call site: the queue may hold this
    // object for a second and rewrites its timestamp before sending, and a
    // caller that kept its own reference would see both happen to it.
    this.#outbound.submit(packetName, { ...fields }, options);
  }

  sendToClient(packetName: string, fields: Readonly<Record<string, unknown>>): void {
    // Nothing paces the downlink: the game client is one process listening to
    // one socket and has no rate limit to offend.
    this.#send(packetName, { ...fields }, false);
  }

  /**
   * Shows a line in the game's own chat, locally.
   *
   * Sent to the client only — it never reaches the server, so it cannot be
   * mistaken for the player saying something. `objectId: -1` is how the game
   * marks a line with no speaker behind it.
   *
   * **`numStars: -1` is what makes it appear at all.** Fame is how this game
   * tells a server-side speaker from a player, and it is the same convention
   * `features/chatfilter` reads on the way in: a non-negative count says a
   * character said this, so the client goes looking for the character named by
   * `objectId` to draw the line against — and there is no object -1, so the
   * line is dropped without a word. Negative fame is the path that takes the
   * name as given, which is the one every notification here wants.
   */
  notify(text: string, from = 'Brownie'): void {
    this.sendToClient('TEXT', {
      name: from,
      objectId: -1,
      numStars: -1,
      bubbleTime: 0,
      recipient: '',
      text,
      cleanText: text,
      isSupporter: false,
      starBg: 0,
    });
  }

  /**
   * Fills in the fields that mean "now", immediately before a packet leaves.
   *
   * **The whole reason a queue is allowed to hold a packet at all.** The server
   * reads the client's clock as a rising sequence and checks a packet's stamp
   * against it, so a stamp taken when the packet was *asked for* is the
   * sequence going backwards by however long the queue held it — and that
   * rejection is silent, which makes it indistinguishable from the action
   * simply not working. `position` is the same story in space: an item move
   * names where the player stands, and they walk.
   *
   * Which fields a packet has is not guessed at — `actionLanes.ts` names them
   * per packet, so nothing writes a field a schema does not have.
   */
  #refresh(fields: Record<string, unknown>, which: readonly RefreshedField[]): void {
    for (const field of which) {
      if (field === 'time') fields['time'] = Math.trunc(this.#world.clientTimeMs);
      else fields['position'] = { x: this.#world.self.x, y: this.#world.self.y };
    }
  }

  /**
   * Builds and injects a packet.
   *
   * A plugin naming a packet that does not exist, or a field that does not
   * type-check, is a bug in the plugin — but it must not take the session down
   * with it, so the failure is logged and the packet dropped.
   *
   * @returns whether it went out, which is what tells the queue to stop waiting
   *   on something that was never sent.
   */
  #send(packetName: string, fields: Record<string, unknown>, toServer: boolean): boolean {
    try {
      const packet = createPacket(this.#registry, packetName);
      packet.fields = fields as typeof packet.fields;
      // Encode here rather than inside the session so a malformed field is
      // caught before anything touches a cipher: a half-written packet would
      // desynchronise the keystream for the rest of the connection.
      encodePacket(this.#registry, packet);
      if (toServer) this.#session.injectToServer(packet);
      else this.#session.injectToClient(packet);
      return true;
    } catch (cause) {
      this.#log.error(`could not send ${packetName}`, cause);
      return false;
    }
  }
}
