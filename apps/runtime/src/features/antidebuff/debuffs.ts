/**
 * Which condition effects the feature offers a switch for.
 *
 * A table rather than six near-identical blocks of registration code: the
 * settings, the labels the overlay draws and the mask the handler tests all
 * come from this one list, so an effect is added in a line instead of three
 * edits that have to agree with each other.
 */

import {
  ConditionEffect,
  conditionBitHigh,
  conditionBitLow,
  type ConditionMask,
} from '../../constants/ConditionEffect.js';

/** One switch, and the effect it acts on. */
export interface DebuffOption {
  /**
   * The key its value persists under.
   *
   * Stable: renaming one silently loses whatever the user had set.
   */
  readonly key: string;
  /** What the overlay calls the effect. */
  readonly label: string;
  readonly effect: ConditionEffect;
}

/**
 * Effects that are only ever a nuisance on screen.
 *
 * Nothing about these reaches the server: the bits are cleared out of the
 * player's own stats on the way to the game client, so the client stops drawing
 * them. The server still believes the effect is on, and it still expires on the
 * server's own schedule — which is what makes them safe to have on by default,
 * and why nothing that changes the *outcome* of a fight belongs in this list.
 */
export const SCREEN_EFFECTS: readonly DebuffOption[] = [
  { key: 'ignoreBlind', label: 'Blind', effect: ConditionEffect.Blind },
  { key: 'ignoreHallucinating', label: 'Hallucinating', effect: ConditionEffect.Hallucinating },
  { key: 'ignoreDrunk', label: 'Drunk', effect: ConditionEffect.Drunk },
  { key: 'ignoreConfused', label: 'Confused', effect: ConditionEffect.Confused },
  { key: 'ignoreUnstable', label: 'Unstable', effect: ConditionEffect.Unstable },
  { key: 'ignoreDarkness', label: 'Darkness', effect: ConditionEffect.Darkness },
];

/** Folds options into the pair of masks their effects occupy. */
export function maskOf(options: Iterable<DebuffOption>): ConditionMask {
  let low = 0;
  let high = 0;
  for (const { effect } of options) {
    low |= conditionBitLow(effect);
    high |= conditionBitHigh(effect);
  }
  return { low, high };
}
