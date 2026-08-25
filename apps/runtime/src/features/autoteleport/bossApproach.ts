/**
 * Who is at the boss, and how far off we are — the two questions auto-teleport
 * asks each tick.
 *
 * A boss in this game carries no "boss" flag on the wire; what marks one is
 * `<Quest/>` in `objects.xml`, the same arrow the game draws over it, read
 * through the catalog the composition root hands over. An approacher is any
 * *other* player standing close to that boss — there is no party roster to draw
 * from, so proximity is the whole of "a teammate is in the fight".
 *
 * Pure, and testable without a session or a live packet stream.
 */

import type { EntityView, Position } from '@brownie/plugin-api';

/** Whether an object type is a quest boss, as `objects.xml` marks it. */
export type BossLookup = (objectType: number) => boolean;

/** Tiles between two points. */
export function tilesBetween(a: Position, b: Position): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * The nearest quest boss to a point, or nothing when the map holds none.
 *
 * Nearest rather than first so a dungeon with more than one — a room of
 * minibosses — is measured against the one actually in front of the character.
 */
export function nearestBoss(
  enemies: Iterable<EntityView>,
  isBoss: BossLookup,
  from: Position,
): EntityView | undefined {
  let best: EntityView | undefined;
  let bestDist = Infinity;
  for (const enemy of enemies) {
    if (!isBoss(enemy.objectType)) continue;
    const dist = tilesBetween(enemy, from);
    if (dist < bestDist) {
      bestDist = dist;
      best = enemy;
    }
  }
  return best;
}

/**
 * The nearest other player standing within reach of the boss, or nothing.
 *
 * `excludeId` is the local player: our own approach is not a teammate arriving,
 * and teleporting to ourselves is not a thing the game does.
 */
export function nearestApproacher(
  players: Iterable<EntityView>,
  boss: Position,
  excludeId: number,
  approachTiles: number,
): EntityView | undefined {
  let best: EntityView | undefined;
  let bestDist = Infinity;
  for (const player of players) {
    if (player.objectId === excludeId) continue;
    const dist = tilesBetween(player, boss);
    if (dist <= approachTiles && dist < bestDist) {
      bestDist = dist;
      best = player;
    }
  }
  return best;
}
