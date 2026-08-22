/**
 * Everything in flight that could reach the player, as flat numbers.
 *
 * **One prediction per shot per plan, shared by every candidate.** Where a shot
 * will be at a moment does not depend on which way the player is thinking of
 * walking, so asking `positionAt` inside the candidate loop computes the same
 * curve once per direction — seventeen times the trigonometry for seventeen
 * copies of one answer. Each shot is sampled once into a polyline here, and
 * every candidate is then swept against those numbers.
 *
 * **The sweep is exact, and that is the point of the polyline.** Between two
 * samples the shot moves in a straight line and a walking player moves in a
 * straight line, so their difference does too — and the closest they come has a
 * closed form (see {@link minChebyshevOnSegment}). The alternative, testing
 * overlap at each step, cannot see a shot that crosses the player *between* two
 * steps: it reports a hit as a miss, and the faster the shot the more often. All
 * four of the reference implementation's dodge generations had that hole and
 * answered it with a finer step and a fatter hitbox, which costs time and
 * accuracy to buy back something the arithmetic gives away.
 *
 * **What is not modelled is paid for by time, not ignored.** `positionAt` does
 * not apply acceleration, turn rate or the client's own clock jitter, so a
 * prediction 600 ms out is worth less than one 60 ms out. `driftTilesPerSecond`
 * widens every shot in proportion to how far ahead it is being asked about,
 * which is the honest shape of that error: near-term decisions stay tight and
 * far-term ones stay cautious. The reference reached the same place by measuring
 * per-type residuals and learning an inflation — a great deal of machinery for a
 * number that only ever grew with lookahead.
 */

import type { Position } from '@brownie/plugin-api';
import { DEFAULT_PROJECTILE_HALF_TILES, effectiveHalf, minChebyshevOnSegment } from './hitbox.js';

/** What the field needs of a shot: where it is at a moment, and how big it is. */
export interface DodgeShot {
  /** `undefined` once it has expired — gone, not "still at its last place". */
  positionAt(gameTimeMs: number): Position | undefined;
  /**
   * The shot's own collision half-extent, when something knows it. Omitted
   * means {@link DEFAULT_PROJECTILE_HALF_TILES}.
   */
  readonly collisionHalfTiles?: number;
  /**
   * Whether the motion model describes this shot's whole path.
   *
   * False for the ones that accelerate or turn — a spiral that curls, a shot
   * that speeds up — where `positionAt` gives a straight line for something that
   * is not one. Those are not dropped; they are *distrusted*, which means room
   * left around them that grows with how far ahead the prediction is. Omitted
   * means the model is believed.
   */
  readonly motionModelled?: boolean;
}

export interface ThreatFieldOptions {
  /** How far ahead to predict. Beyond it, the plan is someone else's problem. */
  readonly horizonMs: number;
  /**
   * Spacing between predicted positions.
   *
   * Bounds how far a curve may bend between two samples, not how far a shot may
   * travel — the sweep between samples is exact, so this can be far coarser than
   * a stepped planner's step. A straight shot is described perfectly by two
   * samples however far apart they are.
   */
  readonly sampleStepMs: number;
  /** Multiplies every shot's extent. Above 1 is more cautious. */
  readonly hitScale: number;
  /** A flat margin on every shot, at every moment. */
  readonly padTiles: number;
  /** How fast confidence in a prediction decays, as extra half-extent. */
  readonly driftTilesPerSecond: number;
  /**
   * How far the player could possibly get within the horizon.
   *
   * Only used to decide what to keep: a shot whose whole predicted path stays
   * outside everywhere the player could be cannot matter to this plan, and
   * dropping it here is what keeps the candidate loop proportional to the fight
   * rather than to the room.
   */
  readonly reachTiles: number;
}

