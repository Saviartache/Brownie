/**
 * The one decision: whether to take the wheel, and where to go with it.
 *
 * **The whole feature in one sentence.** Look at what the player is already
 * doing; if it survives the next fraction of a second with room to spare, say
 * nothing. Otherwise search for the cheapest way through the next second that
 * ends up back on the ground they chose, and command the first step of it. If
 * even that is too slow — the shot lands before one step of walking finishes —
 * spend a frame of movement all at once instead. See `Hop`.
 *
 * **Not running away is most of what makes it a dodge, and it is not a rule
 * here — it is the cost function.** Over any finite horizon giving ground always
 * survives at least as long as standing your ground, because the horizon can see
 * the shot that lands and cannot see the room that ran out. Every planner that
 * ranks on survival therefore backs away from everything, forever, and no amount
 * of lookahead fixes it; the previous generation needed a term against retreat,
 * a term for crossing the fire, a term for travelling less and a dwell timer to
 * stop the three of them arguing. Charging for *distance from the player's own
 * ground, per tick spent there* replaces all of it: a sidestep that returns costs
 * two ticks of deviation, a retreat costs every remaining tick, and no amount of
 * safety at the far end pays the difference. See `StepCost`.
 *
 * **Their own ground is where they were, or the line they are walking.** Both
 * are the same idea — a place the plan is trying to give back — and which one it
 * is depends only on whether they are pressing anything.
 *
 * **Two questions, not one, and confusing them is the difference between a
 * dodge and a leash.** Whether to speak at all is settled by probing the course
 * the player is already on: a shot that will not touch it inside the reaction
 * window is not this moment's problem, however alarming it looks on the screen.
 * Where to go is settled by the search, over a horizon several times longer,
 * because a step that merely postpones a hit has to be visibly worse than one
 * that solves it.
 *
 * **What is deliberately not here.** No goal-seeking, no orbit, no enemy lock,
 * no path drawing, nothing about weapon range. Folding a destination in is how
 * the reference implementation ended up with a nine-hundred-line arbiter and a
 * mode-hysteresis timer. This decides one thing.
 */

import { Blasts, type BlastView } from './Blasts.js';
import { DodgeSearch, type DodgeGround, type DodgeRoute } from './DodgeSearch.js';
import { MAX_HOP_TILES, chooseHop } from './Hop.js';
import { MAX_TRACK_SLICES, ShotTracks, type DodgeShot } from './ShotTracks.js';
import type { StepWeights } from './StepCost.js';
import { ThreatIndex } from './ThreatIndex.js';

/** A session with nothing throwing bombs, which is most of them. */
const NO_BLASTS: readonly BlastView[] = [];

/** Why the planner did what it did. Reported so a picture can say so. */
export type DodgeVerdict =
  /** What the player is already doing is fine for the window that matters. */
  | 'clear'
  /** The same, while they are steering. Their walking is untouched. */
  | 'intent-safe'
  /** Searched, and standing exactly here is the answer. */
  | 'hold'
  /**
   * Moving. Around the fire, or back onto the ground the fire took them off.
   *
   * The two are one verdict because they are one route: the search does not
   * distinguish getting out of the way from coming back, it minimises the whole
   * excursion at once.
   */
  | 'weave'
  /** Nothing in the air; something is standing too close. Making room. */
  | 'spacing'
  /** Standing on damaging ground. Leaving is the plan. */
  | 'escape'
  /** It lands before a step of walking finishes. One frame's worth, at once. */
  | 'hop'
  /** No route clears the horizon. This is the one hit latest and least. */
  | 'unavoidable';

