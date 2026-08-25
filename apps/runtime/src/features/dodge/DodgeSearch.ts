/**
 * The search: a weighted A* over places and moments.
 *
 * **Why a search at all, when the last four generations of this feature were
 * not one.** A straight course is a heading and a distance, and there are
 * patterns with no straight line through them at all — offset ranks, a fan from
 * two sources, a checkerboard. Every candidate then reads as hit, which reads as
 * "no way through", which starts a run away from a pattern a person would have
 * walked into. The previous generation answered that by looking one step past
 * the end of each course and calling it a second leg; a second leg is a search
 * with its depth hard-coded to two, and the honest version of it costs less and
 * describes the whole horizon.
 *
 * **The state is a place *and* a moment, and it has to be both.** Where it is
 * safe to stand is entirely a function of when you are standing there, so a
 * search over places alone is answering a different question. Slice `k` is the
 * moment `leadMs + k · tickMs` from now; a step from `k` to `k + 1` is the
 * character walking in a straight line for one tick, and the shots are sampled
 * on exactly those instants so the two can be swept against each other exactly.
 *
 * **Weighted and never re-expanding — which is what makes it fast.** The
 * estimate in {@link remainingAnchorCost} is consistent, so multiplying it by
 * `greed` leaves the search bounded without needing to revisit anything it has
 * already settled. A plan is made fifty times a second and thrown away before it
 * is walked; a route within half a step of the best one, found in a fifth of the
 * expansions, is strictly the better trade.
 *
 * **And it always has a complete answer to fall back on**, which is
 * {@link #scanStraight}: twelve straight runs, priced on exactly the same terms,
 * costing about one per cent of the search's own budget. That is not a
 * heuristic beside the search — it is a handful of extra candidates, and
 * "whichever is cheaper" is therefore a statement about one quantity. It is
 * also what the search *needs*, twice over: a wall of fire is escaped by
 * running and A* cannot afford to discover that, and a budget that runs out
 * would otherwise leave a route priced over fewer steps than the one it is
 * being compared against — which is how a character came to stand in the middle
 * of a crossfire for a whole fight.
 *
 * **Standing still is always a legal move**, so the horizon is always reachable
 * and the search cannot come back empty-handed. Being hit is priced rather than
 * forbidden — see {@link StepWeights.hitPerStep} — so a fight with no way out
 * still yields the route that is hit latest and least, instead of an exhausted
 * open list and a special case to go with it.
 *
 * **What is deliberately not here.** No goal, no destination, no orbit and
 * nothing about weapon range. The search has one job, which is to be somewhere
 * survivable a second from now without having been dragged off the ground the
 * player chose. Where to *go* is theirs, always.
 */

import { SearchQueue } from './SearchQueue.js';
import { remainingAnchorCost, stepCost, type StepWeights } from './StepCost.js';
import { NO_THREAT_TILES, type ThreatIndex } from './ThreatIndex.js';

/** What the search needs of the map. Implemented by `DodgeScene`. */
export interface DodgeGround {
  /** Whether the player's whole body fits here — walls, objects, unknown map. */
  canStand(x: number, y: number): boolean;
  /** Whether a body here would be standing on ground that costs health. */
  isDamaging(x: number, y: number): boolean;
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
   * and once per landing place rather than per edge — see `Hop` and
   * `DodgePlanner`, which are the two callers that need to know whether
   * something is standing *in* the character rather than merely near them.
   */
  contactAt(x: number, y: number, aheadMs: number): number;
}

/** What the search needs of the area effects on their way down. */
export interface BlastField {
  /**
   * The least room a body standing at a place has, over a window of time.
   *
   * `Infinity` when nothing goes off near it in that window — a blast threatens
   * one place at one instant and nothing at all before or after it.
   */
  clearanceAt(x: number, y: number, fromMs: number, toMs: number): number;
}

