import type { SettingValue } from '@brownie/plugin-api';
import type { PluginStore } from './PluginStore.js';

/**
 * The shape written to disk.
 *
 * Bumped only when the shape changes in a way an older build would misread. A
 * document at an unknown version is left alone rather than guessed at — see
 * `PreferencesFile`.
 */
export const PREFERENCES_VERSION = 1;

/** One plugin, as the file holds it. */
interface Entry {
  /** `undefined` until the user has switched the plugin either way. */
  enabled: boolean | undefined;
  settings: Record<string, SettingValue>;
}

export interface PreferencesDocument {
  readonly version: number;
  readonly plugins: Readonly<Record<string, { enabled?: boolean; settings: object }>>;
}

/**
 * Recognises a preferences document and hands back the part that varies.
 *
 * A document at a version this build does not know is refused whole rather than
 * read for the parts that still look familiar: guessing at a shape written by a
 * different build is how a rename turns into silently discarded configuration.
 */
export function readDocument(raw: unknown): { readonly plugins: unknown } | undefined {
  if (!isRecord(raw) || raw['version'] !== PREFERENCES_VERSION) return undefined;
  return { plugins: raw['plugins'] };
}

/**
 * What the user configured, in memory.
 *
 * Pure: it parses, holds and serialises, and knows nothing about files. That is
 * what lets every rule below — which malformed value is dropped, which change
 * is worth a write — be tested without touching a disk.
 *
 * A change is reported only when it is one. Restoring at startup and re-writing
 * a value that is already stored are both common, and a store that called back
 * for them would rewrite the file on every run and on every duplicate set.
 */
export class PluginPreferences implements PluginStore {
  readonly #entries = new Map<string, Entry>();
  readonly #onChanged: () => void;

  constructor(onChanged: () => void = () => undefined) {
    this.#onChanged = onChanged;
  }

  read(pluginId: string): Readonly<Record<string, SettingValue>> | undefined {
    return this.#entries.get(pluginId)?.settings;
  }

  write(pluginId: string, values: Readonly<Record<string, SettingValue>>): void {
    const entry = this.#entryFor(pluginId);
    if (sameValues(entry.settings, values)) return;
    entry.settings = { ...values };
    this.#onChanged();
  }

  readEnabled(pluginId: string): boolean | undefined {
    return this.#entries.get(pluginId)?.enabled;
  }

  writeEnabled(pluginId: string, enabled: boolean): void {
    const entry = this.#entryFor(pluginId);
    if (entry.enabled === enabled) return;
    entry.enabled = enabled;
    this.#onChanged();
  }

  /**
   * Replaces everything with what a document's `plugins` member holds.
   *
   * The file is external input — hand-edited, or written by a build that had
   * different settings — so every part of it is checked and anything that does
   * not fit is dropped rather than refused. A single bad key must not cost the
   * user the rest of their configuration.
   *
   * Values are only checked for being *storable* here. Whether one still fits
   * the setting that named it is the registry's question, and it asks it
   * against the declaration at load time.
   *
   * @returns how many plugins were restored.
   */
  load(plugins: unknown): number {
    this.#entries.clear();
    if (!isRecord(plugins)) return 0;

    for (const [pluginId, raw] of Object.entries(plugins)) {
      if (pluginId === '' || !isRecord(raw)) continue;
      const enabled = raw['enabled'];
      this.#entries.set(pluginId, {
        enabled: typeof enabled === 'boolean' ? enabled : undefined,
        settings: readSettings(raw['settings']),
      });
    }
    return this.#entries.size;
  }

  /** The whole document, ready to serialise. */
  toDocument(): PreferencesDocument {
    const plugins: Record<string, { enabled?: boolean; settings: object }> = {};
    for (const [pluginId, entry] of this.#entries) {
      plugins[pluginId] = {
        ...(entry.enabled === undefined ? {} : { enabled: entry.enabled }),
        settings: entry.settings,
      };
    }
    return { version: PREFERENCES_VERSION, plugins };
  }

  #entryFor(pluginId: string): Entry {
    let entry = this.#entries.get(pluginId);
    if (entry === undefined) {
      entry = { enabled: undefined, settings: {} };
      this.#entries.set(pluginId, entry);
    }
    return entry;
  }
}

function readSettings(raw: unknown): Record<string, SettingValue> {
  const settings: Record<string, SettingValue> = {};
  if (!isRecord(raw)) return settings;
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'boolean' || typeof value === 'string') settings[key] = value;
    // A non-finite number survives neither JSON nor a setting's bounds.
    else if (typeof value === 'number' && Number.isFinite(value)) settings[key] = value;
  }
  return settings;
}

function sameValues(
  previous: Readonly<Record<string, SettingValue>>,
  next: Readonly<Record<string, SettingValue>>,
): boolean {
  const keys = Object.keys(next);
  if (keys.length !== Object.keys(previous).length) return false;
  for (const key of keys) {
    if (previous[key] !== next[key]) return false;
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
