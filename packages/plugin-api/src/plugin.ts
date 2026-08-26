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
  /**
   * Offer a key that switches this plugin on and off. Default false.
   *
   * A property of the plugin rather than of every plugin, because a bind is
   * only worth having where switching mid-fight is the point — dodging,
   * aiming, walking through a wall. A chat filter is switched on once and left
   * there, and a control for binding one would be a row in the overlay that
   * answers a question nobody asked.
   *
   * `true` binds the plugin's own switch, which is what "on" means for almost
   * every plugin. **A string names a boolean setting to bind instead**, for the
   * plugin whose switch is not the thing a player turns on and off: a plugin
   * cannot observe its own switch moving, so one that has to *undo* something
   * when it stops — noclip lets go of the client's socket — carries its own
   * armed/disarmed setting, and that is what a key has to move.
   *
   * **A list offers more than one key**, for the plugin where switching it on
   * and telling it something mid-fight are two different presses: auto-dodge is
   * switched on for a run and told where to hold ground a dozen times inside
   * one. Each entry is one row in the overlay and one key of its own — see
   * {@link PluginBindable}.
   *
   * The plugin declares nothing else and hears nothing about the key itself.
   * See `apps/runtime/src/plugins/pluginBind.ts`.
   */
  readonly bindable?: boolean | string | readonly PluginBindable[];
}

/**
 * One switch a key can be bound to.
 *
 * **What a key moves is always a boolean the host owns**, which is what keeps
 * the whole mechanism out of the plugin: a press flips the plugin's switch or a
 * setting it declared, and the plugin sees only the value it already had a
 * handle on.
 */
export interface PluginBindable {
  /**
   * The boolean setting a key moves, or the plugin's own switch when absent.
   *
   * It is also the *slot* this bind is filed under — persisted, published to the
   * overlay and reported back by the module under this name — so it is as much
   * a part of the plugin's identity as its id, and renaming one loses the key
   * the user chose.
   */
  readonly setting?: string;
  /**
   * What the overlay calls this key.
   *
   * Worth stating only where there is more than one: a plugin with a single
   * bind has a row that can only mean one thing, and {@link bindLabel} names it
   * for what it is.
   */
  readonly label?: string;
  /**
   * What the game's floating text says when this switch moves, for the switch
   * whose two states do not read as on and off. See {@link BindAnnouncement}.
   */
  readonly announce?: BindAnnouncement;
}

/**
 * What a press says over the player.
 *
 * **A key that says nothing is a key you have to verify**, and the only place
 * to verify it is the panel the bind exists to avoid opening. So every bind
 * reports where it just left its switch, in the game's own text, over the
 * character — the same surface noclip's countdown uses and for the same reason.
 *
 * Declared rather than derived because the two states of a switch do not all
 * read as on and off: the ground auto-dodge holds you to is *set* and *unset*,
 * and `Anchor: On` is a sentence about a feature rather than about the place
 * the key just took.
 */
export interface BindAnnouncement {
  /** What the line calls this switch. */
  readonly name: string;
  /** What its two states read as. */
  readonly on: string;
  readonly off: string;
}

/** The plugin's own switch, as a slot. Empty because it is not a setting. */
export const SWITCH_SLOT = '';

/** The default name of a bind that did not choose one. */
const DEFAULT_BIND_LABEL = 'Hotkey';

/** How a switch that did not say otherwise reads when a key moves it. */
const DEFAULT_ANNOUNCEMENT = { on: 'On', off: 'Off' } as const;

/**
 * Every key a plugin offers, in the order it declared them.
 *
 * Empty for a plugin that offers none, which is most of them. The three
 * spellings of {@link PluginMeta.bindable} collapse to this one shape here, so
 * that nothing downstream has to know there were three.
 */
export function bindTargets(meta: PluginMeta): readonly PluginBindable[] {
  const bindable = meta.bindable;
  if (bindable === true) return [{}];
  if (typeof bindable === 'string') return [{ setting: bindable }];
  // The list, or nothing at all: what is left here is `false`, `undefined` or
  // the array itself, and only one of the three is an object.
  return typeof bindable === 'object' ? bindable : [];
}

/** Which of a plugin's binds this is. See {@link PluginBindable.setting}. */
export function bindSlot(target: PluginBindable): string {
  return target.setting ?? SWITCH_SLOT;
}

/** What to call it on a panel. */
export function bindLabel(target: PluginBindable): string {
  return target.label ?? DEFAULT_BIND_LABEL;
}

/**
 * What to say when one of a plugin's switches moves, or nothing when the plugin
 * offers no key for that slot.
 *
 * **The plugin's own name by default, not the bind's label.** A label answers
 * "which of this plugin's keys is this row", which is a question somebody has
 * while looking at a panel listing all of them; over the character there is no
 * list, and `Hotkey: On` names nothing at all. That default is right for the
 * setting-named bind too — noclip's `active` *is* what the plugin being on
 * means. See {@link PluginBindable.announce} for the bind where it is not.
 */
export function bindAnnouncement(meta: PluginMeta, slot: string): BindAnnouncement | undefined {
  const target = bindTargets(meta).find((candidate) => bindSlot(candidate) === slot);
  if (target === undefined) return undefined;
  return target.announce ?? { name: meta.name, ...DEFAULT_ANNOUNCEMENT };
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
  // Two binds on one slot would be two rows in the overlay writing one stored
  // key, and one press moving whichever of them the host happened to keep.
  const slots = new Set<string>();
  for (const target of bindTargets(meta)) {
    const slot = bindSlot(target);
    if (slots.has(slot)) {
      throw new TypeError(
        `plugin "${meta.id}" offers two keys for ${slot === SWITCH_SLOT ? 'its own switch' : `"${slot}"`}`,
      );
    }
    slots.add(slot);
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
