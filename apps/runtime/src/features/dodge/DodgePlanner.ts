/**
 * The one decision: whether to take the wheel, and what to do with it.
 *
 * **The whole feature in one sentence.** Look at what the player is already
 * doing; if it survives the next fraction of a second with room to spare, say
 * nothing. Otherwise roll a few dozen futures forward a second apiece and
 * command the first move of the cheapest one — which is very often a short
 * step, and very often nothing at all.
 *
 * **The pipeline, stated once.** The world hands over the shots, the map and the
 * bodies; `ShotField` predicts where every shot that could reach us will be;
 * `DangerField` buckets those into a space-time grid so a place-and-moment can
 * be asked about in constant time; `AttackPatterns` reads the volleys as they
 * are announced and says what geometry is being fired; `PocketLock` turns that
 * into where the gaps *will* be; `TrajectoryPlanner` samples first moves and
 * rolls each to the horizon; and this file decides whether any of it should
 * reach the character at all. Every stage answers to the one after it and none
 * of them reaches back.
 *
 * **Not running away is most of what makes it a dodge, and it is not a rule
 * here — it is the cost function.** Over any finite horizon giving ground always
 * survives at least as long as standing your ground, because the horizon can see
 * the shot that lands and cannot see the room that ran out. Every planner that
 * ranks on survival therefore backs away from everything, forever, and no amount
 * of lookahead fixes it. Charging for *distance from the anchor, per tick spent
 * there* replaces all of it, and a step charge for leaving the ring the
 * character can actually fight from is what turns "a tile and back" into "a
 * short step and back". See `TrajectoryScore`.
 *
 * **The anchor is a DPS position.** Where they were, the line they are walking,
 * or a place they named with a key — all three are the same idea, which is
 * *the ground this fight is worth standing on*, and the planner's whole job is
 * to leave it as little as the geometry allows and to be back on it as soon as
 * the geometry allows. See {@link DodgeSituation.anchor}.
 *
 * **Two questions, not one, and confusing them is the difference between a
 * dodge and a leash.** Whether to speak at all is settled by probing the course
 * the player is already on: a shot that will not touch it inside the reaction
 * window is not this moment's problem, however alarming it looks on the screen.
 * What to do is settled by the optimizer, over a horizon several times longer,
 * because a move that merely postpones a hit has to be visibly worse than one
 * that solves it.
 *
 * **What is deliberately not here.** No goal-seeking, no orbit, no enemy lock,
 * no path drawing, nothing about weapon range, and no A* — global navigation is
 * somebody else's problem and always was. This decides one thing. Somewhere the
 * player wants to be arrives as a place and is treated as a place, whether the
 * caller worked it out from a key press or from a weapon's reach to a monster;
 * that it may be somewhere different on the next call is not a fact this file
 * has to hold, because nothing here remembers where it was told last.
 */

import type { Position } from '@brownie/plugin-api';
import type { AttackPatterns } from './AttackPatterns.js';
import { Blasts, type BlastView } from './Blasts.js';
import { DangerField, NO_DANGER_TILES } from './DangerField.js';
import type { DodgeGround } from './DodgeGround.js';
import { PocketLock } from './PocketLock.js';
import { MAX_FIELD_SLICES, ShotField, type DodgeShot } from './ShotField.js';
import {
  TrajectoryPlanner,
  type DodgeTrajectory,
  type TrajectoryRequest,
} from './TrajectoryPlanner.js';
import type { TrajectoryWeights } from './TrajectoryScore.js';

/** A session with nothing throwing bombs, which is most of them. */
const NO_BLASTS: readonly BlastView[] = [];

/** Why the planner did what it did. Reported so a picture can say so. */
export type DodgeVerdict =
  /** What the player is already doing is fine for the window that matters. */
  | 'clear'
  /** The same, while they are steering. Their walking is untouched. */
  | 'intent-safe'
  /** Rolled the futures, and standing exactly here is the answer. */
  | 'hold'
  /**
   * Moving. Around the fire, or back onto the ground the fire took them off.
   *
   * The two are one verdict because they are one trajectory: the optimizer does
   * not distinguish getting out of the way from coming back, it minimises the
   * whole excursion at once.
   */
  | 'weave'
  /** Nothing in the air; something is standing too close. Making room. */
  | 'spacing'
  /** Standing on damaging ground. Leaving is the plan. */
  | 'escape'
  /** No trajectory clears the horizon. This is the one hit latest and least. */
  | 'unavoidable';

