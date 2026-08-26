/**
 * Which portal the player is standing on.
 *
 * Every kind of portal, not only the ones a key pops: `/enter` is asked of a
 * realm portal at least as often as of a dungeon one, so the catalog question
 * behind this is `<Class>Portal</Class>` rather than `<DungeonPortal/>`.
 *
 * Pure, and testable without a session or a live packet stream.
 */

import type { EntityView, Position, WorldView } from '@brownie/plugin-api';

export type PortalLookup = (objectType: number) => boolean;

/**
 * The nearest portal within reach, or `undefined` when there is none.
 *
 * One pass over the world's entities, which is what the state layer holds for
 * the current map and is small enough that a command running once per keypress
 * need not index anything.
 */
export function portalUnder(
  world: WorldView,
  at: Position,
  isPortal: PortalLookup,
  reachTiles: number,
): EntityView | undefined {
  let nearest: EntityView | undefined;
  let nearestTiles = reachTiles;
  for (const entity of world.entities()) {
    if (!isPortal(entity.objectType)) continue;
    const distanceTiles = Math.hypot(entity.x - at.x, entity.y - at.y);
    if (distanceTiles > nearestTiles) continue;
    nearest = entity;
    nearestTiles = distanceTiles;
  }
  return nearest;
}
