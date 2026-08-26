/**
 * What one step of a walk is worth, and what the rest of it cannot cost less
 * than.
 *
 * **This file is the feature's behaviour.** The search in `DodgeSearch` is a
 * general shortest-path over places and moments; every opinion about what a
 * dodge *is* lives here, in what a step is charged for. Keeping the two apart is
 * what makes the behaviour arguable without arguing about heaps and closed sets,
 * and it is what lets the whole of it be pinned down by tests that never run a
 * search.
 *
 * **The anchor is the whole idea.** A planner that ranks courses by survival
 * alone backs away from everything, forever: over any finite horizon giving
 * ground always outlives standing your ground, because the horizon can see the
 * shot that lands and cannot see the room that ran out. So survival is not what
 * is being maximised here. What is being minimised is *how far, and for how
 * long, the character is dragged off the ground they had chosen* — where they
 * were standing, or the line they are walking. Getting hit is priced out of
 * reach above that, and everything in between is a preference.
 *
 * That single change is what turns running away into weaving: a sidestep that
 * returns costs two steps of deviation, a retreat costs every remaining step of
 * it, and no amount of extra safety at the far end pays for the difference.
 *
 * **And the way home is only ever credited to steps that keep their room.** The
 * enemy aims at the ground the character was standing on, so the way back is
 * exactly where the next shot is going — which is why an anchor strong enough
 * to insist on it used to be an anchor that walked people into the volley.
 * Charging a step that is short of comfortable as though it had not moved at
 * all separates the two questions: the pull can be as strong as anybody likes,
 * and it still cannot buy a single tight step. Going round costs a longer walk;
 * going through costs the whole distance twice over.
 *
 * **The estimate below it has to be a lower bound, or the search stops being
 * correct.** {@link remainingAnchorCost} is the least the anchor term can still
 * cost from here — the character closing on the anchor as fast as it is
 * physically able, every remaining step, and every other term charging nothing
 * at all. Anything larger would let A* return a path it has not shown to be
 * best; anything smaller is merely slower.
 */

/**
 * How many steps of the horizon a tight one is charged against.
 *
 * **Bounded, unlike the hit it is a milder version of.** Charged flat, shaving
 * the margin once paid for itself with every free step it bought afterwards —
 * which is how squeezing through a gap became the way home. Charged against the
 * *whole* remaining horizon it swung the other way and had the widest preset
 * refusing to move at all. Three steps is what a plan can honestly claim: the
 * first is the one that will be commanded, the second and third are what the
 * next plan will still be looking at, and everything past them is provisional.
 */
const RISK_SPAN_STEPS = 2;

/** How a step is priced. Every one of these is in the same made-up unit. */
export interface StepWeights {
  /**
   * Per tile away from the anchor, per step spent there.
   *
   * The unit everything else is quoted against, and the reason it is charged
   * *per step* rather than once at the end: being pulled a tile off your ground
   * for the whole horizon should cost more than touching the same place in
   * passing, because it does.
   */
  readonly anchorPerTile: number;
  /**
   * Per tile actually walked.
   *
   * **What keeps the character still when nothing is making them move.** The
   * anchor term alone is indifferent between standing at the anchor and orbiting
   * it, and an indifferent planner picks whichever way the arithmetic rounded.
   */
  readonly travelPerTile: number;
  /**
   * Per tile of room the step is short of {@link safeClearanceTiles}.
   *
   * Not a bar but a gradient, deliberately: "the shot did not technically touch
   * me" is a plan that relies on the prediction being perfect, and a planner
   * that treats a hair of room and a tile of it as the same answer will thread
   * needles when a lane was available one step away.
   */
  readonly riskPerTile: number;
  /** How much room stops being worth paying for. */
  readonly safeClearanceTiles: number;
  /**
   * Per tile inside a monster's keep-away distance, and it steepens.
   *
   * **Room to dodge in is not distance from the shots.** A body pressed against
   * the character has already taken the space every sidestep is made in, and
   * that is worth a step of its own even with nothing in the air.
   *
   * **Charged as `crowding × (1 + crowding)` rather than flat**, because the
   * cost of being near a monster is nothing like linear in the distance: the
   * outer half of the bubble is where an ordinary fight happens, and the last
   * half tile is contact damage and a shot fired point blank. Measured flat, a
   * route that walked straight through a body was outvoted by a tile of anchor;
   * curved, the same route costs an order of magnitude more and the planner goes
   * round.
   */
  readonly crowdPerTile: number;
  /**
   * Per tile of the keep-clear distance a step is short of, and it steepens.
   *
   * **Charged on the distance, not on the tile.** Walking into a pool is refused
   * outright by the search, so a flat charge for standing in one was a term that
   * almost never fired — and it left the planner perfectly content to thread a
   * shot with the character's heel on the boundary, where a correction from the
   * server or a frame of latency puts them in it. Curved for the same reason the
   * crowding is: the outer half of the margin is where an ordinary fight
   * happens, and the last hand's breadth of it is health.
   */
  readonly hazardPerTile: number;
  /**
   * How far from ground that hurts counts as far enough, in tiles.
   *
   * Above it the distance stops mattering, exactly as room from a shot does
   * above {@link safeClearanceTiles}.
   */
  readonly hazardClearTiles: number;
  /**
   * Charged per step still to come, for a step that is actually hit.
   *
   * **Per remaining step, so that a hit later is better than a hit sooner** —
   * which is the only useful thing left to say when every way out is hit. Large
   * enough that no arrangement of the terms above can buy a hit: the whole
   * anchor cost of the worst path the lattice can describe is a fraction of one
   * step of this.
   */
  readonly hitPerStep: number;
}