export interface DodgeSettings {
  /**
   * How far ahead routes are searched.
   *
   * Ranking only — see the file's note on the two questions. Long enough that a
   * route which merely postpones a hit is visibly worse than one that solves it,
   * which is what stops the planner backing into a corner.
   */
  readonly horizonMs: number;
  /**
   * How long one step of the search's lattice lasts.
   *
   * **The single biggest lever on what a plan costs, and on how finely it can
   * thread.** A step covers this much of the character's own walking, so it is
   * also the smallest movement the planner can describe: halving it doubles both
   * the depth needed to see the same distance and the work at every level of it.
   */
  readonly tickMs: number;
  /**
   * How soon trouble has to be before it is worth acting on.
   *
   * **The setting that decides whether the feature is help or a leash.** Below
   * it, nothing on the far side of the room can take the wheel away, so walking
   * up to something that is shooting is possible again.
   */
  readonly reactWithinMs: number;
  /** How many directions the search considers, evenly spaced. */
  readonly headings: number;
  /** Multiplies every shot's extent. Above one is more cautious. */
  readonly hitScale: number;
  /** A flat margin on every shot. */
  readonly padTiles: number;
  /**
   * How long before a plan takes effect.
   *
   * A decision made here reaches the module a frame later and the server later
   * still, so for this long the player is still standing where they are while
   * the shots are not. It *delays* the walk rather than crediting it as a head
   * start.
   */
  readonly leadMs: number;
  /** How fast confidence in a prediction decays. See {@link ShotTracks}. */
  readonly driftTilesPerSecond: number;
  /**
   * How much room counts as safe, in tiles.
   *
   * **Not zero, and the difference is the whole feel of the feature.** Zero
   * means "the shot did not technically touch me", which is a plan that relies
   * on the prediction being perfect. A finger's width of margin is what turns a
   * coin-flip graze into a miss.
   */
  readonly safeClearanceTiles: number;
  /**
   * How hard the planner tries to give the player their ground back.
   *
   * The unit every other term in `StepCost` is quoted against. Raising it makes
   * a dodge tighter and more reluctant to travel; lowering it makes the planner
   * willing to walk further to be safer.
   */
  readonly holdGroundWeight: number;
  /**
   * How much the estimate is inflated, as a multiplier.
   *
   * One searches exactly and slowest; above it the route is within this factor
   * of the best one and is found in a fraction of the expansions. See
   * `DodgeSearch`.
   */
  readonly greed: number;
  /** The most nodes one plan may expand before answering with what it has. */
  readonly maxExpansions: number;
  /** Whether the emergency hop is allowed at all. */
  readonly hopEnabled: boolean;
  /** How far one hop carries, capped at what the module can actually do. */
  readonly hopTiles: number;
  /** The least time between two hops. */
  readonly hopCooldownMs: number;
}

export interface DodgeSituation {
  readonly x: number;
  readonly y: number;
  /** Unit direction the player is steering, or both zero when they are not. */
  readonly intentX: number;
  readonly intentY: number;
  readonly speedTilesPerSecond: number;
  /** The clock shot predictions are relative to. */
  readonly gameTimeMs: number;
  /** Wall-clock, for the hop's cooldown and the commitment. */
  readonly nowMs: number;
  /**
   * Whether the player is standing on ground that is costing them health.
   *
   * **A fact about the player, and deliberately not a question put to the
   * ground.** The game charges for the one tile the character's centre is on;
   * what the planner refuses is the body plus a margin, and reading "am I in it"
   * off that wider answer had the planner announcing an escape from ground
   * nobody was being hurt by, every time somebody chose to fight at the edge of
   * a pool.
   */
  readonly onDamagingGround: boolean;
}

export interface DodgePlan {
  readonly verdict: DodgeVerdict;
  /** Whether the caller should command a move at all. */
  readonly steer: boolean;
  /** Unit direction to walk. Both zero means "hold still, deliberately". */
  readonly dirX: number;
  readonly dirY: number;
  /**
   * How far to walk that way before standing still, in tiles.
   *
   * **A step is a heading and a distance**, and the distance is as much of the
   * answer as the heading: threading a gap is arriving in it and stopping, where
   * carrying on at the same speed walks out the other side. Zero exactly when
   * the plan is to hold.
   */
  readonly stepTiles: number;
  /**
   * Whether to spend it as one frame of movement rather than as a walk.
   *
   * Only ever set with a distance the module can carry in a single frame — see
   * {@link MAX_HOP_TILES}. Everything else about the command is the same.
   */
  readonly hop: boolean;
  /** When the chosen route is first hit, from now, or `Infinity`. */
  readonly impactMs: number;
  /** The least room that route ever has, over the whole horizon. */
  readonly clearanceTiles: number;
  /**
   * Whether something is standing inside the keep-away distance right now.
   *
   * **What tells "get out of this" from every other reason to walk.** A dodge is
   * a sidestep with a margin in hand; making room from a monster already on top
   * of the player is a shove, and the difference is worth a little speed.
   */
  readonly crowded: boolean;
  /** How many shots could reach the player at all. */
  readonly trackedShots: number;
  /** How many area effects are on their way down and could catch us. */
  readonly trackedBlasts: number;
  /** How many nodes the search expanded. Nought when it never had to run. */
  readonly expansions: number;
}

