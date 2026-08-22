/**
 * Condition-effect bit indices, as the game numbers them.
 *
 * The full table, ported from the reference implementation's `ConditionEffect`
 * (read off the running game), even though only a few are acted on today —
 * having the whole set named is what lets the next feature that cares about a
 * debuff read it by name rather than rediscovering a bit.
 *
 * **The mask is split across two stats.** Bits 0–30 live in the first condition
 * stat (`StatType.Effects`, the one {@link SelfState} carries); bits 31+ live in
 * a second condition stat (`StatType.Effects2`) the state layer does not track
 * yet. {@link hasConditionEffect} routes by index, so a caller written now keeps
 * working once that second stat is wired — it just passes it in.
 */
export const ConditionEffect = {
  Dead: 0,
  Quiet: 1,
  Weak: 2,
  Slowed: 3,
  Sick: 4,
  Dazed: 5,
  Stunned: 6,
  Blind: 7,
  Hallucinating: 8,
  Drunk: 9,
  Confused: 10,
  StunImmune: 11,
  Invisible: 12,
  Paralyzed: 13,
  Speedy: 14,
  Bleeding: 15,
  ArmorBrokenImmune: 16,
  Healing: 17,
  Damaging: 18,
  Berserk: 19,
  Paused: 20,
  Stasis: 21,
  StasisImmune: 22,
  Invincible: 23,
  Invulnerable: 24,
  Armored: 25,
  ArmorBroken: 26,
  Hexed: 27,
  NinjaSpeedy: 28,
  Unstable: 29,
  Darkness: 30,
  // Second condition stat: bit (index - 31).
  SlowedImmune: 31,
  DazedImmune: 32,
  ParalyzeImmune: 33,
  Petrified: 34,
  PetrifiedImmune: 35,
  PetDisable: 36,
  Curse: 37,
  CurseImmune: 38,
  HpBoost: 39,
  MpBoost: 40,
  AttBoost: 41,
  DefBoost: 42,
  SpdBoost: 43,
  VitBoost: 44,
  WisBoost: 45,
  DexBoost: 46,
  Silenced: 47,
  Exposed: 48,
  Energized: 49,
  InCombat: 58,
} as const;

export type ConditionEffectName = keyof typeof ConditionEffect;
export type ConditionEffect = (typeof ConditionEffect)[ConditionEffectName];

/** The bit index past which an effect lives in the second condition stat. */
const SECOND_STAT_FIRST_BIT = 31;

/**
 * A set of condition effects, as the pair of bitmasks the stats carry.
 *
 * The pair is one value, not two loose numbers, because the halves are only
 * meaningful together and mixing them up tests the wrong effects entirely.
 */
export interface ConditionMask {
  /** Bits 0–30 — `StatType.Effects`. */
  readonly low: number;
  /** Bits 31 and up, shifted down by 31 — `StatType.Effects2`. */
  readonly high: number;
}

/** Shared, so "this applies nothing" costs no allocation. The common case. */
export const NO_CONDITIONS: ConditionMask = { low: 0, high: 0 };

/**
 * Whether a condition effect is active.
 *
 * @param effectsLow The first condition stat (`SelfView.conditions`).
 * @param effect The effect to test.
 * @param effectsHigh The second condition stat, for effects at bit 31+. Defaults
 *   to 0, so a caller that only has the first stat reads the first-stat effects
 *   correctly and never a false positive on the rest.
 */
export function hasConditionEffect(
  effectsLow: number,
  effect: ConditionEffect,
  effectsHigh = 0,
): boolean {
  if (effect < SECOND_STAT_FIRST_BIT) {
    return (effectsLow & (1 << effect)) !== 0;
  }
  return (effectsHigh & (1 << (effect - SECOND_STAT_FIRST_BIT))) !== 0;
}

/**
 * The bit one effect contributes to the first condition stat, or 0 when it
 * belongs to the second.
 *
 * These exist so a *set* of effects can be folded into a pair of masks once,
 * wherever the set is decided — at data load, or when a setting moves — and
 * then tested with a single `&`. The alternative is asking
 * {@link hasConditionEffect} once per effect on every packet that carries one,
 * which is a loop over a list that did not change.
 */
export function conditionBitLow(effect: ConditionEffect): number {
  return effect < SECOND_STAT_FIRST_BIT ? 1 << effect : 0;
}

/** The bit one effect contributes to the second condition stat, or 0. */
export function conditionBitHigh(effect: ConditionEffect): number {
  return effect < SECOND_STAT_FIRST_BIT ? 0 : 1 << (effect - SECOND_STAT_FIRST_BIT);
}
