/**
 * Where every shot that could reach us will be, sampled once per plan.
 *
 * **The prediction stage, and nothing else.** A shot announces a start, a
 * heading and a speed, and the game turns those into a curve; what a planner
 * needs is that curve as numbers, at the exact instants it is going to ask
 * about. Doing it once here — rather than inside the optimizer, where the same
 * shot would be asked about by every candidate that reaches that slice — is the
 * difference between a few thousand evaluations of `positionAt` per plan and a
 * few million.
 *
 * **Sampled on the planner's own clock, deliberately.** The samples land exactly
 * on the moments a trajectory steps between, so a step from slice `k` to slice
 * `k+1` is a straight segment against a straight segment, and the closest the
 * two ever come has a closed form (see `minChebyshevOnSegment`). Sampling on
 * some other cadence would force an interpolation on every one of those tests,
 * for an answer that is no more accurate.
 *
 * **Each sample carries its own hitbox, and it grows.** The motion model is the
 * client's own, but the moment it is measured from is an estimate unless the
 * client has said, and a prediction 700 ms out carries that error ten times
 * further than one 70 ms out — so the honest shape of it is a shot that gets
 * wider the further ahead it is asked about.
 *
 * **A laser is a row of squares, not one.** Its beam is the damage and the shot
 * never moves, so it is laid out as squares along the beam, spaced tightly
 * enough that their union is the beam's own band — and only the part of the
 * beam anybody could walk into is laid out at all. See {@link DodgeShot.beamTiles}.
 *
 * **What each shot *costs* travels with it**, which is what the scoring ladder
 * is built on: damage is a number the game states, and a shot carrying a
 * condition is categorically worse than one that only hurts. Ranking every hit
 * as one hit is a planner that will take a paralyse to avoid a pellet. See
 * `TrajectoryScore`.
 *
 * **Every downstream test is a point against a square**, the player being the
 * point — which is exactly how the game tests a shot. See `hitbox.ts`.
 *
 * **Nothing here allocates once it is warm.** The rows are typed arrays grown to
 * the busiest screen the session has seen; a thousand shots in flight is about a
 * megabyte that is written over fifty times a second and never collected.
 */

import type { Position } from '@brownie/plugin-api';
import { DEFAULT_PROJECTILE_HALF_TILES, effectiveHalf } from './hitbox.js';

/** What the field needs of a shot: where it will be, how big, and what it costs. */
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
   * How long its beam is, for a laser. Omitted or nought means a point.
   *
   * A beam reaches from {@link positionAt} along {@link angle} for this many
   * tiles, and the whole of it hits.
   */
  readonly beamTiles?: number;
  /** Which way it was fired, in radians. Only a beam reads it. */
  readonly angle?: number;
  /** Greatest possible speed, when known. Enables a cheap early cull. */
  readonly maxSpeedTilesPerSecond?: number;
  /**
   * What it takes off, in the game's own damage units.
   *
   * **A number, not a flag, because the ladder distinguishes hits.** Among two
   * routes that are both hit, the one hit for eight hundred is worse than the
   * one hit for thirty — and a planner that cannot tell them apart will trade a
   * boss's shotgun for a rat's pellet. Omitted is scored as an ordinary shot
   * rather than as a harmless one.
   */
  readonly damage?: number;
  /**
   * How bad the condition this one applies is, from nought to one.
   *
   * **Above damage in the ladder, deliberately.** A paralyse is not a large hit,
   * it is the end of dodging: everything that lands during it lands unopposed,
   * and the fights that kill people are the ones that begin that way. See
   * `debuffSeverity` for what earns which figure.
   */
  readonly debuffSeverity?: number;
  /** Who fired it. Only used to attribute a shot to a recognised pattern. */
  readonly ownerId?: number;
}

