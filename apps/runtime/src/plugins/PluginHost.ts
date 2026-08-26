import {
  PluginState,
  SWITCH_SLOT,
  bindSlot,
  bindTargets,
  type CommandApi,
  type CommandDefinition,
  type MutablePacket,
  type NativeApi,
  type PacketApi,
  type PacketHandler,
  type Plugin,
  type PluginContext,
  type PluginStatus,
  type SessionApi,
  type SessionView,
  type SettingValue,
  type TimerApi,
  type Unsubscribe,
} from '@brownie/plugin-api';
import { toError, type Logger } from '../core/logging/Logger.js';
import { normaliseBind } from './pluginBind.js';
import { MEMORY_ONLY_STORE, type PluginStore } from './PluginStore.js';
import { SettingsRegistry } from './SettingsRegistry.js';

export interface PluginHostOptions {
  readonly log: Logger;
  /** Where settings and switches survive a restart. Defaults to nowhere. */
  readonly store?: PluginStore;
  readonly native: NativeApi;
  readonly sessions: SessionApi;
  /**
   * How many times a plugin's handlers may throw before it is switched off.
   *
   * A plugin that fails once has a bug in an edge case; one that fails
   * constantly is spraying errors into every packet, and the useful thing to do
   * with it is stop calling it and say why.
   */
  readonly maxHandlerErrors?: number;
  readonly onChanged?: () => void;
}

/** Where in the dispatch order a handler sits. */
const Priority = {
  First: 0,
  Normal: 1,
  Any: 2,
} as const;

type Priority = (typeof Priority)[keyof typeof Priority];

/**
 * The order handlers run in, once.
 *
 * A module constant rather than a literal in the dispatch loop: that loop runs
 * for every packet in both directions, and building a three-element array to
 * iterate it was an allocation per packet for a list that never changes.
 */
const DISPATCH_ORDER = [Priority.First, Priority.Normal, Priority.Any] as const;

interface Subscription {
  readonly owner: LoadedPlugin;
  readonly priority: Priority;
  /** `undefined` means every packet. */
  readonly packetName: string | undefined;
  readonly handler: PacketHandler;
}

interface LoadedPlugin {
  readonly plugin: Plugin;
  readonly settings: SettingsRegistry;
  readonly disposers: (() => void)[];
  readonly commands: Set<string>;
  state: PluginState;
  enabled: boolean;
  /**
   * The key bound to each switch this plugin offers, canonically spelled, by
   * the slot it moves.
   *
   * Beside the switch rather than among the settings, for the reason
   * `PluginStore` gives about the switch itself: it is never declared, has no
   * descriptor to validate against, and belongs to the host. A slot the plugin
   * did not declare is absent, which is what makes an unknown one refusable
   * rather than a key that moves nothing.
   */
  readonly binds: Map<string, string>;
  handlerErrors: number;
  error?: string;
  /**
   * Whether it was `setup` that threw.
   *
   * The two ways a plugin can be `Failed` are not the same failure. One threw
   * during `setup`, registered nothing and has nothing to run — switching it on
   * would do exactly nothing, so it stays out of reach until its file is fixed
   * and reloaded. The other ran fine and then threw often enough in its
   * handlers to be switched off; its subscriptions are all still there, and
   * "try again" is a reasonable thing to ask for. Without this flag the second
   * kind was as unreachable as the first, and the only way to clear it was to
   * restart the runtime.
   */
  setupFailed: boolean;
}

/**
 * Loads plugins, gates them, and dispatches to them.
 *
 * The host owns every subscription: a plugin hands over callbacks and never
 * holds a registration itself, so unloading removes all of them by construction
 * rather than by the plugin remembering to. That is the difference between this
 * and the reference implementation, where a plugin registered directly with the
 * proxy and unloading walked a parallel bookkeeping map to undo it.
 *
 * Enabling is a gate the host applies rather than work the plugin repeats.
 * `setup` runs once, while the plugin is still disabled.
 */
export class PluginHost {
  readonly #log: Logger;
  readonly #store: PluginStore;
  readonly #native: NativeApi;
  readonly #sessions: SessionApi;
  readonly #maxHandlerErrors: number;
  readonly #onChanged: () => void;