export interface DodgeSettings {
  /**
   * How far ahead trajectories are rolled.
   *
   * Long enough that a move which merely postpones a hit is visibly worse than
   * one that solves it, which is what stops the planner backing into a corner.
   */
  readonly horizonMs: number;
  /**
   * How long one tick of the horizon lasts.
   *
   * **The single biggest lever on what a plan costs.** Every candidate is
   * evaluated at every tick, so halving it doubles both the number of ticks and
   * the number of danger-field queries. Unlike the previous generation's lattice
   * it is *not* the smallest movement the planner can describe — the first move
   * is sampled at its own resolution, well under a tile.
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
  /** How many directions the optimizer considers, evenly spaced. */
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
   * the shots are not. It *delays* the move rather than crediting it as a head
   * start.
   */
  readonly leadMs: number;
  /** How fast confidence in a prediction decays. See {@link ShotField}. */
  readonly driftTilesPerSecond: number;
  /**
   * How far from ground that hurts counts as far enough, in tiles.
   *
   * **A distance the planner prefers, not one it demands** — except that walking
   * *into* a pool is refused outright whatever this says. Nought turns the
   * preference off and leaves only the refusal.
   */
  readonly hazardClearTiles: number;
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
   * The unit every other term in `TrajectoryScore` is quoted against. Raising it
   * makes a dodge tighter and more reluctant to travel; lowering it makes the
   * planner willing to move further to be safer.
   */
  readonly holdGroundWeight: number;
  /**
   * How far off the anchor the character can still fight from, in tiles.
   *
   * **What makes "practically never leave the DPS spot" a rule rather than a
   * hope.** Inside it nothing is lost but the distance; the first tick outside
   * it is charged a flat price the distance term can never pay back, so a
   * short step that stays inside beats half a tile that does not,
   * however much safer the further one looks.
   */
  readonly dpsRadiusTiles: number;
  /**
   * The most futures one plan may roll out.
   *
   * The backstop rather than a target: an ordinary plan settles in well under
   * it, and what it bounds is the worst case — a screen full of fire with no
   * clean way through, which is exactly when a plan must still arrive on time.
   */
  readonly budget: number;
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
  /** Wall-clock, for the commitment. */
  readonly nowMs: number;
  /**
   * Whether the player is standing on ground that is costing them health.
   *
   * **A fact about the player, and deliberately not a question put to the
   * ground.** The game charges for the one tile the character's centre is on;
   * what the planner refuses is the body plus a margin, and reading "am I in it"
   * off that wider answer had the planner announcing an escape from ground
   * nobody was being hurt by.
   */
  readonly onDamagingGround: boolean;
  /**
   * A place the player named to hold, or nothing while they have not.
   *
   * **The ground a dodge remembers is a guess about what the player wanted;
   * this is not one.** So it is held on none of the terms that one is — it does
   * not follow them, it is not walked out from under a monster, it does not go
   * stale, and no distance drops it — and it is held harder, because the whole
   * point of naming a place is that leaving it costs something.
   *
   * **It may be somewhere else on the next call, and nothing here minds.** The
   * caller restates it every plan, and nothing is remembered between calls.
   *
   * **It is a pull and not a destination**, which is what makes it safe: every
   * other term of the cost model still applies, so the way home goes round the
   * fire rather than through it, stops short of a monster standing on the place,
   * and never crosses a pool to reach it.
   */
  readonly anchor?: Position | undefined;
  /**
   * A thing to keep a distance from, instead of a place to stand on.
   *
   * **The same statement as {@link anchor} about something that moves**, and it
   * is held on exactly the same terms: restated every plan, dropped the moment
   * the player steers, and never set at the same time as a place they named
   * outright — the caller settles that, so nothing here has to.
   *
   * **What makes it a ring rather than the nearest point of one.** Handed over
   * as a point, a step around the monster is charged exactly as much as a step
   * away from it, so the planner had no reason to prefer the one that keeps the
   * player in the fight. Handed over as a ring, only the distance is charged:
   * the arc costs nothing but the walking, and giving ground costs every tick it
   * lasts. That is "strafe rather than back off", as one term rather than a
   * rule. See {@link TrajectoryRequest.orbitTiles}.
   */
  readonly orbit?: DodgeOrbit | undefined;
}