export interface ShotFieldOptions {
  /** The clock `positionAt` is relative to. */
  readonly gameTimeMs: number;
  /** How long before the player can act on this plan. Slice nought sits here. */
  readonly leadMs: number;
  /** How long one slice of the horizon lasts. */
  readonly tickMs: number;
  /** How many steps the horizon takes. There is one more sample than steps. */
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
export const MAX_FIELD_SLICES = 33;

/** What a shot whose data states no damage is ranked as. */
export const UNKNOWN_SHOT_DAMAGE = 60;

/**
 * How far apart the squares a beam is laid out as are, as a share of the
 * beam's own half-width.
 *
 * Half of it, so that between two neighbours the band loses at most a quarter
 * of its width even across a diagonal — and the pad on every square is more
 * than that.
 */
const BEAM_SPACING_OF_HALF = 0.5;

/** The narrowest spacing a beam is laid out at, in tiles, whatever its width. */
const MIN_BEAM_SPACING_TILES = 0.1;

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
 * **The last tick of a flight, which the horizon has no sample for.** A step is
 * swept as a segment against a segment, so a shot without a sample at both ends
 * of one has no segment — and dropping that step is dropping the end of every
 * shot's path, which is the tile a monster's range finishes on. The fraction is
 * how much of the step it lives for, so the walk can be clipped to the same
 * slice of it rather than compared against a moment the shot was not there for.
 */
const TAIL_STRIDE = 4;

export class ShotField {
  #x = new Float64Array(0);
  #y = new Float64Array(0);
  #half = new Float64Array(0);
  /** The last slice at which each shot still exists, inclusive. */
  #liveTo = new Int32Array(0);
  /** Where each shot expires, when that falls inside a step. {@link TAIL_STRIDE}. */
  #tail = new Float64Array(0);
  /** What each one costs to be hit by. See {@link DodgeShot.damage}. */
  #damage = new Float32Array(0);
  #debuff = new Float32Array(0);
  /** Who fired each, so a recognised pattern can claim its own shots. */
  #owner = new Int32Array(0);
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

  /** How many samples each shot has, which is one more than the horizon's steps. */
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

  /** What being hit by it costs, in the game's damage units. */
  damageOf(shot: number): number {
    return this.#damage[shot] ?? UNKNOWN_SHOT_DAMAGE;
  }

  /** And how bad the condition it carries is, from nought to one. */
  debuffOf(shot: number): number {
    return this.#debuff[shot] ?? 0;
  }

  ownerOf(shot: number): number {
    return this.#owner[shot] ?? 0;
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

  /** Drops everything. A stale sample is a shot that expired two maps ago. */
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
   * the reachable set. On a screen with a thousand shots on it that first cull
   * is what decides whether a plan costs a millisecond or thirty.
   */
  build(shots: Iterable<DodgeShot>, options: ShotFieldOptions): void {
    const slices = Math.max(2, Math.min(MAX_FIELD_SLICES, options.ticks + 1));
    this.#slices = slices;
    this.#tickMs = options.tickMs;
    this.#leadMs = options.leadMs;
    this.#count = 0;
    this.#considered = 0;

    const horizonMs = options.leadMs + options.ticks * options.tickMs;
    const keepWithin = options.reachTiles + CULL_MARGIN_TILES;
    const drift = options.driftTilesPerSecond;

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

      const beam = shot.beamTiles !== undefined && shot.beamTiles > 0 ? shot.beamTiles : 0;
      const top = shot.maxSpeedTilesPerSecond;
      if (beam === 0 && top !== undefined && Number.isFinite(top)) {
        // The furthest it could possibly close, which is a bound and not a
        // guess: past it, no arrangement of turns brings it into reach.
        //
        // **Measured from its edge, because a shot is a square.** The widest of
        // them are ten times the standard multiplier — five tiles from middle to
        // edge — so a bound read off the distance to the centre threw away shots
        // the player was standing inside of.
        const hereX = Math.abs(now.x - options.selfX);
        const hereY = Math.abs(now.y - options.selfY);
        const here = hereX > hereY ? hereX : hereY;
        const widest =
          effectiveHalf(own, options.hitScale, options.padTiles) + (drift * horizonMs) / 1000;
        if (here - (top * horizonMs) / 1000 - widest > keepWithin) continue;
      }

      this.#sampleBase(shot, options, slices, own, drift);
      if (this.#baseLiveTo < 0) continue;
      if (beam === 0) {
        this.#emit(shot, options, slices, keepWithin, 0, 0);
      } else {
        this.#emitBeam(shot, options, slices, keepWithin, beam, own);
      }
    }
  }

  /**
   * Where one shot is at every slice, before any row is written.
   *
   * Once per shot however many rows it becomes: a beam is dozens of squares
   * that all move together, and asking the motion model once per square would
   * be dozens of identical answers.
   */
  #sampleBase(
    shot: DodgeShot,
    options: ShotFieldOptions,
    slices: number,
    own: number,
    drift: number,
  ): void {
    let liveTo = -1;
    for (let slice = 0; slice < slices; slice += 1) {
      const aheadMs = options.leadMs + slice * options.tickMs;
      const at = shot.positionAt(options.gameTimeMs + aheadMs);
      // Expired. Everything past here is absence, not a shot parked at its last
      // position — which is the difference between a wall and a memory.
      if (at === undefined) break;
      this.#baseX[slice] = at.x;
      this.#baseY[slice] = at.y;
      this.#baseHalf[slice] =
        effectiveHalf(own, options.hitScale, options.padTiles) + (drift * aheadMs) / 1000;
      liveTo = slice;
    }
    this.#baseLiveTo = liveTo;
    this.#baseFraction = 0;

    // **The last tick of a flight, which the horizon has no sample for.** Its
    // clock is the planner's and a shot's lifetime is its own, so asking the
    // motion model once more at exactly the moment it stops is what turns the
    // last part of a flight from a step nothing looks at into a segment like
    // any other. Nothing to add when it never existed, or when the step it
    // would die in is past the end of the horizon anyway.
    if (liveTo < 0 || liveTo + 1 >= slices) return;
    const end = shot.expiresAtMs;
    if (end === undefined || !Number.isFinite(end)) return;
    const endMs = end - options.gameTimeMs;
    const fraction = (endMs - (options.leadMs + liveTo * options.tickMs)) / options.tickMs;
    // Nought is a shot that expires on the sample itself, and a whole step means
    // its own prediction gave out before its stated end — which is a shot to
    // stop believing rather than one to extrapolate past.
    if (!(fraction > 0) || fraction >= 1) return;
    const where = shot.positionAt(options.gameTimeMs + endMs);
    if (where === undefined) return;
    this.#baseEndX = where.x;
    this.#baseEndY = where.y;
    this.#baseEndHalf =
      effectiveHalf(own, options.hitScale, options.padTiles) + (drift * endMs) / 1000;
    this.#baseFraction = fraction;
  }

