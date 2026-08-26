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
   *
   * Nought means the game gives it no collision square at all, and such a shot
   * is not tracked: see `projectileHalfTiles`.
   */
  readonly collisionHalfTiles?: number;
  /**
   * When it stops existing, on the same clock {@link positionAt} is asked in.
   *
   * Omitted means the last whole step is all that is swept, which leaves the
   * final tick of the shot's flight unmodelled. See {@link endFractionOf}.
   */
  readonly expiresAtMs?: number;
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

/**
 * How many numbers describe where a shot ends up: `x, y, half, fraction`.
 *
 * **The last tick of a flight, which the lattice has no sample for.** A step is
 * swept as a segment against a segment, so a shot without a sample at both ends
 * of one has no segment — and dropping that step is dropping the end of every
 * shot's path, which is the tile a monster's range finishes on. The fraction is
 * how much of the step it lives for, so the walk can be clipped to the same
 * slice of it rather than compared against a moment the shot was not there for.
 */
const TAIL_STRIDE = 4;

export class ShotTracks {
  #x = new Float64Array(0);
  #y = new Float64Array(0);
  #half = new Float64Array(0);
  /** The last slice at which each shot still exists, inclusive. */
  #liveTo = new Int32Array(0);
  /** Where each shot expires, when that falls inside a step. {@link TAIL_STRIDE}. */
  #tail = new Float64Array(0);
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

  /**
   * How much of the step after {@link liveToOf} the shot still exists for.
   *
   * Nought when it expires on the sample itself, when its end is not known, or
   * when there is no step after it inside the horizon — in every one of those
   * there is nothing left to sweep and the other three are meaningless.
   */
  endFractionOf(shot: number): number {
    return this.#tail[shot * TAIL_STRIDE + 3] ?? 0;
  }

  /** Where `shot` is at the instant it expires. */
  endXOf(shot: number): number {
    return this.#tail[shot * TAIL_STRIDE] ?? 0;
  }

  endYOf(shot: number): number {
    return this.#tail[shot * TAIL_STRIDE + 1] ?? 0;
  }

  /** Its half-extent there, the player's own already folded in. */
  endHalfOf(shot: number): number {
    return this.#tail[shot * TAIL_STRIDE + 2] ?? 0;
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

      const own =
        shot.collisionHalfTiles === undefined
          ? DEFAULT_PROJECTILE_HALF_TILES
          : shot.collisionHalfTiles;
      // A shot the game gives no collision square to is one nothing can ever
      // overlap, and predicting it is spending a plan on a decoration.
      if (!(own > 0)) continue;

      const now = shot.positionAt(options.gameTimeMs);
      // No position at the moment of planning means it is already over. The
      // world reports those briefly, and they are not danger.
      if (now === undefined) continue;

      const drift =
        options.driftTilesPerSecond * (shot.motionModelled === false ? UNMODELLED_DRIFT_FACTOR : 1);

      const hereX = Math.abs(now.x - options.selfX);
      const hereY = Math.abs(now.y - options.selfY);
      const here = hereX > hereY ? hereX : hereY;

      const top = shot.maxSpeedTilesPerSecond;
      if (top !== undefined && Number.isFinite(top)) {
        // The furthest it could possibly close, which is a bound and not a
        // guess: past it, no arrangement of turns brings it into reach.
        //
        // **Measured from its edge, because a shot is a square.** The widest of
        // them are ten times the standard multiplier — five tiles from middle to
        // edge — so a bound read off the distance to the centre threw away shots
        // the player was standing inside of.
        const widest =
          effectiveHalf(own, options.hitScale, options.padTiles) + (drift * horizonMs) / 1000;
        if (here - (top * horizonMs) / 1000 - widest > keepWithin) continue;
      }

      if (this.#count >= this.#capacity) this.#reserve();
      if (this.#sample(shot, this.#count, options, slices, keepWithin, own, drift)) {
        this.#count += 1;
      }
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
    own: number,
    drift: number,
  ): boolean {
    const base = index * slices;

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
    const tailed = this.#writeTail(shot, index, options, liveTo, own, drift, slices);
    if (tailed && !near) {
      const dx = Math.abs(this.endXOf(index) - options.selfX);
      const dy = Math.abs(this.endYOf(index) - options.selfY);
      if ((dx > dy ? dx : dy) - this.endHalfOf(index) <= keepWithin) near = true;
    }

    // A shot with nothing but a single sample has no segment to sweep — unless
    // its end is known, which gives it the one it dies on — and one that never
    // comes near cannot be walked into by any course this plan could choose.
    return near && (liveTo >= 1 || tailed);
  }

  /**
   * Records where a shot expires, when it does so part of the way through a
   * step, and says whether there is anything there to sweep.
   *
   * The instant it stops existing is a position the lattice has no sample for:
   * its clock is the search's, and a shot's lifetime is its own. Asking
   * `positionAt` once more at exactly that moment is what turns the last part of
   * a flight from a step nothing looks at into a segment like any other.
   */
  #writeTail(
    shot: DodgeShot,
    index: number,
    options: ShotTrackOptions,
    liveTo: number,
    own: number,
    drift: number,
    slices: number,
  ): boolean {
    const at = index * TAIL_STRIDE;
    this.#tail[at + 3] = 0;
    // Nothing to add when it never existed, or when the step it would die in is
    // past the end of the horizon anyway.
    if (liveTo < 0 || liveTo + 1 >= slices) return false;

    const end = shot.expiresAtMs;
    if (end === undefined || !Number.isFinite(end)) return false;

    const endMs = end - options.gameTimeMs;
    const fraction = (endMs - (options.leadMs + liveTo * options.tickMs)) / options.tickMs;
    // Nought is a shot that expires on the sample itself, and a whole step means
    // its own prediction gave out before its stated end — which is a shot to
    // stop believing rather than one to extrapolate past.
    if (!(fraction > 0) || fraction >= 1) return false;

    const where = shot.positionAt(options.gameTimeMs + endMs);
    if (where === undefined) return false;

    this.#tail[at] = where.x;
    this.#tail[at + 1] = where.y;
    this.#tail[at + 2] =
      effectiveHalf(own, options.hitScale, options.padTiles) + (drift * endMs) / 1000;
    this.#tail[at + 3] = fraction;
    return true;
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
    const tail = new Float64Array(capacity * TAIL_STRIDE);
    tail.set(this.#tail);
    this.#tail = tail;
  }
}
