/**
 * Which portals on this map can be called out.
 *
 * The callout carries an *object id*, so the set of things that can be
 * announced is the set of dungeon portals actually standing here — not the
 * game's catalog of every dungeon there is. That is the whole shape of this
 * feature, and it is why this asks the world rather than the catalog.
 *
 * Pure, and testable without a session or a live packet stream.
 */

import type { Position, WorldView } from '@brownie/plugin-api';

/** One portal on this map, as an announcement would name it. */
export interface AnnounceablePortal {
  /** What the callout carries: the object id the server will resolve. */
  readonly objectId: number;
  /** What the announcement will be about, e.g. "Puppet Master's Theatre". */
  readonly dungeonName: string;
  readonly distanceTiles: number;
}

/**
 * Every dungeon portal on this map, nearest first.
 *
 * One pass over the world's entities, which is what the state layer holds for
 * the current map. The Nexus holds a handful and this runs once a tick, so
 * nothing here needs indexing.
 *
 * Nearest first so that portals popping in the same tick are announced in the
 * order a person would have clicked them.
 *
 * A portal the catalog cannot name is skipped: the announcement is about a
 * dungeon, and one this build has never heard of is one nothing can resolve to
 * a name a player would recognise.
 */
export function announceablePortals(
  world: WorldView,
  from: Position,
  isDungeonPortal: (objectType: number) => boolean,
  dungeonName: (objectType: number) => string | undefined,
  reachTiles: number,
): readonly AnnounceablePortal[] {
  const found: AnnounceablePortal[] = [];
  for (const entity of world.entities()) {
    if (!isDungeonPortal(entity.objectType)) continue;
    const named = dungeonName(entity.objectType);
    if (named === undefined || named === '') continue;
    const distanceTiles = Math.hypot(entity.x - from.x, entity.y - from.y);
    if (distanceTiles > reachTiles) continue;
    found.push({ objectId: entity.objectId, dungeonName: named, distanceTiles });
  }
  found.sort((a, b) => a.distanceTiles - b.distanceTiles);
  return found;
}