/**
 * How long a committed direction still costs a plan to abandon.
 *
 * Refreshed whenever a step is commanded, so a commitment expires on its own
 * rather than renewing itself, and a plan made after a quiet stretch starts with
 * no opinion at all.
 */
const HOLD_FRESH_MS = 260;

/**
 * What reversing the held direction costs, in the cost model's own units.
 *
 * **A thumb on the scale, sized against a tick of deviation.** About a third of
 * a tile-tick, so it settles two routes the search cannot otherwise tell apart
 * and is outvoted the moment one of them is genuinely better. The previous
 * generation needed a dwell timer, a break threshold and a rule for when the
 * commitment could be overruled; this is the same idea priced instead of timed.
 */
const HOLD_BIAS = 0.35;

/**
 * How much of the search's margin the player's own course has to have before
 * nothing is said.
 *
 * **A fraction, and a small one, because the two numbers are different
 * questions.** `safeClearanceTiles` is what a route *aims* for — the point at
 * which more room stops being worth walking for, and it is deliberately most of
 * a bullet's width. What decides whether to speak at all is far tighter: did the
 * shot actually miss. Using the same number for both is a planner that seizes
 * the wheel over a bullet passing a comfortable tile away, which is the leash
 * this feature exists not to be.
 *
 * A third of it, which comes out near a tenth of a tile at every preset — the
 * figure four generations of this feature converged on for "that was a miss".
 */
const PROBE_MARGIN_FRACTION = 0.35;

/**
 * How long a held anchor stands without a plan to refresh it.
 *
 * A gap that long is the feature having been switched off, the session having
 * changed, or the game having been paused — and the ground the player was
 * standing on before any of those is not ground worth walking back to.
 */
const ANCHOR_FRESH_MS = 500;

/**
 * How far the planner may be dragged off the held ground before it gives up on
 * it, in tiles.
 *
 * **The fight moved.** A sustained pattern can push a character several tiles
 * before it lets up, and at some distance "where you were standing" stops being
 * a place they still want and becomes a place across the room. About a horizon's
 * walk, past which the new ground is simply adopted.
 */
const ANCHOR_REACH_TILES = 4;

/**
 * How near the held ground counts as being back on it, in tiles.
 *
 * **What makes the dodge a sidestep rather than a drift.** Without a way back
 * the planner is content wherever the last shot left it — every plan measures
 * from where the character is now, so every plan is already home — and a fight
 * walks somebody the length of the room one blameless step at a time. Under
 * half a step, so one command settles it and there is nothing to oscillate
 * about.
 */
const RETURN_TILES = 0.35;

/**
 * How far inside a monster's bubble is worth taking the wheel over, in tiles.
 *
 * **Not "inside it at all".** The bubble is a couple of tiles wide, so its edge
 * is where an ordinary fight happens; a planner that acts there is one that
 * never stops acting. This is where it stops being a preference and starts being
 * the reason there is nowhere to sidestep to.
 */
const CROWD_ACT_TILES = 0.75;

/** The most travel one tick may consider, so a bad speed cannot size a search. */
const MAX_STEP_TILES = 3;

