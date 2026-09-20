/**
 * What a trajectory is worth. **This file is the feature's behaviour.**
 *
 * The optimizer in `TrajectoryPlanner` is a general "roll a lot of candidates
 * forward and keep the best"; every opinion about what a dodge *is* lives here,
 * in what a step is charged for. Keeping the two apart is what makes the
 * behaviour arguable without arguing about buffers and budgets, and it is what
 * lets the whole of it be pinned down by tests that never roll anything out.
 *
 * **The ladder, in order, and the gaps between the rungs are the point.**
 *
 * 1. *Being hit.* Priced per remaining tick, so a hit later is better than a hit
 *    sooner — which is the only useful thing left to say when every way out is
 *    hit, and it is also correct: the plan twenty milliseconds from now gets
 *    another go at anything that has not landed yet.
 * 2. *The condition it carries.* A paralyse is not a large hit, it is the end of
 *    dodging — everything that lands during it lands unopposed. Worth several
 *    times the largest damage roll in the game and still less than one tick of
 *    being hit at all, so timing wins between two hits and severity settles two
 *    hits at the same moment.
 * 3. *How much it takes off.* A number the game states, and the thing that tells
 *    a boss's shotgun from a rat's pellet.
 * 4. *Room, damaging ground, and bodies.* Not in the stated ladder because they
 *    are not outcomes — they are how likely the three above are. A near miss is
 *    a bet on a prediction; a heel in the lava is health every tick with nothing
 *    left to dodge. Both sit above the anchor by two orders of magnitude, which
 *    is what stops the way home going through the fire.
 * 5. *How far off the anchor.* Charged **per tile, per tick**, which is the
 *    single decision that makes this a dodge rather than a retreat: a sidestep
 *    that returns costs two ticks of deviation, a retreat costs every remaining
 *    tick, and no amount of safety at the far end pays the difference.
 * 6. *DPS uptime.* A step charge for each tick spent outside the ring the
 *    character can actually fight from, on top of the distance. It is what makes
 *    "a twentieth of a tile and back" strictly better than "a tile and back"
 *    even when both are perfectly safe.
 * 7. *How far it walked*, so the character stands still when nothing forces a
 *    move.
 * 8. *Whether it reversed*, which is the only term here that exists to stop a
 *    character vibrating between two answers the field cannot tell apart.
 *
 * **Every constant below is quoted against `anchorPerTile`**, which is the one
 * number a person actually wants to set. Five more on the panel would be five
 * ways to describe the same trade, four of them wrong.
 */

