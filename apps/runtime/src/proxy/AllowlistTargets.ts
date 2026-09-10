import type { MutablePacket } from '@brownie/plugin-api';
import { isIPv4 } from 'node:net';
import type { Logger } from '../core/logging/Logger.js';
import type { ServerTarget } from './ProxySession.js';
import type { TargetResolver } from './ProxyServer.js';

export interface AllowlistTargetsOptions {
  readonly log: Logger;
  /** Hosts a session may be connected to. */
  readonly allow: readonly string[];
  readonly port: number;
  /**
   * Where the game client was originally headed, as reported by whatever
   * redirected it — the injected module writes this.
   *
   * Consulted per session and never trusted: it names a host, and the allowlist
   * decides whether we go there.
   */
  readonly requestedHost?: () => string | undefined;
  /**
   * A game server named by configuration, for a client that was pointed here
   * by hand rather than redirected.
   *
   * The Flash client has no injected module to report where it was heading —
   * it is told to connect to the proxy directly, so the proxy has to be told
   * the other half the same way. Trusted exactly as an `allow` entry is: both
   * are the operator's own configuration.
   */
  readonly upstream?: string;
}

/**
 * Decides which game server a session may reach.
 *
 * An allowlist rather than "whatever the client asked for", because the host we
 * connect to comes from outside the runtime: a file another process wrote, or a
 * `RECONNECT` from a server. Following either without checking would turn the
 * proxy into an open relay to any address something could name.
 */
export class AllowlistTargets implements TargetResolver {
  readonly #log: Logger;
  readonly #allow: Set<string>;
  readonly #port: number;
  readonly #requestedHost: (() => string | undefined) | undefined;
  readonly #upstream: string | undefined;

  constructor(options: AllowlistTargetsOptions) {
    this.#log = options.log.child('targets');
    this.#allow = new Set(options.allow);
    this.#port = options.port;
    this.#requestedHost = options.requestedHost;
    this.#upstream = options.upstream === '' ? undefined : options.upstream;
    // The configured upstream is trusted on the same terms as the allowlist it
    // joins: the operator wrote both.
    if (this.#upstream !== undefined && isIPv4(this.#upstream)) {
      this.#allow.add(this.#upstream);
    } else if (this.#upstream !== undefined) {
      this.#log.warn(`ignored upstream "${this.#upstream}": not an IPv4 address`);
    }
  }

  get allowed(): readonly string[] {
    return [...this.#allow];
  }

  /** The configured upstream, when there is one — what a hand-pointed client reaches. */
  get upstream(): string | undefined {
    return this.#upstream;
  }

  /**
   * Permits a host discovered at runtime — a `RECONNECT` destination, or one
   * the native module saw the game itself dial.
   */
  permit(host: string): boolean {
    if (!isIPv4(host)) {
      this.#log.warn(`refused to allow "${host}": not an IPv4 address`);
      return false;
    }
    this.#allow.add(host);
    return true;
  }

  resolve(packet: MutablePacket): ServerTarget | undefined {
    // A redirected client knows where it was heading; one pointed here by hand
    // does not, and the configured upstream stands in for it.
    const requested = this.#requestedHost?.() ?? this.#upstream;
    if (requested === undefined || requested === '') {
      this.#log.warn(`no server was requested for ${packet.name}; refusing the session`);
      return undefined;
    }
    if (!this.#allow.has(requested)) {
      this.#log.warn(
        `refused "${requested}": not in the allowlist of ${String(this.#allow.size)} host(s)`,
      );
      return undefined;
    }
    return { host: requested, port: this.#port };
  }
}