/**
 * What one step of a walk costs.
 *
 * @param anchorTiles How far the step *ends* from where the character should
 *   have been at that moment.
 * @param fromAnchorTiles How far it *began* from the same ground. What the
 *   anchor term is charged on when the step is not comfortable — see below.
 * @param travelTiles How far it walked.
 * @param clearanceTiles The least room it had at any instant, from
 *   {@link ThreatIndex.clearanceOf}. `Infinity` when nothing came near.
 * @param crowdingTiles How far inside a monster's bubble it ends.
 * @param hazardGapTiles How far the step ends from ground that hurts. Negative
 *   once it is standing on some, which is charged hardest of all.
 * @param stepsLeft How many steps of the horizon are still ahead of it, which
 *   is what makes an early hit worse than a late one.
 */
export function stepCost(
  weights: StepWeights,
  anchorTiles: number,
  fromAnchorTiles: number,
  travelTiles: number,
  clearanceTiles: number,
  crowdingTiles: number,
  hazardGapTiles: number,
  stepsLeft: number,
): number {
  // **A step that is short of comfortable earns no credit for getting nearer
  // home**, and that one rule is what lets the pull be strong without being
  // dangerous. Charged on wherever it *began* instead, so the arithmetic of
  // going home is exactly the arithmetic of standing still: the only way to
  // close the gap is by steps that keep their room, which is the difference
  // between coming back round the fire and coming back through it.
  const charged =
    clearanceTiles >= weights.safeClearanceTiles || fromAnchorTiles < anchorTiles
      ? anchorTiles
      : fromAnchorTiles;
  let cost = weights.anchorPerTile * charged + weights.travelPerTile * travelTiles;

  if (clearanceTiles < weights.safeClearanceTiles) {
    if (clearanceTiles < 0) {
      // Landed. Everything above is noise beside it, and the only thing still
      // worth distinguishing is how much of the horizon was survived first.
      cost += weights.hitPerStep * (stepsLeft + 1);
    } else {
      // **Charged per step still to come, exactly as a hit is.** A plan is
      // remade fifty times a second and only its *first* step is ever
      // commanded, so a route that shaves its margin now is spending the one
      // step that will actually happen — while everything it buys with that is
      // provisional. Charged flat, the saving spread over the rest of the
      // horizon outbid it: squeezing through a gap cost one tight step and paid
      // for itself with every free step after it, which is the way home going
      // straight through the fire.
      const soon = stepsLeft + 1 < RISK_SPAN_STEPS ? stepsLeft + 1 : RISK_SPAN_STEPS;
      cost += weights.riskPerTile * (weights.safeClearanceTiles - clearanceTiles) * soon;
    }
  }

  if (crowdingTiles > 0) {
    cost += weights.crowdPerTile * crowdingTiles * (1 + crowdingTiles);
  }
  if (hazardGapTiles < weights.hazardClearTiles) {
    const shortfall = weights.hazardClearTiles - hazardGapTiles;
    cost += weights.hazardPerTile * shortfall * (1 + shortfall);
  }
  return cost;
}

/**
 * The least the anchor term can still cost, from `tiles` away with `steps` to
 * go.
 *
 * **The character closing as fast as it possibly could, and paying for the
 * ground it has not closed yet.** Each remaining step is charged for whatever
 * distance is left at the moment it ends, so the first few steps are charged
 * even by a perfect run home; only once the gap is closed does the estimate stop
 * growing. Every other term in {@link stepCost} is charged nothing, which is
 * what keeps this a bound rather than a guess.
 *
 * **`closePerStep` is a closing rate, not a walking speed.** When the character
 * is steering, the anchor is walking away at their own speed, so the most the
 * gap can shrink by in one step is their step *plus* the anchor's — using the
 * character's alone would over-estimate the remaining cost, and an
 * over-estimate is exactly what makes A* stop being able to promise anything.
 */
export function remainingAnchorCost(
  anchorPerTile: number,
  tiles: number,
  closePerStep: number,
  steps: number,
): number {
  if (steps <= 0 || tiles <= 0 || anchorPerTile <= 0) return 0;
  if (!(closePerStep > 0)) return anchorPerTile * tiles * steps;

  // How many steps are still charged for anything at all: past this the gap is
  // closed and every further step is free.
  const charged = Math.min(steps, Math.floor(tiles / closePerStep));
  // Sum of `tiles - i * closePerStep` for `i` in `1..charged`.
  const sum = charged * tiles - (closePerStep * charged * (charged + 1)) / 2;
  return anchorPerTile * sum;
}
