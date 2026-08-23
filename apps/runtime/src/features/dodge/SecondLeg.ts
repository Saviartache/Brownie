/**
 * The step a course can be left on, and how long leaving on it lasts.
 *
 * **A straight course cannot describe a way through a staggered pattern, and
 * that is the whole of the bug this answers.** Fire arranged in ranks with the
 * gaps offset — a checkerboard, a fan from two sources, any pattern where the
 * hole in one rank sits behind the shots of the next — has no straight line
 * through it, by construction. Every candidate the planner offers is therefore
 * predicted to be hit, which reads to it as "there is no way through" and starts
 * a run. A person looking at the same pattern walks into it: step into this
 * gap, then into that one. Two straight lines, and the planner had no way to say
 * so.
 *
 * **One turn, and not a path.** The planner's own argument for straight courses
 * is right and is not being overturned here: a plan made fifty times a second is
 * never executed to its end, so routing several steps ahead is an expensive way
 * of choosing the same first one. But that argument is about *walking* a path.
 * It says nothing about *proving* one, and the proof is what was missing — the
 * planner does not need the second leg in order to walk it, it needs it in order
 * to know that the first is not a dead end. One turn is the least that tells a
 * step into a gap with a way on from a step into a gap with a rank behind it,
 * which is exactly the distinction being got wrong. What comes after is the next
 * plan's, twenty milliseconds from now, and it will have real positions to work
 * from rather than a prediction three quarters of a second old.
 *
 * **What it answers is one number: how long the course lasts if it is stepped
 * off rather than stood on.** What the caller does with it is decide whether the
 * course stays clean long enough for the decision to be made again and carried
 * out, which is all any course ever has to do — beyond that the planner is
 * ranking predictions nobody will execute, and preferring the larger of them is
 * exactly how it came to prefer running away. Retreat's cost is not a hit, it is
 * ground, and no horizon can see ground.
 */

import type { Blasts } from './Blasts.js';
import type { Sweep, ThreatField } from './ThreatField.js';
import { WalkReach, type Ground, type Reach } from './WalkReach.js';

/** What the turn is offered, beyond the arrival it is made from. */
export interface SecondLegOptions {
  /** The ring a turn may be made onto — the planner's own, in its order. */
  readonly headingX: Float64Array;
  readonly headingY: Float64Array;
  readonly headings: number;
  /** How far ahead anything is predicted at all. */
  readonly horizonMs: number;
  readonly tilesPerMs: number;
  /**
   * How far the turn walks, in tiles.
   *
   * A sidestep, and it is sized as one by the caller — the width of a gap
   * between two shots, not a sprint. Running is a course of its own and is
   * already in the planner's table; what is missing from it, and what this is
   * for, is arriving somewhere and going on from there.
   */
  readonly stepTiles: number;
  readonly safeClearanceTiles: number;
  readonly avoidWalls: boolean;
  readonly avoidDamagingGround: boolean;
}

/**
 * How many directions the turn is tried in.
 *
 * Coarser than the planner's own ring on purpose. This decides whether a way on
 * exists, not which way to take — the turn is never commanded, and the plan that
 * does command it will re-choose it from the full ring against shots that have
 * actually arrived. Eight is a way out every forty-five degrees, which no gap
 * wide enough to stand in falls between.
 */
const MAX_TURNS = 8;

/**
 * How much of the intended step the ground has to allow before a turn counts.
 *
 * A turn stopped dead by a wall is not a way on, it is standing still with a
 * heading attached — and standing still is a course the planner already has.
 * Half a step is the least that puts the body somewhere else.
 */
const MIN_TURN_SHARE = 0.5;

export class SecondLeg {
  readonly #sweep: Sweep = {
    impactMs: Infinity,
    clearanceTiles: Infinity,
    urgentClearanceTiles: Infinity,
    unsafeAtMs: Infinity,
  };
  readonly #reach: Reach = { wallTiles: Infinity, hazardTiles: Infinity, exitTiles: Infinity };
  readonly #probe = new WalkReach();

  /**
   * When the best step off a course ending at `(fromX, fromY)` at `fromMs` is
   * first hit, or `fromMs` when there is no step to take.
   *
   * **Standing there is deliberately not among the turns tried, and it is not
   * being forgotten either.** A walk that stops and stays stopped is exactly
   * what a straight candidate is, so the caller already has that number and
   * takes the better of the two — which is also what makes a turn incapable of
   * making a course look worse than it is. It matters that the caller keeps it:
   * waiting in a gap for a rank to go by is half of how a person crosses one.
   */
  best(
    fromX: number,
    fromY: number,
    fromMs: number,
    field: ThreatField,
    blasts: Blasts,
    ground: Ground,
    options: SecondLegOptions,
  ): number {
    const { horizonMs, tilesPerMs, safeClearanceTiles } = options;
    const leftMs = horizonMs - fromMs;
    if (leftMs <= 0 || tilesPerMs <= 0) return fromMs;

    // As far as the step asks for, or as far as there is horizon left to walk it
    // in. A turn made near the far edge of the prediction is a short one.
    const wanted = Math.min(options.stepTiles, tilesPerMs * leftMs);
    const least = wanted * MIN_TURN_SHARE;
    if (!(least > 0)) return fromMs;

    let best = fromMs;

    const stride = Math.max(1, Math.ceil(options.headings / MAX_TURNS));
    for (let i = 0; i < options.headings; i += stride) {
      const dirX = options.headingX[i] ?? 0;
      const dirY = options.headingY[i] ?? 0;

      let travel = wanted;
      let hazardMs = Infinity;
      if (options.avoidWalls || options.avoidDamagingGround) {
        // Probed from the arrival, which is somewhere the player is not yet —
        // so nothing measured for the first leg says anything about this one.
        // Short, because the step is: a handful of tile lookups apiece.
        this.#probe.probe(fromX, fromY, dirX, dirY, wanted, ground, this.#reach);
        if (options.avoidWalls) travel = Math.min(travel, this.#reach.wallTiles);
        if (options.avoidDamagingGround && this.#reach.hazardTiles <= travel) {
          hazardMs = fromMs + this.#reach.hazardTiles / tilesPerMs;
        }
      }
      if (travel < least) continue;

      // Damaging ground ends the turn exactly as a shot does, which is the same
      // reading `DodgeController.#score` gives it.
      const untilMs = Math.min(horizonMs, hazardMs);
      field.sweep(
        fromX,
        fromY,
        dirX,
        dirY,
        tilesPerMs,
        tilesPerMs,
        fromMs,
        fromMs,
        untilMs,
        travel,
        safeClearanceTiles,
        this.#sweep,
      );
      blasts.sweep(
        fromX,
        fromY,
        dirX,
        dirY,
        tilesPerMs,
        tilesPerMs,
        fromMs,
        fromMs,
        untilMs,
        travel,
        safeClearanceTiles,
        this.#sweep,
      );

      const impactMs = Math.min(this.#sweep.impactMs, hazardMs);
      if (impactMs > best) best = impactMs;
    }
    return best;
  }
}