  readonly #plugins = new Map<string, LoadedPlugin>();
  readonly #subscriptions: Subscription[] = [];
  readonly #commands = new Map<string, { owner: LoadedPlugin; command: CommandDefinition }>();

  /**
   * Handlers by packet name, in dispatch order, and the ones that want every
   * packet.
   *
   * **Built from the subscriptions, not instead of them.** Subscribing and
   * unsubscribing happen when a plugin loads or is disabled; dispatch happens
   * for every packet of every session. Walking the whole subscription list
   * three times per packet — once per priority — to find the handful that named
   * this packet is work proportional to the wrong thing.
   *
   * Rebuilt lazily, and thrown away whenever the list behind it changes, so
   * there is one place that can be stale and it cannot be read while it is.
   */
  #byName: Map<string, Subscription[]> | undefined;
  #anyHandlers: readonly Subscription[] = [];

  constructor(options: PluginHostOptions) {
    this.#log = options.log;
    this.#store = options.store ?? MEMORY_ONLY_STORE;
    this.#native = options.native;
    this.#sessions = options.sessions;
    this.#maxHandlerErrors = options.maxHandlerErrors ?? 10;
    this.#onChanged = options.onChanged ?? ((): void => undefined);
  }

  statuses(): readonly PluginStatus[] {
    return [...this.#plugins.values()].map((entry) => this.#statusOf(entry));
  }

  status(pluginId: string): PluginStatus | undefined {
    const entry = this.#plugins.get(pluginId);
    return entry === undefined ? undefined : this.#statusOf(entry);
  }

  settingsOf(pluginId: string): SettingsRegistry | undefined {
    return this.#plugins.get(pluginId)?.settings;
  }

  /**
   * Runs a plugin's `setup`.
   *
   * A plugin that throws here is recorded as failed and left inert. Nothing
   * else is affected — that is the entire point of loading them one at a time.
   */
  load(plugin: Plugin): PluginStatus {
    const id = plugin.meta.id;
    if (this.#plugins.has(id)) {
      throw new Error(`plugin "${id}" is already loaded`);
    }

    const entry: LoadedPlugin = {
      plugin,
      settings: new SettingsRegistry({
        pluginId: id,
        store: this.#store,
        onChanged: () => {
          this.#onChanged();
        },
      }),
      disposers: [],
      commands: new Set(),
      state: PluginState.Discovered,
      enabled: false,
      // Restored rather than set, so nothing is written back on every start —
      // and refused rather than repaired, so a hand-edited file leaves the
      // plugin unbound instead of bound to something nobody chose.
      binds: new Map(
        bindTargets(plugin.meta).map((target) => {
          const slot = bindSlot(target);
          return [slot, normaliseBind(this.#store.readBind(id, slot) ?? '') ?? ''];
        }),
      ),
      handlerErrors: 0,
      setupFailed: false,
    };
    this.#plugins.set(id, entry);

    try {
      plugin.setup(this.#buildContext(entry));
      entry.settings.seal();
      entry.state = PluginState.Loaded;
      // A plugin comes back the way it was left, falling back to what it asks
      // for the first time it is ever seen. Assigned rather than routed through
      // `setEnabled`: restoring is not a change, and writing it back would
      // rewrite the file on every start.
      if (this.#store.readEnabled(id) ?? plugin.meta.enabledByDefault ?? false) {
        entry.enabled = true;
        entry.state = PluginState.Enabled;
      }
      this.#log.info(`loaded plugin "${id}"${entry.enabled ? ' (enabled)' : ''}`);
    } catch (cause) {
      const error = toError(cause);
      entry.state = PluginState.Failed;
      entry.setupFailed = true;
      entry.error = error?.message ?? 'setup failed';
      this.#log.error(`plugin "${id}" failed to load`, cause);
      // Anything it managed to register before throwing must go: a plugin that
      // did not finish setting up must not be half-live.
      this.#unregister(entry);
    }

    this.#onChanged();
    return this.#statusOf(entry);
  }

  #statusOf(entry: LoadedPlugin): PluginStatus {
    return {
      meta: entry.plugin.meta,
      state: entry.state,
      handlerErrors: entry.handlerErrors,
      enableable: !entry.setupFailed,
      ...(entry.error === undefined ? {} : { error: entry.error }),
    };
  }

  /**
   * Switches a plugin on or off.
   *
   * @returns false when there is no such plugin, or when its `setup` threw —
   *   that one registered nothing, so switching it on would run nothing. A
   *   plugin switched off for failing handlers can be switched back on: see
   *   {@link LoadedPlugin.setupFailed}.
   */
  setEnabled(pluginId: string, enabled: boolean): boolean {
    const entry = this.#plugins.get(pluginId);
    if (entry === undefined || entry.setupFailed) return false;
    // A plugin switched off for failing is already off, so asking for off again
    // changes nothing; asking for on is the retry, and that path is below.
    if (entry.enabled === enabled) return true;

    entry.enabled = enabled;
    entry.state = enabled ? PluginState.Enabled : PluginState.Loaded;
    // Only here, and not on the restore path above: this is the one place the
    // switch is actually moved, so it is the one place worth persisting.
    this.#store.writeEnabled(pluginId, enabled);
    // A plugin gets a fresh budget each time it is switched on: the user has
    // just said "try again", and refusing to would need them to restart. The
    // recorded reason goes with it — a stale "disabled after 10 handler errors"
    // sitting under a plugin that is now running is worse than no message.
    if (enabled) {
      entry.handlerErrors = 0;
      delete entry.error;
    }
    this.#log.info(`plugin "${pluginId}" ${enabled ? 'enabled' : 'disabled'}`);
    this.#onChanged();
    return true;
  }

  isEnabled(pluginId: string): boolean {
    return this.#plugins.get(pluginId)?.enabled ?? false;
  }

  /** The key bound to one of a plugin's switches, or empty when there is none. */
  bindOf(pluginId: string, slot: string): string {
    return this.#plugins.get(pluginId)?.binds.get(slot) ?? '';
  }

  /**
   * Binds a key to one of a plugin's switches, or clears it with an empty
   * value.
   *
   * @returns false when there is no such plugin, when it offers no key for that
   *   slot, or when the value is not a bind this build understands. Refusing
   *   rather than repairing: the bind it already has is one the user chose, and
   *   replacing it with a guess is worse than ignoring the write.
   */
  setBind(pluginId: string, slot: string, raw: string): boolean {
    const entry = this.#plugins.get(pluginId);
    if (entry === undefined || !entry.binds.has(slot)) return false;

    const bind = normaliseBind(raw);
    if (bind === undefined) return false;
    if (entry.binds.get(slot) === bind) return true;

    entry.binds.set(slot, bind);
    this.#store.writeBind(pluginId, slot, bind);
    this.#log.info(
      `plugin "${pluginId}"${slot === SWITCH_SLOT ? '' : ` (${slot})`} ${
        bind === '' ? 'unbound' : `bound to ${bind}`
      }`,
    );
    this.#onChanged();
    return true;
  }

  /**
   * Whether the switch a key moves is on.
   *
   * The same thing as {@link isEnabled} for the plugin's own switch. For a slot
   * that names a setting it is both: a disarmed setting is off, and so is an
   * armed one inside a plugin nobody enabled — which is also what makes a press
   * able to rescue that second state.
   */
  isActive(pluginId: string, slot: string): boolean {
    const entry = this.#plugins.get(pluginId);
    if (entry === undefined || !entry.binds.has(slot)) return false;
    if (slot === SWITCH_SLOT) return entry.enabled;
    return entry.enabled && entry.settings.value(slot) === true;
  }

  /**
   * Moves that switch the way a bound key does.
   *
   * **Asymmetric on purpose where the slot is a setting.** On needs both — a
   * setting armed inside a plugin that is not running does nothing — while off
   * needs only the setting disarmed: that is what makes the plugin undo
   * whatever it was doing, and switching it off as well would take away a
   * plugin the user had enabled themselves. So a key leaves the switch where it
   * found it and moves only what has to move.
   *
   * @returns false when there is no such plugin, when it offers no key for that
   *   slot, or when the switch cannot be moved.
   */
  setActive(pluginId: string, slot: string, on: boolean): boolean {
    const entry = this.#plugins.get(pluginId);
    if (entry === undefined || !entry.binds.has(slot)) return false;
    if (slot === SWITCH_SLOT) return this.setEnabled(pluginId, on);

    // Order matters both ways: arming a plugin that is not running would leave
    // it armed and inert, and disabling one before it is disarmed would leave
    // whatever it is holding held with nothing left running to let go of it.
    if (on && !this.setEnabled(pluginId, true)) return false;
    return entry.settings.apply(slot, on);
  }

  /** Unloads one plugin, running its disposers and dropping its registrations. */
  unload(pluginId: string): boolean {
    const entry = this.#plugins.get(pluginId);
    if (entry === undefined) return false;
    this.#unregister(entry);
    this.#plugins.delete(pluginId);
    this.#log.info(`unloaded plugin "${pluginId}"`);
    this.#onChanged();
    return true;
  }

  /** Unloads everything, in reverse load order. */
  disposeAll(): void {
    for (const id of [...this.#plugins.keys()].reverse()) this.unload(id);
  }

  /**
   * Offers a packet to every enabled plugin, in priority order.
   *
   * `onFirst` handlers run before ordinary ones across all plugins — auto-nexus
   * has to see a health drop before a plugin that might drop the packet does.
   */
  dispatchPacket(packet: MutablePacket, session: SessionView): void {
    const named = this.#index().get(packet.name);
    if (named !== undefined) {
      for (const subscription of named) this.#deliver(subscription, packet, session);
    }
    for (const subscription of this.#anyHandlers) this.#deliver(subscription, packet, session);
  }

  /**
   * Runs one handler, isolating its failure.
   *
   * Not `#invoke`: that takes a closure and a description, and both would be
   * built for every handler of every packet — a closure and a string
   * concatenation on the hottest path in the runtime, to describe an error
   * almost none of them ever has. The description is built where it is needed,
   * which is the failing branch.
   */
  #deliver(subscription: Subscription, packet: MutablePacket, session: SessionView): void {
    const entry = subscription.owner;
    if (!entry.enabled || entry.state === PluginState.Failed) return;
    try {
      subscription.handler(packet, session);
    } catch (cause) {
      this.#failed(entry, `handler for ${packet.name}`, cause);
    }
  }

  /** The dispatch index, rebuilt if a subscription has come or gone. */
  #index(): Map<string, Subscription[]> {
    if (this.#byName !== undefined) return this.#byName;

    const byName = new Map<string, Subscription[]>();
    const any: Subscription[] = [];
    // By priority first, so each list is already in dispatch order and nothing
    // has to be sorted or re-checked per packet.
    for (const priority of DISPATCH_ORDER) {
      for (const subscription of this.#subscriptions) {
        if (subscription.priority !== priority) continue;
        const name = subscription.packetName;
        if (name === undefined) {
          any.push(subscription);
          continue;
        }
        const list = byName.get(name);
        if (list === undefined) byName.set(name, [subscription]);
        else list.push(subscription);
      }
    }
    this.#anyHandlers = any;
    this.#byName = byName;
    return byName;
  }

  /**
   * Runs a chat command.
   *
   * @returns true when a command ran, which is what tells the caller to keep
   *   the text out of the game's chat. A command whose handler throws is *not*
   *   consumed: swallowing the message as well as the error would leave the
   *   user with no feedback at all.
   */
  dispatchCommand(name: string, args: readonly string[], session: SessionView): boolean {
    const registration = this.#commands.get(name.toLowerCase());
    if (registration === undefined || !registration.owner.enabled) return false;
    return this.#invoke(registration.owner, `command /${name}`, () => {
      registration.command.run(args, session);
    });
  }

  /** Every registered command, for the overlay and for `/cmds`. */
  commands(): readonly { name: string; usage: string; description: string; pluginId: string }[] {
    return [...this.#commands.values()].map(({ owner, command }) => ({
      name: command.name,
      usage: command.usage ?? `/${command.name}`,
      description: command.description,
      pluginId: owner.plugin.meta.id,
    }));
  }