/** Something to keep a distance from, and how far off it to be. */
export interface DodgeOrbit extends Position {
  /** In tiles, from its centre. Nought or less is no ring at all. */
  readonly radiusTiles: number;
}

export interface DodgePlan {
  readonly verdict: DodgeVerdict;
  /** Whether the caller should command a move at all. */
  readonly steer: boolean;
  /** Unit direction to move. Both zero means "hold still, deliberately". */
  readonly dirX: number;
  readonly dirY: number;
  /**
   * How far to displace the character that way, in tiles.
   *
   * **A heading and a distance**, and the distance is as much of the answer as
   * the heading: threading a gap is arriving in it and stopping, where carrying
   * on at the same speed walks out the other side. Zero exactly when the plan is
   * to hold.
   */
  readonly stepTiles: number;
  /** When the chosen trajectory is first hit, from now, or `Infinity`. */
  readonly impactMs: number;
  /** The least room it ever has, over the whole horizon. */
  readonly clearanceTiles: number;
  /**
   * Whether something is standing inside the keep-away distance right now.
   *
   * **What tells "get out of this" from every other reason to move.** A dodge is
   * a sidestep with a margin in hand; making room from a monster already on top
   * of the player is a shove, and the difference is worth a little speed.
   */
  readonly crowded: boolean;
  /** How many shots could reach the player at all. */
  readonly trackedShots: number;
  /** How many area effects are on their way down and could catch us. */
  readonly trackedBlasts: number;
  /** How many futures the optimizer rolled. Nought when it never had to run. */
  readonly evaluated: number;
  /** Whether the plan is riding a recognised pattern's moving gap. */
  readonly ridingPattern: boolean;
}

/**
 * How long a committed direction still costs a plan to abandon.
 *
 * Refreshed whenever a move is commanded, so a commitment expires on its own
 * rather than renewing itself, and a plan made after a quiet stretch starts with
 * no opinion at all.
 */
const HOLD_FRESH_MS = 260;

/**
 * How much of the safe margin the player's own course has to have before nothing
 * is said.
 *
 * **A fraction, and a small one, because the two numbers are different
 * questions.** `safeClearanceTiles` is what a trajectory *aims* for — the point
 * at which more room stops being worth moving for. What decides whether to speak
 * at all is far tighter: did the shot actually miss. Using the same number for
 * both is a planner that seizes the wheel over a bullet passing a comfortable
 * tile away, which is the leash this feature exists not to be.
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
 * a place they still want and becomes a place across the room.
 */
const ANCHOR_REACH_TILES = 4;

/**
 * How much harder a place the player named is held than ground a dodge happened
 * to take them off, as a multiple of `holdGroundWeight`.
 *
 * **It buys the walk home, and it cannot buy anything else.** A step that ends
 * short of comfortable is charged on the ground it *left* rather than the ground
 * it reached — see `TrajectoryScore` — so no anchor weight whatever can pay for
 * a tight step, and raising this only makes the planner willing to spend more
 * *travel* on getting back.
 */
const PINNED_ANCHOR_SCALE = 3;

/** And the most it may come to, whatever the pull is set to. */
const MAX_PINNED_ANCHOR = 2;

/**
 * How near the held ground counts as being back on it, in tiles.
 *
 * **What makes the dodge a sidestep rather than a drift.** Without a way back
 * the planner is content wherever the last shot left it — every plan measures
 * from where the character is now, so every plan is already home — and a fight
 * walks somebody the length of the room one blameless step at a time.
 *
 * Small, and smaller than the previous generation's, because the moves this
 * planner makes are smaller: a tenth of a tile is a displacement it can command
 * exactly, so a tenth of a tile is what "back" is allowed to mean.
 */
const RETURN_TILES = 0.12;

/**
 * How far inside a monster's bubble is worth taking the wheel over, in tiles.
 *
 * **Not "inside it at all".** The bubble is a couple of tiles wide, so its edge
 * is where an ordinary fight happens; a planner that acts there is one that
 * never stops acting.
 */
const CROWD_ACT_TILES = 0.75;

/** The most travel one tick may consider, so a bad speed cannot size a plan. */
const MAX_STEP_TILES = 3;

/** How far out a pattern is worth recognising, in tiles. */
const PATTERN_REACH_TILES = 22;

/**
 * The rest of the cost model, which is not anybody's to tune.
 *
 * **Ratios rather than preferences.** What a person actually wants to say is how
 * hard the planner should hold their ground, and that is one number —
 * `holdGroundWeight`, which every constant below is quoted against.
 */

