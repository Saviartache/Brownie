/**
 * Where the gaps in a recognised pattern will be, one slice at a time.
 *
 * **The whole point of recognising a pattern is being able to aim at a gap that
 * is not there yet.** A spiral's arms sweep past at a rate the player can very
 * often match with a fraction of a tile a tick — but only if the planner knows
 * which way they are sweeping and starts leaning that way before the arm
 * arrives. Sampled a tick at a time against the bullets alone, the same
 * situation reads as safe until it is not, and the answer then costs a whole
 * step instead of a nudge.
 *
 * **Two geometries, because a pattern closes in two ways.** A ring of eight has
 * gaps *between its arms*, and the way through is to sit in one and turn with
 * it. A ring of forty has no angular gap worth the name at any radius a fight
 * happens at; its gaps are *between waves*, and the way through is to sit in the
 * band between two wavefronts. Both are worked out here and the roomier is
 * offered, because which one a monster is doing is not a thing to guess at.
 *
 * **The arms at a radius came from the volley that was fired `r / v` ago**, and
 * getting that right is the difference between a spiral and a rotating line. A
 * shot four tiles out at eight tiles a second left half a second before the one
 * at the muzzle, so the pattern has turned since — which is exactly why a spiral
 * curls. A planner that reads the arms as a rotating straight ray dodges the
 * shape it drew rather than the one on the screen.
 *
 * **The lock is the other half, and it is about not changing your mind.** Two
 * neighbouring pockets are nearly equally good and the arithmetic that ranks
 * them shifts a little every plan, so a planner choosing afresh each tick picks
 * a different one every few ticks and travels between them for nothing. Holding
 * the pocket it chose — the same monster, the same gap between the same two arms
 * — until the pattern itself changes is what turns a sequence of twitches into
 * riding the spiral.
 *
 * **What this produces is a hint, never a verdict.** The waypoints are seeds for
 * the trajectory optimizer's candidate set; whether the step to one is actually
 * safe is still the danger field's answer. A misread pattern therefore costs a
 * wasted candidate, which is a fraction of a microsecond, rather than a hit.
 */

import { PatternKind, type AttackPatterns, type PatternReading } from './AttackPatterns.js';
import type { ShotField } from './ShotField.js';

/** The most slices a pocket sequence is worked out for. */
const MAX_POCKET_SLICES = 33;

/**
 * How long a lock survives without the pattern being re-recognised.
 *
 * A couple of volleys of anything worth locking on to. Past it the fight has
 * moved on, and a pocket held from before it is a gap in a pattern that has
 * stopped firing.
 */
const LOCK_FRESH_MS = 900;

/**
 * How confident the recogniser has to be before its gaps are aimed at.
 *
 * Two agreeing volleys is a guess, and a guess is worth a candidate; below that
 * there is no pattern, only a monster that has fired twice.
 */
const MIN_LOCK_CONFIDENCE = 0.4;

/**
 * How wide a gap has to be, as a multiple of the room a step wants.
 *
 * **A pocket narrower than the player is not a pocket.** The arc between two
 * arms is `radius × spacing` wide, so the same eight-armed ring is a comfortable
 * corridor five tiles out and a closed wall at one — and aiming at the middle of
 * a gap that cannot be stood in is how a planner walks straight at an arm.
 */
const POCKET_WIDTH_MARGIN = 2;

/** Below this the pattern is on top of the player and radius means nothing. */
const MIN_POCKET_RADIUS_TILES = 0.75;

/**
 * How many gaps the character may be away from the one being held before it is
 * chosen again.
 *
 * **One, because one is where the two readings genuinely disagree.** An arm
 * sweeping past puts the character momentarily nearer the next gap than the one
 * they are riding, and re-choosing there is the twitching the lock exists to
 * stop. Two gaps away is not a sweep, it is a knockback, a second pattern or a
 * wall they were pushed along — and a waypoint over there is a hint that costs a
 * rollout and points at nothing.
 */
const MAX_POCKET_DRIFT = 1;

export interface PocketRequest {
  /** Where the player is, and how far from there is worth recognising at all. */
  readonly x: number;
  readonly y: number;
  readonly withinTiles: number;
  /** The world clock, which the readings' own times are on. */
  readonly gameTimeMs: number;
  /** How long before a plan takes effect; slice nought sits here. */
  readonly leadMs: number;
  readonly tickMs: number;
  readonly ticks: number;
  /** How much room a step wants, which is what makes a gap wide enough. */
  readonly safeClearanceTiles: number;
  /** How far one tick of walking covers, for deciding what is reachable. */
  readonly stepTiles: number;
}

export class PocketLock {
  /** The sequence, `x[slice], y[slice]`, valid up to {@link #slices}. */
  readonly #x = new Float64Array(MAX_POCKET_SLICES);
  readonly #y = new Float64Array(MAX_POCKET_SLICES);
  #slices = 0;