/** Where a straight walk ends up against the field. Reused; never handed out. */
export interface Sweep {
  /**
   * When the walk is first inside a shot, or `Infinity` when it never is.
   *
   * The time of the *first* overlap. A walk hit at 200 ms and again at 400 ms is
   * exactly as bad as one hit at 200 ms alone — the player is dead either way,
   * and counting hits would make the planner prefer one large hit to two small.
   */
  impactMs: number;
  /**
   * The least room the walk ever had, in tiles. Negative once something landed.
   *
   * **This is what tells a wide gap from a needle.** Two escapes that both
   * survive the horizon are not equally good, and time-to-hit cannot say so
   * because it is `Infinity` for both.
   */
  clearanceTiles: number;
  /**
   * When the walk first has less than the caller's margin of room.
   *
   * **This is the number that says whether to act, and it is not the same
   * question as how the walk ends.** A shot eight tiles away with a long life
   * *will* reach the player inside a second, so the least room this walk ever
   * has is "none" — and a planner that acted on that would take the wheel every
   * time anything was fired anywhere, which is a planner that cannot walk
   * towards a monster. When the trouble starts is what decides whether it is
   * this moment's problem; the other two numbers decide which way to go once it
   * is.
   */
  unsafeAtMs: number;
}

/**
 * The most samples kept per shot.
 *
 * A ceiling on the buffers rather than a tuning knob: at the shortest step and
 * the longest horizon the settings allow, this is what it comes to.
 */
const MAX_SAMPLES = 64;

/**
 * Faster than anything in the game, in tiles per second.
 *
 * Used once, to decide whether a shot is far enough away that predicting it at
 * all is wasted work. Deliberately generous — the cost of being wrong here is
 * missing a threat, so it is set above every projectile speed in the data rather
 * than at the fastest one seen.
 */
const IMPLAUSIBLE_SPEED_TILES_PER_SECOND = 25;

/**
 * How much room is still worth measuring, in tiles.
 *
 * **A shot that misses by a lot and one that misses by a little are different
 * answers**, and the whole reason the sweep reports a distance rather than a
 * verdict is to tell them apart. So the box a shot is kept in has to be wider
 * than the shot: cull to the hitbox alone and every near miss reports the same
 * infinite room, which collapses the comparison the planner is built on.
 *
 * Past this, one course is as roomy as another and the difference stops
 * deciding anything — which is what keeps the broad phase doing its job.
 */
const CLEARANCE_INTEREST_TILES = 1.0;

/**
 * How much less a shot the model does not fully describe is believed.
 *
 * A turning or accelerating shot is predicted as though it went straight, so the
 * error is not noise — it is a curve the prediction has no term for, and it
 * grows the further ahead it is asked. Three times the ordinary distrust is what
 * turns "this shot will be exactly there" into "somewhere around there", which
 * is the honest reading and the one that makes a spiral dodgeable rather than
 * confidently mistimed.
 */
const UNMODELLED_DRIFT_FACTOR = 3;

export class ThreatField {
  #sampleX = new Float64Array(0);
  #sampleY = new Float64Array(0);
  #sampleCount = new Int32Array(0);
  #half = new Float64Array(0);
  /** How fast this shot's own prediction stops being believed, per second. */
  #drifts = new Float64Array(0);
  #minX = new Float64Array(0);
  #minY = new Float64Array(0);
  #maxX = new Float64Array(0);
  #maxY = new Float64Array(0);

  #capacity = 0;
  #samples = 0;
  #stepMs = 0;
  #tracked = 0;
  #considered = 0;
  #drift = 0;
  #horizonMs = 0;
  #flowX = 0;
  #flowY = 0;
  #flowCoherence = 0;

  /** How many shots could reach the player, and are therefore swept against. */
  get tracked(): number {
    return this.#tracked;
  }

  /** How many were looked at, tracked or not. Zero means nothing is in flight. */
  get considered(): number {
    return this.#considered;
  }

  /**
   * The direction the shots are travelling, taken together.
   *
   * **A unit vector pointing the way the fire is going**, which is to say away
   * from whatever fired it. Walking along it is retreating; walking across it is
   * threading the pattern. Anything that wants to prefer the second over the
   * first needs to know which is which, and this is the only thing that does —
   * the planner never learns where a monster is, only where its shots are.
   *
   * Weighted towards the near ones, because a wave about to arrive says more
   * about which way "back" is than one still crossing the room.
   */
  get flowX(): number {
    return this.#flowX;
  }

  get flowY(): number {
    return this.#flowY;
  }