/** Per tile moved. What keeps the character still when nothing forces a move. */
const TRAVEL_PER_TILE = 0.4;

/**
 * Per tile short of comfortable, per tick.
 *
 * **Two orders of magnitude above the anchor, and it has to be.** Coming back is
 * worth about a tile of deviation per tick; a shot aimed at the ground they were
 * standing on is crossing exactly the way home, and at anything less than this
 * the arithmetic buys the last hundredth of a tile of room with a shorter walk.
 */
const RISK_PER_TILE = 40;

/** Per tile inside a monster's bubble, before the curve steepens it. */
const CROWD_PER_TILE = 4;

/**
 * Per tile of the keep-clear distance a step is short of, before the curve.
 *
 * **Above the room a shot leaves, deliberately.** Room from a bullet is a bet on
 * a prediction; distance from a pool is a fact about the map, and standing in
 * one costs health every tick with nothing left to dodge.
 */
const HAZARD_PER_TILE = 60;

/**
 * What leaving the DPS ring costs per tick, as tiles of anchor distance.
 *
 * Quoted this way so it moves with the one number a person sets: leaving the
 * ring is worth about two thirds of a tile of being off the anchor, every tick,
 * on top of however far off it actually is.
 */
const DPS_TICK_AS_TILES = 0.6;

/**
 * What a complete reversal of the held direction costs.
 *
 * The smallest term in the model, because that is where the
 * ladder puts it. It exists to settle two candidates the field cannot tell
 * apart, and to be outvoted the moment one of them is genuinely better.
 */
const TURN_PER_REVERSAL = 0.18;

/** What damaging ground is worth, against a tile of somebody standing on you. */
const UNFIT_HAZARD_SCORE = 100;

/** And a shot that has stopped on it, which is just as much not worth going to. */
const UNFIT_PARKED_SCORE = 100;

export class DodgePlanner {
  readonly #shots = new ShotField();
  readonly #danger = new DangerField();
  readonly #blasts = new Blasts();
  readonly #pockets = new PocketLock();
  readonly #optimizer = new TrajectoryPlanner();

  /** The direction the last commanded move went, and when it was chosen. */
  #holdDirX = 0;
  #holdDirY = 0;
  #holdAtMs = 0;

  /**
   * The ground the planner took the player off, and whether it is still holding
   * it.
   *
   * **Held only while it is driving**, which is the whole of what makes it safe.
   * A remembered place that outlived the reason for it is a planner pulling
   * somebody back to where they were a minute ago; one that only exists between
   * "I moved you" and "you are back" is a sidestep with a return in it.
   */
  #anchorX = 0;
  #anchorY = 0;
  #anchorHeld = false;
  #anchorAtMs = 0;
  /**
   * How far off {@link #anchorX} to stand, when the held ground is a ring.
   *
   * Nought for every other kind of anchor, which is what the whole of the cost
   * model reads it as: a place. See {@link DodgeSituation.orbit}.
   */
  #orbitTiles = 0;
  /**
   * Whether the last plan was holding a place the player named rather than one
   * a dodge remembered.
   *
   * Kept so the two can hand over cleanly: what one of them was holding is not
   * the other's to hold.
   */
  #pinned = false;

