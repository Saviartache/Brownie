/**
 * The key bound to one of a plugin's switches.
 *
 * *Which* switch is the slot, and that is the plugin's own declaration — see
 * `bindTargets` in `@brownie/plugin-api`. What is here is the other half: the
 * key and the way it acts.
 *
 * A bind is one value, not two, and that is the point of this file. The mode
 * and the key are a single choice — "this key, acting this way" — and holding
 * them apart would be two stored values that can disagree: a mode set on a
 * plugin nothing is bound to, or a key whose mode was written by a build that
 * no longer runs.
 *
 * **The runtime owns the mode and knows nothing about the key.** Which switch a
 * press moves, and whether a press flips it or holds it, is the host's business
 * — it owns the switch. What a key *is* belongs to the injected module: it is
 * the only side that can watch a keyboard, the only side that can name a key
 * the player just pressed, and the only side that has to survive the player
 * changing their keyboard layout. So the key travels as opaque text that this
 * checks the shape of and never interprets. See `docs/ipc.md`.
 */

/** How a bound key drives the switch. */
export const BindMode = {
  /** A press flips the switch and it stays where it was put. */
  Toggle: 'toggle',
  /** The switch is on while the key is down, and goes back on the way up. */
  Hold: 'hold',
} as const;

export type BindMode = (typeof BindMode)[keyof typeof BindMode];

export interface PluginBind {
  readonly mode: BindMode;
  /**
   * The chord, as the module spells it — `F5`, `Ctrl+Shift+A`, `Mouse5`.
   * Empty means nothing is bound.
   */
  readonly key: string;
}

/** Nothing bound, in the mode a bind starts in. */
export const NO_BIND: PluginBind = { mode: BindMode.Toggle, key: '' };

/**
 * What a key may be spelled with.
 *
 * Deliberately narrow: the runtime does not know what any of these names mean,
 * so the only defence it can offer is refusing text that cannot be one. A
 * chord is `+`-joined alphanumeric words and nothing else — no separators the
 * record format frames on, no whitespace, nothing that could be an escape.
 */
const KEY_PATTERN = /^[A-Za-z0-9]+(?:\+[A-Za-z0-9]+)*$/;

/** Longer than any chord the module can name, shorter than anything worth storing. */
const MAX_KEY_LENGTH = 48;

/**
 * Reads a stored or transmitted bind, or refuses it.
 *
 * The empty string is a real value — no bind, in the default mode — and the one
 * spelling accepted that is not `mode:key`. Everything else must be canonical:
 * the only writers are this runtime and its own overlay, so a value that is not
 * one of theirs is config somebody hand-edited or a build that disagreed, and
 * guessing at it would bind a key nobody chose.
 */
export function parseBind(raw: string): PluginBind | undefined {
  if (raw === '') return NO_BIND;

  const separator = raw.indexOf(':');
  if (separator < 0) return undefined;

  const mode = raw.slice(0, separator);
  if (mode !== BindMode.Toggle && mode !== BindMode.Hold) return undefined;

  const key = raw.slice(separator + 1);
  // An empty key with a mode is how a bind keeps the mode the user chose while
  // they have nothing bound — clearing a key must not silently undo it too.
  if (key !== '' && (key.length > MAX_KEY_LENGTH || !KEY_PATTERN.test(key))) return undefined;

  return { mode, key };
}

/** The one spelling of a bind, so the same bind never reads as a change. */
export function formatBind(bind: PluginBind): string {
  if (bind.mode === BindMode.Toggle && bind.key === '') return '';
  return `${bind.mode}:${bind.key}`;
}

/**
 * The canonical spelling of a bind that arrived from outside, or nothing when
 * the text is not one.
 *
 * Refusing rather than falling back, for the reason a colour setting refuses:
 * what the plugin already has is a bind, and keeping it beats inventing one.
 */
export function normaliseBind(raw: string): string | undefined {
  const parsed = parseBind(raw);
  return parsed === undefined ? undefined : formatBind(parsed);
}
