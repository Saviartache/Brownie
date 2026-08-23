import type { SettingValue } from '@brownie/plugin-api';

/** Where a plugin's setting values come from and go. */
export interface SettingsStore {
  read(pluginId: string): Readonly<Record<string, SettingValue>> | undefined;
  write(pluginId: string, values: Readonly<Record<string, SettingValue>>): void;
}

/**
 * Everything about a plugin that outlives the run.
 *
 * The switch is kept apart from the settings because it is not one of them: it
 * is never declared, has no descriptor and no bounds to validate against, and
 * the host owns it rather than the plugin. Folding it in as a reserved key
 * would put it back in reach of `apply`, which is exactly what must not happen.
 */
export interface PluginStore extends SettingsStore {
  /** Whether the plugin was left switched on, or `undefined` if never seen. */
  readEnabled(pluginId: string): boolean | undefined;
  writeEnabled(pluginId: string, enabled: boolean): void;
}

/** A store that forgets everything — the default when nothing is persisted. */
export const MEMORY_ONLY_STORE: PluginStore = {
  read: () => undefined,
  write: () => undefined,
  readEnabled: () => undefined,
  writeEnabled: () => undefined,
};
