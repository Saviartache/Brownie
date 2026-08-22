/**
 * Which enemies a shot can do anything to.
 *
 * Separate from both the ranking and the arithmetic, because it is a third kind
 * of question: "which one" is a preference, "where will it be" is a solution,
 * and this is a fact about the enemy that makes aiming at it pointless whatever
 * the other two say.
 *
 * **Most of these were learned from the reference implementation the hard
 * way.** Aim that ignored them spent boss phases pouring every shot into an
 * invulnerable body, and spent dungeons shooting the decorative wall two tiles
 * away instead of the thing killing you — because a wall in this game is an
 * object with hit points, and to anything ranking by distance it is simply the
 * closest enemy.
 */

import type { EntityView } from '@brownie/plugin-api';
import { ConditionEffect, conditionBitLow } from '../../constants/ConditionEffect.js';

/**
 * The effects under which an enemy takes no damage at all.
 *
 * Folded into one mask at load rather than tested one effect at a time per
 * enemy per tick. All three live in the first condition stat, which is the one
 * an {@link EntityView} carries — an effect from the second would silently test
 * the wrong bit, so adding one here means carrying the second stat too.
 */
const UNTOUCHABLE =
  conditionBitLow(ConditionEffect.Invulnerable) |
  conditionBitLow(ConditionEffect.Invincible) |
  conditionBitLow(ConditionEffect.Stasis);

export interface ShootableRules {
  /**
   * Skip enemies that cannot be hurt right now.
   *
   * A setting rather than a rule, because the two are not the same claim: a
   * boss that is invulnerable *this phase* is still the thing to keep aiming
   * at if the next shot lands after it drops, and somebody fighting one may
   * want exactly that.
   */
  readonly skipUntouchable: boolean;
  /** Skip enemies that are scenery — a wall with hit points is still a wall. */
  readonly skipObstacles: boolean;
  /**
   * Whether a type stands in the way, from the game's own object data.
   *
   * `OccupySquare` and `FullOccupy` in `objects.xml` are how a wall is marked,
   * and nothing on the wire says so — which is why this is asked of the caller
   * rather than derived from the entity.
   */
  readonly isObstacle: (objectType: number) => boolean;
  /**
   * Whether a type can never be damaged, from the game's own object data.
   *
   * **Not a setting, unlike {@link skipUntouchable}, because it is not the same
   * claim.** An invulnerable boss phase ends and the shot in flight lands after
   * it; `<Invincible />` is what the object *is* — a spawn anchor, an emitter,
   * a room controller, the thing a fight uses to place monsters. It has health,
   * it is marked `<Enemy />`, and it will never lose a hit point, so there is
   * no setting under which aiming at one is what the player wanted.
   *
   * Asked of the caller for the same reason as {@link isObstacle}: it is in
   * `objects.xml`, nothing on the wire says it, and a plugin is not given the
   * object catalog.
   */
  readonly isInvincible: (objectType: number) => boolean;
}

/** Whether shooting at this one could accomplish anything. */
export function isShootable(enemy: EntityView, rules: ShootableRules): boolean {
  if (rules.isInvincible(enemy.objectType)) return false;
  // No health bar, nothing to empty. The server states an enemy's maximum
  // health alongside its current health, so a positive current health with no
  // maximum behind it is not a monster at half strength — it is something the
  // server never described as having health to lose.
  if (enemy.maxHp <= 0) return false;
  if (rules.skipUntouchable && (enemy.conditions & UNTOUCHABLE) !== 0) return false;
  if (rules.skipObstacles && rules.isObstacle(enemy.objectType)) return false;
  return true;
}
