/**
 * Whether a place is close enough to ground that hurts to be worth refusing.
 *
 * **A tile is not a point, and neither is a player.** The planner probed the
 * ground by asking about the single point at the middle of the character, so a
 * course that put three quarters of the body over lava and the centre a hair
 * outside it read as perfectly safe — and then the first thing that moved the
 * character, a server correction, a rounding, the next step, put them in it.
 * The complaint was the plain one: it dodges *into* the lava.
 *
 * So the question is asked about the body, and about a margin around the body.
 * Damaging ground is the one hazard on the map that is worth standing well clear
 * of rather than merely outside: a wall costs a step, a shot costs a graze, and
 * a lava tile costs health every tick you are in it with nothing to dodge.
 *
 * **Unknown ground is not damaging.** The server sends tiles around the player
 * and no further, and refusing what has not been described is already
 * `canStandAt`'s job — a course is stopped at the edge of the known map whatever
 * this says, so answering "dangerous" here would only make the planner treat the
 * edge of its knowledge as a fire.
 */

import type { TileView } from '@brownie/plugin-api';
import { PLAYER_HALF_TILES } from './hitbox.js';

/** The part of the world this needs: one tile at a time. */
export interface TileSource {
  tileAt(x: number, y: number): TileView | undefined;
}

/**
 * Whether the body, widened by `clearanceTiles`, covers any damaging tile.
 *
 * Every tile the box touches is asked about rather than its four corners: the
 * corners are enough only while the box is under two tiles across, which is true
 * of every margin the overlay offers and would stop being true the moment
 * somebody raised the limit. A whole-box sweep is two nested loops over at most
 * three by three and cannot be wrong.
 */
export function overDamagingGround(
  tiles: TileSource,
  x: number,
  y: number,
  clearanceTiles: number,
): boolean {
  const half = PLAYER_HALF_TILES + Math.max(0, clearanceTiles);
  const fromX = Math.floor(x - half);
  const toX = Math.floor(x + half);
  const fromY = Math.floor(y - half);
  const toY = Math.floor(y + half);

  for (let tileX = fromX; tileX <= toX; tileX += 1) {
    for (let tileY = fromY; tileY <= toY; tileY += 1) {
      if (tiles.tileAt(tileX, tileY)?.damaging === true) return true;
    }
  }
  return false;
}
