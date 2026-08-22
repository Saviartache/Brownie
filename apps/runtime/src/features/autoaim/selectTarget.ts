/**
 * Which enemy to shoot at.
 *
 * Separate from the intercept arithmetic and from the plugin, because the two
 * questions fail differently: "which one" is a preference and can be argued
 * about, "where will it be" is a solution and is either right or absent.
 */

import type { EntityView, Position } from '@brownie/plugin-api';

export const TargetPriority = {
  /** The one that will reach you first, which is usually the one to stop. */
  Closest: 'closest',
  /** The one nearest to dying, so a kill lands rather than three wounds. */
  LowestHp: 'lowestHp',
  /**
   * The one with the most health left.
   *
   * A boss, in practice: it is the thing in the room with an order of magnitude
   * more health than its minions, and the reason to want this is that `Closest`
   * spends a whole fight shooting whatever wandered nearest instead.
   */
  HighestHp: 'highestHp',
  /**
   * The one nearest to where the player is pointing.
   *
   * **A distance to a place, not a turn from a bearing.** This was an angle
   * once, on the argument that a cursor names a direction and nothing else —
   * which was true only for as long as nobody could work out the place. The
   * module now asks the game's own camera, so the cursor is a point on the map
   * and "nearest it" is the plain reading of the words.
   *
   * Needs a reading; see {@link SelectOptions.cursorPoint}.
   */
  ClosestToCursor: 'closestToCursor',
} as const;

export type TargetPriority = (typeof TargetPriority)[keyof typeof TargetPriority];

export interface SelectOptions {
  readonly shooterX: number;
  readonly shooterY: number;
  /** Nothing beyond this is considered, whatever else recommends it. */
  readonly maxRangeTiles: number;
  readonly priority: TargetPriority;
  /**
   * Where the player is pointing, in the same tiles everything else here is
   * measured in.
   *
   * Read only by {@link TargetPriority.ClosestToCursor}, and that priority
   * picks *nothing* without it. Falling back to the closest enemy would be the
   * mode appearing to work while ranking by something nobody asked for — which
   * is exactly what the reference implementation shipped, its cursor position
   * being a variable that was declared and never written.
   */
  readonly cursorPoint?: Position | undefined;
  /**
   * How far from that point an enemy may be and still count, in tiles.
   *
   * A circle around the cursor, so a monster on the other side of the screen is
   * not "at the cursor" merely for being the least bad of what is in range.
   * Absent is no bound at all, which is a legitimate choice and needs no
   * special case.
   */
  readonly cursorRadiusTiles?: number;
  /**
   * A last word from the caller, asked only about candidates that already
   * passed everything above.
   *
   * This is where "and can it actually be hit" lives. Keeping it out here means
   * selection does not have to know what a projectile is, and the expensive
   * test runs on the few candidates worth asking about rather than on every
   * enemy on the screen.
   */
  readonly accept?: (enemy: EntityView, distanceTiles: number) => boolean;
}

/**
 * The best enemy to shoot, or `undefined` when there is not one.
 *
 * One pass, no intermediate array and no sort: this runs on every server tick
 * with every visible entity in it, and a sort would be the most expensive thing
 * the feature does — to pick one element out of it.
 */
export function selectTarget(
  enemies: Iterable<EntityView>,
  options: SelectOptions,
): EntityView | undefined {
  const maxRange = options.maxRangeTiles;
  // Both hoisted out of the loop: the score is the same expression for every
  // candidate, and deciding which one it is per enemy would be a string
  // comparison per enemy, on every tick, for a realm's worth of them.
  const byCursor = options.priority === TargetPriority.ClosestToCursor;
  const byHp =
    options.priority === TargetPriority.LowestHp || options.priority === TargetPriority.HighestHp;
  const sign = options.priority === TargetPriority.HighestHp ? -1 : 1;

  // Where the player is pointing, taken once. Without a reading there is
  // nothing this priority ranks by, so it picks nothing at all.
  let cursorX = 0;
  let cursorY = 0;
  if (byCursor) {
    if (options.cursorPoint === undefined) return undefined;
    cursorX = options.cursorPoint.x;
    cursorY = options.cursorPoint.y;
  }
  // Squared, because the comparison below is: a square root per enemy to find
  // out it is out of reach is the slow way of asking.
  const radius = options.cursorRadiusTiles ?? Number.POSITIVE_INFINITY;
  const radiusSquared = radius * radius;

  let best: EntityView | undefined;
  let bestScore = Number.POSITIVE_INFINITY;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const enemy of enemies) {
    // Dead things are still in the store until the server says they are gone,
    // and shooting one is a shot that does nothing at all.
    if (enemy.hp <= 0) continue;

    const dx = enemy.x - options.shooterX;
    const dy = enemy.y - options.shooterY;
    // Compared squared: the range test rejects most candidates, and a square
    // root per rejected enemy is the cost of finding that out the slow way.
    const squared = dx * dx + dy * dy;
    if (squared > maxRange * maxRange) continue;

    const distance = Math.sqrt(squared);
    // Lowest wins, always — which is what makes "the toughest" a negated
    // health rather than a second comparison to keep in step with this one.
    let score: number;
    if (byCursor) {
      // How far the enemy stands from the point itself. Kept squared: it is
      // only ever compared with other scores and with the radius, and both of
      // those are squared too — a square root per enemy would change the
      // ordering not at all.
      const cursorDx = enemy.x - cursorX;
      const cursorDy = enemy.y - cursorY;
      score = cursorDx * cursorDx + cursorDy * cursorDy;
      if (score > radiusSquared) continue;
    } else {
      score = byHp ? sign * enemy.hp : distance;
    }
    // Distance breaks a tie under every priority, which for enemies of equal
    // health — or two standing along the same line from the cursor — is the
    // difference between a stable choice and one that flickers every tick.
    if (score > bestScore || (score === bestScore && distance >= bestDistance)) continue;
    if (options.accept !== undefined && !options.accept(enemy, distance)) continue;

    best = enemy;
    bestScore = score;
    bestDistance = distance;
  }

  return best;
}
