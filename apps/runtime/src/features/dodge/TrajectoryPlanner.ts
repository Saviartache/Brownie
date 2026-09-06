/**
 * Receding-horizon trajectory optimization: roll a lot of futures, keep the best
 * first move.
 *
 * **Why this and not a search.** The previous generation was a weighted A* over
 * places and moments, and it was correct — but a shortest-path search is
 * answering "how do I get somewhere", and a dodge is not going anywhere. What it
 * actually has to decide is one action, right now, judged by what the next
 * second looks like if it takes it; the rest of the path is never walked,
 * because the plan twenty milliseconds from now re-decides it against shots that
 * have actually arrived. A search spends its whole budget refining a tail nobody
 * will ever act on, and pays for it with a lattice: its steps are quantised to
 * one tick of walking, so the smallest thing it can say is "most of a tile that
 * way" — which is the opposite of what this feature is for.
 *
 * **Sampling the first action directly is what buys the micro-dodge.** The
 * candidates here are a heading *and a distance*, down to a twentieth of a tile,
 * and every one of them is rolled the whole way to the horizon. Threading a
 * spiral is then an ordinary answer rather than something the lattice cannot
 * express, and "do not move at all" is a candidate that competes on the same
 * terms as the rest instead of being the search's start node.
 *
 * **Three continuations, and the cheapest of them is what a candidate is worth.**
 * A first action is only as good as what can still be done afterwards, and there
 * are exactly three things a dodge does next: come home, ride the pattern's
 * pocket, or keep going. Rolling each candidate under all three and keeping the
 * best is a claim the receding horizon actually supports — *there exists* a way
 * out from here — where insisting on one of them would reject the sidestep that
 * needs a second sidestep, and rejecting that is how a planner walks into a wall
 * of fire it could have crossed.
 *
 * **`MOVE` and `HOP` are both candidates, ranked on one scale.** They are
 * genuinely different actions and neither is an emergency version of the other:
 * a walk covers ground over a tick and can be turned part way through; a hop
 * spends one frame's allowance at once and is exact. What decides between them
 * is the same arithmetic that decides everything else — see `TrajectoryScore`.
 * The one asymmetry is at the small end, and it is the module's rather than a
 * preference: a walk is delivered as a heading the frame steps along, so
 * anything under {@link MIN_WALK_TILES} is not a distance a walk can express,
 * and a hop is. Which is why the smallest dodges in this feature are hops.
 *
 * **Coarse to fine.** Every heading is tried at a walk and two hops first; the
 * best few headings are then tried at every distance. A saturated screen
 * therefore costs about forty rollouts rather than four hundred, and the answer
 * is the same one nearly every time, because the cost surface in the heading is
 * smooth and the one in the distance is not.
 *
 * **And a rollout stops the moment it cannot win.** Every term in the cost model
 * is non-negative, so a future that has already cost more than the best complete
 * one can never come back — and in a saturated field that is nearly all of them,
 * because being hit on the first tick is priced above everything the remaining
 * seven could possibly be worth. Measured on a screen with a thousand shots on
 * it, abandoning those is about a third of what a plan costs.
 *
 * **Nothing here allocates.** The candidate table is typed arrays grown once,
 * the step record is rewritten in place, and the answer is a single object
 * rewritten every run.
 */

import { entersHazard, walkableBetween, type BlastField, type DodgeGround } from './DodgeGround.js';
import { NO_DANGER_TILES, type DangerField } from './DangerField.js';
import type { PocketLock } from './PocketLock.js';
import {
  decisionCost,
  stepCost,
  type TrajectoryStep,
  type TrajectoryWeights,
} from './TrajectoryScore.js';

/**
 * The shortest displacement a walk can be asked for, in tiles.
 *
 * **The module's arithmetic, not a preference.** A walk is published as an
 * offset the frame resolves against the character's live position and steps
 * along at whatever the frame's budget allows; a distance under about a quarter
 * of a tile is inside one frame of that at ordinary speeds, so the command
 * degenerates into "one frame's worth, in this direction" — which is a hop with
 * extra steps and no precision. Below this the planner uses the hop, which
 * carries exactly the offset it is given.
 */
export const MIN_WALK_TILES = 0.25;

/**
 * The distances a walk is offered at, as fractions of one tick's travel.
 *
 * Uneven on purpose: the interesting part of the range is the short end, where
 * a fifth of a tick is the difference between slipping between two arms and
 * stepping into the next one.
 */