export interface SearchRequest {
  readonly startX: number;
  readonly startY: number;
  /**
   * Where the character should be at slice nought, and how that moves per tick.
   *
   * **Their own ground, and keeping them on it is the whole of what the search
   * is for.** Standing still, it is where they are; walking, it is the line they
   * are walking, one step of it per tick. See `StepCost`.
   */
  readonly anchorX: number;
  readonly anchorY: number;
  readonly anchorStepX: number;
  readonly anchorStepY: number;
  /** How far one tick of walking covers, in tiles. */
  readonly stepTiles: number;
  readonly ticks: number;
  readonly tickMs: number;
  /** How long before the plan takes effect. Slice nought sits here. */
  readonly leadMs: number;
  /** How many directions to consider, evenly spaced. */
  readonly headings: number;
  readonly weights: StepWeights;
  /** How much the estimate is inflated. One is exact; above it is faster. */
  readonly greed: number;
  /** The most nodes to expand before answering with the best found so far. */
  readonly maxExpansions: number;
  /**
   * The direction the last plan committed to, as a unit vector.
   *
   * **Not a lock — a thumb on the scale, and only on the first step.** The
   * danger field shifts a little every plan, so two near-equal routes swap
   * places on noise, which looks like and is a character vibrating. Charging a
   * first step for disagreeing with the one already being walked settles that
   * with one term, where the previous generation needed a dwell timer, a break
   * threshold and a rule for when the commitment could be overruled.
   */
  readonly holdDirX: number;
  readonly holdDirY: number;
  /**
   * What a complete reversal of {@link holdDirX} costs.
   *
   * **Nought when there is nothing being held**, which the caller says by
   * passing nought rather than by passing a direction of nought — an
   * unrecognised direction would otherwise charge every moving first step the
   * same amount, which is a constant nobody can see and nobody meant.
   */
  readonly holdBias: number;
  readonly ground: DodgeGround;
  readonly threats: ThreatIndex;
  readonly blasts: BlastField | undefined;
}

/** Where the search came out. Owned by the search and rewritten every run. */
export interface DodgeRoute {
  /** Unit direction of the first step. Both zero means "stand, deliberately". */
  readonly dirX: number;
  readonly dirY: number;
  /** How far that first step walks before stopping, in tiles. */
  readonly stepTiles: number;
  /**
   * Plan-relative milliseconds at which the route is first hit, or `Infinity`.
   *
   * The *start* of the step that lands, not its end: a hit somewhere inside a
   * tick is a hit the caller has until the beginning of that tick to answer, and
   * rounding it the other way is the one direction that reads as more time than
   * there is.
   */
  readonly impactMs: number;
  /** The least room the route ever has. `Infinity` when nothing came near. */
  readonly clearanceTiles: number;
  /** How far the route ends from where the character should have been. */
  readonly driftTiles: number;
  /**
   * How far ahead the route actually reached, in slices.
   *
   * Short of `ticks` only when the budget ran out, and worth reading before
   * {@link impactMs}: a route that stopped early has not been shown to survive
   * the rest, whatever it says about the part it did cover.
   */
  readonly depth: number;
  /** What it cost, for a caller comparing it against another. */
  readonly cost: number;
  /** How many nodes were expanded getting there. */
  readonly expansions: number;
}

/**
 * How finely two routes' positions are told apart, as a fraction of a step.
 *
 * **The dedup, and the only reason the search is affordable.** Twelve headings
 * over eight ticks describe billions of distinct paths and a few hundred
 * distinct *places*; two that end up within a third of a step of each other at
 * the same moment are the same decision, and keeping only the cheaper is what
 * collapses the one number into the other. Finer would split decisions nothing
 * downstream can act on — the command is a walk, with a server between it and
 * the character.
 */
const CELL_FRACTION = 0.5;

/** How wide a lattice the packed state key can describe, in cells either way. */
const CELL_RANGE = 512;
const CELL_SPAN = CELL_RANGE * 2;
const SLICE_SPAN = 64;

/** The most headings the tables are ever built for. */
const MAX_HEADINGS = 64;