/**
 * The rest of the cost model, which is not anybody's to tune.
 *
 * **Ratios rather than preferences.** What a person actually wants to say is how
 * hard the planner should hold their ground, and that is one number —
 * `holdGroundWeight`, which every constant below is quoted against. Five more on
 * the panel would be five ways to describe the same trade, four of them wrong.
 */

/** Per tile walked. What keeps the character still when nothing forces a move. */
const TRAVEL_PER_TILE = 0.4;

/** Per tile short of comfortable. Enough that a lane beats a needle. */
const RISK_PER_TILE = 10;

/** Per tile inside a monster's bubble. Above the anchor, so a shove wins. */
const CROWD_PER_TILE = 2.5;

/** For a step ending on ground that hurts. Whole tiles' worth, because it is. */
const HAZARD_COST = 8;

/**
 * Per remaining step, for a step that is hit.
 *
 * **Priced out of reach rather than forbidden.** Large enough that no
 * arrangement of the terms above can buy a hit — the whole anchor cost of the
 * furthest route the lattice can describe is a fraction of one step of this —
 * and finite, so that a fight with no way out still has a best answer instead of
 * an exhausted open list and a special case to go with it.
 */
const HIT_PER_STEP = 400;

export class DodgePlanner {
  readonly #tracks = new ShotTracks();
  readonly #threats = new ThreatIndex();
  readonly #blasts = new Blasts();
  readonly #search = new DodgeSearch();

  /** The direction the last commanded step went, and when it was chosen. */
  #holdDirX = 0;
  #holdDirY = 0;
  #holdAtMs = 0;
  /** When the last hop was spent, so one cannot become a way of walking. */
  #hoppedAtMs = 0;

  /**
   * The ground the planner took the player off, and whether it is still holding
   * it.
   *
   * **Held only while it is driving**, which is the whole of what makes it safe.
   * A remembered place that outlived the reason for it is a planner pulling
   * somebody back to where they were a minute ago; one that only exists between
   * "I moved you" and "you are back" is a sidestep with a return in it. While
   * nothing is held the anchor simply follows the character, which is what makes
   * every plan measure interference from where they actually are.
   */
  #anchorX = 0;
  #anchorY = 0;
  #anchorHeld = false;
  #anchorAtMs = 0;

