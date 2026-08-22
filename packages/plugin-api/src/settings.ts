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

/** Shared by every setting kind. */
export interface SettingCommon {
  /** Shown next to the control. Defaults to a humanised key. */
  readonly label?: string;
  /** Section heading the overlay files this setting under. */
  readonly group?: string;
  /** Hidden behind the overlay's "advanced" toggle. */
  readonly advanced?: boolean;
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
  select<T extends string>(key: string, options: SelectSettingOptions<T>): SettingHandle<T>;
  text(key: string, options: TextSettingOptions): SettingHandle<string>;
  /** A control with no value: pressing it calls `onPress`. */
  button(key: string, options: ButtonOptions): void;
}

/** The declared shape of one setting, as the overlay and config store see it. */
export type SettingDescriptor =
  | ({ readonly kind: 'boolean'; readonly key: string } & BooleanSettingOptions)
  | ({ readonly kind: 'number' | 'range'; readonly key: string } & NumberSettingOptions)
  | ({ readonly kind: 'select'; readonly key: string } & SelectSettingOptions<string>)
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
