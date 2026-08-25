import {
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
  type SettingDescriptor,
  type SettingHandle,
  type SettingValue,
  type SettingsApi,
  type TextSettingOptions,
  type Unsubscribe,
} from '@brownie/plugin-api';
import type { SettingsStore } from './PluginStore.js';

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

  select<T extends string>(key: string, options: SelectSettingOptions<T>): SelectHandle<T> {
    if (!options.options.some(([value]) => value === options.default)) {
      throw new TypeError(
        `setting "${key}" defaults to "${options.default}", which is not one of its options`,
      );
    }
    this.#declare({ kind: 'select', key, ...withLabel(key, options) }, options.default);
    const handle = this.#handle<T>(key);
    return {
      ...handle,
      setOptions: (next): void => {
        this.#setSelectOptions(key, next);
      },
    };
  }

  multiSelect<T extends string>(
    key: string,
    options: MultiSelectSettingOptions<T>,
  ): MultiSelectHandle<T> {
    const known = new Set<string>(options.options.map(([value]) => value));
    for (const chosen of options.default) {
      if (!known.has(chosen)) {
        throw new TypeError(
          `setting "${key}" defaults to "${chosen}", which is not one of its options`,
        );
      }
    }
    const descriptor = { kind: 'multiSelect' as const, key, ...withLabel(key, options) };
    this.#declare(descriptor, canonicalSelection(descriptor, options.default));
    return this.#multiHandle<T>(key);
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

    // A persisted value only wins if it still fits the declaration. A dynamic
    // select is the exception: its real options arrive after setup, and that
    // first update validates the value before anything can use it.
    const persisted = this.#store.read(this.#pluginId)?.[descriptor.key];
    if (persisted !== undefined) {
      if (
        descriptor.kind === 'select' &&
        descriptor.dynamic === true &&
        typeof persisted === 'string'
      ) {
        this.#values.set(descriptor.key, persisted);
        return;
      }
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

  // The array-facing view of a multi-select. The value is stored as a single
  // delimited string like every other setting; this is where it is split for a
  // plugin to read and joined for one to write.
  #multiHandle<T extends string>(key: string): MultiSelectHandle<T> {
    const inner = this.#handle<string>(key);
    return {
      key,
      get: (): readonly T[] => splitSelection(inner.get()) as T[],
      has: (value: T): boolean => splitSelection(inner.get()).includes(value),
      set: (values: readonly T[]): void => {
        inner.set(values.join(MULTI_SELECT_DELIMITER));
      },
      onChange: (listener: (values: readonly T[]) => void): Unsubscribe =>
        inner.onChange((value) => {
          listener(splitSelection(value) as T[]);
        }),
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

  #setSelectOptions(key: string, options: ReadonlyArray<readonly [string, string]>): void {
    const current = this.#descriptors.get(key);
    if (current?.kind !== 'select') throw new TypeError(`setting "${key}" is not a select`);
    if (!options.some(([value]) => value === current.default)) {
      throw new TypeError(
        `setting "${key}" options no longer contain its default "${current.default}"`,
      );
    }

    const descriptor: SettingDescriptor = { ...current, options };
    this.#descriptors.set(key, descriptor);
    const value = this.#values.get(key);
    if (typeof value === 'string' && options.some(([candidate]) => candidate === value)) {
      this.#onChanged(this.#pluginId, key, value);
      return;
    }
    this.#commit(key, current.default);
  }
}

function withLabel<T extends { label?: string }>(key: string, options: T): T & { label: string } {
  return { ...options, label: options.label ?? humaniseKey(key) };
}

/** The empty string is a real value here — no options chosen — not "not set". */
function splitSelection(value: string): string[] {
  return value === '' ? [] : value.split(MULTI_SELECT_DELIMITER);
}

/**
 * The one spelling of a multi-select's set: its chosen keys in the order the
 * options were declared, joined by the delimiter, with unknowns already dropped
 * by the caller. Independent of the order the keys arrived in, so the same set
 * always produces the same string.
 */
function canonicalSelection(
  descriptor: MultiSelectSettingOptions<string>,
  chosen: readonly string[],
): string {
  const wanted = new Set(chosen);
  return descriptor.options
    .filter(([value]) => wanted.has(value))
    .map(([value]) => value)
    .join(MULTI_SELECT_DELIMITER);
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
    case 'multiSelect': {
      // A string of keys from the overlay or an array from plugin code; either
      // way, keep only keys that are still declared options, in declared order,
      // and re-join into a canonical string. Canonical because `#commit`
      // dedupes with `===`: two spellings of the same set must compare equal.
      const raws = typeof raw === 'string' ? raw.split(MULTI_SELECT_DELIMITER) : raw;
      if (!Array.isArray(raws)) return undefined;
      const chosen = new Set(raws.map(String));
      return canonicalSelection(
        descriptor,
        descriptor.options.filter(([value]) => chosen.has(value)).map(([value]) => value),
      );
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
