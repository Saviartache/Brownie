/**
 * What the planner needs of the world it is planning in.
 *
 * **Four questions, and the planner knows nothing else about the map.** Whether
 * a body fits here, how far this place is from ground that hurts, how much room
 * to dodge in it leaves, and whether something is standing *in* it. Everything
 * else — the object catalog, the clearance margins, the motion tracker that
 * turns five sightings a second into a velocity — is the business of whoever
 * answers them. See `DodgeScene`.
 *
 * Its own file because both the optimizer and the scene depend on it and neither
 * should depend on the other: the shape of the question belongs to neither the
 * thing that asks it nor the thing that answers it.
 *
 * The two rules that turn those questions into refusals live here as well, for
 * the same reason: what "this step does not fit" means is a property of the
 * question rather than of whoever happens to be asking it.
 */

import { PLAYER_ENVIRONMENT_HALF_TILES } from './hitbox.js';

/** The map, as a trajectory sees it. Implemented by `DodgeScene`. */
export interface DodgeGround {
  /** Whether the player's whole body fits here — walls, objects, unknown map. */
  canStand(x: number, y: number): boolean;
  /**
   * How far a body standing here is from ground that costs health, in tiles.
   *
   * **A distance and not a verdict, which is the whole of what stops a dodge
   * ending with a heel in the lava.** Refusing to walk *into* a pool says
   * nothing about hugging its edge, and a route planned to the last millimetre
   * is a route that a server correction or a frame of latency puts inside it.
   * Negative once the body is actually on some, and `Infinity` when there is
   * none near enough for the difference to decide anything.
   *
   * @param aheadMs When the player would be standing there. Only the ground
   *   that *moves* — an enemy's learned self-blast radius, carried forward by
   *   the enemy's own movement — takes any notice of it; a pool is where it is.
   */
  hazardGapTiles(x: number, y: number, aheadMs?: number): number;
  /**
   * How far inside a monster's keep-away distance a place is, and nought
   * anywhere with room to spare.
   *
   * @param aheadMs When the player would be standing there. The bodies are
   *   carried forward over it, which is what tells one the player walked up to
   *   from one that is walking up to the player.
   */
  crowdingAt(x: number, y: number, aheadMs: number): number;
  /**
   * How far a monster's own body overlaps one standing here, in tiles.
   *
   * **Not the keep-away distance scaled down**: that one is a preference, and
   * this is the fact the game charges contact damage for. Asked once per plan
   * and once per landing place rather than per tick.
   */
  contactAt(x: number, y: number, aheadMs: number): number;
}

/** What the planner needs of the area effects on their way down. */
export interface BlastField {
  /**
   * The least room a body standing at a place has, over a window of time.
   *
   * `Infinity` when nothing goes off near it in that window — a blast threatens
   * one place at one instant and nothing at all before or after it.
   */
  clearanceAt(x: number, y: number, fromMs: number, toMs: number): number;
}

/**
 * How far apart the places along a step are asked about, in tiles.
 *
 * **Under the body's own width, which is what makes the answer about the path.**
 * The character is a square a little under half a tile across, so consecutive
 * samples this far apart overlap — there is no gap between two of them for a
 * wall to sit in. Sampling the two ends instead is enough only while a step is
 * shorter than the body, and a step is most of a tile: a pillar thinner than
 * that, or the corner of one clipped diagonally, sits entirely between the ends
 * and reads as clear.
 */
const SAMPLE_TILES = PLAYER_ENVIRONMENT_HALF_TILES;

/**
 * Whether the body fits everywhere along a step, not merely at its ends.
 *
 * **Walls are refused rather than priced, and this is what "refused" has to
 * mean.** The runtime hands the module an offset and the module walks the
 * character along it; nothing between the two sides tests the ground on the
 * way. So a route that clips a corner is a character that runs into it — at
 * full speed, for as long as the record stands — which is the failure this
 * exists to make impossible.
 *
 * **Only walkability, and only because it is cheap.** A tile's walkability is
 * one lookup in a table the plan has already built (see `GroundCache`), so a
 * handful of them per step costs nothing measurable. Damaging ground is asked
 * about as a *distance*, which scans a box of tiles per query, and is a region
 * rather than a tile — the two ends and the middle are both what that can
 * afford and what a pool's size makes sufficient.
 */
export function walkableBetween(
  ground: DodgeGround,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
): boolean {
  const dx = toX - fromX;
  const dy = toY - fromY;
  const distance = Math.sqrt(dx * dx + dy * dy);
  // Standing still is a place rather than a path, and the caller has already
  // been there.
  if (!(distance > 0)) return ground.canStand(toX, toY);

  const steps = Math.max(1, Math.ceil(distance / SAMPLE_TILES));
  for (let i = 1; i <= steps; i += 1) {
    const at = i / steps;
    if (!ground.canStand(fromX + dx * at, fromY + dy * at)) return false;
  }
  return true;
}

/**
 * Whether a step takes the character nearer a pool than it may go.
 *
 * **A ratchet, and one line of it.** The character may never end a step closer
 * to ground that hurts than the better of where they already are and the margin
 * they are meant to keep. Above the margin the distance is free; below it, the
 * only steps left are the ones that hold their ground or open it up.
 *
 * **Why a refusal and not a charge.** Room from a bullet is a bet on a
 * prediction and is worth trading; distance from a pool is a fact about the map,
 * and a route planned to the last millimetre of an edge is one that a server
 * correction or a frame of latency puts inside — the same loss arriving by a
 * different road. The live report is the plain one: *never mind the projectiles,
 * do not end up in the lava*.
 *
 * **And it can never hold anybody in one.** The floor is what they already have,
 * so a character standing in a pool may take any step that is not deeper, and
 * standing still always qualifies.
 *
 * @param clearTiles How far from a pool counts as far enough. Nought leaves only
 *   the pool itself refused, which is what switching the margin off should mean.
 */
export function entersHazard(
  fromGap: number,
  toGap: number,
  middleGap: number,
  clearTiles: number,
): boolean {
  const worst = toGap < middleGap ? toGap : middleGap;
  return worst < (fromGap < clearTiles ? fromGap : clearTiles);
}