  /** What is being held, and since when. */
  #ownerId = 0;
  #pocket = 0;
  #radial = false;
  #lockedAtMs = 0;

  /** How many slices of the sequence are filled. Nought means no pattern. */
  get slices(): number {
    return this.#slices;
  }

  /** Where the pocket is at `slice`. Only meaningful below {@link slices}. */
  xOf(slice: number): number {
    return this.#x[slice] ?? 0;
  }

  yOf(slice: number): number {
    return this.#y[slice] ?? 0;
  }

  /** Whether a pattern is being ridden at all this plan. */
  get locked(): boolean {
    return this.#slices > 0;
  }

  /** Forgets the lock. A new map is a new fight. */
  reset(): void {
    this.#slices = 0;
    this.#ownerId = 0;
    this.#lockedAtMs = 0;
  }

  /**
   * Works out where the gaps will be over the horizon.
   *
   * Called once per plan, before the optimizer. Leaves {@link slices} at nought
   * when there is no pattern worth riding, which is most of the time and costs
   * one walk of a table with a couple of dozen rows in it.
   */
  aim(patterns: AttackPatterns, shots: ShotField, request: PocketRequest): void {
    this.#slices = 0;

    // The one being held, while it is still being fired and still believed —
    // which is what stops the choice being remade from scratch every plan.
    let reading: PatternReading | undefined;
    if (this.#ownerId !== 0 && request.gameTimeMs - this.#lockedAtMs <= LOCK_FRESH_MS) {
      reading = patterns.readingOf(this.#ownerId, request.gameTimeMs);
      if (reading !== undefined && reading.confidence < MIN_LOCK_CONFIDENCE) reading = undefined;
    }
    if (reading === undefined) {
      reading = patterns.strongestNear(
        request.x,
        request.y,
        request.withinTiles,
        request.gameTimeMs,
      );
      if (reading === undefined || reading.confidence < MIN_LOCK_CONFIDENCE) {
        this.#ownerId = 0;
        return;
      }
      // A different pattern is a different set of gaps, so the pocket index
      // means nothing until it has been chosen against this one.
      this.#ownerId = reading.ownerId;
      this.#pocket = Number.NaN;
    }
    this.#lockedAtMs = request.gameTimeMs;

    const speed = speedOfOwner(shots, reading.ownerId, request.tickMs);
    if (!(speed > 0)) return;

    const dx = request.x - reading.originX;
    const dy = request.y - reading.originY;
    const radius = Math.hypot(dx, dy);
    if (radius < MIN_POCKET_RADIUS_TILES) return;
    const here = Math.atan2(dy, dx);

    // **Which of the two geometries this pattern actually offers.** The arc
    // between neighbouring arms has to be wide enough to stand in; where it is
    // not — a dense ring, a wall — the only gap is the band between two waves.
    const arcTiles = radius * reading.spacingRadians;
    const wanted = request.safeClearanceTiles * POCKET_WIDTH_MARGIN;
    const angular = reading.kind !== PatternKind.Single && arcTiles >= wanted;
    if (angular) {
      this.#aimAngular(reading, request, radius, here, speed);
    } else if (reading.periodMs > 0) {
      this.#aimRadial(reading, request, radius, here, speed);
    }
  }

  /**
   * The gap between two arms, followed as it sweeps.
   *
   * **The arms at radius `r` are the volley fired `r / v` ago**, so the base
   * angle to measure against is the pattern's as it was then rather than as it
   * is now. That one term is what makes a spiral curl, and leaving it out draws
   * a straight rotating ray that the shots on the screen do not follow.
   */
  #aimAngular(
    reading: PatternReading,
    request: PocketRequest,
    radius: number,
    here: number,
    speed: number,
  ): void {
    const spacing = reading.spacingRadians;
    const lagMs = (radius / speed) * 1000;

    // Which gap, chosen once and then held: the one the player is already
    // nearest at the moment the plan takes effect.
    const firstBase = this.#baseAt(reading, request.gameTimeMs + request.leadMs - lagMs);
    const nearest = Math.round((here - firstBase) / spacing - 0.5);
    // **Held, until holding it stops being about the character.** The lock is
    // what turns a sequence of twitches into riding a spiral: two neighbouring
    // gaps are nearly equally good and the arithmetic that ranks them shifts a
    // little every plan, so choosing afresh each tick is a planner travelling
    // between them for nothing.
    //
    // What it must not become is a bearing across the room. A knockback, a
    // second pattern or a wall the character was pushed along can leave them
    // whole gaps away from the one being held, and a waypoint over there is a
    // hint that costs a rollout and points at nothing. So the lock survives
    // being off by a gap — which is the ordinary case while the arms sweep past
    // — and gives way once the character is plainly somewhere else.
    if (!Number.isFinite(this.#pocket) || Math.abs(nearest - this.#pocket) > MAX_POCKET_DRIFT) {
      this.#pocket = nearest;
    }

    for (let slice = 0; slice <= request.ticks; slice += 1) {
      const aheadMs = request.leadMs + slice * request.tickMs;
      const base = this.#baseAt(reading, request.gameTimeMs + aheadMs - lagMs);
      const angle = base + (this.#pocket + 0.5) * spacing;
      // The emitter's own walking, so the pockets stay attached to the monster
      // rather than to the ground it fired the first volley from.
      const originX = reading.originX + (reading.originVelocityX * aheadMs) / 1000;
      const originY = reading.originY + (reading.originVelocityY * aheadMs) / 1000;
      this.#x[slice] = originX + Math.cos(angle) * radius;
      this.#y[slice] = originY + Math.sin(angle) * radius;
    }
    this.#radial = false;
    this.#slices = request.ticks + 1;
  }

  /**
   * The band between two wavefronts, followed as it expands.
   *
   * **What is left when a ring has no angular gap at all.** Wavefronts leave the
   * origin one period apart and travel at the shot's own speed, so at any moment
   * they sit at radii `v · (t − t_k)` — half a period's travel apart, and the
   * middle of that band is the only place to be. Riding it means moving outwards
   * at the wave speed, which nobody can do for long; what makes it worth aiming
   * at anyway is that the *next* band inwards is usually a step away, and the
   * optimizer will find that step because the waypoint points at it.
   */
  #aimRadial(
    reading: PatternReading,
    request: PocketRequest,
    radius: number,
    here: number,
    speed: number,
  ): void {
    const bandTiles = (speed * reading.periodMs) / 1000;
    if (!(bandTiles > request.safeClearanceTiles * POCKET_WIDTH_MARGIN)) return;

    // Which band, in whole waves out from the newest one, chosen once and held.
    const firstFront = (speed * (request.gameTimeMs + request.leadMs - reading.baseAtMs)) / 1000;
    if (!Number.isFinite(this.#pocket) || !this.#radial) {
      this.#pocket = Math.round((firstFront - radius) / bandTiles - 0.5);
    }

    for (let slice = 0; slice <= request.ticks; slice += 1) {
      const aheadMs = request.leadMs + slice * request.tickMs;
      const front = (speed * (request.gameTimeMs + aheadMs - reading.baseAtMs)) / 1000;
      // Behind the newest wavefront by the chosen number of whole bands, and
      // then half a band further in, which is the middle of the gap.
      const want = Math.max(MIN_POCKET_RADIUS_TILES, front - (this.#pocket + 0.5) * bandTiles);
      const originX = reading.originX + (reading.originVelocityX * aheadMs) / 1000;
      const originY = reading.originY + (reading.originVelocityY * aheadMs) / 1000;
      this.#x[slice] = originX + Math.cos(here) * want;
      this.#y[slice] = originY + Math.sin(here) * want;
    }
    this.#radial = true;
    this.#slices = request.ticks + 1;
  }

  /**
   * Where the pattern's arms point at an instant.
   *
   * A turn for a spiral, and a half-gap flip every period for one that
   * alternates — the two being the only ways a pattern's base angle is known to
   * move. See `AttackPatterns`.
   */
  #baseAt(reading: PatternReading, atMs: number): number {
    const sinceMs = atMs - reading.baseAtMs;
    if (reading.alternating && reading.periodMs > 0) {
      const volleys = Math.round(sinceMs / reading.periodMs);
      const flipped = (volleys & 1) === 1;
      return reading.baseAngle + (flipped ? reading.spacingRadians / 2 : 0);
    }
    return reading.baseAngle + (reading.omegaRadiansPerSecond * sinceMs) / 1000;
  }
}

/**
 * How fast one monster's shots travel, measured off the samples themselves.
 *
 * **Read back rather than looked up, and that is what keeps this out of the
 * catalog.** The speed that matters is the one the prediction actually used —
 * acceleration, clamp and all — so measuring the first slice of a shot already
 * in the field is both exactly right and free of a second lookup that could
 * disagree with it.
 *
 * Nought when none of that monster's shots is being tracked, which is what
 * happens the instant before its first volley arrives.
 */
function speedOfOwner(shots: ShotField, ownerId: number, tickMs: number): number {
  for (let shot = 0; shot < shots.count; shot += 1) {
    if (shots.ownerOf(shot) !== ownerId) continue;
    if (shots.liveToOf(shot) < 1) continue;
    const dx = shots.xOf(shot, 1) - shots.xOf(shot, 0);
    const dy = shots.yOf(shot, 1) - shots.yOf(shot, 0);
    const speed = (Math.hypot(dx, dy) * 1000) / tickMs;
    if (speed > 0) return speed;
  }
  return 0;
}