  /** @returns whether the call completed without throwing. */
  #invoke(entry: LoadedPlugin, what: string, fn: () => void): boolean {
    if (entry.state === PluginState.Failed) return false;
    try {
      fn();
      return true;
    } catch (cause) {
      this.#failed(entry, what, cause);
      return false;
    }
  }

  /** Records one failure, and switches the plugin off if it keeps having them. */
  #failed(entry: LoadedPlugin, what: string, cause: unknown): void {
    entry.handlerErrors++;
    this.#log.error(`plugin "${entry.plugin.meta.id}" threw in ${what}`, cause);
    if (entry.handlerErrors < this.#maxHandlerErrors) return;

    entry.enabled = false;
    entry.state = PluginState.Failed;
    entry.error = `disabled after ${String(entry.handlerErrors)} handler errors`;
    this.#log.warn(`plugin "${entry.plugin.meta.id}" ${entry.error}`);
    this.#onChanged();
  }

  #unregister(entry: LoadedPlugin): void {
    for (let i = this.#subscriptions.length - 1; i >= 0; i--) {
      if (this.#subscriptions[i]?.owner === entry) this.#subscriptions.splice(i, 1);
    }
    this.#byName = undefined;
    for (const name of entry.commands) this.#commands.delete(name);
    entry.commands.clear();

    // Disposers run in reverse registration order, and one that throws must not
    // stop the rest: a leaked timer is worse than a logged error.
    for (const dispose of [...entry.disposers].reverse()) {
      try {
        dispose();
      } catch (cause) {
        this.#log.error(`plugin "${entry.plugin.meta.id}" threw while disposing`, cause);
      }
    }
    entry.disposers.length = 0;
    entry.enabled = false;
  }

  // Everything below is arrow functions closing over `this` lexically: a
  // plugin stores these callbacks wherever it likes, and they must not depend
  // on how they are later called.
  #buildContext(entry: LoadedPlugin): PluginContext {
    const id = entry.plugin.meta.id;

    const subscribe = (
      priority: Priority,
      packetName: string | undefined,
      handler: PacketHandler,
    ): Unsubscribe => {
      const subscription: Subscription = { owner: entry, priority, packetName, handler };
      this.#subscriptions.push(subscription);
      this.#byName = undefined;
      return () => {
        const index = this.#subscriptions.indexOf(subscription);
        if (index < 0) return;
        this.#subscriptions.splice(index, 1);
        this.#byName = undefined;
      };
    };

    const packets: PacketApi = {
      on: (packetName, handler) => subscribe(Priority.Normal, packetName, handler),
      onFirst: (packetName, handler) => subscribe(Priority.First, packetName, handler),
      onAny: (handler) => subscribe(Priority.Any, undefined, handler),
    };

    const commands: CommandApi = {
      register: (command: CommandDefinition): Unsubscribe => {
        const name = command.name.toLowerCase();
        const existing = this.#commands.get(name);
        if (existing !== undefined) {
          throw new Error(
            `command "/${name}" is already registered by "${existing.owner.plugin.meta.id}"`,
          );
        }
        this.#commands.set(name, { owner: entry, command });
        entry.commands.add(name);
        return () => {
          this.#commands.delete(name);
          entry.commands.delete(name);
        };
      },
    };

    const timers: TimerApi = {
      setTimeout: (fn: () => void, ms: number): Unsubscribe => {
        const handle = setTimeout(() => {
          // Gated like a packet handler: a disabled plugin does not act.
          if (entry.enabled) this.#invoke(entry, 'a timeout', fn);
        }, ms);
        const cancel = (): void => {
          clearTimeout(handle);
        };
        entry.disposers.push(cancel);
        return cancel;
      },
      setInterval: (fn: () => void, ms: number): Unsubscribe => {
        const handle = setInterval(() => {
          if (entry.enabled) this.#invoke(entry, 'an interval', fn);
        }, ms);
        const cancel = (): void => {
          clearInterval(handle);
        };
        entry.disposers.push(cancel);
        return cancel;
      },
    };

    const log = this.#log.child(`plugin:${id}`);

    return {
      packets,
      commands,
      timers,
      settings: entry.settings,
      sessions: this.#sessions,
      native: this.#native,
      log: {
        trace: (message): void => {
          log.trace(message);
        },
        debug: (message): void => {
          log.debug(message);
        },
        info: (message): void => {
          log.info(message);
        },
        warn: (message): void => {
          log.warn(message);
        },
        error: (message, cause): void => {
          log.error(message, cause);
        },
      },
      get enabled(): boolean {
        return entry.enabled;
      },
      onDispose(fn: () => void): void {
        entry.disposers.push(fn);
      },
    };
  }
}

export type { SettingValue };
