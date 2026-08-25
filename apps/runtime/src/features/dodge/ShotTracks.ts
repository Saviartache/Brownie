/**
 * Where every shot that could reach us will be, sampled once per plan.
 *
 * **The extrapolation, and nothing else.** A shot announces a start, a heading
 * and a speed, and the game turns those into a curve; what a planner needs is
 * that curve as numbers, at the exact instants it is going to ask about. Doing
 * it once here — rather than inside the search, where the same shot would be
 * asked about by every branch that reaches that slice — is the difference
 * between a few hundred evaluations of `positionAt` per plan and a few hundred
 * thousand.
 *
 * **Sampled on the search's own clock, deliberately.** The samples land exactly
 * on the moments the lattice steps between, so a step from slice `k` to slice
 * `k+1` is a straight segment against a straight segment, and the closest the
 * two ever come has a closed form (see {@link minChebyshevOnSegment}). Sampling
 * on some other cadence would force an interpolation on every one of those
 * tests, for an answer that is no more accurate.
 *
 * **Each sample carries its own hitbox, and it grows.** `positionAt` does not
 * model turn rate or the client's own clock, so a prediction 700 ms out is worth
 * less than one 70 ms out — and the honest shape of that error is a shot that
 * gets wider the further ahead it is asked about. The alternative is a single
 * fat hitbox everywhere, which is cautious where caution is free and reckless
 * where it is not. A shot the model does not claim to describe at all — the
 * spirals that curl — is distrusted several times as fast, which is what makes
 * one dodgeable rather than confidently mistimed.
 *
 * **The player's own half is folded in here**, so every downstream test is a
 * point against a square rather than a square against a square. That is also how
 * the game does it.
 */

import type { Position } from '@brownie/plugin-api';
import { DEFAULT_PROJECTILE_HALF_TILES, effectiveHalf } from './hitbox.js';

/** What a track needs of a shot: where it will be, and how big it is. */
export interface DodgeShot {
  /** `undefined` once it has expired — gone, not "still at its last place". */
  positionAt(gameTimeMs: number): Position | undefined;
  /**
   * The shot's own collision half-extent. Omitted means the standard size.
   */
  readonly collisionHalfTiles?: number;
  /**
   * Whether the motion model describes this shot's whole path. Omitted means it
   * is believed; false earns the extra distrust described above.
   */
  readonly motionModelled?: boolean;
  /** Greatest possible speed, when known. Enables a cheap early cull. */
  readonly maxSpeedTilesPerSecond?: number;
}

export interface ShotTrackOptions {
  /** The clock `positionAt` is relative to. */
  readonly gameTimeMs: number;
  /** How long before the player can act on this plan. Slice nought sits here. */
  readonly leadMs: number;
  /** How long one lattice step lasts. */
  readonly tickMs: number;
  /** How many steps the lattice takes. There is one more sample than steps. */
  readonly ticks: number;
  /** Where the player is, for the culls. */
  readonly selfX: number;
  readonly selfY: number;
  /** How far the player could possibly get inside the horizon. */
  readonly reachTiles: number;
  /** Multiplies every shot's own extent. Above one is more cautious. */
  readonly hitScale: number;
  /** A flat margin on every shot, at every moment. */
  readonly padTiles: number;
  /** How fast confidence in a prediction decays, as extra half-extent. */
  readonly driftTilesPerSecond: number;
}

/** The most samples kept per shot, which bounds the tables at the busiest. */
export const MAX_TRACK_SLICES = 33;

/**
 * How much less a shot the model does not fully describe is believed.
 *
 * A turning shot is predicted as though it went straight, so the error is not
 * noise — it is a curve the prediction has no term for, and it grows with how
 * far ahead it is asked.
 */
const UNMODELLED_DRIFT_FACTOR = 3;

/**
 * How far past everywhere the player could get a shot still counts, in tiles.
 *
 * A body's width and a little: a shot passing exactly at the edge of the
 * reachable set is still one a step could walk into, and one dropped for being
 * a hair outside it is one nothing in the plan can see.
 */
const CULL_MARGIN_TILES = 1;

export class ShotTracks {
  #x = new Float64Array(0);
  #y = new Float64Array(0);
  #half = new Float64Array(0);
  /** The last slice at which each shot still exists, inclusive. */
  #liveTo = new Int32Array(0);
  #capacity = 0;

  #slices = 0;
  #count = 0;
  #considered = 0;
  #tickMs = 0;
  #leadMs = 0;

  /** How many shots are worth sweeping against. */
  get count(): number {
    return this.#count;
  }

  /** How many were looked at. Zero means nothing at all is in flight. */
  get considered(): number {
    return this.#considered;
  }

  /** How many samples each shot has, which is one more than the lattice steps. */
  get slices(): number {
    return this.#slices;
  }

  /** Plan-relative milliseconds of sample `slice`. */
  timeOf(slice: number): number {
    return this.#leadMs + slice * this.#tickMs;
  }

  xOf(shot: number, slice: number): number {
    return this.#x[shot * this.#slices + slice] ?? 0;
  }