/** How a trajectory is priced. Every one of these is in the same made-up unit. */
export interface TrajectoryWeights {
  /**
   * Per tile away from the anchor, per tick spent there.
   *
   * The unit everything else is quoted against. Charged per tick rather than
   * once at the end because being pulled a tile off your ground for a whole
   * horizon genuinely costs more than touching the same place in passing.
   */
  readonly anchorPerTile: number;
  /**
   * How far from the anchor the character can still fight from, in tiles.
   *
   * **The anchor is a DPS position, and this is what makes that mean
   * something.** Inside it nothing is lost but the distance itself; outside it
   * the character is out of position and every tick of that is charged. Small on
   * purpose — a fraction of a tile — because the whole request this feature
   * exists to answer is "move as little as you possibly can".
   */
  readonly dpsRadiusTiles: number;
  /** Per tick spent outside that ring, on top of the distance. */
  readonly dpsPerTick: number;
  /**
   * Per tile actually walked.
   *
   * **What keeps the character still when nothing is making them move.** The
   * anchor term alone is indifferent between standing at the anchor and orbiting
   * it, and an indifferent planner picks whichever way the arithmetic rounded.
   */
  readonly travelPerTile: number;
  /**
   * The most a complete reversal of the held direction costs.
   *
   * **A thumb on the scale, and the smallest term here.** The danger field
   * shifts a little every plan, so two near-equal candidates swap places on
   * noise, which looks like and is a character vibrating. Charging a first step
   * for disagreeing with the one already being walked settles that with one
   * term, where the previous generation needed a dwell timer, a break threshold
   * and a rule for when the commitment could be overruled.
   */
  readonly turnPerReversal: number;
  /** How much room stops being worth paying for. */
  readonly safeClearanceTiles: number;
  /**
   * Per tile of room a step is short of {@link safeClearanceTiles}.
   *
   * Not a bar but a gradient, deliberately: "the shot did not technically touch
   * me" is a plan that relies on the prediction being perfect, and a planner
   * that treats a hair of room and a tile of it as the same answer will thread
   * needles when a lane was available a twentieth of a tile away.
   */
  readonly riskPerTile: number;
  /**
   * Per tile inside a monster's keep-away distance, and it steepens.
   *
   * **Room to dodge in is not distance from the shots.** A body pressed against
   * the character has already taken the space every sidestep is made in, and
   * that is worth a step of its own with nothing in the air at all. Charged as
   * `crowding × (1 + crowding)` because the cost of being near a monster is
   * nothing like linear in the distance: the outer half of the bubble is where
   * an ordinary fight happens, and the last half tile is contact damage and a
   * shot fired point blank.
   */
  readonly crowdPerTile: number;
  /**
   * Per tile of the keep-clear distance a step is short of, and it steepens.
   *
   * **Above the room a shot leaves, deliberately.** Room from a bullet is a bet
   * on a prediction; distance from a pool is a fact about the map, and standing
   * in one costs health every tick with nothing left to dodge. The planner
   * should give up a graze before it gives up its footing.
   */
  readonly hazardPerTile: number;
  /** How far from ground that hurts counts as far enough, in tiles. */
  readonly hazardClearTiles: number;
}

/**
 * Per remaining tick, for a tick that is hit.
 *
 * **Priced out of reach rather than forbidden.** Large enough that no
 * arrangement of every other term can buy a hit — the whole anchor and travel
 * cost of the furthest trajectory the horizon can describe is a fraction of one
 * tick of this — and finite, so that a fight with no way out still has a best
 * answer instead of a special case.
 */
export const COLLISION_PER_TICK = 20_000;

/**
 * For a hit that carries a condition, at full severity.
 *
 * **Below one tick of being hit at all, and above every damage roll in the
 * game.** Under a tick, so that between two hits the later one still wins —
 * a hit that has not landed yet is one the next plan can still answer. Above the
 * damage, so that between two hits at the same moment the paralyse is the one
 * refused. See `debuffSeverity` for what earns which figure.
 */
export const DEBUFF_PER_SEVERITY = 6000;

/**
 * Per point of damage, for a tick that is hit.
 *
 * The game's heaviest shots are in the hundreds, so this tops out well under the
 * condition term and enormously under the collision term: it settles two hits
 * that are otherwise identical, and never anything else.
 */
const DAMAGE_PER_POINT = 1;

/**
 * How many ticks a tight step is charged against.
 *
 * **Bounded, unlike the hit it is a milder version of.** Charged once, shaving
 * the margin paid for itself with every free tick it bought afterwards — which
 * is how squeezing through a gap became the way home. Charged against the whole
 * remaining horizon, the widest settings refused to move at all. Two ticks is
 * what a plan can honestly claim: the first is the one that will be commanded,
 * the second is what the next plan will still be looking at, and everything past
 * them is provisional.
 */
const RISK_SPAN_TICKS = 2;