/**
 * How much a deeper node is preferred by, in the cost model's own units.
 *
 * **The one thing that stops an easy plan spending its whole budget.** Near the
 * anchor the estimate is nought and so is most of the cost, so every state in a
 * tile-wide cloud around the character ties at nearly the same `f` — and A* has
 * to expand all of them before it reaches the depth where an answer lives.
 * Measured with a single shot in the air, that was **the budget exhausted on
 * half of the plans that searched at all**, which then fell through to the
 * straight run and had the character travelling twice as far as it needed to.
 *
 * **It is an inflation, not a tiebreak, and that is deliberate.** Subtracting a
 * constant per level leaves the ordering *within* each level exactly as it was
 * and biases only across them, so the search dives through the cheap cloud
 * instead of sweeping it. What it costs is the `greed` bound: a route may now be
 * up to this much per level worse than the best one. What replaces that promise
 * is {@link #scanStraight} — whatever the search comes back with is only taken
 * when it beats a complete route that was priced exactly.
 *
 * A tile-tick, which is the size of an ordinary step's worth of deviation.
 * **Measured**: at nought the budget was exhausted on half the light plans; at
 * one it is exhausted on none of them and the fight measurements are at their
 * best; at four the character starts committing to routes that are visibly
 * worse, and both the hits and the time spent inside monsters go back up.
 */
const DEPTH_PULL = 1;

export class DodgeSearch {
  readonly #open = new SearchQueue();
  /** Which node holds each visited state. Cleared per run. */
  readonly #seen = new Map<number, number>();

  readonly #headingX = new Float64Array(MAX_HEADINGS);
  readonly #headingY = new Float64Array(MAX_HEADINGS);
  #headings = 0;

  #x = new Float64Array(0);
  #y = new Float64Array(0);
  #slice = new Int32Array(0);
  #parent = new Int32Array(0);
  #g = new Float64Array(0);
  /** The earliest hit anywhere along the route to this node, or `Infinity`. */
  #impact = new Float64Array(0);
  /** And the least room it ever had. */
  #room = new Float64Array(0);
  #closed = new Uint8Array(0);
  #nodes = 0;

  /**
   * What every move out of the node being expanded shares.
   *
   * Written once per expansion rather than passed down: the alternative is a
   * twenty-argument call in the hottest loop the feature has, or a record built
   * per move, and a plan makes a few thousand of them.
   */
  #fromX = 0;
  #fromY = 0;
  #fromG = 0;
  #fromImpact = Infinity;
  #fromRoom = NO_THREAT_TILES;
  #step = 0;
  #next = 0;
  #stepsLeft = 0;
  #startsMs = 0;
  #arriveMs = 0;
  #anchorX = 0;
  #anchorY = 0;
  #cell = 1;
  #closePerStep = 1;
  /** The room the last {@link #priceOf} measured. See its note. */
  #priced = NO_THREAT_TILES;

  /** The best straight run of the current plan, filled by {@link #scanStraight}. */
  #runCost = Infinity;
  #runDirX = 0;
  #runDirY = 0;
  #runStepTiles = 0;
  #runImpactMs = Infinity;
  #runRoom = NO_THREAT_TILES;
  #runDriftTiles = 0;