  /**
   * How much the shots agree about that direction, from nought to one.
   *
   * One when a single wave sweeps through, near nought in a crossfire — where
   * there is no "back" to retreat towards and the idea should stop applying.
   * Anything scaled by this fades out on its own rather than needing a rule.
   */
  get flowCoherence(): number {
    return this.#flowCoherence;
  }

  /**
   * Predicts everything in flight, keeping what could matter.
   *
   * Allocates nothing after the first few plans: the buffers grow to the busiest
   * fight seen and are reused.
   */
  build(
    gameTimeMs: number,
    selfX: number,
    selfY: number,
    shots: Iterable<DodgeShot>,
    options: ThreatFieldOptions,
  ): void {
    const horizonMs = Math.max(options.sampleStepMs, options.horizonMs);
    const stepMs = Math.max(1, options.sampleStepMs);
    const samples = Math.min(MAX_SAMPLES, Math.max(2, Math.floor(horizonMs / stepMs) + 1));

    this.#stepMs = stepMs;
    this.#samples = samples;
    this.#drift = Math.max(0, options.driftTilesPerSecond);
    this.#horizonMs = horizonMs;
    this.#tracked = 0;
    this.#considered = 0;
    // Accumulated as the shots are predicted, since the first two samples of a
    // path are exactly the direction it is going.
    let flowX = 0;
    let flowY = 0;
    let flowWeight = 0;

    // Everywhere the player could stand within the horizon, as a square. A shot
    // whose own path never enters it cannot be dodged into or out of.
    const reach = Math.max(0, options.reachTiles);
    const skipBeyond =
      reach +
      (IMPLAUSIBLE_SPEED_TILES_PER_SECOND * horizonMs) / 1000 +
      DEFAULT_PROJECTILE_HALF_TILES;

    for (const shot of shots) {
      this.#considered += 1;

      const start = shot.positionAt(gameTimeMs);
      // Already gone. Counted as considered because the caller asked about it.
      if (start === undefined) continue;
      // Too far to become relevant however fast it is. One comparison saves the
      // whole prediction, which is the expensive part of a plan.
      if (Math.abs(start.x - selfX) > skipBeyond || Math.abs(start.y - selfY) > skipBeyond) {
        continue;
      }

      this.#reserve(this.#tracked + 1);
      const slot = this.#tracked;
      const base = slot * this.#samples;

      const half = effectiveHalf(
        shot.collisionHalfTiles ?? DEFAULT_PROJECTILE_HALF_TILES,
        options.hitScale,
        options.padTiles,
      );
      const drift =
        shot.motionModelled === false ? this.#drift * UNMODELLED_DRIFT_FACTOR : this.#drift;

      let minX = start.x;
      let minY = start.y;
      let maxX = start.x;
      let maxY = start.y;
      this.#sampleX[base] = start.x;
      this.#sampleY[base] = start.y;

      let taken = 1;
      for (let k = 1; k < this.#samples; k += 1) {
        const at = shot.positionAt(gameTimeMs + k * stepMs);
        // Expired part-way through the horizon, which most shots do. The
        // remaining samples do not exist rather than repeating the last one — a
        // shot that has ended is not a shot sitting still.
        if (at === undefined) break;
        this.#sampleX[base + k] = at.x;
        this.#sampleY[base + k] = at.y;
        if (at.x < minX) minX = at.x;
        else if (at.x > maxX) maxX = at.x;
        if (at.y < minY) minY = at.y;
        else if (at.y > maxY) maxY = at.y;
        taken += 1;
      }

      // The box carries the widest this shot ever gets, plus the margin over
      // which a near miss is still worth measuring — so a sweep that misses the
      // box has genuinely missed the shot by more than anything cares about.
      const widest = half + (drift * horizonMs) / 1000 + CLEARANCE_INTEREST_TILES;
      if (
        minX - widest > selfX + reach ||
        maxX + widest < selfX - reach ||
        minY - widest > selfY + reach ||
        maxY + widest < selfY - reach
      ) {
        continue;
      }

      this.#sampleCount[slot] = taken;
      this.#half[slot] = half;
      this.#drifts[slot] = drift;
      this.#minX[slot] = minX - widest;
      this.#minY[slot] = minY - widest;
      this.#maxX[slot] = maxX + widest;
      this.#maxY[slot] = maxY + widest;
      this.#tracked += 1;

      // Which way this one is going, weighted towards the ones close enough to
      // be about to matter. A shot with a single sample has no direction yet and
      // contributes nothing rather than a guess.
      if (taken > 1) {
        const stepX = (this.#sampleX[base + 1] ?? 0) - start.x;
        const stepY = (this.#sampleY[base + 1] ?? 0) - start.y;
        const length = Math.hypot(stepX, stepY);
        if (length > 0) {
          const weight = 1 / Math.max(1, Math.hypot(start.x - selfX, start.y - selfY));
          flowX += (stepX / length) * weight;
          flowY += (stepY / length) * weight;
          flowWeight += weight;
        }
      }
    }

    const flow = Math.hypot(flowX, flowY);
    if (flow > 0 && flowWeight > 0) {
      this.#flowX = flowX / flow;
      this.#flowY = flowY / flow;
      this.#flowCoherence = Math.min(1, flow / flowWeight);
    } else {
      this.#flowX = 0;
      this.#flowY = 0;
      this.#flowCoherence = 0;
    }
  }

  /**
   * Walks one straight course through the field.
   *
   * @param leadMs How far into the future the walk starts. A decision made here
   *   reaches the game a frame later and the server later still, so the player
   *   is already somewhere else by the time it takes effect — planning from
   *   where they *will* be is the difference between a dodge that clears a shot
   *   and one that clears where the shot used to be aimed.
   * @param untilMs When to stop looking, which is the horizon or sooner.
   * @param maxTravelTiles How far the course can actually go before geometry
   *   stops it. **The walk continues after that, standing still**, which is what
   *   a character pressed against a wall does — and is why a wall is not scored
   *   as damage here. A course that runs out of room simply stops earning any
   *   more distance from what is coming, which is exactly as bad as that is.
   * @param safeMarginTiles How much room counts as comfortable. Only decides
   *   {@link Sweep.unsafeAtMs}, which is what tells "this is a problem now" from
   *   "this is a problem eventually".
   * @param out Filled in place, so a plan's hundred sweeps allocate nothing.
   */
  sweep(
    selfX: number,
    selfY: number,
    dirX: number,
    dirY: number,
    tilesPerMs: number,
    leadMs: number,
    untilMs: number,
    maxTravelTiles: number,
    safeMarginTiles: number,
    out: Sweep,
  ): void {
    out.impactMs = Infinity;
    out.clearanceTiles = Infinity;
    out.unsafeAtMs = Infinity;

    const endMs = Math.min(this.#horizonMs, untilMs);
    if (endMs < 0 || this.#tracked === 0) return;

    // When the course stops advancing. Before the walk even begins if the
    // player is already against something, which makes this a standing sweep.
    const stopMs =
      maxTravelTiles === Infinity || tilesPerMs <= 0
        ? Infinity
        : maxTravelTiles / tilesPerMs - leadMs;

    const startTravel = Math.min(tilesPerMs * leadMs, maxTravelTiles);
    const finishTravel = Math.min(tilesPerMs * (leadMs + endMs), maxTravelTiles);
    const startX = selfX + dirX * startTravel;
    const startY = selfY + dirY * startTravel;
    const finishX = selfX + dirX * finishTravel;
    const finishY = selfY + dirY * finishTravel;

    // The course as a box, so a shot nowhere near it costs four comparisons.
    const walkMinX = Math.min(startX, finishX);
    const walkMaxX = Math.max(startX, finishX);
    const walkMinY = Math.min(startY, finishY);
    const walkMaxY = Math.max(startY, finishY);

    const stepMs = this.#stepMs;
    const samples = this.#samples;

    for (let i = 0; i < this.#tracked; i += 1) {
      if (
        (this.#minX[i] ?? 0) > walkMaxX ||
        (this.#maxX[i] ?? 0) < walkMinX ||
        (this.#minY[i] ?? 0) > walkMaxY ||
        (this.#maxY[i] ?? 0) < walkMinY
      ) {
        continue;
      }

      const base = i * samples;
      const count = this.#sampleCount[i] ?? 0;
      const half = this.#half[i] ?? 0;
      const drift = this.#drifts[i] ?? 0;

      if (count === 1) {
        // Announced and over within one sample. Still a hit if it is on us.
        const room =
          Math.max(
            Math.abs((this.#sampleX[base] ?? 0) - startX),
            Math.abs((this.#sampleY[base] ?? 0) - startY),
          ) - half;
        if (room < out.clearanceTiles) out.clearanceTiles = room;
        if (room <= 0 && out.impactMs > 0) out.impactMs = 0;
        if (room < safeMarginTiles && out.unsafeAtMs > 0) out.unsafeAtMs = 0;
        continue;
      }

      for (let k = 0; k + 1 < count; k += 1) {
        const segmentAt = k * stepMs;
        if (segmentAt > endMs) break;

        const shotAx = this.#sampleX[base + k] ?? 0;
        const shotAy = this.#sampleY[base + k] ?? 0;
        const shotBx = this.#sampleX[base + k + 1] ?? 0;
        const shotBy = this.#sampleY[base + k + 1] ?? 0;
        // The last segment is clipped rather than dropped: a shot that lands at
        // 610 ms of a 600 ms horizon still threatens the first 600.
        const segmentEnd = Math.min(segmentAt + stepMs, endMs);

        // Split where the course stops moving, so both halves stay straight in
        // the player *and* the shot — which is what makes the closed form exact
        // rather than a very good guess.
        const split = stopMs > segmentAt && stopMs < segmentEnd ? stopMs : segmentEnd;

        let from = segmentAt;
        for (;;) {
          const to = from === segmentAt ? split : segmentEnd;
          const alongFrom = (from - segmentAt) / stepMs;
          const alongTo = (to - segmentAt) / stepMs;
          const travelFrom = Math.min(tilesPerMs * (leadMs + from), maxTravelTiles);
          const travelTo = Math.min(tilesPerMs * (leadMs + to), maxTravelTiles);

          const closest = minChebyshevOnSegment(
            shotAx + (shotBx - shotAx) * alongFrom - (selfX + dirX * travelFrom),
            shotAy + (shotBy - shotAy) * alongFrom - (selfY + dirY * travelFrom),
            shotAx + (shotBx - shotAx) * alongTo - (selfX + dirX * travelTo),
            shotAy + (shotBy - shotAy) * alongTo - (selfY + dirY * travelTo),
          );
          // Widened by how far ahead this is: a prediction the model cannot
          // fully explain is one to leave more room around.
          const room = closest - (half + (drift * to) / 1000);
          if (room < out.clearanceTiles) out.clearanceTiles = room;
          if (room <= 0 && from < out.impactMs) out.impactMs = from;
          if (room < safeMarginTiles && from < out.unsafeAtMs) out.unsafeAtMs = from;

          if (to >= segmentEnd) break;
          from = to;
        }
      }
    }
  }

  #reserve(shots: number): void {
    if (shots <= this.#capacity && this.#sampleX.length >= this.#capacity * this.#samples) return;

    const capacity = Math.max(shots, this.#capacity * 2, 16);
    const cells = capacity * this.#samples;
    const sampleX = new Float64Array(cells);
    const sampleY = new Float64Array(cells);
    // Only the shots already built this plan are worth carrying over; the rest
    // of the buffer is written before it is read.
    sampleX.set(this.#sampleX.subarray(0, Math.min(this.#sampleX.length, cells)));
    sampleY.set(this.#sampleY.subarray(0, Math.min(this.#sampleY.length, cells)));
    this.#sampleX = sampleX;
    this.#sampleY = sampleY;

    const sampleCount = new Int32Array(capacity);
    sampleCount.set(this.#sampleCount.subarray(0, Math.min(this.#sampleCount.length, capacity)));
    this.#sampleCount = sampleCount;

    this.#half = grow(this.#half, capacity);
    this.#drifts = grow(this.#drifts, capacity);
    this.#minX = grow(this.#minX, capacity);
    this.#minY = grow(this.#minY, capacity);
    this.#maxX = grow(this.#maxX, capacity);
    this.#maxY = grow(this.#maxY, capacity);
    this.#capacity = capacity;
  }
}

function grow(from: Float64Array<ArrayBuffer>, length: number): Float64Array<ArrayBuffer> {
  const to = new Float64Array(length);
  to.set(from.subarray(0, Math.min(from.length, length)));
  return to;
}