/** What one tick of a trajectory is measured by. Reused; never held. */
export interface TrajectoryStep {
  /** How far the tick *ends* from where the character should have been then. */
  anchorTiles: number;
  /**
   * How far it *began* from the same ground.
   *
   * **A step that is short of comfortable earns no credit for getting nearer
   * home**, and that one rule is what lets the anchor pull be strong without
   * being dangerous: the enemy aims at the ground the character was standing on,
   * so the way back is exactly where the next shot is going. Charged on wherever
   * it began instead, the arithmetic of going home is the arithmetic of standing
   * still — the only way to close the gap is by steps that keep their room.
   */
  fromAnchorTiles: number;
  /** How far it walked. */
  travelTiles: number;
  /** The least room it had at any instant. `Infinity` when nothing came near. */
  clearanceTiles: number;
  /** What landed on it, when something did. Nought otherwise. */
  hitDamage: number;
  hitDebuff: number;
  /** How far inside a monster's bubble it ends. */
  crowdingTiles: number;
  /** How far it ends from ground that hurts. Negative once standing on some. */
  hazardGapTiles: number;
  /** How many ticks of the horizon are still ahead of it. */
  ticksLeft: number;
}

/**
 * What one tick of a trajectory costs.
 *
 * Split from the trajectory-wide terms below because this is the part that is
 * summed: the reversal is a property of the *decision*, charged
 * once, and folding it in here would charge it once per tick.
 */
export function stepCost(weights: TrajectoryWeights, step: TrajectoryStep): number {
  const charged =
    step.clearanceTiles >= weights.safeClearanceTiles || step.fromAnchorTiles < step.anchorTiles
      ? step.anchorTiles
      : step.fromAnchorTiles;
  let cost = weights.anchorPerTile * charged + weights.travelPerTile * step.travelTiles;
  // **A step, not a slope, and that is the whole of "stay on the DPS spot".**
  // The distance term alone trades a tenth of a tile against a tile at the same
  // rate; this makes leaving the ring at all cost something the distance cannot
  // pay back, so a dodge that fits inside it is strictly preferred to one that
  // does not — however safe the further one is.
  if (charged > weights.dpsRadiusTiles) cost += weights.dpsPerTick;

  if (step.clearanceTiles < weights.safeClearanceTiles) {
    if (step.clearanceTiles < 0) {
      // Landed. Everything above is noise beside it, and what is still worth
      // distinguishing is when it happened and what it was.
      cost += COLLISION_PER_TICK * (step.ticksLeft + 1);
      cost += DEBUFF_PER_SEVERITY * step.hitDebuff;
      cost += DAMAGE_PER_POINT * step.hitDamage;
    } else {
      // **Charged per tick still to come, exactly as a hit is.** A plan is
      // remade fifty times a second and only its first tick is ever commanded,
      // so a trajectory that shaves its margin now is spending the one tick that
      // will actually happen — while everything it buys with that is
      // provisional. Charged flat, the saving spread over the rest of the
      // horizon outbid it, which is the way home going straight through the
      // fire.
      const soon = step.ticksLeft + 1 < RISK_SPAN_TICKS ? step.ticksLeft + 1 : RISK_SPAN_TICKS;
      cost += weights.riskPerTile * (weights.safeClearanceTiles - step.clearanceTiles) * soon;
    }
  }

  if (step.crowdingTiles > 0) {
    cost += weights.crowdPerTile * step.crowdingTiles * (1 + step.crowdingTiles);
  }
  if (step.hazardGapTiles < weights.hazardClearTiles) {
    const shortfall = weights.hazardClearTiles - step.hazardGapTiles;
    cost += weights.hazardPerTile * shortfall * (1 + shortfall);
  }
  return cost;
}

/**
 * What the *decision* costs, on top of the ticks it leads to.
 *
 * Charged once per trajectory: a reversal is a property of the first step
 * alone — only the first step is ever commanded, and the rest of the trajectory
 * is a claim about what the next plan will still be able to do.
 *
 * @param along How much the first step agrees with the direction already being
 *   walked, from `-1` for a reversal to `1` for carrying straight on. Pass `1`
 *   when nothing is being held, which charges nothing.
 */
export function decisionCost(weights: TrajectoryWeights, along: number): number {
  return (weights.turnPerReversal * (1 - along)) / 2;
}
