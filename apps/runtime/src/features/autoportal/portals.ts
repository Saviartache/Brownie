/**
 * Which opened dungeon portals are in reach, nearest first.
 *
 * A dungeon portal only exists in the Nexus once somebody has popped a key for
 * it — the Nexus carries none of its own — so a dungeon portal *being here at
 * all* is the whole of "someone opened one". The chooser narrows that to the
 * ones the player asked for; this narrows it to those and sorts by distance.
 *
 * Pure, and testable without a session or a live packet stream.
 */

import type { EntityView, Position, WorldView } from '@brownie/plugin-api';

export type DungeonPortalLookup = (objectType: number) => boolean;

/** A portal in the world the player has chosen to enter. */
export interface PortalTarget {
  readonly entity: EntityView;
  readonly distanceTiles: number;
}

/**
 * Every chosen dungeon portal in the world, nearest first.
 *
 * One pass over the world's entities. The Nexus holds only a handful, so the
 * cost is trivial and the sort keeps "walk to the closest" honest when two are
 * open at once.
 */
export function findChosenPortals(
  world: WorldView,
  from: Position,
  isDungeonPortal: DungeonPortalLookup,
  chosenTypes: ReadonlySet<number>,
): PortalTarget[] {
  if (chosenTypes.size === 0) return [];

  const found: PortalTarget[] = [];
  for (const entity of world.entities()) {
    if (!isDungeonPortal(entity.objectType)) continue;
    if (!chosenTypes.has(entity.objectType)) continue;
    const distanceTiles = Math.hypot(entity.x - from.x, entity.y - from.y);
    found.push({ entity, distanceTiles });
  }
  found.sort((a, b) => a.distanceTiles - b.distanceTiles);
  return found;
}

/** Whether the player is close enough to step onto the portal. */
export function withinReach(target: PortalTarget, radiusTiles: number): boolean {
  return target.distanceTiles <= radiusTiles;
}

/** The map that is the Nexus, matched the way the safe-zone check matches it. */
export function isNexus(mapName: string): boolean {
  return mapName.trim().toLowerCase() === 'nexus';
}
