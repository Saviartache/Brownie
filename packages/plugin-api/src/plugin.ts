import type { PluginContext } from './context.js';

/** Where the overlay files a plugin. */
export const PluginCategory = {
  Combat: 'combat',
  Movement: 'movement',
  Items: 'items',
  Visuals: 'visuals',
  Utility: 'utility',
  /** A plugin whose point is the chat command it registers. */
  Commands: 'commands',
  Developer: 'developer',
} as const;

export type PluginCategory = (typeof PluginCategory)[keyof typeof PluginCategory];

export interface PluginMeta {
  /** Stable, unique, kebab-case. Persisted config and hotkeys key off this. */
  readonly id: string;
  readonly name: string;
  readonly category: PluginCategory;
  /** One line for the overlay. */
  readonly description?: string;
  readonly author?: string;
  readonly version?: string;
  /** Start enabled the first time this plugin is ever seen. Default false. */
  readonly enabledByDefault?: boolean;
}

/**
 * A plugin.
 *
 * `setup` runs once when the plugin loads, while it is still disabled. It
 * declares settings, subscribes to packets and registers commands; the host
 * holds every subscription and only *delivers* to them while the plugin is
 * enabled. That is why there is no `onEnable`/`onDisable` pair to get wrong:
 * enabling is a gate the host applies, not work the plugin repeats.
 *
 * A plugin that needs to act on the transition — pushing native feature keys,
 * say — subscribes with `ctx.settings` handles and `ctx.native`, both of which
 * the host replays on enable and on native reconnect.
 */
export interface Plugin {
  readonly meta: PluginMeta;
  /**
   * Declares everything the plugin needs. Synchronous, deliberately.
   *
   * An `async setup` would leave a window in which the plugin is loaded but has
   * not finished subscribing, so a packet arriving during it reaches some of
   * the plugin's handlers and not others. Returning synchronously means the
   * plugin's subscriptions are complete the moment it exists.
   *
   * A plugin that needs asynchronous work — reading a file, fetching a list —
   * starts it here and handles its own failure; the runtime is already running
   * either way. Cleanup goes through `ctx.onDispose`, which is the single
   * mechanism rather than one of two.
   */
  setup(ctx: PluginContext): void;
}

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Declares a plugin, validating its metadata at the point of definition.
 *
 * The identity check is not ceremony: the id is the key under which settings
 * and hotkeys are persisted, so a plugin that changes or mistypes its id
 * silently loses the user's configuration.
 *
 * @throws {TypeError} if the metadata cannot identify the plugin.
 */
export function definePlugin(plugin: Plugin): Plugin {
  const { meta } = plugin;
  if (!ID_PATTERN.test(meta.id)) {
    throw new TypeError(
      `plugin id "${meta.id}" must be lower-case kebab-case — it is the key its settings persist under`,
    );
  }
  if (meta.name.trim().length === 0) {
    throw new TypeError(`plugin "${meta.id}" has no display name`);
  }
  if (!Object.values(PluginCategory).includes(meta.category)) {
    throw new TypeError(
      `plugin "${meta.id}" has category "${meta.category}"; expected one of ${Object.values(
        PluginCategory,
      ).join(', ')}`,
    );
  }
  if (typeof plugin.setup !== 'function') {
    throw new TypeError(`plugin "${meta.id}" has no setup function`);
  }
  return plugin;
}

/** Lifecycle states the host reports for a plugin. */
export const PluginState = {
  /** Found on disk, not yet imported. */
  Discovered: 'discovered',
  /** Imported and `setup` completed. Handlers are registered but gated off. */
  Loaded: 'loaded',
  /** Handlers receive packets. */
  Enabled: 'enabled',
  /**
   * Refused to load, or threw too often to be trusted.
   *
   * A failed plugin is inert, not fatal: one plugin's mistake must never take
   * down the proxy or another plugin.
   */
  Failed: 'failed',
} as const;

export type PluginState = (typeof PluginState)[keyof typeof PluginState];

export interface PluginStatus {
  readonly meta: PluginMeta;
  readonly state: PluginState;
  /** Present when `state` is `failed`. */
  readonly error?: string;
  /** How many times a handler of this plugin has thrown. */
  readonly handlerErrors: number;
  /**
   * Whether switching it on would do anything.
   *
   * False only for a plugin whose `setup` threw: it registered nothing, so
   * there would be nothing to run, and its file has to be fixed and reloaded.
   * A plugin switched off for failing handlers is `failed` too, but its
   * subscriptions are intact and it can be retried — which is the difference
   * the overlay needs in order to know whether to put a toggle out of reach.
   */
  readonly enableable: boolean;
}
