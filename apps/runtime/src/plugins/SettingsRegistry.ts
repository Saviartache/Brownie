import {
  clampToBounds,
  humaniseKey,
  type BooleanSettingOptions,
  type ButtonOptions,
  type NumberSettingOptions,
  type SelectSettingOptions,
  type SettingDescriptor,
  type SettingHandle,
  type SettingValue,
  type SettingsApi,
  type TextSettingOptions,
  type Unsubscribe,
} from '@brownie/plugin-api';

/** Where persisted setting values come from and go. */
export interface SettingsStore {
  read(pluginId: string): Readonly<Record<string, SettingValue>> | undefined;
  write(pluginId: string, values: Readonly<Record<string, SettingValue>>): void;
}

/** A store that forgets everything — the default until config is wired up. */
export const MEMORY_ONLY_STORE: SettingsStore = {
  read: () => undefined,
  write: () => undefined,
};

export interface SettingsRegistryOptions {
  readonly pluginId: string;
  readonly store: SettingsStore;
  /** Called whenever a value changes, so the overlay and config can follow. */
  readonly onChanged: (pluginId: string, key: string, value: SettingValue) => void;
}

/**
 * One plugin's settings.
 *
 * A declaration is the single source of truth for three things at once: the
 * value the plugin reads, the control the overlay draws, and the key the config
 * store persists. The reference implementation kept those in three places and
 * reconciled them by hand.
 *
 * Values arrive from three untrusted directions — the overlay, config written
 * by an older build, and plugin code — so every write is validated against the
 * declaration rather than trusted for having the right TypeScript type.
 */
export class SettingsRegistry implements SettingsApi {
  readonly #pluginId: string;
  readonly #store: SettingsStore;
  readonly #onChanged: (pluginId: string, key: string, value: SettingValue) => void;

  readonly #descriptors = new Map<string, SettingDescriptor>();
  readonly #values = new Map<string, SettingValue>();
  readonly #listeners = new Map<string, Set<(value: never) => void>>();
  readonly #buttons = new Map<string, () => void>();
  #sealed = false;

  constructor(options: SettingsRegistryOptions) {
    this.#pluginId = options.pluginId;
    this.#store = options.store;
    this.#onChanged = options.onChanged;
  }

  /**
   * Stops further declarations.
   *
   * The set of settings is fixed once `setup` returns, which is what lets the
   * overlay publish a complete picture instead of watching for late arrivals.
   */
  seal(): void {
    this.#sealed = true;
  }

  descriptors(): readonly SettingDescriptor[] {
    return [...this.#descriptors.values()];
  }

  values(): Readonly<Record<string, SettingValue>> {
    return Object.fromEntries(this.#values);
  }

  /** Presses a button setting. Returns false if there is no such button. */
  press(key: string): boolean {
    const action = this.#buttons.get(key);
    if (action === undefined) return false;
    action();
    return true;
  }

  /**
   * Applies a value from outside — the overlay, or persisted config.
   *
   * @returns false when the key is unknown or the value cannot be made to fit
   *   its declaration. Unknown keys are common and harmless: config persisted
   *   by an older build names settings this version no longer has.
   */
  apply(key: string, raw: unknown): boolean {
    const descriptor = this.#descriptors.get(key);
    if (descriptor === undefined) return false;
    const coerced = coerce(descriptor, raw);
    if (coerced === undefined) return false;
    this.#commit(key, coerced);
    return true;
  }

  boolean(key: string, options: BooleanSettingOptions): SettingHandle<boolean> {
    this.#declare({ kind: 'boolean', key, ...withLabel(key, options) }, options.default);
    return this.#handle<boolean>(key);
  }

  number(key: string, options: NumberSettingOptions): SettingHandle<number> {
    this.#declare(
      { kind: 'number', key, ...withLabel(key, options) },
      clampToBounds(options.default, options),
    );
    return this.#handle<number>(key);
  }

  range(
    key: string,
    options: NumberSettingOptions & { readonly min: number; readonly max: number },
  ): SettingHandle<number> {
    this.#declare(
      { kind: 'range', key, ...withLabel(key, options) },
      clampToBounds(options.default, options),
    );
    return this.#handle<number>(key);
  }