  readonly #route = {
    dirX: 0,
    dirY: 0,
    stepTiles: 0,
    impactMs: Infinity,
    clearanceTiles: Infinity,
    driftTiles: 0,
    depth: 0,
    cost: 0,
    expansions: 0,
  };

  /** Forgets the last run. Nothing here survives a change of map. */
  reset(): void {
    this.#seen.clear();
    this.#open.clear();
    this.#nodes = 0;
  }

  /**
   * Finds the route, and reports its first step.
   *
   * **Only the first step is ever acted on**, and that is not a shortcoming —
   * the plan twenty milliseconds from now re-decides the rest of it against
   * shots that have actually arrived. What the rest of the route is for is
   * telling a gap with a way on from a gap with a rank behind it, which no
   * amount of staring at the first step alone can do.
   */
  run(request: SearchRequest): DodgeRoute {
    const ticks = Math.max(1, Math.min(SLICE_SPAN - 1, request.ticks));
    this.#buildHeadings(request.headings);
    // Every expansion offers standing still and one move per heading, and each
    // of those files at most one node. Reserved up front so the tables can never
    // move under a run that is already writing into them.
    this.#reserve((request.maxExpansions + 2) * (this.#headings + 1));

    this.#seen.clear();
    this.#open.clear();
    this.#nodes = 0;
    this.#cell = Math.max(1e-3, request.stepTiles * CELL_FRACTION);
    // The most the gap to the anchor can close in one tick, which is what keeps
    // the estimate a bound rather than a guess. See `remainingAnchorCost`.
    this.#closePerStep = request.stepTiles + Math.hypot(request.anchorStepX, request.anchorStepY);

    // Before the search and not after it: this is what the search has to beat,
    // and it is the answer whenever the budget runs out. See {@link #scanStraight}.
    this.#scanStraight(request, ticks);

    const start = this.#file(request.startX, request.startY, 0, -1, 0, Infinity, NO_THREAT_TILES);
    this.#seen.set(keyOf(0, 0, 0), start);
    this.#open.push(start, 0);

    let expansions = 0;
    let goal = -1;

    while (expansions < request.maxExpansions) {
      const node = this.#open.pop();
      if (node < 0) break;
      if (this.#closed[node] === 1) continue;
      this.#closed[node] = 1;

      const slice = this.#slice[node] ?? 0;
      if (slice >= ticks) {
        goal = node;
        break;
      }
      // **Nothing is kept from a partial expansion**, and that is the change
      // the straight scan bought: the deepest node the search happened to reach
      // is a route priced over fewer steps than the one it would be compared
      // against, and reading it as an answer is how a character came to stand
      // in the middle of a crossfire for a whole fight.

      expansions += 1;
      this.#expand(request, node, slice, ticks);
    }

    // **A route that reached the horizon beats one that did not, whatever the
    // two cost.** A budget that ran out leaves a partial answer priced over
    // fewer steps, so its number is not comparable — and the straight run is
    // always complete. When both are complete the cheaper wins, which is the
    // ordinary case and settles it in the search's favour nearly every time.
    if (goal < 0 || (this.#g[goal] ?? Infinity) > this.#runCost) {
      return this.#reportRun(expansions, ticks);
    }
    return this.#reportOn(request, goal, expansions);
  }

  /**
   * Walks every heading the whole way, and keeps the cheapest.
   *
   * **The answer to a wall of fire, and the search cannot afford to find it.**
   * When a pattern is wide enough that everywhere nearby is hit, the cost of
   * every first step ties — they are all hit at the same moment — and A* has to
   * expand the whole tie before it reaches the depth where running clear starts
   * to pay. Measured on four sources converging on one spot, that took several
   * thousand expansions; the character stood in the middle and was hit for half
   * the fight. Twelve straight lines cost about one per cent of the search's own
   * budget and describe exactly the escape it could not reach.
   *
   * **Priced by {@link #priceOf}, which is what makes the comparison mean
   * anything.** This is not a heuristic beside the search — it is a handful of
   * extra candidates scored on the same terms, so "whichever is cheaper" is a
   * statement about the same quantity.
   *
   * **A wall shortens a run rather than ending it.** Walking into one costs the
   * step and nothing else, and the character stands where it stopped them —
   * which is the honest model, and it is what stops a run along a corridor being
   * discarded for the wall at the end of it.
   */
  #scanStraight(request: SearchRequest, ticks: number): void {
    this.#runCost = Infinity;
    this.#runDirX = 0;
    this.#runDirY = 0;
    this.#runStepTiles = 0;

    // Standing still is candidate nought and always available: it is the floor
    // every other run has to beat, and it is very often the answer.
    this.#priceRun(request, ticks, 0, 0);
    for (let i = 0; i < this.#headings; i += 1) {
      this.#priceRun(request, ticks, this.#headingX[i] ?? 0, this.#headingY[i] ?? 0);
    }
  }

  /** Prices one heading run end to end, keeping it if it is the best so far. */
  #priceRun(request: SearchRequest, ticks: number, dirX: number, dirY: number): void {
    let x = request.startX;
    let y = request.startY;
    let total = 0;
    let impact = Infinity;
    let room = NO_THREAT_TILES;

    for (let step = 0; step < ticks; step += 1) {
      const next = step + 1;
      this.#fromX = x;
      this.#fromY = y;
      this.#step = step;
      this.#next = next;
      this.#stepsLeft = ticks - next;
      this.#startsMs = request.leadMs + step * request.tickMs;
      this.#arriveMs = this.#startsMs + request.tickMs;
      this.#anchorX = request.anchorX + request.anchorStepX * next;
      this.#anchorY = request.anchorY + request.anchorStepY * next;

      let toX = x + dirX * request.stepTiles;
      let toY = y + dirY * request.stepTiles;
      let travel = dirX === 0 && dirY === 0 ? 0 : request.stepTiles;
      if (
        travel > 0 &&
        (!request.ground.canStand(toX, toY) ||
          !request.ground.canStand((x + toX) / 2, (y + toY) / 2))
      ) {
        toX = x;
        toY = y;
        travel = 0;
      }

      const anchorX = toX - this.#anchorX;
      const anchorY = toY - this.#anchorY;
      const anchorTiles = Math.sqrt(anchorX * anchorX + anchorY * anchorY);
      total += this.#priceOf(request, toX, toY, dirX, dirY, travel, anchorTiles);
      if (this.#priced < 0 && this.#startsMs < impact) impact = this.#startsMs;
      if (this.#priced < room) room = this.#priced;

      x = toX;
      y = toY;
      if (total >= this.#runCost) return; // already beaten; the rest cannot help
    }

    this.#runCost = total;
    this.#runDirX = dirX;
    this.#runDirY = dirY;
    this.#runStepTiles = dirX === 0 && dirY === 0 ? 0 : request.stepTiles;
    this.#runImpactMs = impact;
    this.#runRoom = room;
    this.#runDriftTiles = Math.hypot(
      x - (request.anchorX + request.anchorStepX * ticks),
      y - (request.anchorY + request.anchorStepY * ticks),
    );
  }

  /** The best straight run, as the answer. */
  #reportRun(expansions: number, ticks: number): DodgeRoute {
    const route = this.#route;
    route.expansions = expansions;
    route.depth = ticks;
    route.cost = this.#runCost;
    route.impactMs = this.#runImpactMs;
    route.clearanceTiles = this.#runRoom;
    route.driftTiles = this.#runDriftTiles;
    route.dirX = this.#runDirX;
    route.dirY = this.#runDirY;
    route.stepTiles = this.#runStepTiles;
    return route;
  }

  /** Every move out of one node, priced and offered to the open list. */
  #expand(request: SearchRequest, node: number, slice: number, ticks: number): void {
    this.#fromX = this.#x[node] ?? 0;
    this.#fromY = this.#y[node] ?? 0;
    this.#fromG = this.#g[node] ?? 0;
    this.#fromImpact = this.#impact[node] ?? Infinity;
    this.#fromRoom = this.#room[node] ?? NO_THREAT_TILES;
    this.#step = slice;
    this.#next = slice + 1;
    this.#stepsLeft = ticks - this.#next;
    this.#startsMs = request.leadMs + slice * request.tickMs;
    this.#arriveMs = this.#startsMs + request.tickMs;
    this.#anchorX = request.anchorX + request.anchorStepX * this.#next;
    this.#anchorY = request.anchorY + request.anchorStepY * this.#next;

    // Standing still first, and it can never be refused: a node exists only
    // because its own place was walkable, so the horizon is always reachable
    // from wherever the search has got to.
    this.#offer(request, node, this.#fromX, this.#fromY, 0, 0, 0);

    for (let i = 0; i < this.#headings; i += 1) {
      const dirX = this.#headingX[i] ?? 0;
      const dirY = this.#headingY[i] ?? 0;
      const toX = this.#fromX + dirX * request.stepTiles;
      const toY = this.#fromY + dirY * request.stepTiles;

      // **A wall refuses a move here rather than shortening it.** The lattice
      // already offers standing still and every other direction, so a step that
      // does not fit has an answer beside it — where the previous generation had
      // to model being stopped part-way, because a straight course was the only
      // thing it could say. The midpoint as well as the end, because a step is
      // most of a tile and a pillar narrower than that would be walked through.
      if (!request.ground.canStand(toX, toY)) continue;
      if (!request.ground.canStand((this.#fromX + toX) / 2, (this.#fromY + toY) / 2)) continue;

      this.#offer(request, node, toX, toY, dirX, dirY, request.stepTiles);
    }
  }

  /**
   * What one move costs, and how much room it had.
   *
   * **Shared with the straight scan, and that is the whole point of it being a
   * method.** The two only mean anything compared against each other, and a
   * second copy of this arithmetic would be a second set of weights to keep in
   * step — which is how a planner ends up preferring a run it has priced
   * differently from the route it is being weighed against.
   *
   * The room the move had is left in {@link #priced} rather than returned
   * beside the cost: both callers want both numbers, and a record per edge is
   * an allocation per edge.
   */
  #priceOf(
    request: SearchRequest,
    toX: number,
    toY: number,
    dirX: number,
    dirY: number,
    travelTiles: number,
    anchorTiles: number,
  ): number {
    let clearance = request.threats.clearanceOf(this.#step, this.#fromX, this.#fromY, toX, toY);
    if (request.blasts !== undefined) {
      // Merged rather than reported beside it: "how much room did this step
      // have" has one answer whatever is taking the room, and a blast that
      // catches a step is exactly as much an impact as a bullet that does.
      const blast = request.blasts.clearanceAt(toX, toY, this.#startsMs, this.#arriveMs);
      if (blast < clearance) clearance = blast;
    }
    this.#priced = clearance;

    let cost = stepCost(
      request.weights,
      anchorTiles,
      travelTiles,
      clearance,
      request.ground.crowdingAt(toX, toY, this.#arriveMs),
      request.ground.isDamaging(toX, toY),
      this.#stepsLeft,
    );

    // Only the first step, because only the first step is ever commanded. What
    // it buys is a character that finishes the sidestep it started.
    if (this.#step === 0 && travelTiles > 0 && request.holdBias > 0) {
      const along = dirX * request.holdDirX + dirY * request.holdDirY;
      cost += (request.holdBias * (1 - along)) / 2;
    }
    return cost;
  }

  /** Prices one move and files it, unless something cheaper already covers it. */
  #offer(
    request: SearchRequest,
    parent: number,
    toX: number,
    toY: number,
    dirX: number,
    dirY: number,
    travelTiles: number,
  ): void {
    const cellX = Math.round((toX - request.startX) / this.#cell);
    const cellY = Math.round((toY - request.startY) / this.#cell);
    if (cellX <= -CELL_RANGE || cellX >= CELL_RANGE) return;
    if (cellY <= -CELL_RANGE || cellY >= CELL_RANGE) return;

    // `Math.hypot` guards against overflow at a cost this loop cannot pay: it
    // is called once per edge, a few thousand times a plan, on numbers that are
    // tiles apart. The plain distance is the same answer here.
    const anchorX = toX - this.#anchorX;
    const anchorY = toY - this.#anchorY;
    const anchorTiles = Math.sqrt(anchorX * anchorX + anchorY * anchorY);

    const weights = request.weights;
    const key = keyOf(cellX, cellY, this.#next);
    const seen = this.#seen.get(key);
    // **The cheapest question first, and it settles most of them.** Every term
    // in `stepCost` is non-negative, so what the anchor and the walking already
    // cost is a floor under what this move can possibly come to — and a state
    // already reached for less than that floor can never be improved on here.
    // Asked before the sweep rather than after it, because the sweep is two
    // thirds of what a plan costs and this is two comparisons.
    if (seen !== undefined) {
      const floor =
        this.#fromG + weights.anchorPerTile * anchorTiles + weights.travelPerTile * travelTiles;
      if ((this.#g[seen] ?? 0) <= floor) return;
    }

    const cost = this.#priceOf(request, toX, toY, dirX, dirY, travelTiles, anchorTiles);
    const clearance = this.#priced;
    const g = this.#fromG + cost;
    // No decrease-key and no re-expansion: with a consistent estimate the first
    // route to settle a state is the one worth keeping, and a cheaper one
    // arriving later is only cheaper by the slack `greed` already allows.
    if (seen !== undefined && (this.#g[seen] ?? 0) <= g) return;

    const impact =
      clearance < 0 && this.#startsMs < this.#fromImpact ? this.#startsMs : this.#fromImpact;
    const room = clearance < this.#fromRoom ? clearance : this.#fromRoom;
    const node = this.#file(toX, toY, this.#next, parent, g, impact, room);
    this.#seen.set(key, node);

    const heuristic = remainingAnchorCost(
      weights.anchorPerTile,
      anchorTiles,
      this.#closePerStep,
      this.#stepsLeft,
    );
    this.#open.push(node, g + request.greed * heuristic - this.#next * DEPTH_PULL);
  }

  /** Walks the chain back to the first step and fills in the answer. */
  #reportOn(request: SearchRequest, node: number, expansions: number): DodgeRoute {
    const route = this.#route;
    route.expansions = expansions;
    route.depth = this.#slice[node] ?? 0;
    route.cost = this.#g[node] ?? 0;
    route.impactMs = this.#impact[node] ?? Infinity;
    route.clearanceTiles = this.#room[node] ?? NO_THREAT_TILES;
    route.driftTiles = Math.hypot(
      (this.#x[node] ?? 0) - (request.anchorX + request.anchorStepX * route.depth),
      (this.#y[node] ?? 0) - (request.anchorY + request.anchorStepY * route.depth),
    );

    route.dirX = 0;
    route.dirY = 0;
    route.stepTiles = 0;
    if (route.depth < 1) return route;

    let first = node;
    while ((this.#slice[first] ?? 0) > 1) {
      const parent = this.#parent[first] ?? -1;
      if (parent < 0) break;
      first = parent;
    }

    const dx = (this.#x[first] ?? 0) - request.startX;
    const dy = (this.#y[first] ?? 0) - request.startY;
    const distance = Math.hypot(dx, dy);
    // Standing still is a first step like any other, and it is the common one.
    if (distance < 1e-6) return route;

    route.dirX = dx / distance;
    route.dirY = dy / distance;
    route.stepTiles = distance;
    return route;
  }

  /** Files a node and returns its index. */
  #file(
    x: number,
    y: number,
    slice: number,
    parent: number,
    g: number,
    impact: number,
    room: number,
  ): number {
    if (this.#nodes >= this.#x.length) this.#reserve(Math.max(1024, this.#x.length * 2));
    const node = this.#nodes;
    this.#nodes += 1;
    this.#x[node] = x;
    this.#y[node] = y;
    this.#slice[node] = slice;
    this.#parent[node] = parent;
    this.#g[node] = g;
    this.#impact[node] = impact;
    this.#room[node] = room;
    this.#closed[node] = 0;
    return node;
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

  /** Grows the node tables, carrying over whatever a run has already written. */
  #reserve(nodes: number): void {
    if (this.#x.length >= nodes) return;
    const x = new Float64Array(nodes);
    const y = new Float64Array(nodes);
    const slice = new Int32Array(nodes);
    const parent = new Int32Array(nodes);
    const g = new Float64Array(nodes);
    const impact = new Float64Array(nodes);
    const room = new Float64Array(nodes);
    const closed = new Uint8Array(nodes);
    x.set(this.#x);
    y.set(this.#y);
    slice.set(this.#slice);
    parent.set(this.#parent);
    g.set(this.#g);
    impact.set(this.#impact);
    room.set(this.#room);
    closed.set(this.#closed);
    this.#x = x;
    this.#y = y;
    this.#slice = slice;
    this.#parent = parent;
    this.#g = g;
    this.#impact = impact;
    this.#room = room;
    this.#closed = closed;
  }
}

/** One state — a cell and a moment — as a single number the map can key on. */
function keyOf(cellX: number, cellY: number, slice: number): number {
  return ((cellY + CELL_RANGE) * CELL_SPAN + (cellX + CELL_RANGE)) * SLICE_SPAN + slice;
}