const WALK_FRACTIONS = [0.25, 0.45, 0.7, 1] as const;

/**
 * And the coarse pass's, which is one: a whole tick of walking.
 *
 * The coarse pass is looking for the right *side* of the field, and every walk
 * along a heading agrees about that. Which distance is a question for the fine
 * pass, where it is asked of three headings instead of twelve.
 */
const COARSE_WALK_FRACTIONS = [1] as const;

/**
 * The distances a hop is offered at, as fractions of the hop's own reach.
 *
 * **This is where the twentieth of a tile lives.** A full hop is seven tenths of
 * a tile and can step clean over the only gap there was; the short ones are not
 * caution, they are the whole of the micro-dodge — a hop of a twentieth of a
 * tile is a real, exactly delivered movement, and it is very often all that a
 * spiral or a checkerboard actually asks for.
 */
const HOP_FRACTIONS = [0.07, 0.15, 0.3, 0.5, 0.75, 1] as const;

/**
 * And the coarse pass's two.
 *
 * Two rather than one because the hop is the action whose *distance* changes the
 * answer at this stage: a nudge that stays inside the ring the character fights
 * from and a leap that clears a line are different decisions, not two amounts of
 * the same one.
 */
const COARSE_HOP_FRACTIONS = [0.15, 1] as const;

/** How many headings the fine pass refines around. */
const REFINED_HEADINGS = 3;

/** The most headings the tables are ever built for. */
const MAX_HEADINGS = 64;

/** How the rest of the horizon is walked, once the first action is taken. */
const Continuation = {
  /** Back to the anchor, as fast as walking allows. The ordinary answer. */
  Home: 0,
  /** After the pattern's moving pocket. Only offered while one is locked. */
  Ride: 1,
  /** Straight on, the way the first step went. What crosses a wall of fire. */
  Carry: 2,
} as const;

type Continuation = (typeof Continuation)[keyof typeof Continuation];

/** In the order they are tried, cheapest-to-be-the-answer first. */
const CONTINUATIONS = [Continuation.Home, Continuation.Ride, Continuation.Carry] as const;

export interface TrajectoryRequest {
  readonly startX: number;
  readonly startY: number;
  /**
   * Where the character should be at slice nought, and how that moves per tick.
   *
   * **The DPS position, and keeping them on it is the whole of what this is
   * for.** Standing still it is where they are or where they said to stand;
   * walking, it is the line they are walking, one tick of it at a time.
   */
  readonly anchorX: number;
  readonly anchorY: number;
  readonly anchorStepX: number;
  readonly anchorStepY: number;
  /** How far one tick of walking covers, in tiles. */
  readonly stepTiles: number;
  /** How far one hop carries. Nought when the hop is not available at all. */
  readonly hopTiles: number;
  readonly ticks: number;
  readonly tickMs: number;
  /** How long before the plan takes effect. Slice nought sits here. */
  readonly leadMs: number;
  /** How many directions to consider, evenly spaced. */
  readonly headings: number;
  readonly weights: TrajectoryWeights;
  /**
   * The direction the last plan committed to, as a unit vector.
   *
   * Both nought when nothing is being held, which charges no reversal at all.
   */
  readonly holdDirX: number;
  readonly holdDirY: number;
  readonly ground: DodgeGround;
  readonly danger: DangerField;
  readonly blasts: BlastField | undefined;
  /** The pattern's gaps, when one is recognised. See `PocketLock`. */
  readonly pockets: PocketLock | undefined;
  /** The most candidates one plan may roll out. */
  readonly budget: number;
}

/** Where the optimizer came out. Owned by it and rewritten every run. */
export interface DodgeTrajectory {
  /** Unit direction of the first action. Both zero means "stand, deliberately". */
  readonly dirX: number;
  readonly dirY: number;
  /** How far that action displaces the character, in tiles. */
  readonly stepTiles: number;
  /** Whether it is spent as one frame of movement rather than as a walk. */
  readonly hop: boolean;
  /**
   * Plan-relative milliseconds at which the trajectory is first hit, or
   * `Infinity`.
   *
   * The *start* of the tick that lands, not its end: a hit somewhere inside a
   * tick is a hit the caller has until the beginning of that tick to answer, and
   * rounding it the other way reads as more time than there is.
   */
  readonly impactMs: number;
  /** The least room it ever has. `Infinity` when nothing came near. */
  readonly clearanceTiles: number;
  /** How far it ends from where the character should have been. */
  readonly driftTiles: number;
  /** What it cost. */
  readonly cost: number;
  /** How many candidates were rolled out getting there. */
  readonly evaluated: number;
  /** Whether the winner was one aimed at a recognised pattern's gap. */
  readonly ridingPocket: boolean;
}

