/**
 * Where to walk to follow an ally, and which ally the cursor is on.
 *
 * Pure geometry, kept apart from the plugin so it can be tested without a
 * session or a live packet stream.
 */

import type { EntityView, Position } from '@brownie/plugin-api';
import { PLAYER_ENVIRONMENT_HALF_TILES } from '../dodge/hitbox.js';

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

/**
 * How far apart the places along a line are asked about, in tiles.
 *
 * The body's own half-width, so consecutive samples overlap and there is no gap
 * between two of them for a wall to hide in. The dodge samples its steps at
 * exactly this spacing and for exactly this reason — see `dodge/DodgeGround`.
 */
const SAMPLE_TILES = PLAYER_ENVIRONMENT_HALF_TILES;

/**
 * Whether the character could walk the straight line between two places.
 *
 * **This is the question the old follow never asked.** It aimed at where the
 * ally stood and left the walking to the native mover, which walks a heading
 * and tests nothing on the way: an ally around a corner was a character held
 * against the corner for as long as they stayed there. Asking turns a heading
 * into a route — and, used against a remembered trail, turns a route the ally
 * proved walkable into one the follow can take.
 *
 * Both ends are tested along with everything between, because the far end is
 * usually the place being proposed as a walk target and the near end is where a
 * character already wedged into scenery stands.
 *
 * @param canStand Whether the player's whole body fits at a point. Expected to
 *   be cached per tile by the caller — this asks a hundred times for a line
 *   across the screen, and the lines it is asked about overlap heavily.
 */
export function clearLineBetween(
  from: Position,
  to: Position,
  canStand: (x: number, y: number) => boolean,
): boolean {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  if (!(distance > 0)) return canStand(to.x, to.y);

  const steps = Math.max(1, Math.ceil(distance / SAMPLE_TILES));
  for (let i = 0; i <= steps; i += 1) {
    const at = i / steps;
    if (!canStand(from.x + dx * at, from.y + dy * at)) return false;
  }
  return true;
}
