/**
 * Where to walk to follow an ally, and which ally the cursor is on.
 *
 * Pure geometry, kept apart from the plugin so it can be tested without a
 * session or a live packet stream.
 */

import type { EntityView, Position } from '@brownie/plugin-api';

/** Tiles between two points. */
export function tilesBetween(a: Position, b: Position): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * The point to walk to so as to end up `keepDistanceTiles` short of the target,
 * or nothing when the character is already that close.
 *
 * Walking straight at the target ends the character standing on top of them,
 * which fights their movement and reads as jitter; stopping a set distance short
 * keeps station instead. The point is on the line from here to there, pulled
 * back by the gap — so the walk shortens as the ally is neared and stops on its
 * own once the gap is closed, which is what returning nothing says.
 */
export function followPoint(
  self: Position,
  target: Position,
  keepDistanceTiles: number,
): Position | undefined {
  const dx = target.x - self.x;
  const dy = target.y - self.y;
  const dist = Math.hypot(dx, dy);
  if (dist <= keepDistanceTiles) return undefined;
  const fraction = (dist - keepDistanceTiles) / dist;
  return { x: self.x + dx * fraction, y: self.y + dy * fraction };
}

/**
 * The player nearest a point and no further from it than `withinTiles` — the
 * one the cursor is on — or nothing when none is that close.
 *
 * `excludeId` is the local player: a follow selection is another player, and
 * the cursor is often nearest our own character.
 *
 * The reach is what lets a click on empty ground mean *nobody* instead of
 * whoever is nearest, so the caller can read that answer as a cancel.
 */
export function nearestPlayerTo(
  players: Iterable<EntityView>,
  point: Position,
  excludeId: number,
  withinTiles: number,
): EntityView | undefined {
  let best: EntityView | undefined;
  let bestDist = Infinity;
  for (const player of players) {
    if (player.objectId === excludeId) continue;
    const dist = tilesBetween(player, point);
    if (dist > withinTiles || dist >= bestDist) continue;
    bestDist = dist;
    best = player;
  }
  return best;
}
