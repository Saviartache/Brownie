/**
 * How much of a hit's raw damage actually lands.
 *
 * The game's own arithmetic, ported from the reference implementation's
 * `calcDamage` (itself a port of the client's damage path): defence is
 * subtracted, some condition effects rewrite it, and a floor keeps every hit
 * doing at least a fixed share of its raw amount so that no amount of armour
 * makes a character unkillable. Getting this right is the whole point — it is
 * the number auto-nexus compares against tracked health, and an estimate that
 * is too low stands in a lethal hit.
 *
 * **Only the condition effects the runtime can actually read are applied.** The
 * four below live in the first condition stat (`StatType.Effects`), which is the
 * one {@link SelfState} tracks. Petrify, curse and exposed live in a second
 * condition stat the state layer does not carry yet, so they are deliberately
 * not modelled — invariant 5: a feature acts on what is verified and available,
 * not on a value it cannot see. Their absence rounds the estimate the safe way
 * for armour-broken-style effects (which only ever raise damage) and leaves the
 * two small multipliers (petrify ×0.9, curse ×1.25) unapplied.
 */

import { ConditionEffect, hasConditionEffect } from '../../constants/ConditionEffect.js';
import { ARMORED_DEFENSE_MULTIPLIER, MIN_DAMAGE_MULTIPLIER } from './constants.js';

export interface DamageInputs {
  readonly defense: number;
  /** The first condition-stat bitmask, as `SelfView.conditions` reports it. */
  readonly conditions: number;
  /** True when the shot ignores defence — armour-piercing, or an unknown shot. */
  readonly piercing: boolean;
}

/**
 * The health a single hit removes, after defence, conditions and the floor.
 *
 * @param rawDamage The shot's declared damage. Non-positive means no threat.
 */
export function damageTaken(rawDamage: number, inputs: DamageInputs): number {
  if (rawDamage <= 0) return 0;

  const { conditions } = inputs;
  if (
    hasConditionEffect(conditions, ConditionEffect.Invulnerable) ||
    hasConditionEffect(conditions, ConditionEffect.Invincible)
  ) {
    return 0;
  }

  let defense: number;
  if (inputs.piercing || hasConditionEffect(conditions, ConditionEffect.ArmorBroken)) {
    defense = 0;
  } else if (hasConditionEffect(conditions, ConditionEffect.Armored)) {
    defense = Math.floor(inputs.defense * ARMORED_DEFENSE_MULTIPLIER);
  } else {
    defense = inputs.defense;
  }
  defense = Math.max(defense, 0);

  const floor = rawDamage * MIN_DAMAGE_MULTIPLIER;
  const reduced = rawDamage - defense;
  return Math.floor(reduced > floor ? reduced : floor);
}