  /**
   * Lays a beam out as squares along the part of it anybody could walk into.
   *
   * The beam is clipped to the box around everywhere the player could get, at
   * the slice it is nearest — a beam a hundred tiles long is otherwise four
   * hundred rows, all but a handful of them across the room.
   */
  #emitBeam(
    shot: DodgeShot,
    options: ShotFieldOptions,
    slices: number,
    keepWithin: number,
    beam: number,
    own: number,
  ): void {
    const angle = shot.angle ?? 0;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    let from = beam;
    let to = 0;
    for (let slice = 0; slice <= this.#baseLiveTo; slice += 1) {
      const reach = keepWithin + (this.#baseHalf[slice] ?? 0);
      const span = this.#span;
      const inside = segmentInBox(
        (this.#baseX[slice] ?? 0) - options.selfX,
        (this.#baseY[slice] ?? 0) - options.selfY,
        cos,
        sin,
        beam,
        reach,
        span,
      );
      if (!inside) continue;
      if (span.from < from) from = span.from;
      if (span.to > to) to = span.to;
    }
    if (!(to >= from)) return;

    const spacing = Math.max(MIN_BEAM_SPACING_TILES, own * BEAM_SPACING_OF_HALF);
    const squares = Math.ceil((to - from) / spacing);
    for (let i = 0; i <= squares; i += 1) {
      const along = Math.min(to, from + i * spacing);
      this.#emit(shot, options, slices, keepWithin, cos * along, sin * along);
    }
  }

  /**
   * Writes one row from the sampled shot, moved by an offset, and keeps it if
   * it could matter.
   *
   * A row is dropped when the whole predicted path stays outside everywhere the
   * player could get to, which is most of what a busy screen is made of — and
   * when it has nothing to sweep: a single sample has no segment, unless its end
   * is known, which gives it the one it dies on.
   */
  #emit(
    shot: DodgeShot,
    options: ShotFieldOptions,
    slices: number,
    keepWithin: number,
    offsetX: number,
    offsetY: number,
  ): void {
    const liveTo = this.#baseLiveTo;
    const tailed = this.#baseFraction > 0;
    if (liveTo < 1 && !tailed) return;

    if (this.#count >= this.#capacity) this.#reserve();
    const index = this.#count;
    const base = index * slices;

    let near = false;
    for (let slice = 0; slice <= liveTo; slice += 1) {
      const x = (this.#baseX[slice] ?? 0) + offsetX;
      const y = (this.#baseY[slice] ?? 0) + offsetY;
      const half = this.#baseHalf[slice] ?? 0;
      this.#x[base + slice] = x;
      this.#y[base + slice] = y;
      this.#half[base + slice] = half;
      if (!near) {
        const dx = Math.abs(x - options.selfX);
        const dy = Math.abs(y - options.selfY);
        if ((dx > dy ? dx : dy) - half <= keepWithin) near = true;
      }
    }
    this.#liveTo[index] = liveTo;

    const tail = index * TAIL_STRIDE;
    this.#tail[tail + 3] = 0;
    if (tailed) {
      const x = this.#baseEndX + offsetX;
      const y = this.#baseEndY + offsetY;
      this.#tail[tail] = x;
      this.#tail[tail + 1] = y;
      this.#tail[tail + 2] = this.#baseEndHalf;
      this.#tail[tail + 3] = this.#baseFraction;
      if (!near) {
        const dx = Math.abs(x - options.selfX);
        const dy = Math.abs(y - options.selfY);
        if ((dx > dy ? dx : dy) - this.#baseEndHalf <= keepWithin) near = true;
      }
    }
    if (!near) return;

    this.#damage[index] = shot.damage === undefined ? UNKNOWN_SHOT_DAMAGE : shot.damage;
    this.#debuff[index] = shot.debuffSeverity ?? 0;
    this.#owner[index] = shot.ownerId ?? 0;
    this.#count += 1;
  }

  /** One shot's samples, before they become rows. See {@link #sampleBase}. */
  readonly #baseX = new Float64Array(MAX_FIELD_SLICES);
  readonly #baseY = new Float64Array(MAX_FIELD_SLICES);
  readonly #baseHalf = new Float64Array(MAX_FIELD_SLICES);
  #baseLiveTo = -1;
  #baseFraction = 0;
  #baseEndX = 0;
  #baseEndY = 0;
  #baseEndHalf = 0;
  /** Where a beam crosses the reachable box. See {@link segmentInBox}. */
  readonly #span: Span = { from: 0, to: 0 };

  /**
   * Makes room for twice as many shots.
   *
   * **The rows already written this plan are carried over**, which is only
   * sound because the stride does not change during a build: it is `#slices`
   * throughout, and the widest stride the settings allow is what every row is
   * given room for.
   */
  #reserve(): void {
    const capacity = Math.max(64, this.#capacity * 2);
    this.#capacity = capacity;
    const length = capacity * MAX_FIELD_SLICES;
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
    const owner = new Int32Array(capacity);
    owner.set(this.#owner);
    this.#owner = owner;
    const damage = new Float32Array(capacity);
    damage.set(this.#damage);
    this.#damage = damage;
    const debuff = new Float32Array(capacity);
    debuff.set(this.#debuff);
    this.#debuff = debuff;
    const tail = new Float64Array(capacity * TAIL_STRIDE);
    tail.set(this.#tail);
    this.#tail = tail;
  }
}

/** A stretch of a segment, as distances along it from its start. */
interface Span {
  from: number;
  to: number;
}

/**
 * Which stretch of a segment lies inside a square centred on the origin.
 *
 * The segment starts at `(x, y)` and runs `length` along `(cos, sin)`; the
 * square reaches `reach` either way on both axes. Clipped one axis at a time,
 * which is exact for a box and is all a beam needs: the part of it that could
 * be walked into.
 *
 * Written into `span` rather than returned, so that laying a beam out
 * allocates nothing — see the file note.
 *
 * @returns whether any of it is inside.
 */
function segmentInBox(
  x: number,
  y: number,
  cos: number,
  sin: number,
  length: number,
  reach: number,
  span: Span,
): boolean {
  span.from = 0;
  span.to = length;
  return clipAxis(x, cos, reach, span) && clipAxis(y, sin, reach, span) && span.from <= span.to;
}

/** One axis of {@link segmentInBox}: narrows `span` to where it is within reach. */
function clipAxis(start: number, step: number, reach: number, span: Span): boolean {
  if (Math.abs(step) < 1e-9) return Math.abs(start) <= reach;
  const enter = (-reach - start) / step;
  const leave = (reach - start) / step;
  span.from = Math.max(span.from, Math.min(enter, leave));
  span.to = Math.min(span.to, Math.max(enter, leave));
  return true;
}
