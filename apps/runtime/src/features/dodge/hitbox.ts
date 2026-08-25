/**
 * What counts as being hit, and how close a near miss was.
 *
 * **Realm projectile collision is an axis-aligned square, not a circle.** The
 * game's own test (`FUN_18015be50` in the dumped client) is
 * `|dx| < r && |dy| < r` — Chebyshev distance. A circle is not a rounder
 * approximation of that; it is a different shape, and it disagrees exactly at
 * the corners, which is where a shot grazes. A planner built on a circle dodges
 * shots that would have missed and stands in shots that will land.
 *
 * These constants come from the reference implementation's `DodgeHit.h`, which
 * took them from the client. They are the one part of four dodge generations
 * worth carrying over unchanged.
 *
 * **Distance, not a boolean, is what the planner actually needs.** "Was I hit"
 * answers one question; "how much room did I have" answers the one that decides
 * between two escapes, and it is what lets a dodge prefer the wide gap over the
 * needle. {@link minChebyshevOnSegment} is where that number comes from.
 */

/**
 * The player's collision half-extent against *shots*, in tiles.
 *
 * Deliberately distinct from {@link PLAYER_ENVIRONMENT_HALF_TILES} — the two
 * tests are different tests, and using one for the other is wrong in both
 * directions.
 */
export const PLAYER_HALF_TILES = 0.2139;

/**
 * The player's collision half-extent against the *map*, in tiles.
 *
 * What the client measures a body by when it asks whether it fits: the ground
 * under it, and any object that owns its square. Bigger than the projectile
 * half above, and the difference is not cosmetic — a plan that sizes the body
 * by the smaller one walks to places the game refuses to put the character, the
 * server puts them back, and the player reads that as being stuck in the wall.
 *
 * The reference implementation's `kPlayerChebyshevScale`, taken there from the
 * client's own collision routine.
 */
export const PLAYER_ENVIRONMENT_HALF_TILES = 0.2285;

/**
 * The collision multiplier of a shot whose data does not state one.
 *
 * `<CollisionMult>` appears on a few hundred of the game's projectiles and is
 * absent from the rest, which means one. Halved, it is the 0.5 the reference
 * fell back to for every shot alike.
 */
export const DEFAULT_COLLISION_MULTIPLIER = 1;

/**
 * The half-extent to assume for a shot whose real one is unknown.
 *
 * The standard case — collision multiplier 1.0 — and what the reference falls
 * back to when the runtime value is unavailable.
 */
export const DEFAULT_PROJECTILE_HALF_TILES = 0.5;

/**
 * A shot's own collision half-extent, from the multiplier its data declares.
 *
 * The game builds a projectile's collision square as `collisionMult × 0.5`
 * tiles — the reference implementation's `ProjectileRuntimeReader` reads exactly
 * that off the live properties when the richer fields are unavailable. The
 * multiplier is in `objects.xml`, so a proxy can compute the same number without
 * being inside the process, which is why nothing here needs the native module.
 *
 * Nonsense is refused rather than propagated: a multiplier that did not parse
 * would otherwise become a shot with no hitbox, and a dodge that sees no danger.
 */
export function projectileHalfTiles(collisionMultiplier: number): number {
  if (!Number.isFinite(collisionMultiplier) || collisionMultiplier <= 0) {
    return DEFAULT_PROJECTILE_HALF_TILES;
  }
  return (collisionMultiplier * DEFAULT_PROJECTILE_HALF_TILES) / DEFAULT_COLLISION_MULTIPLIER;
}

/**
 * The half-side of the square to test a player position against.
 *
 * Folds three things into one number, which is how the game does it: the
 * projectile's own extent, the player's, and a pad.
 *
 * @param padTiles Margin for everything the model does not know — see
 *   `ShotTracks`' drift term, which is where most of it now lives. It has no
 *   default on purpose.
 */
export function effectiveHalf(
  projectileHalfTiles: number,
  hitScale: number,
  padTiles: number,
): number {
  return projectileHalfTiles * hitScale + PLAYER_HALF_TILES + padTiles;
}

/** Whether a player at `player` overlaps a shot centred at `bullet`. */
export function overlaps(
  bulletX: number,
  bulletY: number,
  playerX: number,
  playerY: number,
  half: number,
): boolean {
  return Math.abs(bulletX - playerX) < half && Math.abs(bulletY - playerY) < half;
}

/**
 * The closest a segment comes to the origin, measured the way the game measures.
 *
 * **This is what replaces stepping.** Between two prediction samples both the
 * shot and a walking player move in a straight line, so their *difference* moves
 * in a straight line too — and the whole question "how close do they come, and
 * when" is the minimum of `max(|x|, |y|)` along one segment. Sampling that
 * function instead is what lets a fast shot cross a player between two steps and
 * be reported as a miss; the reference implementation's grid generations all had
 * that hole and papered over it with a finer step and a fatter hitbox.
 *
 * `max(|x|, |y|)` is convex, and stays convex composed with the segment's affine
 * parameter, so its minimum is at an endpoint or at one of the four places where
 * a piece changes: `x = 0`, `y = 0`, `x = y`, `x = -y`. Checking those is exact,
 * not approximate, and costs four divisions.
 *
 * Ported from the reference's `MinChebOnSegment`, which is the one piece of
 * `PJDodgeTypes.h` that is pure mathematics.
 */
export function minChebyshevOnSegment(x0: number, y0: number, x1: number, y1: number): number {
  let best = Math.min(Math.max(Math.abs(x0), Math.abs(y0)), Math.max(Math.abs(x1), Math.abs(y1)));
  const dx = x1 - x0;
  const dy = y1 - y0;

  const consider = (t: number): void => {
    if (!(t > 0) || !(t < 1)) return;
    const x = x0 + dx * t;
    const y = y0 + dy * t;
    const here = Math.max(Math.abs(x), Math.abs(y));
    if (here < best) best = here;
  };

  if (dx !== 0) consider(-x0 / dx);
  if (dy !== 0) consider(-y0 / dy);
  if (dx !== dy) consider((y0 - x0) / (dx - dy));
  if (dx !== -dy) consider((-y0 - x0) / (dx + dy));
  return best;
}