  yOf(shot: number, slice: number): number {
    return this.#y[shot * this.#slices + slice] ?? 0;
  }

  /** This shot's half-extent at `slice`, the player's own already folded in. */
  halfOf(shot: number, slice: number): number {
    return this.#half[shot * this.#slices + slice] ?? 0;
  }

  /** The last slice `shot` still exists at. Slices past it are not swept. */
  liveToOf(shot: number): number {
    return this.#liveTo[shot] ?? -1;
  }

  /** Drops everything. A stale track is a shot that expired two maps ago. */
  clear(): void {
    this.#count = 0;
    this.#considered = 0;
    this.#slices = 0;
  }

  /**
   * Samples everything in flight that this plan could possibly meet.
   *
   * **Culled twice, cheaply first.** A shot's own top speed bounds how far it
   * can travel in the horizon, so one whose current distance already exceeds
   * that plus everywhere the player could get cannot matter — and that is one
   * subtraction rather than a dozen calls into the motion model. What survives
   * is sampled, and then dropped again if the whole sampled path stays clear of
   * the reachable set.
   */
  build(shots: Iterable<DodgeShot>, options: ShotTrackOptions): void {
    const slices = Math.max(2, Math.min(MAX_TRACK_SLICES, options.ticks + 1));
    this.#slices = slices;
    this.#tickMs = options.tickMs;
    this.#leadMs = options.leadMs;
    this.#count = 0;
    this.#considered = 0;

    const horizonMs = options.leadMs + options.ticks * options.tickMs;
    const keepWithin = options.reachTiles + CULL_MARGIN_TILES;

    for (const shot of shots) {
      this.#considered += 1;

      const now = shot.positionAt(options.gameTimeMs);
      // No position at the moment of planning means it is already over. The
      // world reports those briefly, and they are not danger.
      if (now === undefined) continue;

      const hereX = Math.abs(now.x - options.selfX);
      const hereY = Math.abs(now.y - options.selfY);
      const here = hereX > hereY ? hereX : hereY;

      const top = shot.maxSpeedTilesPerSecond;
      if (top !== undefined && Number.isFinite(top)) {
        // The furthest it could possibly close, which is a bound and not a
        // guess: past it, no arrangement of turns brings it into reach.
        if (here - (top * horizonMs) / 1000 > keepWithin) continue;
      }

      if (this.#count >= this.#capacity) this.#reserve();
      if (this.#sample(shot, this.#count, options, slices, keepWithin)) this.#count += 1;
    }
  }

  /**
   * Fills one shot's row, and says whether it was worth keeping.
   *
   * @returns false when the whole predicted path stays outside everywhere the
   *   player could get to, which is most of what a busy screen is made of.
   */
  #sample(
    shot: DodgeShot,
    index: number,
    options: ShotTrackOptions,
    slices: number,
    keepWithin: number,
  ): boolean {
    const base = index * slices;
    const own =
      shot.collisionHalfTiles === undefined
        ? DEFAULT_PROJECTILE_HALF_TILES
        : shot.collisionHalfTiles;
    const drift =
      options.driftTilesPerSecond * (shot.motionModelled === false ? UNMODELLED_DRIFT_FACTOR : 1);

    let liveTo = -1;
    let near = false;
    for (let slice = 0; slice < slices; slice += 1) {
      const aheadMs = options.leadMs + slice * options.tickMs;
      const at = shot.positionAt(options.gameTimeMs + aheadMs);
      // Expired. Everything past here is absence, not a shot parked at its last
      // position — which is the difference between a wall and a memory.
      if (at === undefined) break;

      const half =
        effectiveHalf(own, options.hitScale, options.padTiles) + (drift * aheadMs) / 1000;
      this.#x[base + slice] = at.x;
      this.#y[base + slice] = at.y;
      this.#half[base + slice] = half;
      liveTo = slice;

      if (!near) {
        const dx = Math.abs(at.x - options.selfX);
        const dy = Math.abs(at.y - options.selfY);
        if ((dx > dy ? dx : dy) - half <= keepWithin) near = true;
      }
    }

    this.#liveTo[index] = liveTo;
    // A shot with a single sample has no segment to sweep, and one that never
    // comes near cannot be walked into by any course this plan could choose.
    return liveTo >= 1 && near;
  }

  /**
   * Makes room for twice as many shots.
   *
   * **The rows already written this plan are carried over**, which is only
   * sound because the stride does not change during a build: it is `#slices`
   * throughout, and the widest stride the settings allow is what every row is
   * given room for.
   */
  #reserve(): void {
    const capacity = Math.max(16, this.#capacity * 2);
    this.#capacity = capacity;
    const length = capacity * MAX_TRACK_SLICES;
    const x = new Float64Array(length);
    const y = new Float64Array(length);
    const half = new Float64Array(length);
    x.set(this.#x);
    y.set(this.#y);
    half.set(this.#half);
    this.#x = x;
    this.#y = y;
    this.#half = half;
    const liveTo = new Int32Array(capacity);
    liveTo.set(this.#liveTo);
    this.#liveTo = liveTo;
  }
}
