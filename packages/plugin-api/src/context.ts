import type { MutablePacket } from './packet.js';
import type { SettingsApi, Unsubscribe } from './settings.js';
import type { SessionView } from './views.js';

/**
 * What a plugin is handed.
 *
 * A capability object, not the runtime. Each member below is a small interface
 * that can be replaced by a fake in a test, and nothing on it exposes a socket,
 * a cipher, the pipeline or another plugin. The reference implementation passed
 * a 395-line context object that carried the proxy, the world state, the
 * projectile tracker and a session resolver, so any plugin could reach
 * anything — and several did.
 *
 * Every subscription made through this object is owned by the host. Unloading
 * a plugin removes all of them, because the host holds the registry and the
 * plugin only ever handed it callbacks.
 */
export interface PluginContext {
  readonly packets: PacketApi;
  readonly commands: CommandApi;
  readonly settings: SettingsApi;
  readonly sessions: SessionApi;
  readonly native: NativeApi;
  readonly log: Logger;
  readonly timers: TimerApi;
  /** True while the plugin is enabled. Handlers do not run while it is false. */
  readonly enabled: boolean;
  /** Runs when the plugin is disabled or unloaded. Prefer this over globals. */
  onDispose(fn: () => void): void;
}

export type PacketHandler = (packet: MutablePacket, session: SessionView) => void;

export interface PacketApi {
  /**
   * Subscribes to one packet by name.
   *
   * @throws {Error} if no definition has that name — a typo would otherwise be
   *   a handler that silently never runs.
   */
  on(packetName: string, handler: PacketHandler): Unsubscribe;

  /**
   * Subscribes ahead of every other handler for this packet.
   *
   * For safety-critical work only — auto-nexus has to see a health drop before
   * a plugin that might drop the packet does. Ordinary plugins do not use this.
   */
  onFirst(packetName: string, handler: PacketHandler): Unsubscribe;

  /** Subscribes to every packet. Costs a call per packet; use sparingly. */
  onAny(handler: PacketHandler): Unsubscribe;
}

export interface CommandDefinition {
  /** Without the leading slash. */
  readonly name: string;
  /** Full usage line, e.g. `/con <name|ip>`. Defaults to `/<name>`. */
  readonly usage?: string;
  /** One imperative line — what it does. Shown by the overlay and `/cmds`. */
  readonly description: string;
  readonly run: (args: readonly string[], session: SessionView) => void;
}

export interface CommandApi {
  /**
   * Registers a chat command.
   *
   * A command is consumed — it never reaches the game server — only if its
   * handler runs without throwing. The reference implementation matched a
   * command anywhere in the line, so typing "nexus?" in chat silently invoked
   * it; matching is anchored to a leading slash.
   *
   * @throws {Error} if the name is already taken by this plugin.
   */
  register(command: CommandDefinition): Unsubscribe;
}

export interface SessionApi {
  /** The session currently connected, if any. */
  current(): SessionView | undefined;
  all(): Iterable<SessionView>;
  onConnected(listener: (session: SessionView) => void): Unsubscribe;
  onDisconnected(listener: (session: SessionView) => void): Unsubscribe;
}

/**
 * The native module, as far as a plugin needs it.
 *
 * Deliberately one-way and untyped in its values: the runtime does not model
 * what the native side does with a key, and the native side ignores keys it
 * does not know. That is what lets either be older than the other.
 */
export interface NativeApi {
  /** True while the native module is connected and authenticated. */
  readonly connected: boolean;
  /**
   * Sets a gameplay feature.
   *
   * The runtime remembers the last value per key and re-sends it whenever the
   * native module (re)connects, so a plugin sets a key once and does not have
   * to watch the connection.
   */
  setFeature(key: string, value: boolean | number | string): void;
  onConnected(listener: () => void): Unsubscribe;
}

export interface Logger {
  trace(message: string): void;
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string, cause?: unknown): void;
}

/**
 * Timers the host owns.
 *
 * A plugin that calls `setInterval` directly keeps running after it is
 * disabled, and keeps the process alive at shutdown. These are cancelled with
 * the plugin.
 */
export interface TimerApi {
  setTimeout(fn: () => void, ms: number): Unsubscribe;
  setInterval(fn: () => void, ms: number): Unsubscribe;
}