  /** Rewritten in place: a plan happens fifty times a second. */
  readonly #weights: { -readonly [K in keyof StepWeights]: StepWeights[K] } = {
    anchorPerTile: 0,
    travelPerTile: TRAVEL_PER_TILE,
    riskPerTile: RISK_PER_TILE,
    safeClearanceTiles: 0,
    crowdPerTile: CROWD_PER_TILE,
    hazard: HAZARD_COST,
    hitPerStep: HIT_PER_STEP,
  };

  /** What the probe of the player's own course found. Rewritten in place. */
  #probeImpactMs = Infinity;
  #probeRoomTiles = Infinity;
  #probeUrgentTiles = Infinity;

  readonly #plan = {
    verdict: 'clear' as DodgeVerdict,
    steer: false,
    dirX: 0,
    dirY: 0,
    stepTiles: 0,
    hop: false,
    impactMs: Infinity,
    clearanceTiles: Infinity,
    crowded: false,
    trackedShots: 0,
    trackedBlasts: 0,
    expansions: 0,
  };

  /** What the last plan predicted about the shots. For a picture to draw. */
  get tracks(): ShotTracks {
    return this.#tracks;
  }

  /** Forgets everything. A new connection is a new character in a new place. */
  reset(): void {
    this.#tracks.clear();
    this.#threats.clear();
    this.#blasts.clear();
    this.#search.reset();
    this.#holdDirX = 0;
    this.#holdDirY = 0;
    this.#holdAtMs = 0;
    this.#hoppedAtMs = 0;
    this.#anchorHeld = false;
    this.#anchorAtMs = 0;
  }

  /**
   * Decides what to do about everything in the air.
   *
   * @param world Where a body may stand, where the ground hurts, and how much
   *   room to dodge in a place leaves. See `DodgeScene`.
   * @returns a plan valid until the next call. Never held on to by the caller.
   */
  plan(
    situation: DodgeSituation,
    settings: DodgeSettings,
    world: DodgeGround,
    shots: Iterable<DodgeShot>,
    blasts: Iterable<BlastView> = NO_BLASTS,
  ): DodgePlan {
    const plan = this.#plan;
    const tickMs = Math.max(20, settings.tickMs);
    const ticks = Math.max(
      1,
      Math.min(MAX_TRACK_SLICES - 1, Math.round(settings.horizonMs / tickMs)),
    );
    const stepTiles = Math.min(
      MAX_STEP_TILES,
      Math.max(0, (situation.speedTilesPerSecond * tickMs) / 1000),
    );
    const reachTiles = stepTiles * ticks;
    const horizonMs = settings.leadMs + ticks * tickMs;

    this.#tracks.build(shots, {
      gameTimeMs: situation.gameTimeMs,
      leadMs: settings.leadMs,
      tickMs,
      ticks,
      selfX: situation.x,
      selfY: situation.y,
      reachTiles,
      hitScale: settings.hitScale,
      padTiles: settings.padTiles,
      driftTilesPerSecond: settings.driftTilesPerSecond,
    });
    // **How much room the cost model can still tell apart.** Above the margin it
    // aims for, two steps are equally safe and the difference decides nothing —
    // so asking the index to measure it is asking a query to drag half a screen
    // of shots through the exact test for an answer nothing reads.
    this.#threats.build(this.#tracks, settings.safeClearanceTiles);
    this.#blasts.collect(
      blasts,
      situation.gameTimeMs,
      situation.x,
      situation.y,
      reachTiles,
      horizonMs,
    );

    const crowding = world.crowdingAt(situation.x, situation.y, 0);
    plan.trackedShots = this.#tracks.count;
    plan.trackedBlasts = this.#blasts.count;
    plan.crowded = crowding > 0;
    plan.expansions = 0;
    plan.hop = false;

    // **What the player is already doing, and whether it needs answering.** The
    // course they are on rather than the ones they might take: a planner asking
    // "could anything reach me" takes the wheel every time something fires
    // anywhere, and one asking "is what I am doing about to cost me" leaves an
    // entire fight alone.
    this.#probe(situation, settings, world, stepTiles, ticks, tickMs);
    const steering = situation.intentX !== 0 || situation.intentY !== 0;
    const offGround = this.#aimAnchor(situation, steering);
    if (
      !situation.onDamagingGround &&
      crowding <= CROWD_ACT_TILES &&
      offGround <= RETURN_TILES &&
      this.#probeImpactMs > settings.reactWithinMs &&
      this.#probeUrgentTiles >= settings.safeClearanceTiles * PROBE_MARGIN_FRACTION
    ) {
      plan.verdict = steering ? 'intent-safe' : 'clear';
      plan.steer = false;
      plan.dirX = 0;
      plan.dirY = 0;
      plan.stepTiles = 0;
      plan.impactMs = this.#probeImpactMs;
      plan.clearanceTiles = this.#probeRoomTiles;
      // Back where they were, so there is no longer any ground to hold — the
      // anchor goes back to following the character.
      this.#anchorHeld = false;
      this.#release();
      return plan;
    }

    // **Nought while standing in it**, because the anchor is the ground the
    // player is on and that ground is what is hurting them. Leaving is then the
    // only thing worth wanting, and the hazard term is what says so.
    this.#weights.anchorPerTile = situation.onDamagingGround
      ? 0
      : Math.max(0, settings.holdGroundWeight);
    this.#weights.safeClearanceTiles = settings.safeClearanceTiles;

    const holding =
      (this.#holdDirX !== 0 || this.#holdDirY !== 0) &&
      situation.nowMs - this.#holdAtMs <= HOLD_FRESH_MS;
    const route = this.#search.run({
      startX: situation.x,
      startY: situation.y,
      // **Their own ground**: where the planner took them from, or where they
      // are when it has not taken them anywhere — and walking, the line they
      // are walking, one step of it per tick. See {@link #aimAnchor}.
      anchorX: this.#anchorX,
      anchorY: this.#anchorY,
      anchorStepX: situation.intentX * stepTiles,
      anchorStepY: situation.intentY * stepTiles,
      stepTiles,
      ticks,
      tickMs,
      leadMs: settings.leadMs,
      headings: settings.headings,
      weights: this.#weights,
      greed: Math.max(1, settings.greed),
      maxExpansions: Math.max(16, Math.round(settings.maxExpansions)),
      holdDirX: this.#holdDirX,
      holdDirY: this.#holdDirY,
      holdBias: holding ? HOLD_BIAS : 0,
      ground: world,
      threats: this.#threats,
      blasts: this.#blasts.count > 0 ? this.#blasts : undefined,
    });

    plan.expansions = route.expansions;
    plan.impactMs = route.impactMs;
    plan.clearanceTiles = route.clearanceTiles;

    if (this.#hopInstead(situation, settings, world, route, tickMs)) return plan;

    plan.dirX = route.dirX;
    plan.dirY = route.dirY;
    plan.stepTiles = route.stepTiles;
    // Standing still is a real answer, and under fire it is usually because
    // nowhere in reach is better. It is still worth commanding while the player
    // is pressing a key, because then the command is what cancels it.
    plan.steer = route.stepTiles > 0 || steering;
    plan.verdict = verdictFor(situation, plan, route);
    if (route.stepTiles > 0) {
      this.#commit(route.dirX, route.dirY, situation.nowMs);
      // The ground under the character stops being the ground it is aiming for
      // the moment it moves them off it, and stays that way until they are back.
      this.#anchorHeld = true;
    } else {
      this.#release();
    }
    return plan;
  }

  /**
   * Settles where the player's own ground is this plan, and how far off it they
   * have been taken.
   *
   * **Held only between "I moved you" and "you are back".** Without a way back
   * the planner is content wherever the last shot left it — every plan measures
   * from where the character is *now*, so every plan is already home — and a
   * long fight walks somebody the length of the room one blameless step at a
   * time. Remembering the place it took them from is what turns that drift into
   * a sidestep with a return in it.
   *
   * **And it is dropped in every case where holding it would be a fight.** They
   * are steering, so the ground they want is wherever they are walking; nothing
   * has been planned for long enough that the memory is stale; or the fight has
   * pushed them so far that the old place is across the room rather than one
   * step away.
   *
   * @returns how far off the held ground the character is, in tiles.
   */
  #aimAnchor(situation: DodgeSituation, steering: boolean): number {
    if (this.#anchorHeld) {
      const off = Math.hypot(situation.x - this.#anchorX, situation.y - this.#anchorY);
      const stale = situation.nowMs - this.#anchorAtMs > ANCHOR_FRESH_MS;
      this.#anchorAtMs = situation.nowMs;
      if (!steering && !stale && off <= ANCHOR_REACH_TILES) return off;
      this.#anchorHeld = false;
    }

    this.#anchorX = situation.x;
    this.#anchorY = situation.y;
    this.#anchorAtMs = situation.nowMs;
    return 0;
  }

  /**
   * Spends a frame of movement at once, when walking has already lost.
   *
   * **The one case walking cannot answer**, and the only one a hop is for: the
   * shot lands before the first step of the lattice has finished being walked,
   * so every route the search can describe is too late by construction.
   *
   * @returns whether the plan is now a hop.
   */
  #hopInstead(
    situation: DodgeSituation,
    settings: DodgeSettings,
    world: DodgeGround,
    route: DodgeRoute,
    tickMs: number,
  ): boolean {
    if (!settings.hopEnabled) return false;
    if (route.impactMs > settings.leadMs) return false;
    if (situation.nowMs - this.#hoppedAtMs < settings.hopCooldownMs) return false;

    const hop = chooseHop({
      x: situation.x,
      y: situation.y,
      // The same ground the search is aiming for, so that a hop taken while
      // already pushed off it lands on the side that gets some of it back.
      anchorX: this.#anchorX,
      anchorY: this.#anchorY,
      tiles: Math.min(MAX_HOP_TILES, settings.hopTiles),
      headings: settings.headings,
      safeClearanceTiles: settings.safeClearanceTiles,
      ground: world,
      threats: this.#threats,
      blasts: this.#blasts.count > 0 ? this.#blasts : undefined,
      leadMs: settings.leadMs,
      tickMs,
    });
    if (hop === undefined) return false;

    const distance = Math.hypot(hop.offsetX, hop.offsetY);
    if (!(distance > 0)) return false;

    const plan = this.#plan;
    this.#hoppedAtMs = situation.nowMs;
    plan.verdict = 'hop';
    plan.steer = true;
    plan.hop = true;
    plan.dirX = hop.offsetX / distance;
    plan.dirY = hop.offsetY / distance;
    plan.stepTiles = distance;
    plan.clearanceTiles = hop.clearanceTiles;
    this.#commit(plan.dirX, plan.dirY, situation.nowMs);
    // A hop is a displacement off their ground like any other, so the ground is
    // held and the next plan walks the rest of the way back to it.
    this.#anchorHeld = true;
    return true;
  }

  /**
   * Walks the player's own course down the lattice, to see whether it needs
   * answering.
   *
   * **The cheap question, and the one asked first.** It is the same arithmetic
   * the search does, over exactly one route — a handful of queries rather than a
   * few thousand — and on the great majority of plans its answer is "leave them
   * alone", which is the whole of the work.
   *
   * **Two numbers about room, not one.** The least room over the *horizon* is
   * what the plan reports; the least room inside the *reaction window* is what
   * decides whether to speak. A bullet due to pass a tile away in nine hundred
   * milliseconds is almost always the tighter of the two in a busy fight, and
   * acting on it is how a planner comes to answer the far shot while the near
   * one arrives.
   */
  #probe(
    situation: DodgeSituation,
    settings: DodgeSettings,
    world: DodgeGround,
    stepTiles: number,
    ticks: number,
    tickMs: number,
  ): void {
    let x = situation.x;
    let y = situation.y;
    this.#probeImpactMs = Infinity;
    this.#probeRoomTiles = Infinity;
    this.#probeUrgentTiles = Infinity;

    for (let step = 0; step < ticks; step += 1) {
      const startsMs = settings.leadMs + step * tickMs;
      const toX = x + situation.intentX * stepTiles;
      const toY = y + situation.intentY * stepTiles;
      // A course into a wall simply stops there; the game's own collision does
      // the same, and calling it a hit would have the planner seizing the wheel
      // over geometry.
      const walkable = world.canStand(toX, toY);
      const endX = walkable ? toX : x;
      const endY = walkable ? toY : y;

      let room = this.#threats.clearanceOf(step, x, y, endX, endY);
      if (this.#blasts.count > 0) {
        const blast = this.#blasts.clearanceAt(endX, endY, startsMs, startsMs + tickMs);
        if (blast < room) room = blast;
      }
      if (room < this.#probeRoomTiles) this.#probeRoomTiles = room;
      if (startsMs < settings.reactWithinMs && room < this.#probeUrgentTiles) {
        this.#probeUrgentTiles = room;
      }
      if (room < 0 && this.#probeImpactMs === Infinity) this.#probeImpactMs = startsMs;

      x = endX;
      y = endY;
    }
  }

  #commit(dirX: number, dirY: number, nowMs: number): void {
    this.#holdDirX = dirX;
    this.#holdDirY = dirY;
    this.#holdAtMs = nowMs;
  }

  /** Lets go of the commitment. Nothing is being walked, so nothing is held. */
  #release(): void {
    this.#holdDirX = 0;
    this.#holdDirY = 0;
  }
}

/** Why the planner is about to move, once it has decided that it is. */
function verdictFor(situation: DodgeSituation, plan: DodgePlan, route: DodgeRoute): DodgeVerdict {
  if (route.impactMs < Infinity) return 'unavoidable';
  if (situation.onDamagingGround) return 'escape';
  if (route.stepTiles === 0) return 'hold';
  if (plan.trackedShots === 0 && plan.trackedBlasts === 0 && plan.crowded) return 'spacing';
  return 'weave';
}