  /** Rewritten in place: a plan happens fifty times a second. */
  readonly #weights: { -readonly [K in keyof TrajectoryWeights]: TrajectoryWeights[K] } = {
    anchorPerTile: 0,
    dpsRadiusTiles: 0,
    dpsPerTick: 0,
    travelPerTile: TRAVEL_PER_TILE,
    turnPerReversal: TURN_PER_REVERSAL,
    safeClearanceTiles: 0,
    riskPerTile: RISK_PER_TILE,
    crowdPerTile: CROWD_PER_TILE,
    hazardPerTile: HAZARD_PER_TILE,
    hazardClearTiles: 0,
  };

  /** The optimizer's own inputs, rewritten in place for the same reason. */
  readonly #request: { -readonly [K in keyof TrajectoryRequest]: TrajectoryRequest[K] } = {
    startX: 0,
    startY: 0,
    anchorX: 0,
    anchorY: 0,
    anchorStepX: 0,
    anchorStepY: 0,
    orbitX: 0,
    orbitY: 0,
    orbitTiles: 0,
    stepTiles: 0,
    ticks: 1,
    tickMs: 100,
    leadMs: 0,
    headings: 12,
    weights: this.#weights,
    holdDirX: 0,
    holdDirY: 0,
    ground: undefined as unknown as DodgeGround,
    danger: this.#danger,
    blasts: undefined,
    pockets: undefined,
    budget: 256,
  };

  readonly #plan = {
    verdict: 'clear' as DodgeVerdict,
    steer: false,
    dirX: 0,
    dirY: 0,
    stepTiles: 0,
    impactMs: Infinity,
    clearanceTiles: NO_DANGER_TILES,
    crowded: false,
    trackedShots: 0,
    trackedBlasts: 0,
    evaluated: 0,
    ridingPattern: false,
  };

  /** Forgets everything. A new connection is a new character in a new place. */
  reset(): void {
    this.#shots.clear();
    this.#danger.clear();
    this.#blasts.clear();
    this.#pockets.reset();
    this.#optimizer.reset();
    this.#holdDirX = 0;
    this.#holdDirY = 0;
    this.#holdAtMs = 0;
    this.#anchorHeld = false;
    this.#anchorAtMs = 0;
    this.#orbitTiles = 0;
    this.#pinned = false;
  }

  /**
   * Decides what to do about everything in the air.
   *
   * @param world Where a body may stand, where the ground hurts, and how much
   *   room to dodge in a place leaves. See `DodgeScene`.
   * @param patterns What geometry is being fired, when anything has been
   *   recognised. Omitted, the planner is a pure bullet-dodger and every other
   *   stage works exactly as it does with one.
   * @returns a plan valid until the next call. Never held on to by the caller.
   */
  plan(
    situation: DodgeSituation,
    settings: DodgeSettings,
    world: DodgeGround,
    shots: Iterable<DodgeShot>,
    blasts: Iterable<BlastView> = NO_BLASTS,
    patterns?: AttackPatterns,
  ): DodgePlan {
    const plan = this.#plan;
    const tickMs = Math.max(20, settings.tickMs);
    const ticks = Math.max(
      1,
      Math.min(MAX_FIELD_SLICES - 1, Math.round(settings.horizonMs / tickMs)),
    );
    const stepTiles = Math.min(
      MAX_STEP_TILES,
      Math.max(0, (situation.speedTilesPerSecond * tickMs) / 1000),
    );
    const reachTiles = stepTiles * ticks;
    const horizonMs = settings.leadMs + ticks * tickMs;

    this.#shots.build(shots, {
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
    // so asking the field to measure it is asking a query to drag half a screen
    // of shots through the exact test for an answer nothing reads.
    this.#danger.build(this.#shots, {
      centreX: situation.x,
      centreY: situation.y,
      reachTiles,
      interestTiles: settings.safeClearanceTiles,
    });
    this.#blasts.collect(
      blasts,
      situation.gameTimeMs,
      situation.x,
      situation.y,
      reachTiles,
      horizonMs,
    );

    const crowding = world.crowdingAt(situation.x, situation.y, 0);
    plan.trackedShots = this.#shots.count;
    plan.trackedBlasts = this.#blasts.count;
    plan.crowded = crowding > 0;
    plan.evaluated = 0;
    plan.ridingPattern = false;

    const steering = situation.intentX !== 0 || situation.intentY !== 0;
    const offGround = this.#aimAnchor(
      situation,
      steering,
      world,
      stepTiles,
      settings.headings,
      ticks,
    );

    // **Where the gaps will be, before anything is asked about where to move.**
    // A pattern is recognised from the volleys rather than from the bullets, so
    // this costs a walk of a table with a couple of dozen rows in it whether or
    // not the screen is full — and when it finds nothing, every stage after it
    // behaves exactly as though it did not exist.
    if (patterns !== undefined) {
      this.#pockets.aim(patterns, this.#shots, {
        x: situation.x,
        y: situation.y,
        withinTiles: PATTERN_REACH_TILES,
        gameTimeMs: situation.gameTimeMs,
        leadMs: settings.leadMs,
        tickMs,
        ticks,
        safeClearanceTiles: settings.safeClearanceTiles,
        stepTiles,
      });
    } else {
      this.#pockets.reset();
    }

    this.#fill(situation, settings, world, stepTiles, ticks, tickMs);

    // **What the player is already doing, and whether it needs answering.** The
    // course they are on rather than the ones they might take: a planner asking
    // "could anything reach me" takes the wheel every time something fires
    // anywhere, and one asking "is what I am doing about to cost me" leaves an
    // entire fight alone.
    this.#optimizer.probe(
      this.#request,
      situation.intentX,
      situation.intentY,
      settings.reactWithinMs,
    );
    if (
      !situation.onDamagingGround &&
      crowding <= CROWD_ACT_TILES &&
      offGround <= RETURN_TILES &&
      // **Walking into a pool is a mistake worth answering on its own**, with
      // nothing in the air at all. The optimizer will not walk into one, so the
      // whole of what this decides is whether the planner may keep quiet while
      // the player does.
      this.#optimizer.probeHazardTiles >= 0 &&
      this.#optimizer.probeImpactMs > settings.reactWithinMs &&
      this.#optimizer.probeUrgentTiles >= settings.safeClearanceTiles * PROBE_MARGIN_FRACTION
    ) {
      plan.verdict = steering ? 'intent-safe' : 'clear';
      plan.steer = false;
      plan.dirX = 0;
      plan.dirY = 0;
      plan.stepTiles = 0;
      plan.impactMs = this.#optimizer.probeImpactMs;
      plan.clearanceTiles = this.#optimizer.probeRoomTiles;
      // Back where they were, so there is no longer any ground to hold — the
      // anchor goes back to following the character.
      this.#anchorHeld = false;
      this.#release();
      return plan;
    }

    const trajectory = this.#optimizer.run(this.#request);
    plan.evaluated = trajectory.evaluated;
    plan.impactMs = trajectory.impactMs;
    plan.clearanceTiles = trajectory.clearanceTiles;
    plan.dirX = trajectory.dirX;
    plan.dirY = trajectory.dirY;
    plan.stepTiles = trajectory.stepTiles;
    plan.ridingPattern = trajectory.ridingPocket && this.#pockets.locked;
    // Standing still is a real answer, and under fire it is usually because
    // nowhere in reach is better. It is still worth commanding while the player
    // is pressing a key, because then the command is what cancels it.
    plan.steer = trajectory.stepTiles > 0 || steering;
    plan.verdict = verdictFor(situation, plan, trajectory);

    if (trajectory.stepTiles > 0) {
      this.#commit(trajectory.dirX, trajectory.dirY, situation.nowMs);
      // The ground under the character stops being the ground it is aiming for
      // the moment it moves them off it, and stays that way until they are back.
      this.#anchorHeld = true;
    } else {
      this.#release();
    }
    return plan;
  }

  /** Points the optimizer at this plan's world, weights and geometry. */
  #fill(
    situation: DodgeSituation,
    settings: DodgeSettings,
    world: DodgeGround,
    stepTiles: number,
    ticks: number,
    tickMs: number,
  ): void {
    // **Nought while standing in it**, because the anchor is the ground the
    // player is on and that ground is what is hurting them. Leaving is then the
    // only thing worth wanting, and the hazard term is what says so. A place the
    // player named is no exception: coming back to it starts with not being in a
    // pool.
    const pull = Math.max(0, settings.holdGroundWeight);
    const weights = this.#weights;
    weights.anchorPerTile = situation.onDamagingGround
      ? 0
      : this.#pinned
        ? Math.min(pull * PINNED_ANCHOR_SCALE, MAX_PINNED_ANCHOR)
        : pull;
    weights.dpsRadiusTiles = Math.max(0, settings.dpsRadiusTiles);
    weights.dpsPerTick = weights.anchorPerTile * DPS_TICK_AS_TILES;
    weights.safeClearanceTiles = settings.safeClearanceTiles;
    weights.hazardClearTiles = Math.max(0, settings.hazardClearTiles);

    const holding =
      (this.#holdDirX !== 0 || this.#holdDirY !== 0) &&
      situation.nowMs - this.#holdAtMs <= HOLD_FRESH_MS;

    const request = this.#request;
    request.startX = situation.x;
    request.startY = situation.y;
    // **Their own ground**: where the planner took them from, or where they are
    // when it has not taken them anywhere — and walking, the line they are
    // walking, one tick of it at a time. See {@link #aimAnchor}.
    request.anchorX = this.#anchorX;
    request.anchorY = this.#anchorY;
    request.anchorStepX = situation.intentX * stepTiles;
    request.anchorStepY = situation.intentY * stepTiles;
    // The same two numbers again when the ground is a ring, because then they
    // are its centre rather than a place — see {@link TrajectoryRequest.orbitTiles}.
    request.orbitX = this.#anchorX;
    request.orbitY = this.#anchorY;
    request.orbitTiles = this.#orbitTiles;
    request.stepTiles = stepTiles;
    request.ticks = ticks;
    request.tickMs = tickMs;
    request.leadMs = settings.leadMs;
    request.headings = settings.headings;
    request.holdDirX = holding ? this.#holdDirX : 0;
    request.holdDirY = holding ? this.#holdDirY : 0;
    request.ground = world;
    request.blasts = this.#blasts.count > 0 ? this.#blasts : undefined;
    request.pockets = this.#pockets.locked ? this.#pockets : undefined;
    request.budget = Math.max(16, Math.round(settings.budget));
  }

  /**
   * Settles where the player's own ground is this plan, and how far off it they
   * have been taken.
   *
   * **Held only between "I moved you" and "you are back".** Without a way back
   * the planner is content wherever the last shot left it — every plan measures
   * from where the character is *now*, so every plan is already home — and a
   * long fight walks somebody the length of the room one blameless step at a
   * time.
   *
   * **And it is dropped in every case where holding it would be a fight.** They
   * are steering, so the ground they want is wherever they are walking; nothing
   * has been planned for long enough that the memory is stale; or the fight has
   * pushed them so far that the old place is across the room rather than a step
   * away.
   *
   * **None of which applies to a place the player named.** Every rule above is a
   * guess about what ground they wanted, and a guess is exactly what a key press
   * is not. The one thing that overrides it is the player walking, which is a
   * more recent statement of where they want to be than the key was.
   *
   * @returns how far off the held ground the character is, in tiles.
   */
  #aimAnchor(
    situation: DodgeSituation,
    steering: boolean,
    world: DodgeGround,
    stepTiles: number,
    headings: number,
    ticks: number,
  ): number {
    // Both are the player saying where they want to be, and both are dropped by
    // the same thing: walking is a more recent statement than either was. Which
    // of the two is in force is settled by the caller, so a plan is never handed
    // a place and a ring at once.
    const pin = steering ? undefined : situation.anchor;
    const ring = steering || pin !== undefined ? undefined : situation.orbit;
    const named = pin !== undefined || (ring !== undefined && ring.radiusTiles > 0);
    if (named !== this.#pinned) {
      // Changing hands. What the other kind of anchor was holding is not this
      // one's to hold — most of all when a pin is dropped, where the ground it
      // named must not become ground a dodge goes on returning to.
      this.#pinned = named;
      this.#anchorHeld = false;
    }
    if (pin !== undefined) {
      this.#anchorX = pin.x;
      this.#anchorY = pin.y;
      this.#orbitTiles = 0;
      this.#anchorAtMs = situation.nowMs;
      return Math.hypot(situation.x - pin.x, situation.y - pin.y);
    }
    if (ring !== undefined && ring.radiusTiles > 0) {
      this.#anchorX = ring.x;
      this.#anchorY = ring.y;
      this.#orbitTiles = ring.radiusTiles;
      this.#anchorAtMs = situation.nowMs;
      // **How far off the ring, not how far from the thing.** Standing anywhere
      // on it is standing on the held ground, which is what the whole of the
      // cost model below then reads — and what keeps the probe quiet while the
      // player is already at the right distance, wherever round it they are.
      return Math.abs(Math.hypot(situation.x - ring.x, situation.y - ring.y) - ring.radiusTiles);
    }

    if (this.#anchorHeld) {
      const stale = situation.nowMs - this.#anchorAtMs > ANCHOR_FRESH_MS;
      this.#anchorAtMs = situation.nowMs;
      if (!steering && !stale) {
        const worth = this.#shiftAnchor(world, stepTiles, headings, situation, ticks);
        const off = Math.hypot(situation.x - this.#anchorX, situation.y - this.#anchorY);
        if (worth && off <= ANCHOR_REACH_TILES) return off;
      }
      this.#anchorHeld = false;
    }

    this.#anchorX = situation.x;
    this.#anchorY = situation.y;
    this.#orbitTiles = 0;
    this.#anchorAtMs = situation.nowMs;
    return 0;
  }

  /**
   * Walks the held ground out from under whatever has taken it.
   *
   * **A return point is a claim that somewhere is worth standing on**, and a
   * monster walking onto it makes that claim false — so the planner was pulling
   * the character back into the body it had just stepped out of. Ground that has
   * started to hurt is the same mistake with a worse ending.
   *
   * **One step per plan, and it stops as soon as it is clear.** The anchor is a
   * place to come back to, not a heading, so it may not sprint: it moves by a
   * single step towards whichever neighbour is least crowded, settles the moment
   * nothing is standing in it, and is dropped altogether once the character has
   * been carried further from it than {@link ANCHOR_REACH_TILES}.
   */
  #shiftAnchor(
    world: DodgeGround,
    stepTiles: number,
    headings: number,
    situation: DodgeSituation,
    ticks: number,
  ): boolean {
    let bestScore = this.#unfitness(world, this.#anchorX, this.#anchorY, ticks);
    if (bestScore <= 0) return true;

    let bestX = this.#anchorX;
    let bestY = this.#anchorY;
    // Nearer the character breaks a tie, so the return point backs away from
    // the monster rather than away from the player.
    let bestNear = Math.hypot(this.#anchorX - situation.x, this.#anchorY - situation.y);

    const ring = Math.max(4, Math.round(headings));
    for (let i = 0; i < ring; i += 1) {
      const angle = (i * 2 * Math.PI) / ring;
      const toX = this.#anchorX + Math.cos(angle) * stepTiles;
      const toY = this.#anchorY + Math.sin(angle) * stepTiles;
      const score = this.#unfitness(world, toX, toY, ticks);
      if (score > bestScore) continue;
      const near = Math.hypot(toX - situation.x, toY - situation.y);
      if (score === bestScore && near >= bestNear) continue;
      bestScore = score;
      bestNear = near;
      bestX = toX;
      bestY = toY;
    }

    this.#anchorX = bestX;
    this.#anchorY = bestY;
    // **Whether the place it settled on is worth walking back to at all, which
    // is a different question from whether it is crowded.** Crowding is what the
    // stepping above is *for*. What cannot be answered by stepping is a shot
    // that has stopped on it — it will sit there for the rest of its life, and
    // no number of steps makes that ground worth having.
    return !this.#parkedOn(bestX, bestY, ticks) && world.hazardGapTiles(bestX, bestY) >= 0;
  }

  /**
   * How unfit a place is to be the ground the planner walks back to.
   *
   * Nought for anywhere worth standing, and larger the less worth standing it
   * is. Somewhere a body does not fit is refused outright — a return point
   * inside a wall is a target the character can never arrive at.
   */
  #unfitness(world: DodgeGround, x: number, y: number, ticks: number): number {
    if (!world.canStand(x, y)) return Infinity;
    let score = world.crowdingAt(x, y, 0);
    if (world.hazardGapTiles(x, y) < 0) score += UNFIT_HAZARD_SCORE;
    if (this.#parkedOn(x, y, ticks)) score += UNFIT_PARKED_SCORE;
    return score;
  }

  /**
   * Whether a shot is going to be *sitting* on this place, rather than passing
   * over it.
   *
   * **Two moments well apart, which is the whole of the test.** A bullet crosses
   * a place and is gone; one that has slowed to a stop is there at the middle of
   * the horizon and still there at the end of it. Asking about both tells the
   * two apart without the planner having to know anything about acceleration
   * curves.
   */
  #parkedOn(x: number, y: number, ticks: number): boolean {
    const last = ticks - 1;
    if (last < 1) return false;
    const middle = last >> 1;
    if (this.#danger.clearanceOf(last, x, y, x, y) >= 0) return false;
    return this.#danger.clearanceOf(middle, x, y, x, y) < 0;
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

/**
 * Why the planner is about to move, once it has decided that it is.
 *
 * **Why, not how.** The reason for a move is a separate question at every rung
 * of this ladder: the fast way out of a pool is an escape, and a shove away
 * from a body is spacing. Folding them together meant the picture could not
 * say what the planner was actually answering.
 */
function verdictFor(
  situation: DodgeSituation,
  plan: DodgePlan,
  trajectory: DodgeTrajectory,
): DodgeVerdict {
  if (trajectory.impactMs < Infinity) return 'unavoidable';
  if (situation.onDamagingGround) return 'escape';
  if (trajectory.stepTiles === 0) return 'hold';
  if (plan.trackedShots === 0 && plan.trackedBlasts === 0 && plan.crowded) return 'spacing';
  return 'weave';
}
