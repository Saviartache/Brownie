/**
 * Plugin settings.
 *
 * A setting is declared once, in `setup`, and the declaration is the single
 * source of truth for three things at once: the value the plugin reads, the
 * control the overlay draws, and the key the config store persists. The
 * reference implementation kept those in three places and reconciled them by
 * hand.
 *
 * Declaring returns a typed handle rather than a string key, so reading a
 * setting cannot misspell it and cannot get back the wrong type.
 */

export type SettingValue = boolean | number | string;

/** Cancels a subscription. Idempotent. */
export type Unsubscribe = () => void;

export interface SettingHandle<T extends SettingValue> {
  readonly key: string;
  /** Current value — the persisted one if there is one, else the default. */
  get(): T;
  /** Changes the value, notifying the overlay and the config store. */
  set(value: T): void;
  /** Fires on every change, including ones made from the overlay. */
  onChange(listener: (value: T) => void): Unsubscribe;
}

/** A single choice whose available values may follow live application state. */
export interface SelectHandle<T extends string> extends SettingHandle<T> {
  /** Replaces the choices. The declared default must remain available. */
  setOptions(options: ReadonlyArray<readonly [T, string]>): void;
}

/**
 * A many-of-N choice — the handle a {@link SettingsApi.multiSelect} returns.
 *
 * Deliberately **not** a {@link SettingHandle}. Its value is a *set* of chosen
 * option keys, and {@link SettingValue} is scalar on purpose — the persistence
 * and overlay layers carry one value per setting as a boolean, a number or a
 * string, and nothing else. So the set is stored as a single string of its keys
 * joined by {@link MULTI_SELECT_DELIMITER}, and this handle is the one place a
 * plugin reads it back as an array instead of having to split it.
 */
export interface MultiSelectHandle<T extends string> {
  readonly key: string;
  /** The chosen keys, in the order the options were declared. */
  get(): readonly T[];
  /** Whether one option is chosen. */
  has(value: T): boolean;
  /** Replaces the chosen set. Unknown keys are dropped, as on any other write. */
  set(values: readonly T[]): void;
  onChange(listener: (values: readonly T[]) => void): Unsubscribe;
}

/**
 * The separator between a multi-select's chosen keys on the wire and on disk.
 *
 * A comma, because option keys are identifiers and do not contain one — the
 * runtime drops any key that is not a declared option anyway, so a key that did
 * contain the delimiter would simply never match rather than corrupt the set.
 * The native overlay hard-codes the same character; it is a cross-language
 * contract, so it lives here where both a plugin and a test can name it.
 */
export const MULTI_SELECT_DELIMITER = ',';

/** Shared by every setting kind. */
export interface SettingCommon {
  /** Shown next to the control. Defaults to a humanised key. */
  readonly label?: string;
  /** Section heading the overlay files this setting under. */
  readonly group?: string;
  /** Hidden behind the overlay's "advanced" toggle. */
  readonly advanced?: boolean;
  /**
   * Persisted and readable, but never drawn.
   *
   * For state a plugin has to keep across runs that is not a knob — what the
   * skin changer picked for each character class, say. A declaration is already
   * the only thing the config store persists, so this is where such state
   * belongs rather than in a second file with its own lifetime.
   */
  readonly hidden?: boolean;
  /**
   * Show only while a sibling setting holds one of these values.
   *
   * Hiding, rather than disabling, is deliberate here and against the
   * overlay's usual rule: a plugin with one knob per planner would otherwise
   * show several sets of greyed-out controls that can never apply at once.
   */
  readonly visibleWhen?: { readonly key: string; readonly equals: readonly SettingValue[] };
}

export interface BooleanSettingOptions extends SettingCommon {
  readonly default: boolean;
}

export interface NumberSettingOptions extends SettingCommon {
  readonly default: number;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
}

export interface SelectSettingOptions<T extends string> extends SettingCommon {
  readonly default: T;
  /** Persisted values may be accepted before a live option list is supplied. */
  readonly dynamic?: boolean;
  /** Value → label, in the order the overlay should show them. */
  readonly options: ReadonlyArray<readonly [T, string]>;
}

export interface MultiSelectSettingOptions<T extends string> extends SettingCommon {
  /** The keys chosen by default. Each must be one of {@link options}. */
  readonly default: readonly T[];
  /** Value → label, in the order the overlay should show them. */
  readonly options: ReadonlyArray<readonly [T, string]>;
}

export interface TextSettingOptions extends SettingCommon {
  readonly default: string;
  readonly maxLength?: number;
}

export interface ButtonOptions extends SettingCommon {
  readonly label: string;
  readonly onPress: () => void;
}

/**
 * What a plugin uses to declare its settings.
 *
 * Every method is safe to call only during `setup`: the set of settings is
 * fixed for a plugin's lifetime, which is what lets the overlay publish a
 * complete picture rather than watching for late arrivals.
 */
export interface SettingsApi {
  boolean(key: string, options: BooleanSettingOptions): SettingHandle<boolean>;
  /** A free number, drawn as a drag field. */
  number(key: string, options: NumberSettingOptions): SettingHandle<number>;
  /** A bounded number, drawn as a slider. `min` and `max` are required. */
  range(
    key: string,
    options: NumberSettingOptions & { readonly min: number; readonly max: number },
  ): SettingHandle<number>;
  select<T extends string>(key: string, options: SelectSettingOptions<T>): SelectHandle<T>;
  /** A many-of-N choice, drawn as a list of checkboxes. */
  multiSelect<T extends string>(
    key: string,
    options: MultiSelectSettingOptions<T>,
  ): MultiSelectHandle<T>;
  text(key: string, options: TextSettingOptions): SettingHandle<string>;
  /** A control with no value: pressing it calls `onPress`. */
  button(key: string, options: ButtonOptions): void;
}

/** The declared shape of one setting, as the overlay and config store see it. */
export type SettingDescriptor =
  | ({ readonly kind: 'boolean'; readonly key: string } & BooleanSettingOptions)
  | ({ readonly kind: 'number' | 'range'; readonly key: string } & NumberSettingOptions)
  | ({ readonly kind: 'select'; readonly key: string } & SelectSettingOptions<string>)
  | ({ readonly kind: 'multiSelect'; readonly key: string } & MultiSelectSettingOptions<string>)
  | ({ readonly kind: 'text'; readonly key: string } & TextSettingOptions)
  | ({ readonly kind: 'button'; readonly key: string } & ButtonOptions);

/**
 * Clamps a number to a setting's declared bounds.
 *
 * Values arrive from the overlay, from persisted config written by an older
 * build, and from plugin code. None of those is trustworthy, and a setting
 * that silently goes out of range is how a "0.5 tile radius" becomes a
 * negative one.
 */
export function clampToBounds(value: number, options: NumberSettingOptions): number {
  if (!Number.isFinite(value)) return options.default;
  let result = value;
  if (options.min !== undefined) result = Math.max(options.min, result);
  if (options.max !== undefined) result = Math.min(options.max, result);
  return result;
}

/** Turns `hpPercentThreshold` into `Hp percent threshold` for a missing label. */
export function humaniseKey(key: string): string {
  const spaced = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_]+/g, ' ')
    .trim()
    .toLowerCase();
  return spaced.length === 0 ? key : spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
