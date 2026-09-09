/**
 * Which enemy the cursor is on.
 *
 * **A pick is a click on something, not a search of the map.** What the player
 * points at is a body on the screen, so the reach is measured to the *body*
 * rather than to a centre, and clicking the floor beside a monster takes nobody
 * — which is what lets an empty click read as letting go.
 *
 * Where to stand once one is picked is not here and is deliberately not a place:
 * it is a distance, handed to the planner as a ring so that going round the
 * monster stays free and only backing off is charged. See
 * `DodgeSituation.orbit`.
 *
 * Pure geometry, kept apart from the plugin so it can be tested without a
 * session or a live packet stream. See `dodgePlugin` for what feeds it.
 */

import type { EntityView, Position } from '@brownie/plugin-api';

/**
 * How far past the edge of a body a click still counts as being on it, in tiles.
 *
 * A pick is a click *on* something, not a search of the map, so the margin is
 * about the hand rather than about the monster: a tile is roughly a character
 * wide, and half of one is the slop a person leaves when they click a thing they
 * are looking straight at. Clicking the floor beside a monster takes nobody,
 * which is what lets an empty click read as a cancel.
 */
export const PICK_MARGIN_TILES = 0.5;

/** What separates an enemy worth picking from the rest of the room. */
export interface EnemyPickRules {
  /**
   * Half the width of one, in tiles.
   *
   * **Because a boss is not a point.** Clicking the near edge of something four
   * tiles across puts the cursor two tiles from its centre, which no fixed
   * radius measured to a centre can accept without also grabbing minions across
   * the room from it.
   */
  readonly halfTiles: (enemy: EntityView) => number;
  /** Whether fighting this one is a thing a person could mean. */
  readonly worthFighting: (enemy: EntityView) => boolean;
}

/**
 * The enemy the cursor is on, or nothing when it is on none of them.
 *
 * **Ranked by the gap to the body rather than the distance to the centre**, so a
 * click inside a boss takes the boss even when a minion's centre happens to be
 * nearer the cursor. Both are measured the same way, which is what makes the
 * comparison mean anything.
 */
export function enemyUnderCursor(
  enemies: Iterable<EntityView>,
  point: Position,
  rules: EnemyPickRules,
): EntityView | undefined {
  let best: EntityView | undefined;
  let bestGap = Infinity;
  for (const enemy of enemies) {
    if (!rules.worthFighting(enemy)) continue;
    const gap = Math.hypot(enemy.x - point.x, enemy.y - point.y) - rules.halfTiles(enemy);
    if (gap > PICK_MARGIN_TILES || gap >= bestGap) continue;
    bestGap = gap;
    best = enemy;
  }
  return best;
}
