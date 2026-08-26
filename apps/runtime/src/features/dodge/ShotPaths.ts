/**
 * Where every shot in flight is going, for somebody to draw.
 *
 * **A panel cannot answer "why did it dodge that way".** The planner's whole
 * input is a set of curves through the next second, and the only way to see
 * whether it is predicting the right ones is to put them on the map beside the
 * shots they claim to describe. A shot whose drawn path runs where the shot
 * actually goes says the model is right; one that veers off says it is not, and
 * says it in the half second it takes to look — which no amount of numbers in a
 * table does.
 *
 * **From where it is now to where it dies, and no further back.** The part
 * already travelled is not information: it is where the shot has been, which is
 * visible on the screen as the shot itself. Sending only what is left means the
 * drawn line shortens from behind as the shot advances, which is the erasure
 * without anything having to erase it.
 *
 * **Not the planner's own samples, deliberately.** Those are culled to what
 * could reach the player and clipped to the planning horizon, which is exactly
 * right for planning and misleading to look at — a shot dropped for being
 * irrelevant would vanish from the picture and read as a shot the runtime cannot
 * see. This describes what is in flight, all of it.
 */

import type { ProjectileView } from '@brownie/plugin-api';

/** One shot's remaining path. Rebuilt each time; never held across publishes. */
export interface ShotPath {
  /**
   * How much of the shot's life is left, in thousandths.
   *
   * A thousand the moment it is fired, nought as it expires. Carried rather than
   * derived from the point count so that a drawing of it can colour the line by
   * age without knowing anything about how it was sampled.
   */
  readonly lifePermille: number;
  /** Flat `x, y` pairs in tiles, the first being where the shot is now. */
  readonly points: readonly number[];
  /**
   * Half the side of this shot's own collision square, in tiles.
   *
   * **A line says where a shot goes and nothing about what it takes with it**,
   * and the two are different questions: the game's widest shots are ten times
   * the standard multiplier, so a picture drawn as hairlines says a boss's wall
   * of fire and a rat's pellet are the same thing. Nought for the ones the game
   * gives no collision at all — the warning telegraphs — which is worth seeing
   * as much as the rest, because it is why the planner ignores them.
   */
  readonly halfTiles: number;
  /**
   * How fast it is travelling right now, in tiles a second.
   *
   * **Because a set goes out twenty times a second and a shot crosses a tile in
   * less than that.** Drawn where it was last stated, the head of a fast shot
   * steps a third of a tile at a time while the shot itself moves smoothly —
   * and a hitbox that stutters is one nobody can check against the game's own.
   * The same reason a monster's circle carries one; see `DodgeMarks`.
   */
  readonly velocityX: number;
  readonly velocityY: number;
}

/**
 * The most points kept per shot.
 *
 * A path is a smooth curve at worst, and a dozen points across it is past what
 * anybody can distinguish at the zoom this is drawn at. It is also the bound on
 * what a busy screen costs to send: everything here crosses a pipe.
 */
export const MAX_PATH_POINTS = 12;

/** Shots with less life left than this are not worth a line of their own. */
const MIN_PATH_MS = 40;

/**
 * Builds the paths of everything in flight.
 *
 * @param gameTimeMs The clock `positionAt` is relative to.
 * @param limit The most shots to describe. A screen full of them is already
 *   unreadable, and the cap is what keeps a bullet-hell from turning a debug
 *   view into the most expensive thing in the process.
 */
export function shotPaths(
  gameTimeMs: number,
  shots: Iterable<ProjectileView>,
  limit: number,
): ShotPath[] {
  const paths: ShotPath[] = [];

  for (const shot of shots) {
    if (paths.length >= limit) break;

    const life = shot.expiresAtMs - shot.firedAtMs;
    const left = shot.expiresAtMs - gameTimeMs;
    if (!(life > 0) || left < MIN_PATH_MS) continue;

    // Evenly across what is left, so a shot near the end of its life is drawn
    // as a short line rather than a dozen points on top of each other.
    const steps = Math.min(MAX_PATH_POINTS, Math.max(2, Math.ceil(left / 60)));
    const spanMs = left / (steps - 1);
    const points: number[] = [];
    for (let i = 0; i < steps; i += 1) {
      const at = gameTimeMs + spanMs * i;
      const position = shot.positionAt(at);
      // The last sample lands exactly on expiry, where the shot no longer
      // exists. Stopping is right: the line should end where the shot does.
      if (position === undefined) break;
      points.push(position.x, position.y);
    }
    if (points.length < 4) continue;

    paths.push({
      lifePermille: Math.max(0, Math.min(1000, Math.round((left / life) * 1000))),
      points,
      halfTiles: shot.collisionHalfTiles,
      // The first sampled step, which is the one the drawing carries the head
      // along — not the shot's stated speed, because a curving or decelerating
      // one is going somewhere its speed alone does not describe.
      velocityX: ((points[2] ?? 0) - (points[0] ?? 0)) * (1000 / spanMs),
      velocityY: ((points[3] ?? 0) - (points[1] ?? 0)) * (1000 / spanMs),
    });
  }

  return paths;
}