export class TrajectoryPlanner {
  readonly #headingX = new Float64Array(MAX_HEADINGS);
  readonly #headingY = new Float64Array(MAX_HEADINGS);
  #headings = 0;

  /** Rewritten per tick of every rollout. */
  readonly #step: TrajectoryStep = {
    anchorTiles: 0,
    fromAnchorTiles: 0,
    travelTiles: 0,
    clearanceTiles: NO_DANGER_TILES,
    hitDamage: 0,
    hitDebuff: 0,
    crowdingTiles: 0,
    hazardGapTiles: NO_DANGER_TILES,
    ticksLeft: 0,
  };

  /** What the rollout in progress has found. Read back by {@link #consider}. */
  #rollCost = 0;
  #rollImpactMs = Infinity;
  #rollRoom = NO_DANGER_TILES;
  #rollDriftTiles = 0;

  readonly #best = {
    dirX: 0,
    dirY: 0,
    stepTiles: 0,
    hop: false,
    impactMs: Infinity,
    clearanceTiles: NO_DANGER_TILES,
    driftTiles: 0,
    cost: Infinity,
    evaluated: 0,
    ridingPocket: false,
  };
  /** Which heading the winner came from, for the fine pass to refine around. */
  #bestHeading = -1;
  #evaluated = 0;
  /** How far the character is standing from ground that hurts, this plan. */
  #startGap = NO_DANGER_TILES;

  /** Forgets the last run. Nothing here survives a change of map. */
  reset(): void {
    this.#best.cost = Infinity;
    this.#bestHeading = -1;
    this.#evaluated = 0;
  }

  /**
   * Finds the action to take, and reports it.
   *
   * **Only the first action is ever acted on**, and that is not a shortcoming:
   * what the rest of the rollout is for is telling a gap with a way on from a
   * gap with a rank behind it, which no amount of staring at one step can do.
   */
  run(request: TrajectoryRequest): DodgeTrajectory {
    this.#buildHeadings(request.headings);
    this.#best.cost = Infinity;
    this.#best.dirX = 0;
    this.#best.dirY = 0;
    this.#best.stepTiles = 0;
    this.#best.hop = false;
    this.#best.ridingPocket = false;
    this.#bestHeading = -1;
    this.#evaluated = 0;
    // **Asked once, because it is one question.** How far the character is
    // standing from ground that hurts is the same number for every candidate and
    // every tick nought of every rollout, and answering it scans a box of tiles
    // where the other ground queries are a single lookup. Once per plan rather
    // than a hundred and fifty times.
    this.#startGap = request.ground.hazardGapTiles(request.startX, request.startY);

    // **Standing still is candidate nought and always available.** It is the
    // floor every other candidate has to beat, it is very often the answer, and
    // it is the reason the optimizer can never come back empty-handed.
    this.#offerHold(request);
    this.#coarse(request);
    this.#pocketAimed(request);
    this.#fine(request);

    const best = this.#best;
    best.evaluated = this.#evaluated;
    return best;
  }

  /**
   * Walks the course the player is already on, to see whether it needs
   * answering.
   *
   * **The cheap question, and the one the caller asks first.** It is a handful
   * of queries rather than a few thousand, and on the great majority of plans
   * its answer is "leave them alone", which is the whole of the work. See
   * `DodgePlanner`.
   *
   * **Its own loop rather than a rollout, because it wants different numbers.**
   * A candidate is worth a cost; a probe is worth four facts, two of which are
   * about the *reaction window* rather than the horizon — and threading those
   * through the rollout would be two branches in the one loop that cannot afford
   * any. There is no cost function here at all, which is also why the two cannot
   * disagree: they are not comparing anything.
   *
   * The answer is left in {@link probeImpactMs} and its companions rather than
   * returned, because a record per plan is an allocation per plan.
   *
   * @param withinMs How soon trouble has to be to be this moment's problem.
   */
  probe(request: TrajectoryRequest, dirX: number, dirY: number, withinMs: number): void {
    let x = request.startX;
    let y = request.startY;
    this.#probeImpactMs = Infinity;
    this.#probeRoomTiles = NO_DANGER_TILES;
    this.#probeUrgentTiles = NO_DANGER_TILES;
    // Where they are now counts: a player standing in a pool is one the planner
    // has to answer for whether or not they are walking anywhere.
    this.#probeHazardTiles = request.ground.hazardGapTiles(x, y);

    const moving = dirX !== 0 || dirY !== 0;
    for (let tick = 0; tick < request.ticks; tick += 1) {
      const startsMs = request.leadMs + tick * request.tickMs;
      const toX = moving ? x + dirX * request.stepTiles : x;
      const toY = moving ? y + dirY * request.stepTiles : y;
      // A course into a wall simply stops there; the game's own collision does
      // the same, and calling it a hit would have the planner seizing the wheel
      // over geometry.
      const walkable = !moving || request.ground.canStand(toX, toY);
      const endX = walkable ? toX : x;
      const endY = walkable ? toY : y;

      let room = request.danger.clearanceOf(tick, x, y, endX, endY);
      if (request.blasts !== undefined) {
        const blast = request.blasts.clearanceAt(endX, endY, startsMs, startsMs + request.tickMs);
        if (blast < room) room = blast;
      }
      if (room < this.#probeRoomTiles) this.#probeRoomTiles = room;
      if (startsMs < withinMs && room < this.#probeUrgentTiles) this.#probeUrgentTiles = room;
      if (room < 0 && this.#probeImpactMs === Infinity) this.#probeImpactMs = startsMs;

      // Only while the window is open. A course that walks into a pool two
      // seconds from now is somebody walking somewhere, and the plan that is
      // made when they get there is the one that has to answer for it.
      if (startsMs < withinMs) {
        const gap = request.ground.hazardGapTiles(endX, endY);
        if (gap < this.#probeHazardTiles) this.#probeHazardTiles = gap;
      }

      x = endX;
      y = endY;
    }
  }

  #probeImpactMs = Infinity;
  #probeRoomTiles = NO_DANGER_TILES;
  #probeUrgentTiles = NO_DANGER_TILES;
  #probeHazardTiles = NO_DANGER_TILES;

  /** When the probed course is first hit, from now, or `Infinity`. */
  get probeImpactMs(): number {
    return this.#probeImpactMs;
  }

  /** The least room it ever has, over the whole horizon. */
  get probeRoomTiles(): number {
    return this.#probeRoomTiles;
  }

  /**
   * And the least it has inside the reaction window.
   *
   * **Two numbers about room, not one.** A bullet due to pass a tile away in
   * nine hundred milliseconds is almost always the tighter of the two in a busy
   * fight, and acting on it is how a planner comes to answer the far shot while
   * the near one arrives.
   */
  get probeUrgentTiles(): number {
    return this.#probeUrgentTiles;
  }

  /** The least room the course leaves itself from ground that hurts. */
  get probeHazardTiles(): number {
    return this.#probeHazardTiles;
  }

  /**
   * Standing exactly here — now, and for as long as that keeps working.
   *
   * **Holding is the only candidate that cannot say "and then I move", and
   * without that it is the only one that cannot say anything.** Every other
   * candidate has a direction, so its `Carry` continuation is a full-speed run
   * the rest of the horizon can be judged against; holding has none, so its
   * futures were "stand here and be hit" — which made standing still look fatal
   * in every situation a step later would have solved, and had the planner
   * twitching a fiftieth of a tile a whole horizon before it needed to move at
   * all.
   *
   * So the ring is rolled *from the second tick*: hold now, run then. It is what
   * makes the planner patient, which is the whole of "move as little as
   * possible" — a shot half a second away is answered by a shot half a second
   * away, not by leaning away from it now.
   *
   * A dozen rollouts, and they are the cheapest in the plan: nothing moves on
   * the first tick, so the first tick's queries are the same query every time.
   */
  #offerHold(request: TrajectoryRequest): void {
    this.#consider(request, 0, 0, 0, false, -1);
    // Every other heading, because what this is asking is whether *some* escape
    // is still open a tick from now, and half a ring answers that: a direction
    // between two spokes is within fifteen degrees of one of them, which over
    // seven ticks of running is well inside the width of a gap.
    for (let i = 0; i < this.#headings; i += 2) {
      this.#considerDelayed(request, this.#headingX[i] ?? 0, this.#headingY[i] ?? 0);
    }
  }

  /**
   * Holding this tick and running that way from the next one.
   *
   * Reported as holding, because that is the move that would actually be
   * commanded — the rest is what the next plan will still be able to do, which
   * is the only thing any continuation ever is.
   */
  #considerDelayed(request: TrajectoryRequest, carryX: number, carryY: number): void {
    if (this.#evaluated >= request.budget) return;
    this.#evaluated += 1;
    this.#roll(request, 0, 0, 0, false, Continuation.Carry, carryX, carryY, this.#best.cost);
    if (!(this.#rollCost < this.#best.cost)) return;
    this.#best.cost = this.#rollCost;
    this.#best.dirX = 0;
    this.#best.dirY = 0;
    this.#best.stepTiles = 0;
    this.#best.hop = false;
    this.#best.impactMs = this.#rollImpactMs;
    this.#best.clearanceTiles = this.#rollRoom;
    this.#best.driftTiles = this.#rollDriftTiles;
    this.#best.ridingPocket = false;
  }

  /**
   * Every heading at two distances apiece, walking and hopping.
   *
   * The cost surface in the heading is smooth — two neighbouring directions
   * differ by a few hundredths of a tile of room — so a coarse sweep finds the
   * right *side* of the field reliably, and the fine pass is what finds the
   * distance, where the surface is not smooth at all.
   */
  #coarse(request: TrajectoryRequest): void {
    for (let i = 0; i < this.#headings; i += 1) {
      const dirX = this.#headingX[i] ?? 0;
      const dirY = this.#headingY[i] ?? 0;
      for (const fraction of COARSE_WALK_FRACTIONS) {
        const distance = request.stepTiles * fraction;
        if (distance < MIN_WALK_TILES) continue;
        this.#consider(request, dirX, dirY, distance, false, i);
      }
      if (request.hopTiles <= 0) continue;
      for (const fraction of COARSE_HOP_FRACTIONS) {
        this.#consider(request, dirX, dirY, request.hopTiles * fraction, true, i);
      }
    }
  }

  /**
   * Every distance, around the headings the coarse pass liked.
   *
   * **Where the micro-dodge is actually found.** Between a twentieth of a tile
   * and a whole tick's walk there are half a dozen genuinely different answers,
   * and which of them is right turns on where one arm of a spiral is against
   * where the next one will be — a surface with a step in it, not a slope.
   */
  #fine(request: TrajectoryRequest): void {
    if (this.#bestHeading < 0 || this.#headings === 0) return;
    const centre = this.#bestHeading;
    const half = REFINED_HEADINGS >> 1;
    for (let offset = -half; offset <= half; offset += 1) {
      const i = (centre + offset + this.#headings) % this.#headings;
      const dirX = this.#headingX[i] ?? 0;
      const dirY = this.#headingY[i] ?? 0;
      for (const fraction of WALK_FRACTIONS) {
        const distance = request.stepTiles * fraction;
        if (distance < MIN_WALK_TILES) continue;
        this.#consider(request, dirX, dirY, distance, false, i);
      }
      if (request.hopTiles <= 0) continue;
      for (const fraction of HOP_FRACTIONS) {
        this.#consider(request, dirX, dirY, request.hopTiles * fraction, true, i);
      }
    }
  }

  /**
   * Straight at the gap the recognised pattern will have.
   *
   * **A handful of candidates, and they are the ones the ring cannot offer.**
   * The pocket is at a particular bearing and a particular distance, and neither
   * is likely to be exactly on the heading ring — so aiming at it directly is
   * what turns "the arms are sweeping this way" into a step of the right size in
   * the right direction. It is still only a candidate: whether that step is safe
   * is the danger field's answer, so a misread pattern costs a rollout.
   */
  #pocketAimed(request: TrajectoryRequest): void {
    const pockets = request.pockets;
    if (pockets === undefined || pockets.slices < 2) return;

    const toX = pockets.xOf(1) - request.startX;
    const toY = pockets.yOf(1) - request.startY;
    const distance = Math.hypot(toX, toY);
    if (!(distance > 1e-4)) return;
    const dirX = toX / distance;
    const dirY = toY / distance;

    // Walked if it is far enough to be a walk, and hopped besides — the pocket
    // is very often a fraction of a tile away, which is exactly the range only a
    // hop can deliver.
    const walk = Math.min(distance, request.stepTiles);
    if (walk >= MIN_WALK_TILES) this.#consider(request, dirX, dirY, walk, false, -1);
    if (request.hopTiles > 0) {
      this.#consider(request, dirX, dirY, Math.min(distance, request.hopTiles), true, -1);
    }
  }

  /**
   * Rolls one candidate under every continuation, and keeps it if it wins.
   *
   * The continuations are tried in order of how likely each is to be the cheap
   * one; a candidate is worth the best of them, because the receding horizon's
   * claim is that *some* way out exists from here, not that a particular one
   * does.
   */
  #consider(
    request: TrajectoryRequest,
    dirX: number,
    dirY: number,
    distance: number,
    hop: boolean,
    heading: number,
  ): void {
    if (this.#evaluated >= request.budget) return;
    // **A move the ground refuses is not a cheap move, it is not a move**, and
    // the difference is the whole of a bug this feature shipped with: a
    // candidate whose first step ran into a wall was *rolled* as though it had
    // stood still — which is safe, and cheap, and very often the best answer
    // available — and then *commanded* as the step it never took. The character
    // walked into the wall at full speed for as long as the record stood.
    //
    // So the geometry is asked before anything is priced, and a first action
    // that does not fit is dropped. Standing still is already a candidate; it
    // does not need a second entry wearing a heading.
    if (distance > 0 && !this.#fits(request, dirX, dirY, distance)) return;
    this.#evaluated += 1;

    const held = request.holdDirX !== 0 || request.holdDirY !== 0;
    const along = held && distance > 0 ? dirX * request.holdDirX + dirY * request.holdDirY : 1;
    const decision = decisionCost(request.weights, hop, along);

    let cost = Infinity;
    let impactMs = Infinity;
    let room = NO_DANGER_TILES;
    let drift = 0;

    // **Standing still has one future, not three**, and rolling it three times
    // is three times the work for one answer: carrying on goes nowhere, and
    // riding a pocket from a candidate that has not moved is the walk home by
    // another name. Only a candidate that actually displaces the character has
    // continuations that differ.
    // **What this candidate has to beat**, which is what lets a rollout stop the
    // moment it cannot: the best complete future so far, less what the decision
    // itself already costs.
    const bound = this.#best.cost - decision;
    for (const mode of CONTINUATIONS) {
      if (mode !== Continuation.Home && distance <= 0) break;
      if (
        mode === Continuation.Ride &&
        (request.pockets === undefined || request.pockets.slices === 0)
      ) {
        continue;
      }
      this.#roll(request, dirX, dirY, distance, hop, mode, dirX, dirY, cost < bound ? cost : bound);
      if (this.#rollCost >= cost) continue;
      cost = this.#rollCost;
      impactMs = this.#rollImpactMs;
      room = this.#rollRoom;
      drift = this.#rollDriftTiles;
    }

    const total = cost + decision;
    if (!(total < this.#best.cost)) return;
    this.#best.cost = total;
    this.#best.dirX = distance > 0 ? dirX : 0;
    this.#best.dirY = distance > 0 ? dirY : 0;
    this.#best.stepTiles = distance;
    this.#best.hop = hop && distance > 0;
    this.#best.impactMs = impactMs;
    this.#best.clearanceTiles = room;
    this.#best.driftTiles = drift;
    this.#best.ridingPocket = heading < 0 && distance > 0;
    if (heading >= 0) this.#bestHeading = heading;
  }

  /**
   * Whether the ground allows the first action at all.
   *
   * **Every place the body passes through, not two of them.** A tick of walking
   * is most of a tile and a hop is the better part of one, so a wall thinner
   * than the step sits entirely between the two ends of it — and a corner
   * clipped diagonally is thinner still. The samples are spaced under the body's
   * own width, which is what makes "the path is clear" mean the path rather than
   * a few points along it. See {@link walkableBetween}.
   *
   * **The hazard ratchet stays at two points**, and deliberately: a pool is a
   * region rather than a tile, the test is a *distance* from one rather than a
   * membership in it, and each of those queries scans a box of tiles where a
   * walkability query is one lookup. The end and the middle are what that can
   * afford, and what a pool's size makes sufficient.
   */
  #fits(request: TrajectoryRequest, dirX: number, dirY: number, distance: number): boolean {
    const toX = request.startX + dirX * distance;
    const toY = request.startY + dirY * distance;
    if (!walkableBetween(request.ground, request.startX, request.startY, toX, toY)) return false;

    const gap = request.ground.hazardGapTiles(toX, toY);
    const middle = request.ground.hazardGapTiles(
      (request.startX + toX) / 2,
      (request.startY + toY) / 2,
    );
    return !entersHazard(this.#startGap, gap, middle, request.weights.hazardClearTiles);
  }

  /**
   * Walks one candidate the whole way to the horizon, and prices every tick.
   *
   * **The one hot loop in the feature.** Everything it touches is either a
   * number on the stack or a typed array; the only calls out of it are the four
   * questions about the ground and the one about the danger field, and those are
   * exactly the ones nothing here can answer for itself.
   */
  #roll(
    request: TrajectoryRequest,
    dirX: number,
    dirY: number,
    distance: number,
    hop: boolean,
    mode: Continuation,
    carryX: number,
    carryY: number,
    bound: number,
  ): void {
    const weights = request.weights;
    const step = this.#step;
    let x = request.startX;
    let y = request.startY;
    let total = 0;
    this.#rollImpactMs = Infinity;
    this.#rollRoom = NO_DANGER_TILES;

    for (let tick = 0; tick < request.ticks; tick += 1) {
      const next = tick + 1;
      const startsMs = request.leadMs + tick * request.tickMs;
      const arriveMs = startsMs + request.tickMs;
      // Tick nought always begins where the plan does, so its answer is the one
      // the run took once. See {@link #startGap}.
      const fromGap = tick === 0 ? this.#startGap : request.ground.hazardGapTiles(x, y);

      // Where this tick wants to end up: the candidate's own displacement on the
      // first one, and whatever the continuation asks for after that.
      let wantX = x;
      let wantY = y;
      let reach = 0;
      if (tick === 0) {
        wantX = x + dirX * distance;
        wantY = y + dirY * distance;
        reach = distance;
      } else {
        reach = request.stepTiles;
        if (mode === Continuation.Carry) {
          wantX = x + carryX * reach;
          wantY = y + carryY * reach;
        } else {
          const towardX =
            mode === Continuation.Ride &&
            request.pockets !== undefined &&
            next < request.pockets.slices
              ? request.pockets.xOf(next)
              : request.anchorX + request.anchorStepX * next;
          const towardY =
            mode === Continuation.Ride &&
            request.pockets !== undefined &&
            next < request.pockets.slices
              ? request.pockets.yOf(next)
              : request.anchorY + request.anchorStepY * next;
          const gapX = towardX - x;
          const gapY = towardY - y;
          const away = Math.hypot(gapX, gapY);
          if (away > 1e-6) {
            const travel = away < reach ? away : reach;
            wantX = x + (gapX / away) * travel;
            wantY = y + (gapY / away) * travel;
            reach = travel;
          } else {
            reach = 0;
          }
        }
      }

      // **Geometry refuses the movement rather than shortening it**, and the
      // character stands where they were: what a continuation would actually
      // meet is another plan, made from wherever the character has got to, so
      // modelling a partial step would be modelling a decision nothing will
      // ever command.
      //
      // **The first tick is not asked, because it has already been answered.**
      // A candidate the ground refuses is dropped before it is rolled — see
      // {@link #fits} — so asking again here would be the same three queries
      // per rollout, for a candidate that cannot reach this loop unless the
      // answer was yes. What is still needed from the first tick is the
      // distance from a pool, because the cost is charged on it.
      let toX = wantX;
      let toY = wantY;
      let travelTiles = reach;
      let gap = fromGap;
      if (travelTiles > 0) {
        gap = request.ground.hazardGapTiles(toX, toY);
        if (tick > 0) {
          const midX = (x + toX) / 2;
          const midY = (y + toY) / 2;
          const middle = request.ground.hazardGapTiles(midX, midY);
          if (
            !walkableBetween(request.ground, x, y, toX, toY) ||
            entersHazard(fromGap, gap, middle, weights.hazardClearTiles)
          ) {
            toX = x;
            toY = y;
            travelTiles = 0;
            gap = fromGap;
          }
        }
      }

      // **A hop is measured where it lands, and a walk along the way it
      // went.** The game tests collision at a position once a frame, so a
      // displacement spent inside one frame does not touch what it crossed —
      // which is exactly why hopping *through* a line of fire is a real answer
      // and walking through one is not. Sweeping the travel as well would price
      // a hop for the shot it is escaping, since every hop starts from a place
      // the shot is already reaching, and no escape would ever be affordable.
      //
      // What it is still measured for is the rest of the tick: the character
      // stands at the landing place until the next plan, so the arm arriving
      // there a moment later is the hop's problem and not somebody else's.
      const instant = tick === 0 && hop && travelTiles > 0;
      let clearance = instant
        ? request.danger.clearanceOf(tick, toX, toY, toX, toY)
        : request.danger.clearanceOf(tick, x, y, toX, toY);
      let hitDamage = request.danger.worstDamage;
      let hitDebuff = request.danger.worstDebuff;
      // **And a hop's landing is judged from *now*, not from the moment the
      // model assumes the command arrives.** `leadMs` is an upper bound on the
      // round trip rather than a measurement of it, so a command that lands
      // sooner than assumed puts the character somewhere the shots have not
      // left yet. A walk errs safe under the same mistake — it simply covers
      // less ground than planned — and a hop covers all of it at once, into a
      // place chosen for where the shots were going to be.
      if (instant) {
        const lead = request.danger.leadSlice;
        if (lead >= 0) {
          const arriving = request.danger.clearanceOf(lead, toX, toY, toX, toY);
          if (arriving < clearance) {
            clearance = arriving;
            hitDamage = request.danger.worstDamage;
            hitDebuff = request.danger.worstDebuff;
          }
        }
      }
      let room = clearance;
      if (request.blasts !== undefined) {
        // Merged rather than reported beside it: "how much room did this tick
        // have" has one answer whatever is taking the room, and a blast that
        // catches a tick is exactly as much an impact as a bullet that does.
        const blast = request.blasts.clearanceAt(toX, toY, startsMs, arriveMs);
        if (blast < room) {
          room = blast;
          hitDamage = 0;
          hitDebuff = 0;
        }
      }

      const anchorAtX = request.anchorX + request.anchorStepX * next;
      const anchorAtY = request.anchorY + request.anchorStepY * next;
      step.anchorTiles = Math.hypot(toX - anchorAtX, toY - anchorAtY);
      step.fromAnchorTiles = Math.hypot(
        x - (request.anchorX + request.anchorStepX * tick),
        y - (request.anchorY + request.anchorStepY * tick),
      );
      step.travelTiles = travelTiles;
      step.clearanceTiles = room;
      step.hitDamage = hitDamage;
      step.hitDebuff = hitDebuff;
      step.crowdingTiles = request.ground.crowdingAt(toX, toY, arriveMs);
      step.hazardGapTiles = gap;
      step.ticksLeft = request.ticks - next;
      total += stepCost(weights, step);

      if (room < 0 && startsMs < this.#rollImpactMs) this.#rollImpactMs = startsMs;
      if (room < this.#rollRoom) this.#rollRoom = room;

      x = toX;
      y = toY;

      // **Beaten already, and every term still to come is non-negative.** A
      // future priced over fewer ticks is not comparable to one priced over all
      // of them, so it is not reported as a cheaper answer — it is reported as
      // no answer at all, which is what it is.
      if (total >= bound) {
        this.#rollCost = Infinity;
        this.#rollDriftTiles = 0;
        return;
      }
    }

    this.#rollCost = total;
    this.#rollDriftTiles = Math.hypot(
      x - (request.anchorX + request.anchorStepX * request.ticks),
      y - (request.anchorY + request.anchorStepY * request.ticks),
    );
  }

  /** The evenly spaced ring of directions, rebuilt only when the count changes. */
  #buildHeadings(count: number): void {
    const wanted = Math.max(4, Math.min(MAX_HEADINGS, Math.round(count)));
    if (wanted === this.#headings) return;
    this.#headings = wanted;
    for (let i = 0; i < wanted; i += 1) {
      const angle = (i * 2 * Math.PI) / wanted;
      this.#headingX[i] = Math.cos(angle);
      this.#headingY[i] = Math.sin(angle);
    }
  }
}