  select<T extends string>(key: string, options: SelectSettingOptions<T>): SettingHandle<T> {
    if (!options.options.some(([value]) => value === options.default)) {
      throw new TypeError(
        `setting "${key}" defaults to "${options.default}", which is not one of its options`,
      );
    }
    this.#declare({ kind: 'select', key, ...withLabel(key, options) }, options.default);
    return this.#handle<T>(key);
  }

  text(key: string, options: TextSettingOptions): SettingHandle<string> {
    this.#declare({ kind: 'text', key, ...withLabel(key, options) }, options.default);
    return this.#handle<string>(key);
  }

  button(key: string, options: ButtonOptions): void {
    this.#declare({ kind: 'button', key, ...options }, '');
    this.#buttons.set(key, options.onPress);
  }

  #declare(descriptor: SettingDescriptor, defaultValue: SettingValue): void {
    if (this.#sealed) {
      throw new Error(
        `plugin "${this.#pluginId}" declared setting "${descriptor.key}" after setup returned`,
      );
    }
    if (this.#descriptors.has(descriptor.key)) {
      throw new TypeError(`plugin "${this.#pluginId}" declares setting "${descriptor.key}" twice`);
    }
    this.#descriptors.set(descriptor.key, descriptor);
    this.#values.set(descriptor.key, defaultValue);

    // A persisted value only wins if it still fits the declaration; a setting
    // whose bounds tightened between builds falls back to the new default
    // rather than staying out of range.
    const persisted = this.#store.read(this.#pluginId)?.[descriptor.key];
    if (persisted !== undefined) {
      const coerced = coerce(descriptor, persisted);
      if (coerced !== undefined) this.#values.set(descriptor.key, coerced);
    }
  }

  // Arrow properties rather than method shorthand: they close over `this`
  // lexically, so the handle keeps working however the caller stores it.
  #handle<T extends SettingValue>(key: string): SettingHandle<T> {
    return {
      key,
      get: (): T => this.#values.get(key) as T,
      set: (value: T): void => {
        this.apply(key, value);
      },
      onChange: (listener: (value: T) => void): Unsubscribe => {
        let listeners = this.#listeners.get(key);
        if (listeners === undefined) {
          listeners = new Set();
          this.#listeners.set(key, listeners);
        }
        const entry = listener as (value: never) => void;
        listeners.add(entry);
        return () => {
          listeners.delete(entry);
        };
      },
    };
  }

  #commit(key: string, value: SettingValue): void {
    if (this.#values.get(key) === value) return;
    this.#values.set(key, value);
    this.#store.write(this.#pluginId, this.values());

    for (const listener of this.#listeners.get(key) ?? []) {
      (listener as (value: SettingValue) => void)(value);
    }
    this.#onChanged(this.#pluginId, key, value);
  }
}

function withLabel<T extends { label?: string }>(key: string, options: T): T & { label: string } {
  return { ...options, label: options.label ?? humaniseKey(key) };
}

/**
 * Fits an outside value to a declaration, or refuses.
 *
 * Coercing rather than rejecting outright for the easy cases — a number that
 * arrived as a string, a boolean that arrived as `1` — because persisted JSON
 * and an overlay text field both lose type information legitimately.
 */
function coerce(descriptor: SettingDescriptor, raw: unknown): SettingValue | undefined {
  switch (descriptor.kind) {
    case 'boolean': {
      if (typeof raw === 'boolean') return raw;
      if (raw === 1 || raw === '1' || raw === 'true') return true;
      if (raw === 0 || raw === '0' || raw === 'false') return false;
      return undefined;
    }
    case 'number':
    case 'range': {
      const value = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
      if (!Number.isFinite(value)) return undefined;
      return clampToBounds(value, descriptor);
    }
    case 'select': {
      if (typeof raw !== 'string') return undefined;
      return descriptor.options.some(([value]) => value === raw) ? raw : undefined;
    }
    case 'text': {
      if (typeof raw !== 'string') return undefined;
      const max = descriptor.maxLength;
      return max !== undefined && raw.length > max ? raw.slice(0, max) : raw;
    }
    case 'button':
      // A button holds no value; setting one is meaningless rather than wrong.
      return undefined;
  }
}
