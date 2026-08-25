/**
 * `@brownie/plugin-api` — everything a plugin author compiles against, and
 * nothing else.
 *
 * The package is deliberately almost all types. What implementation there is
 * ({@link MutablePacket}, the settings helpers) is pure and shared by both
 * sides, so a plugin and the host cannot disagree about what a setting's bounds
 * mean or when a packet counts as modified.
 *
 * The runtime *implements* these interfaces; plugins *consume* them. That
 * direction is what keeps a plugin from reaching into runtime internals, and
 * what makes a plugin testable without a proxy, a game or a network.
 */

export { MutablePacket, Verdict } from './packet.js';

export {
  clampToBounds,
  humaniseKey,
  MULTI_SELECT_DELIMITER,
  type BooleanSettingOptions,
  type ButtonOptions,
  type MultiSelectHandle,
  type MultiSelectSettingOptions,
  type NumberSettingOptions,
  type SelectSettingOptions,
  type SelectHandle,
  type SettingCommon,
  type SettingDescriptor,
  type SettingHandle,
  type SettingValue,
  type SettingsApi,
  type TextSettingOptions,
  type Unsubscribe,
} from './settings.js';

export type {
  EntityView,
  InventoryView,
  ItemSlotView,
  PermanentStats,
  Position,
  BlastView,
  ProjectileView,
  SelfView,
  SessionView,
  TileView,
  WorldView,
} from './views.js';

export type {
  CommandApi,
  CommandDefinition,
  Logger,
  NativeApi,
  PacketApi,
  PacketHandler,
  PluginContext,
  SessionApi,
  TimerApi,
} from './context.js';

export {
  PluginCategory,
  PluginState,
  definePlugin,
  type Plugin,
  type PluginMeta,
  type PluginStatus,
} from './plugin.js';
