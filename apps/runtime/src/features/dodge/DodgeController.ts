/**
 * The one decision: whether to take the wheel, and where to go with it.
 *
 * **Four generations of the reference implementation collapse into this.** The
 * old tree had roughly 7 500 lines of C++ solving the same problem four ways — a
 * spacetime BFS over a 41×41×13 danger grid with an A* strategic tier, a
 * forward-rollout planner with three broad-phase backends, an intent-assist
 * slide planner, and a clearance controller. Only the last of those was asking
 * the right question. A grid quantises time and space and then needs a fringe, a
 * corner-clip filter, a walkability cache and a continuous-collision pass bolted
 * on to undo the quantisation; asking each candidate course "how close does this
 * come to anything, and when" needs none of it and is exact.
 *
 * The shape here is: propose a small set of straight courses, sweep each one
 * against every shot that could reach us, and then — and this is the part that
 * decides how the feature *feels* — prefer the course the player was already
 * asking for, and only overrule them by as much as survival actually requires.
 *
 * **Two windows, and confusing them is the difference between a dodge and a
 * leash.** `reactWithinMs` is how soon trouble has to be before it is this
 * moment's problem; `horizonMs` is how far ahead courses are *compared*. A shot
 * eight tiles away with a long life will reach the player inside a second, so a
 * planner with one window treats it as danger, walks away from it, and can never
 * approach the monster that fired it. Judging on the near window and ranking on
 * the far one is what lets the same planner be relaxed about distant fire and
 * still prefer the sidestep to the backpedal — because the backpedal's low room
 * at the far end is exactly what the ranking sees.
 *
 * **Why straight courses and not a path.** A plan made fifty times a second is
 * never executed to its end; the second half of any route is replaced before it
 * is walked. A route through a bullet field is therefore a more expensive way of
 * choosing the same first step — which is the receding-horizon argument, and it
 * is why the A* tier in the reference existed only to travel somewhere, never to
 * dodge.
 *
 * **Straight, but not always at full speed.** Full speed in every direction
 * reaches a ring; the places that are actually safe in a wall of shots are
 * mostly *inside* it — a half-step into a gap, or a shuffle that lets an arc
 * sweep past. So when nothing at full speed survives, the same directions are
 * tried again at part speed. It is off the fast path deliberately: in open fire
 * the first tier answers, and the extra tiers are the difference between "no
 * escape" and threading a fan.
 *
 * **A window is not the same question as a wall, and one number tells them
 * apart.** A bullet is answered by a sidestep, so "is this trouble close enough
 * to act on" is the right question about one. A pattern several tiles deep is
 * answered by a run, and asking the same question about it produces the failure
 * the player reported: nothing was close enough to be this moment's problem
 * until the moment nothing could be done. The signature of the second is that
 * *every* candidate, in every direction, is predicted to be hit inside the
 * horizon — a single shot never manages that — and it is what the `outrun`
 * verdict is for.
 *
 * **A wall is not damage.** Walking into one costs a step, so geometry here
 * *shortens* a course rather than condemning it: the sweep keeps going with the
 * player standing where the wall stopped them, and that course simply stops
 * earning distance from what is coming. Damaging ground is the opposite — it
 * costs health, so reaching it is scored exactly like being hit, and heading
 * into it is worth taking the wheel for even when nothing is in the air.
 *
 * **Where to stand is part of the same decision, and it is not goal-seeking.**
 * A band — no nearer to a monster than leaves room to dodge, no further than the
 * weapon reaches — is a *preference between the courses already being compared*,
 * which costs a comparison and can never fight the player for the wheel. It has
 * to be able to act, though, and not only to rank: every course that gives
 * ground survives fractionally longer than every course that does not, so a
 * planner that only ranks on it drifts out of the fight one safe step at a time
 * and a monster that walks onto somebody is watched in silence. Both edges are
 * one rule, and both stand down the moment the player's own walking is what is
 * fixing the distance.
 *
 * **What is deliberately not here.** No goal-seeking, no orbit, no enemy lock,
 * no path drawing. The band is a preference over candidates, not a place to go;
 * nothing here picks a destination. Folding one in is how the reference ended up
 * with a nine-hundred-line arbiter and a mode-hysteresis timer. This decides one
 * thing.
 */

import { Blasts, type BlastView } from './Blasts.js';
import {
  COHERENT_FLOW,
  ThreatField,
  type DodgeShot,
  type Sweep,
  type ThreatFieldOptions,
} from './ThreatField.js';
import { WalkReach, type Ground, type Reach } from './WalkReach.js';

/** A session with nothing throwing bombs, which is most of them. */
const NO_BLASTS: readonly BlastView[] = [];

/** Why the controller did what it did. Reported so a log can say so. */
export type DodgeVerdict =
  /** Nothing that could reach us in time. The player has the wheel throughout. */
  | 'clear'
  /** Their own course is fine for the window that matters. Left alone. */
  | 'intent-safe'
  /** Not urgent: moved to the nearest course that is safe and still theirs. */
  | 'guide'
  /** Nothing in the air; the fighting distance is wrong. Fixing it. */
  | 'spacing'
  /**
   * Nowhere within reach stays clear. Running, while there is still time to.
   *
   * The wide-attack case, and the whole reason it has a name: a wall of shots
   * is not answered by a sidestep, and by the time one is close enough to be
   * this moment's problem the only answer left is which hit to take.
   */
  | 'outrun'
  /** Something lands soon. Survival first, their heading second. */
  | 'evade'
  /** No course clears the window. This is the one that is hit latest and least. */
  | 'unavoidable'
  /** Standing on damaging ground. Leaving is the plan. */
  | 'escape';

export interface DodgeSettings {
  /**
   * How far ahead courses are compared.
   *
   * Ranking only — see the file's note on the two windows. Long enough that a
   * course which merely postpones a hit is visibly worse than one that solves
   * it, which is what stops the planner backpedalling into a corner.
   */
  readonly horizonMs: number;
  /**
   * How soon trouble has to be before it is worth acting on.
   *
   * **The setting that decides whether the feature is help or a leash.** Below
   * it, nothing on the far side of the room can take the wheel away, so walking
   * up to something that is shooting is possible again.
   */
  readonly reactWithinMs: number;
  /**
   * How near a shot has to actually be before it may take the wheel, in tiles.
   *
   * The ring — see {@link ThreatFieldOptions.engageTiles}. Safe to keep tight
   * because it is not the only trigger: a shot too fast, or a pattern too wide,
   * for the ring to be reached in time raises its hand on the escape deadline
   * instead, which is about time rather than distance.
   */
  readonly engageWithinTiles: number;
  /** Spacing of predicted shot positions. See {@link ThreatFieldOptions}. */
  readonly sampleStepMs: number;
  /** How many directions to consider, evenly spaced. */
  readonly headings: number;
  /** Multiplies every shot's extent. Above 1 is more cautious. */
  readonly hitScale: number;
  /** A flat margin on every shot. */
  readonly padTiles: number;
  /**
   * How long before a plan takes effect.
   *
   * A decision made here reaches the module a frame later and the server later
   * still, so for this long the player is still standing where they are while
   * the shots are not. It *delays* the walk — see {@link ThreatField.sweep},
   * where crediting it as a head start instead was costing most of a tile.
   */
  readonly leadMs: number;
  /** How fast confidence in a prediction decays. See {@link ThreatFieldOptions}. */
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
  /** Trouble sooner than this is worth overruling the player firmly for. */
  readonly urgentWithinMs: number;
  /** Let geometry shorten a course. Off means only the game's own collision. */
  readonly avoidWalls: boolean;
  /** Treat damaging ground as somewhere not to be. */
  readonly avoidDamagingGround: boolean;
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
  /** Wall-clock, for hysteresis and the ground cache. */
  readonly nowMs: number;
  /**
   * Whether the player is standing on ground that is costing them health.
   *
   * **A fact about the player, and deliberately not a question put to the
   * ground.** The game charges for the one tile the character's centre is on;
   * what the planner refuses is the body plus a margin — see
   * {@link DodgeWorld.isDamaging} — and reading "am I in it" off that wider
   * answer had the planner announcing an escape from ground nobody was being
   * hurt by, every time a player chose to stand at the edge of a pool.
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
   * What fraction of full speed to walk at.
   *
   * Below one when the safe place is inside the ring rather than on it — see the
   * file's note on part speed. Zero exactly when the plan is to hold.
   */
  readonly speedScale: number;
  /** When the chosen course first has less than a safe margin, or `Infinity`. */
  readonly unsafeAtMs: number;
  /** When the chosen course is first actually hit, or `Infinity`. */
  readonly impactMs: number;
  /** The least room that course ever has, over the whole horizon. */
  readonly clearanceTiles: number;
  /**
   * Whether something is standing inside the near edge right now.
   *
   * **What tells "get out of this" from every other reason to walk.** A dodge is
   * a sidestep with a margin in hand; making room from a monster already on top
   * of the player is a shove, and the difference is worth a little speed — see
   * where the caller spends it. Reported rather than folded into
   * {@link speedScale}, because the scale is about which candidate was chosen
   * and this is about how hard to carry it out.
   */
  readonly crowded: boolean;
  /** How many shots could reach the player at all. */
  readonly trackedShots: number;
  /**
   * How many area effects are on their way down and could catch us.
   *
   * Reported beside the shots and not folded into them: whether a blast was
   * seen at all is the one thing a log cannot otherwise answer, because the
   * telegraph that announces one is decoded from a packet body nobody
   * documented. A takeover line with blasts in it is the proof it arrived.
   */
  readonly trackedBlasts: number;
}

/**
 * What a plan needs of the world beyond the shots.
 *
 * A few callbacks rather than a world model: the controller is arithmetic over
 * positions, and the only reason it needs the map is to refuse places the player
 * cannot or should not be.
 */
export interface DodgeWorld extends Ground {
  /**
   * How far out of position a place is, in tiles: negative too near a monster,
   * positive further from one than the weapon reaches, nought when it is
   * somewhere worth standing. See `EnemyBodies.standoffAt`.
   *
   * **Scored, never a veto.** The only lane out of a volley sometimes runs past
   * a monster, and a planner that refuses it stands in the volley instead.
   *
   * @param aheadMs When the player would be standing there, from now. The
   *   monsters are carried forward over it, which is what tells one the player
   *   walked up to from one that is walking up to the player.
   */
  standoffAt(x: number, y: number, aheadMs: number): number;
}

/** The course that stays put. Always index nought, always considered. */
const HOLD = 0;

/**
 * The speeds each direction is offered at.
 *
 * **Full speed alone reaches a ring, and a ring is not the reachable set.** In a
 * wall of shots the survivable places are mostly inside it — half a step into a
 * gap, a shuffle that lets an arc go past — and a planner that can only sprint
 * or stand finds none of them. The reference implementation reached the same
 * conclusion twice: once as a speed-matching pass, once as a multi-segment
 * escape search, both bolted on after "no straight heading survives" turned out
 * to be the common case in dense fire rather than the rare one.
 *
 * Only the first is ever scored unless it fails, so open fire costs what it
 * always did.
 */
const SPEED_TIERS = [1, 0.6, 0.3] as const;

/**
 * How soon damaging ground has to be before it is worth seizing the wheel.
 *
 * A player walking towards lava four tiles away is going somewhere; one about to
 * step in it has made a mistake. Long enough to turn them, short enough that
 * skirting the edge of a pool is still allowed.
 */
const HAZARD_GUARD_MS = 250;

/**
 * How many neighbouring headings either side count towards a course's room.
 *
 * **This is what tells a lane from a needle.** Two courses can both survive the
 * horizon while one runs down the middle of a gap and the other threads between
 * two shots that are about to close. Summing what the neighbours are worth
 * prefers the gap, and it costs nothing but the addition — the neighbours were
 * all evaluated anyway.
 */
const CORRIDOR_NEIGHBOURS = 3;

/**
 * How long a chosen direction is kept before a different one may replace it.
 *
 * The danger field shifts a little every plan, so two near-equal courses swap
 * places on noise — which looks like, and is, a character vibrating. The
 * reference implementation shipped this bug in three generations and fixed it
 * three times, twice at the wrong layer (goal selection, then path selection)
 * before putting it where the commitment actually happens.
 *
 * **Long enough to actually leave, which is what a dodge is for.** A sustained
 * pattern — a fan, a rotating source — has no course that is safe *now*; the way
 * out is to run three or four tiles, which takes the better part of a second at
 * six tiles a second. A planner that re-decides fifty times a second and commits
 * for a tenth of one never completes an escape: it follows the local gradient,
 * which points downwind, and drifts along in front of the pattern taking hits.
 * Measured at a hundred and twenty milliseconds, three seconds of a wide fan
 * produced forty-seven course changes and twenty ticks overlapping a shot; the
 * churn falls off sharply between two and four hundred.
 *
 * **It is not a lock**, and {@link DodgeController.noWorse} is why it is safe to
 * make it this long: the held course is kept only while it is no worse than the
 * fresh answer on every measure that matters. Refreshed only when the course
 * changes, so a commitment expires on its own rather than renewing itself.
 */
const DWELL_MS = 300;

/** How much better a new course must be to break the dwell, in tiles of room. */
const DWELL_BREAK_TILES = 0.06;

/**
 * How much of the safe window may be traded for going the player's way when
 * trouble is close.
 *
 * Only ever spent down to {@link DodgeSettings.reactWithinMs}, never below.
 */
const URGENT_TRADE_MS = 120;

/** The same, for when nothing clears the window: how much of the best is tradeable. */
const DOOMED_TRADE_MS = 60;
const DOOMED_TRADE_TILES = 0.05;

/**
 * And for the run out of a wide pattern.
 *
 * A sample, and no more. Being generous here is what turns a run back into a
 * shuffle: the heading the player is pressing outranks everything in
 * {@link DodgeController.#mostAligned}, so any course admitted alongside the
 * best one is a course their keys can pick — and their keys are how they came to
 * be standing in front of a wall.
 */
const OUTRUN_TRADE_MS = 20;

/** More than the overlay allows, so the tables never resize in a fight. */
const MAX_HEADINGS = 64;

/**
 * How finely two courses are told apart before the next question is asked.
 *
 * **Without this the ordering below has exactly one term.** Two courses that are
 * mirror images of each other come out of the arithmetic a few bits apart —
 * `sin(45°)` and `sin(315°)` are not exactly opposite — so a strict comparison
 * on room always finds a winner and nothing after it is ever reached. Every
 * tiebreak in this file was unreachable for that reason, which is the sort of
 * bug that looks like a preference simply not working.
 *
 * The numbers are also honest ones: five hundredths of a tile is well inside
 * what the prediction can distinguish, and twenty milliseconds is half a sample.
 * A difference smaller than the model's own accuracy is not a difference.
 */
const ROOM_QUANTUM_TILES = 0.05;
const IMPACT_QUANTUM_MS = 20;
/**
 * The same, for how well a course sits relative to the monsters.
 *
 * Coarse, and that is what keeps it from being a leash of its own: two
 * sidesteps around the same monster are equally good places to fight from, and
 * splitting them by a hundredth of a tile would spend the term on a distinction
 * nobody could see. What it is meant to separate is the sidestep from the
 * retreat, and those differ by tiles.
 */
const STANDOFF_QUANTUM_TILES = 0.25;
/**
 * How much worse being too near a monster is than being too far from one.
 *
 * Out of range costs damage that was not dealt; inside the bubble costs the room
 * needed to dodge at all, and then contact damage. They are not the same
 * mistake, so a tile of each does not weigh the same.
 */
const CROWDED_WEIGHT = 2;
/** The same, for how close a course is to the way the player is walking. */
const ALIGNMENT_QUANTUM = 0.02;
/**
 * The same, for how much a course is a retreat.
 *
 * Coarse on purpose: this is meant to separate "running with the shots" from
 * "crossing them", not to rank two sidesteps that differ by a degree.
 */
const RETREAT_QUANTUM = 0.2;

/**
 * How much of a course must run with the shots before it counts as giving
 * ground.
 *
 * Barely more than nothing, and deliberately: this only decides whether it is
 * worth *looking* for something better, and the thing being looked for — a short
 * step through a window — is invisible to the full-speed ring. A course that
 * drifts back at a shallow angle is still drifting back, and answering a pattern
 * that has a hole in it by edging away from it is the behaviour this exists to
 * stop.
 */
const GIVING_GROUND = 0.05;

/** A value in whole quanta, so equal-enough compares equal. */
function inQuanta(value: number, quantum: number): number {
  return Math.round(value / quantum);
}

/** Signed tiles out of the band as a cost. See {@link CROWDED_WEIGHT}. */
function standoffCost(outOfBandTiles: number): number {
  return outOfBandTiles < 0 ? -outOfBandTiles * CROWDED_WEIGHT : outOfBandTiles;
}

/**
 * What a course has to clear before {@link DodgeController.#mostAligned} will
 * look at it at all.
 *
 * **A requirement is not a preference, and mixing the two is how a planner ends
 * up trading being hit for a tidier heading.** Everything in the ordering below
 * the bars is an argument about which of several acceptable courses is nicest;
 * these decide what "acceptable" means, and they are settled first so that no
 * amount of niceness can outvote them.
 */
interface Bars {
  /** Trouble must be strictly later than this. */
  windowMs: number;
  /**
   * And a hit strictly later than this.
   *
   * **Strictly, because the release test is strict**, and a course that is hit
   * at exactly the moment the window closes has to be refused by both or by
   * neither. Admitted here while refused there, it produced a plan that would
   * not hand the wheel back and then chose to stand still anyway — a `guide`
   * verdict steering nowhere, with a hit predicted on the last sample of the
   * window. Both are now "a hit inside the window is a hit inside the window".
   */
  impactMs: number;
  /** And at least this much room over the horizon. */
  roomTiles: number;
  /**
   * And a strictly better place against the monsters than this, in quanta.
   *
   * `Infinity` — the usual case — admits everything, which is what "nobody is
   * inside the bubble" should mean. Finite only while something is, and then it
   * is the cost of standing where the player already is: a course that does not
   * improve on that is not an answer to being crowded.
   */
  standoff: number;
}

export class DodgeController {
  readonly #field = new ThreatField();
  readonly #blasts = new Blasts();
  readonly #reach = new WalkReach();

  /**
   * Candidate courses.
   *
   * Index nought holds still. After it come {@link SPEED_TIERS} blocks, each of
   * `headings + 1` slots: the ring at that speed, then the player's own
   * direction at that speed. One flat layout so every array below is indexed the
   * same way, and so a tier can be scored without disturbing the ones before it.
   */
  #dirX = new Float64Array(0);
  #dirY = new Float64Array(0);
  #scale = new Float64Array(0);
  /** Just the ring, as the ground cache wants it. Views, not copies. */
  #headingX = new Float64Array(0);
  #headingY = new Float64Array(0);
  /** How far each course can go before geometry stops it, in tiles. */
  #wallTiles = new Float64Array(0);
  /** When each course reaches damaging ground, and when it leaves it. */
  #hazardMs = new Float64Array(0);
  #exitMs = new Float64Array(0);
  #impactMs = new Float64Array(0);
  #unsafeMs = new Float64Array(0);
  #clearance = new Float64Array(0);
  /** The same, over the reaction window alone. See {@link Sweep.urgentClearanceTiles}. */
  #urgentClearance = new Float64Array(0);
  /** How far out of the standoff band each course ends up, as a cost. */
  #standoff = new Float64Array(0);
  #headings = -1;
  /** Slots per speed tier: the ring plus the player's own direction. */
  #stride = 0;

  /** How high a course's survival may count towards a lane. See {@link #lane}. */
  #survivalCapMs = 0;

  /** Why {@link #choose} chose what it did, for the plan to report. */
  #verdict: DodgeVerdict = 'clear';

  /**
   * Whether something is standing closer than the band allows.
   *
   * A field rather than an argument because {@link #mostAligned} needs it and
   * already takes six. What it changes there is one thing: a player who has let
   * go of the keys is normally asking to stay where they are, and while
   * something is on top of them that is not a request worth honouring.
   */
  #crowded = false;

  /**
   * And whether the nearest one is further off than the weapon reaches.
   *
   * **The other edge of the same band, and until now it could only ever be a
   * tiebreak.** Every course that gives ground survives a little longer than
   * every course that does not, so a planner that only ever *ranks* on this
   * drifts out of range one safe step at a time and then has nothing to say,
   * because nothing is shooting at somebody nobody can reach. The live report
   * was the plain one: "I do no damage, because I am far away." Being out of
   * position is a reason to plan, exactly as being crowded is.
   *
   * Bounded by the band itself rather than by a rule here: `standoffAt` stops
   * counting past a couple of tiles out of range, so every course a plan can
   * reach is equally far from a monster across the room and the term decides
   * nothing. That is what keeps this a step back into the fight and not a chase.
   */
  #tooFar = false;

  /**
   * How badly the place the player is standing sits against the monsters.
   *
   * Signed as {@link DodgeWorld.standoffAt} reports it, and kept because two
   * separate decisions are made against it: which edge of the band has been
   * crossed, and — once one has — which courses count as getting back inside it
   * rather than merely moving.
   */
  #hereStandoff = 0;

  /**
   * Whether being out of position is something the player is choosing.
   *
   * True while they are steering and the course they are steering leaves them
   * better placed than standing here would — which is what walking a route past
   * a monster, or walking back towards one, looks like. Read by the release test
   * and by {@link #choose}, and both have to agree: releasing on it while the
   * bar in the scoring still insisted on fixing the distance would hand the
   * wheel back on one plan and take it on the next.
   */
  #yielding = false;

  /**
   * Whether nothing within reach stays clear for the whole horizon.
   *
   * The wide-attack state. Kept between plans only for its own hysteresis band
   * — see {@link #nothingStaysClear} — and cleared with everything else when the
   * air goes quiet.
   */
  #caught = false;

  /**
   * The course last committed to, and until when it stands.
   *
   * **Held is a flag rather than "the direction is not nought", because holding
   * still is a decision too.** Inferring it from the direction made the one
   * transition that matters most — standing to walking and back — the only one
   * with no hysteresis at all, so a shot drifting across the reaction window
   * produced take-the-wheel, give-it-back, take-it-again at fifty hertz. That is
   * the stutter, and it is also why a walk never got anywhere: every other plan
   * started it over.
   */
  #held = false;
  #heldX = 0;
  #heldY = 0;
  #heldScale = 0;
  #heldUntilMs = 0;

  /** What counted as trouble this plan, for {@link #safety} to classify against. */
  #reactWithinMs = 0;

  /**
   * How coarse the numbers the branches are chosen on actually are.
   *
   * Every time the sweep reports lands on the sample grid, so a threshold
   * compared against one has a step of this size under it. It is the width the
   * hysteresis bands below are given, because a band narrower than the noise is
   * not a band.
   */
  #quantumMs = 0;

  /**
   * Which branch the last plan took, so a threshold has to be crossed properly
   * to change it rather than merely brushed. See {@link #choose}.
   */
  #doomed = false;
  #urgent = false;
  /**
   * What {@link #doomed} was on the *previous* plan.
   *
   * Kept apart because `#choose` runs twice when the part-speed courses turn out
   * to be worth scoring, and a band measured against a value this plan already
   * set would widen itself on the second call and latch.
   */
  #doomedBefore = false;

  readonly #sweep: Sweep = {
    impactMs: Infinity,
    clearanceTiles: Infinity,
    urgentClearanceTiles: Infinity,
    unsafeAtMs: Infinity,
  };
  readonly #probe: Reach = { wallTiles: Infinity, hazardTiles: Infinity, exitTiles: Infinity };
  /** What a course must clear to be considered. Rewritten in place per branch. */
  readonly #bars: Bars = {
    windowMs: -Infinity,
    impactMs: -Infinity,
    roomTiles: -Infinity,
    standoff: Infinity,
  };

  /** Drops the commitment. Called when the session or the character changes. */
  reset(): void {
    this.#forget();
  }

  #forget(): void {
    // Nothing in the air is neither urgent nor hopeless, and a band remembered
    // across a quiet stretch is a band applied to a different fight.
    this.#doomed = false;
    this.#doomedBefore = false;
    this.#urgent = false;
    this.#caught = false;
    this.#held = false;
    this.#heldX = 0;
    this.#heldY = 0;
    this.#heldScale = 0;
    this.#heldUntilMs = 0;
  }

  /**
   * @param blasts Area effects on their way down — thrown bombs, novas,
   *   telegraphed circles. Separate from `shots` because they are a different
   *   shape of danger and are measured differently; see `Blasts`. Omitted means
   *   this session has no source of them, which is what a test about bullets
   *   wants and what a runtime without the telegraph decoded gets.
   */
  plan(
    situation: DodgeSituation,
    settings: DodgeSettings,
    world: DodgeWorld,
    shots: Iterable<DodgeShot>,
    blasts: Iterable<BlastView> = NO_BLASTS,
  ): DodgePlan {
    const tilesPerMs = situation.speedTilesPerSecond / 1000;
    const steering = situation.intentX !== 0 || situation.intentY !== 0;

    // A character that cannot move has no plan to make — paralysed, petrified,
    // or simply between characters. Every candidate would be the same place.
    if (!(tilesPerMs > 0)) return this.#nothing('clear', 0, 0);

    const headings = this.#prepare(settings.headings);
    const stride = this.#stride;
    // The player's own direction, repeated at each speed. When they are not
    // steering it is the standing course, which costs one sweep per tier and
    // spares every line below a special case.
    for (let tier = 0; tier < SPEED_TIERS.length; tier += 1) {
      const slot = 1 + tier * stride + headings;
      this.#dirX[slot] = situation.intentX;
      this.#dirY[slot] = situation.intentY;
    }
    const own = steering ? 1 + headings : HOLD;
    const firstTier = 1 + stride;
    const total = 1 + SPEED_TIERS.length * stride;

    const horizonMs = settings.horizonMs;
    const reactWithinMs = Math.min(settings.reactWithinMs, horizonMs);
    this.#reactWithinMs = reactWithinMs;
    this.#quantumMs = Math.max(1, settings.sampleStepMs);
    this.#survivalCapMs = horizonMs + settings.sampleStepMs;
    const reachTiles = tilesPerMs * (settings.leadMs + horizonMs);
    const fieldOptions: ThreatFieldOptions = {
      horizonMs,
      sampleStepMs: settings.sampleStepMs,
      hitScale: settings.hitScale,
      padTiles: settings.padTiles,
      driftTilesPerSecond: settings.driftTilesPerSecond,
      reachTiles,
      engageTiles: settings.engageWithinTiles,
      reactWithinMs,
    };
    this.#field.build(situation.gameTimeMs, situation.x, situation.y, shots, fieldOptions);
    this.#blasts.collect(
      blasts,
      situation.gameTimeMs,
      situation.x,
      situation.y,
      reachTiles,
      horizonMs,
      reactWithinMs,
    );

    const onHazard = settings.avoidDamagingGround && situation.onDamagingGround;
    // How badly the place they are standing sits against the monsters — too
    // near one to have room to dodge, or too far from the nearest to be hitting
    // anything. Not damage either way, and both a reason to speak: the room
    // being taken is the room a dodge needs, and a dodge that has quietly backed
    // its player out of weapon range has turned the damage off.
    //
    // Asked about right now, because "where am I standing" is a question about
    // the present. Where a *course* leaves the player is asked about the moment
    // they would arrive; see {@link #standoffFor}.
    this.#hereStandoff = world.standoffAt(situation.x, situation.y, 0);
    this.#crowded = this.#hereStandoff < 0;
    this.#tooFar = this.#hereStandoff > 0;
    const offBand = this.#crowded || this.#tooFar;
    const tracked = this.#field.tracked;
    const blastCount = this.#blasts.count;
    // Shots in flight and blasts on their way down. Either is a reason to think.
    const incoming = tracked + blastCount;

    // The cheapest way out, and the common one: nothing can reach us, the ground
    // is fine, we are standing at a sensible distance and nobody is walking
    // anywhere. Asked before any probing, because probing the map is the
    // expensive half of a plan with nothing to decide.
    if (incoming === 0 && !onHazard && !offBand && !steering) return this.#nothing('clear', 0, 0);

    this.#measureGround(situation, settings, world, headings, reachTiles, tilesPerMs);

    // The same shortcut one probe later: nothing in the air, good ground now,
    // and the way they are walking stays good ground.
    if (
      incoming === 0 &&
      !onHazard &&
      !offBand &&
      (this.#hazardMs[own] ?? Infinity) > HAZARD_GUARD_MS
    ) {
      return this.#nothing('clear', 0, 0);
    }

    this.#score(situation, settings, 0, firstTier, tilesPerMs, horizonMs, onHazard, world);

    if (onHazard) {
      // Getting off it may well need part speed too — a pool with one clean
      // step out of it is exactly the case the extra tiers exist for.
      this.#score(situation, settings, firstTier, total, tilesPerMs, horizonMs, onHazard, world);
      return this.#commit(
        'escape',
        this.#leaveHazard(situation, total),
        total,
        situation,
        tracked,
        blastCount,
      );
    }

    // What the player is already doing, which is the baseline every branch below
    // is measured against.
    const ownUnsafeAt = this.#unsafeMs[own] ?? Infinity;
    const ownHazard = this.#hazardMs[own] ?? Infinity;

    // **Whether their own walking is the answer to being out of position.** The
    // question this settles used to be asked of the monster alone — "is anything
    // inside the bubble coming at me" — which is right about a minion running
    // somebody down and silent about the two cases the player actually
    // complained of: a boss that has arrived and stopped, and a player who has
    // drifted out of range with their hand still on a key. Both read as "nobody
    // is closing", and both went unanswered.
    //
    // What replaces it is the plain question, and it costs a comparison because
    // the numbers were already computed: does the course they are steering leave
    // them better placed than standing here would? A route past a monster does;
    // shuffling against one that is on top of them does not; walking away from
    // something matching their speed does not either, because the bodies are
    // carried forward and the gap comes out the same. One rule for both edges of
    // the band, and none of it applies to a player who has let go of the keys —
    // they have chosen nothing, so there is nothing to yield to.
    this.#yielding = steering && this.#standoffOf(own) < this.#hereCost();

    // **Mid-escape, and letting go now would undo it.** A walk out of a pattern
    // takes several hundred milliseconds, and it passes through moments where
    // standing still happens to be safe for the next four hundred — so a gate
    // that hands the wheel back the instant that is true stops the escape a
    // third of the way through, every time, and starts it again on the next
    // plan. That is the stutter the player sees and the reason a dodge never
    // gets anywhere. The commitment expires on its own; until it does, the
    // decision belongs to the scoring below, which is free to re-choose
    // standing still if that is genuinely the best course.
    const committed =
      this.#held && (this.#heldX !== 0 || this.#heldY !== 0) && situation.nowMs < this.#heldUntilMs;

    // **Letting go asks for more than taking over did.** The bar is a sample
    // higher while the planner is driving, so a course sitting on the threshold
    // cannot hand the wheel back and take it again on alternate plans — which is
    // what the live log showed as `clear` and `guide` trading places every sixty
    // milliseconds, each time with a hit still half a second out.
    const releaseBar = this.#held ? reactWithinMs + this.#quantumMs : reactWithinMs;
    // **A hit counts wherever it came from.** `unsafeAtMs` is raised only by
    // shots already near — that is what stops the planner reacting to fire
    // across the room — but a fast shot eight tiles out still lands inside the
    // window, and judging solely on the near ones handed the wheel back with an
    // impact four hundred milliseconds away. The live log has that exact line:
    // `clear ... hit in 480ms, at 0% speed`. Being about to be grazed by
    // something close and being about to be hit by anything at all are both
    // reasons to stay.
    const ownImpact = this.#impactMs[own] ?? Infinity;
    // **Nowhere within reach stays clear, and waiting will not make one.** A
    // reaction window is sized for sidestepping a bullet; a wall of shots is
    // several tiles deep and leaving it is a run, not a step. Judged only on how
    // soon the first one arrives, the planner sat still through the whole of the
    // warning — the shots were not yet "this moment's problem" — and then found,
    // at the moment they became one, that no course survived. Every verdict in
    // the live log for those seconds reads `unavoidable`, and the player's
    // description was the accurate one: standing there doing something
    // incomprehensible.
    //
    // The signature is exact and costs nothing: every candidate, in every
    // direction, is predicted to be hit inside the horizon. A single bullet
    // never does that — sixteen headings and one of them walks out of it. Only a
    // pattern too wide to step out of does, and the answer to one is to start
    // running while there is still most of a second of it left.
    this.#caught = this.#nothingStaysClear(firstTier, horizonMs);
    if (
      ownUnsafeAt > releaseBar &&
      ownImpact > releaseBar &&
      ownHazard > HAZARD_GUARD_MS &&
      (!offBand || this.#yielding) &&
      !this.#caught &&
      !committed
    ) {
      // Their course is fine for as long as this decision is about. Nothing to
      // say, and not saying it *is* the feature — what the caller does with a
      // plan that steers nowhere is give the wheel back; see `dodgePlugin`.
      this.#forget();
      return {
        verdict: steering ? 'intent-safe' : 'clear',
        steer: false,
        dirX: 0,
        dirY: 0,
        speedScale: 0,
        unsafeAtMs: ownUnsafeAt,
        impactMs: ownImpact,
        clearanceTiles: this.#clearance[own] ?? Infinity,
        crowded: this.#crowded,
        trackedShots: tracked,
        trackedBlasts: blastCount,
      };
    }

    // Full speed first, and then a closer look if the answer is unsatisfying.
    // **Two things make it worth three times the sweeps**: nothing at full speed
    // clearing the window at all, and — just as important — the only full-speed
    // answer being to give ground. A pattern with a window in it is walked
    // through, not backed away from, and the window is usually a short step
    // rather than a sprint. Neither happens in open fire, so the fast path stays
    // the fast path.
    // Entered at the setting, left a sample later — the same band, and for the
    // same reason, as the one on the doomed test below.
    this.#urgent =
      ownUnsafeAt <
      (this.#urgent ? settings.urgentWithinMs + this.#quantumMs : settings.urgentWithinMs);
    const urgent = this.#urgent;
    this.#doomedBefore = this.#doomed;
    let scored = firstTier;
    let chosen = this.#choose(scored, reactWithinMs, urgent, situation);
    if (this.#worthACloserLook(chosen, scored, reactWithinMs)) {
      this.#score(situation, settings, firstTier, total, tilesPerMs, horizonMs, onHazard, world);
      scored = total;
      chosen = this.#choose(scored, reactWithinMs, urgent, situation);
    }

    // Said plainly when nothing in the air was the reason to move and the
    // fighting distance was. The choice is the same one; the log is the only
    // place a person can tell the two apart.
    const verdict =
      this.#verdict === 'guide' && offBand && ownUnsafeAt > reactWithinMs
        ? 'spacing'
        : this.#verdict;
    return this.#commit(verdict, chosen, scored, situation, tracked, blastCount);
  }

  /**
   * Whether every candidate is predicted to be hit inside the horizon.
   *
   * The wide-attack test. Hysteresis of one sample either side, because both
   * numbers land on the prediction grid and a bare threshold on a quantised
   * signal changes its mind every plan or two — which here would be the
   * difference between running and not.
   */
  #nothingStaysClear(scored: number, horizonMs: number): boolean {
    const bar = this.#caught ? horizonMs + this.#quantumMs : horizonMs;
    return this.#longestUnhitWindow(scored) < bar;
  }

  /** How badly the place they are standing sits, on the scale the bars use. */
  #hereCost(): number {
    return inQuanta(standoffCost(this.#hereStandoff), STANDOFF_QUANTUM_TILES);
  }

  // ── Candidate tables ──────────────────────────────────────────────────────

  /** Builds the tables when the heading count changes. Returns how many there are. */
  #prepare(requested: number): number {
    const headings = Math.min(MAX_HEADINGS, Math.max(4, Math.floor(requested)));
    if (headings === this.#headings) return headings;

    const stride = headings + 1;
    const slots = 1 + SPEED_TIERS.length * stride;
    this.#dirX = new Float64Array(slots);
    this.#dirY = new Float64Array(slots);
    this.#scale = new Float64Array(slots);
    this.#wallTiles = new Float64Array(slots);
    this.#hazardMs = new Float64Array(slots);
    this.#exitMs = new Float64Array(slots);
    this.#impactMs = new Float64Array(slots);
    this.#unsafeMs = new Float64Array(slots);
    this.#clearance = new Float64Array(slots);
    this.#urgentClearance = new Float64Array(slots);
    this.#standoff = new Float64Array(slots);

    for (let tier = 0; tier < SPEED_TIERS.length; tier += 1) {
      const base = 1 + tier * stride;
      const scale = SPEED_TIERS[tier] ?? 1;
      for (let i = 0; i < headings; i += 1) {
        const angle = (i / headings) * 2 * Math.PI;
        this.#dirX[base + i] = Math.cos(angle);
        this.#dirY[base + i] = Math.sin(angle);
        this.#scale[base + i] = scale;
      }
      this.#scale[base + headings] = scale;
    }
    this.#headingX = this.#dirX.subarray(1, headings + 1);
    this.#headingY = this.#dirY.subarray(1, headings + 1);
    this.#headings = headings;
    this.#stride = stride;
    return headings;
  }

  // ── Ground ────────────────────────────────────────────────────────────────

  /**
   * How far each course can go, and where it meets ground worth avoiding.
   *
   * The heading table is cached — walls do not move and the player usually has
   * not — while the player's own direction is measured every plan, because it
   * changes on a keystroke and it is the one that decides whether they keep the
   * wheel. Distances are measured once per *direction*; the times they become
   * are per candidate, because a slower course reaches the same wall later.
   */
  #measureGround(
    situation: DodgeSituation,
    settings: DodgeSettings,
    world: DodgeWorld,
    headings: number,
    reachTiles: number,
    tilesPerMs: number,
  ): void {
    const stride = this.#stride;
    const total = 1 + SPEED_TIERS.length * stride;

    // Holding still leaves no ground, so nothing can stop it. Whether the player
    // *fits* where they already stand is not a useful question — refusing it
    // would leave a character wedged in geometry with no candidate at all.
    this.#wallTiles[HOLD] = Infinity;
    // The same question as `onHazard`, and it has to be answered the same way:
    // holding still costs health exactly when the game is already charging for
    // this tile, not when the margin around it is being touched.
    this.#hazardMs[HOLD] = situation.onDamagingGround ? 0 : Infinity;
    this.#exitMs[HOLD] = Infinity;

    if (!settings.avoidWalls && !settings.avoidDamagingGround) {
      for (let c = 1; c < total; c += 1) {
        this.#wallTiles[c] = Infinity;
        this.#hazardMs[c] = Infinity;
        this.#exitMs[c] = Infinity;
      }
      return;
    }

    this.#reach.refresh(
      situation.x,
      situation.y,
      this.#headingX,
      this.#headingY,
      headings,
      reachTiles,
      world,
      situation.nowMs,
    );
    this.#reach.probe(
      situation.x,
      situation.y,
      situation.intentX,
      situation.intentY,
      reachTiles,
      world,
      this.#probe,
    );

    for (let tier = 0; tier < SPEED_TIERS.length; tier += 1) {
      const base = 1 + tier * stride;
      const speed = tilesPerMs * (SPEED_TIERS[tier] ?? 1);
      // Distance to time at *this* course's speed, counting from now — so the
      // wait before the walk starts is added, not taken off. The same
      // correction as the sweep's, and it has to be the same or a course would
      // meet a wall at one moment and a shot on a different clock.
      const whenReached = (tiles: number): number =>
        tiles === Infinity || speed <= 0 ? Infinity : tiles / speed + settings.leadMs;

      for (let i = 0; i < headings; i += 1) {
        this.#wallTiles[base + i] = this.#reach.wallTilesFor(i);
        this.#hazardMs[base + i] = whenReached(this.#reach.hazardTilesFor(i));
        this.#exitMs[base + i] = whenReached(this.#reach.exitTilesFor(i));
      }
      this.#wallTiles[base + headings] = this.#probe.wallTiles;
      this.#hazardMs[base + headings] = whenReached(this.#probe.hazardTiles);
      this.#exitMs[base + headings] = whenReached(this.#probe.exitTiles);
    }
  }

  // ── Scoring ───────────────────────────────────────────────────────────────

  /** Sweeps candidates `[from, to)` against the field. */
  #score(
    situation: DodgeSituation,
    settings: DodgeSettings,
    from: number,
    to: number,
    tilesPerMs: number,
    horizonMs: number,
    onHazard: boolean,
    world: DodgeWorld,
  ): void {
    for (let c = from; c < to; c += 1) {
      // Damaging ground is treated as a hit while we are not standing in it.
      // While we are, it is the thing being escaped and cannot also be the thing
      // that condemns every escape.
      const hazard =
        settings.avoidDamagingGround && !onHazard ? (this.#hazardMs[c] ?? Infinity) : Infinity;
      const travel = settings.avoidWalls ? (this.#wallTiles[c] ?? Infinity) : Infinity;
      const until = Math.min(horizonMs, hazard);
      const speed = tilesPerMs * (c === HOLD ? 0 : (this.#scale[c] ?? 1));

      this.#field.sweep(
        situation.x,
        situation.y,
        this.#dirX[c] ?? 0,
        this.#dirY[c] ?? 0,
        speed,
        tilesPerMs,
        settings.leadMs,
        until,
        travel,
        settings.safeClearanceTiles,
        this.#sweep,
      );
      // Into the same three numbers, because "when is this course in trouble"
      // has one answer however it is caused. See `Blasts.sweep`.
      this.#blasts.sweep(
        situation.x,
        situation.y,
        this.#dirX[c] ?? 0,
        this.#dirY[c] ?? 0,
        speed,
        tilesPerMs,
        settings.leadMs,
        until,
        travel,
        settings.safeClearanceTiles,
        this.#sweep,
      );
      this.#impactMs[c] = Math.min(this.#sweep.impactMs, hazard);
      this.#unsafeMs[c] = Math.min(this.#sweep.unsafeAtMs, hazard);
      this.#clearance[c] = this.#sweep.clearanceTiles;
      this.#urgentClearance[c] = this.#sweep.urgentClearanceTiles;
      this.#standoff[c] = this.#standoffFor(situation, world, c, speed, until, travel);
    }
  }

  /**
   * How badly a course sits relative to the monsters, as a cost. Lower is better.
   *
   * Two points rather than every sample: enemies barely move over half a second,
   * and the whole point is to prefer the lane that keeps the fight rather than to
   * measure by how much. The *worse* of the two, because a course that ends in
   * range having walked through a boss on the way is not a course that kept its
   * distance.
   */
  #standoffFor(
    situation: DodgeSituation,
    world: DodgeWorld,
    candidate: number,
    tilesPerMs: number,
    untilMs: number,
    maxTravelTiles: number,
  ): number {
    const dirX = this.#dirX[candidate] ?? 0;
    const dirY = this.#dirY[candidate] ?? 0;
    if ((dirX === 0 && dirY === 0) || tilesPerMs <= 0) {
      // Standing still is not standing still relative to something walking
      // towards you, so this asks about the far moment too and takes the worse.
      return Math.max(
        standoffCost(world.standoffAt(situation.x, situation.y, 0)),
        standoffCost(world.standoffAt(situation.x, situation.y, untilMs)),
      );
    }
    const farTiles = Math.min(tilesPerMs * untilMs, maxTravelTiles);
    const nearTiles = farTiles / 2;
    // When the course is at each of those two places, so the monsters can be
    // asked about the same moment rather than about now.
    const farMs = untilMs;
    const nearMs = untilMs / 2;
    return Math.max(
      standoffCost(
        world.standoffAt(situation.x + dirX * nearTiles, situation.y + dirY * nearTiles, nearMs),
      ),
      standoffCost(
        world.standoffAt(situation.x + dirX * farTiles, situation.y + dirY * farTiles, farMs),
      ),
    );
  }

  // ── Choosing ──────────────────────────────────────────────────────────────

  /**
   * Picks a course, and records why.
   *
   * The verdict comes back through a field rather than an object because this
   * runs fifty times a second and sometimes twice per plan; there is nothing to
   * learn from allocating a pair.
   */
  #choose(
    scored: number,
    reactWithinMs: number,
    urgent: boolean,
    situation: DodgeSituation,
  ): number {
    const bestWindow = this.#longestSafeWindow(scored);
    // **Hopeless means hit, not grazed** — and with hysteresis, because both
    // numbers land on the sixty-millisecond sample grid and a bare threshold on
    // a quantised signal flips branch every plan or two. The live log showed
    // guide, evade and unavoidable alternating six times in a hundred and fifty
    // milliseconds, and each branch admits a different set of courses.
    const doomedBar = this.#doomedBefore ? reactWithinMs + this.#quantumMs : reactWithinMs;
    this.#doomed = this.#longestUnhitWindow(scored) <= doomedBar;
    if (this.#doomed) {
      // Nothing clears the window, whatever speed it is walked at. Trade inside
      // a narrow band so the hit is still the latest and lightest available —
      // and where the course leaves us stops mattering, because there is no
      // window left to walk through and nothing to shoot back with once hit.
      const best = this.#bestSurvival(scored);
      this.#verdict = 'unavoidable';
      this.#bars.windowMs = -Infinity;
      // Capped before the subtraction: "a hair worse than never" is still
      // never, and a floor of `Infinity` would exclude every course including
      // the one it was derived from.
      this.#bars.impactMs =
        Math.min(this.#impactMs[best] ?? 0, this.#survivalCapMs) - DOOMED_TRADE_MS;
      this.#bars.roomTiles = (this.#clearance[best] ?? -Infinity) - DOOMED_TRADE_TILES;
      // Nothing survives the window, so where a course leaves us has stopped
      // being a question — including whether it leaves the bubble.
      this.#bars.standoff = Infinity;
      return this.#mostAligned(scored, situation, false);
    }
    if (urgent) {
      // Survival is achievable but close. Spend a little of the safe window on
      // their heading and no more — capped for the reason above.
      this.#verdict = 'evade';
      this.#bars.windowMs = Math.max(
        reactWithinMs,
        Math.min(bestWindow, this.#survivalCapMs) - URGENT_TRADE_MS,
      );
      this.#bars.impactMs = reactWithinMs;
      this.#bars.roomTiles = -Infinity;
      // Something lands in a moment. Being crowded is the lesser problem and
      // insisting on the bubble here would throw away courses that survive.
      this.#bars.standoff = Infinity;
      return this.#mostAligned(scored, situation, true);
    }
    if (this.#caught) {
      // **A wall, and there is still time to be somewhere else.** Nothing within
      // reach stays clear for the horizon, but the first of it is not here yet —
      // so this is the moment the run has to start, and it is the moment the
      // planner used to spend deferring to whatever the player was pressing.
      //
      // Ranked from the best survival available and traded no further than a
      // hair, which is what makes it a *run*: with a loose bar the heading term
      // in {@link #mostAligned} would hand the answer straight back to the
      // player's own keys, and their keys are what walked into the wall. What is
      // still allowed to argue below it is where the course leaves us — an
      // escape that ends out of weapon range is one to prefer second, not one to
      // refuse — and, through it, not running along with the fire.
      const best = this.#bestSurvival(scored);
      this.#verdict = 'outrun';
      this.#bars.windowMs = -Infinity;
      this.#bars.impactMs =
        Math.min(this.#impactMs[best] ?? 0, this.#survivalCapMs) - OUTRUN_TRADE_MS;
      this.#bars.roomTiles = -Infinity;
      this.#bars.standoff = Infinity;
      return this.#mostAligned(scored, situation, true);
    }
    // There is time. Take the course closest to where they were going out of
    // everything that clears the window — the difference between a feature that
    // reads as help and one that reads as a hand on the shoulder.
    //
    // **"Clears the window" has to mean both numbers.** It used to mean
    // `unsafeAtMs` alone, which is raised only by shots near enough to be this
    // moment's problem — so a course that was predicted to be *hit* inside the
    // window by anything the near test had not flagged was admitted anyway, and
    // then won outright on being the heading the player was already pressing.
    // That is the planner watching a bullet arrive and deciding to leave the
    // wheel where it was.
    this.#verdict = 'guide';
    this.#bars.windowMs = reactWithinMs;
    this.#bars.impactMs = reactWithinMs;
    this.#bars.roomTiles = -Infinity;
    // **And when the fighting distance is wrong, a course has to be fixing
    // it.** This is the branch a player out of position reaches, and every term
    // that measures where a course leaves us sits below the one that prefers
    // the heading they are pressing — so their own course won outright and the
    // planner watched a monster walk onto them without a word, or watched them
    // drift out of range and said nothing at all. A bar rather than a
    // reordering, because that is what the other three are: survival still comes
    // first, and among the courses that survive *and* fix the distance, theirs
    // is still preferred. Lifted entirely while their own walking is what is
    // fixing it: that is a route, not a mistake to correct.
    //
    // Both edges, one rule. It reads as backing off from a boss on top of them
    // and as stepping back into range of one they have drifted away from, and
    // there is no reason for those to be two mechanisms.
    this.#bars.standoff =
      (this.#crowded || this.#tooFar) && !this.#yielding ? this.#hereCost() : Infinity;
    return this.#mostAligned(scored, situation, true);
  }

  /**
   * Whether the part-speed courses are worth scoring after all.
   *
   * Either because nothing survives the window, or because the answer so far is
   * to give ground — and a pattern with a window in it should be walked through
   * rather than backed away from. The window is usually a short step, which is
   * exactly what the full-speed ring cannot reach.
   *
   * **Or because the correction wanted is a small one.** Fixing the fighting
   * distance is a step or two, and a second of full speed in any direction is
   * five or six tiles — which overshoots the band as surely as standing still
   * misses it, so with only the fast ring to choose from *every* course scored
   * as out of position and the planner had nothing it was allowed to pick.
   */
  #worthACloserLook(chosen: number, scored: number, reactWithinMs: number): boolean {
    if (this.#longestSafeWindow(scored) <= reactWithinMs) return true;
    // Only for the far edge. Stepping back into range is a short correction and
    // a second of full speed overshoots it; getting out from under something is
    // the opposite, and offering it a third of a step is offering it nothing.
    if (this.#tooFar && !this.#yielding) return true;
    if (this.#field.flowCoherence < COHERENT_FLOW) return false;
    const along =
      (this.#dirX[chosen] ?? 0) * this.#field.flowX + (this.#dirY[chosen] ?? 0) * this.#field.flowY;
    return along > GIVING_GROUND;
  }

  /** The longest any scored course goes before it runs out of room. */
  #longestSafeWindow(scored: number): number {
    let best = -Infinity;
    for (let c = 0; c < scored; c += 1) {
      const window = this.#unsafeMs[c] ?? 0;
      if (window > best) best = window;
    }
    return best;
  }

  /**
   * The longest any scored course goes before something actually lands on it.
   *
   * **Not the same question as {@link #longestSafeWindow}, and confusing the two
   * declared every busy moment hopeless.** That one asks when a course drops
   * below a comfortable margin — eight hundredths of a tile by default — which
   * in twenty-shot fire is nearly always and nearly always a *miss*. Deciding
   * "nothing can be done" on it produced verdicts reading `unavoidable, room
   * 0.01t, hit in never`: no course was going to be hit, and the planner had
   * just thrown away its sense of position to survive a hit that was not coming.
   * Being grazed is not being hit, and only being hit is hopeless.
   */
  #longestUnhitWindow(scored: number): number {
    let best = -Infinity;
    for (let c = 0; c < scored; c += 1) {
      const window = this.#impactMs[c] ?? 0;
      if (window > best) best = window;
    }
    return best;
  }

  /**
   * The course that survives longest, in the widest lane, with the most room.
   *
   * Lexicographic rather than a weighted sum, and deliberately: weights make
   * "survives 100 ms longer" tradeable against "half a tile more room", and
   * there is no exchange rate between those that is right in both a corridor and
   * an open room. Ordering them says what actually matters first.
   *
   * Holding still is index nought and every comparison is strict, so it keeps a
   * tie — which is what stops the planner twitching between equally good answers
   * when the honest one is to stand there.
   */
  #bestSurvival(scored: number): number {
    let best = HOLD;
    let bestImpact = this.#survival(HOLD);
    let bestLane = this.#lane(HOLD);
    let bestUrgentRoom = this.#urgentRoom(HOLD);
    let bestRoom = this.#room(HOLD);
    let bestStandoff = this.#standoffOf(HOLD);

    for (let c = 1; c < scored; c += 1) {
      const impact = this.#survival(c);
      if (impact < bestImpact) continue;
      const lane = this.#lane(c);
      const urgentRoom = this.#urgentRoom(c);
      const room = this.#room(c);
      const standoff = this.#standoffOf(c);
      const better =
        impact > bestImpact ||
        lane > bestLane ||
        (lane === bestLane &&
          (urgentRoom > bestUrgentRoom ||
            (urgentRoom === bestUrgentRoom &&
              (room > bestRoom || (room === bestRoom && standoff < bestStandoff)))));
      if (!better) continue;
      best = c;
      bestImpact = impact;
      bestLane = lane;
      bestUrgentRoom = urgentRoom;
      bestRoom = room;
      bestStandoff = standoff;
    }
    return best;
  }

  /**
   * How long a course survives, in whole quanta.
   *
   * Capped as well as quantised: `Infinity` is a fine answer on its own and a
   * useless one to add up, which {@link #lane} does.
   */
  #survival(candidate: number): number {
    return inQuanta(
      Math.min(this.#impactMs[candidate] ?? 0, this.#survivalCapMs),
      IMPACT_QUANTUM_MS,
    );
  }

  /** How much room a course has, in whole quanta. */
  #room(candidate: number): number {
    return inQuanta(this.#clearance[candidate] ?? -Infinity, ROOM_QUANTUM_TILES);
  }

  /**
   * The same, counting only what is close enough to be this moment's problem.
   *
   * **Above {@link #room}, and that is what stops the planner answering the
   * wrong shot.** The full-horizon figure is a minimum over a second of
   * prediction, so in a busy fight it is set by whichever bullet happens to pass
   * closest at the far end — and the direction was being chosen to thread a gap
   * the player would be re-planned out of fifty times before reaching it, while
   * the shot actually arriving went unanswered. Both numbers still count.
   *
   * **And below every preference, which is not a compromise.** Short-term room
   * on its own is maximised by fleeing along the incoming line: a shot outruns a
   * character, so running with it keeps the distance for exactly as long as the
   * window lasts and is cornered a moment after. That is the behaviour `ground`
   * exists to refuse, and putting this above it would reintroduce it.
   *
   * `Infinity` for every course when nothing comes near inside the window, so
   * the term compares equal and decides nothing until there is something near.
   */
  #urgentRoom(candidate: number): number {
    return inQuanta(this.#urgentClearance[candidate] ?? -Infinity, ROOM_QUANTUM_TILES);
  }

  /** How far out of the band a course ends up, in whole quanta. Lower is better. */
  #standoffOf(candidate: number): number {
    return inQuanta(this.#standoff[candidate] ?? 0, STANDOFF_QUANTUM_TILES);
  }

  /**
   * Whether a course is safe at all, as a class rather than a measurement.
   *
   * **Two: never touched inside the horizon. One: touched, but not until after
   * the moment that decided to act. Nought: hit inside it.**
   *
   * This is what stops the planner trading a hit for a better position, and it
   * has to be a class rather than a number for the same reason the whole
   * comparison is lexicographic: there is no exchange rate between "half a tile
   * closer to the monster" and "gets shot", and inventing one produces exactly
   * the behaviour it was invented to avoid. Two courses that both survive are
   * then free to be told apart by where they leave us, which is the point of the
   * terms after it.
   */
  #safety(candidate: number): number {
    const impact = this.#impactMs[candidate] ?? Infinity;
    if (impact === Infinity) return 2;
    return impact > this.#reactWithinMs ? 1 : 0;
  }

  /** How much survival the neighbouring headings have. See {@link CORRIDOR_NEIGHBOURS}. */
  #lane(candidate: number): number {
    const headings = this.#headings;
    const width = CORRIDOR_NEIGHBOURS * 2 + 1;
    if (candidate === HOLD) return this.#survival(candidate) * width;

    const offset = candidate - 1;
    const position = offset % this.#stride;
    // The player's own direction is not on the ring, so it is measured over the
    // same width with nothing either side of it — which is honest: nothing was.
    if (position === headings) return this.#survival(candidate) * width;

    const base = candidate - position;
    let total = this.#survival(candidate);
    for (let gap = 1; gap <= CORRIDOR_NEIGHBOURS; gap += 1) {
      total += this.#survival(base + ((position + gap) % headings));
      total += this.#survival(base + ((position - gap + headings) % headings));
    }
    return total;
  }

  /**
   * Among the courses good enough, the one most like what the player asked for.
   *
   * When they are steering, "most like" is the direction they are pressing. When
   * they are not, it is holding still — a player who let go of the keys is
   * asking to stay where they are, and a dodge that wanders off whenever a shot
   * passes nearby is one they will switch off. Ties fall back to survival, which
   * is what stops "every heading is equally unlike standing still" from picking
   * whichever happens to be first in the table.
   *
   * **Among courses that all clear the window, the one that keeps the fight
   * wins.** Every acceptable course is safe for as long as this decision is
   * about, so choosing the *safest* of them is choosing to back away from a
   * pattern there was room to walk through — and a dodge that answers every wave
   * by retreating is one that can never be in range of anything.
   *
   * Two terms say that, in this order. Where the course leaves us relative to
   * the monsters is a measurement and comes first; whether it runs *with* the
   * shots is a heuristic for the same thing and is what remains when there is
   * nobody in the list to measure against — an enemy off the edge of what was
   * collected, or the whole idea switched off. Crossing the fire and closing on
   * it are alike to the second term, because the planner has no business
   * preferring one of those to the other and the band is what keeps it off the
   * monster itself.
   *
   * What a course has to clear before it is considered at all is in
   * {@link #bars}, which the caller fills. **They are bars and not terms on
   * purpose**: the ordering below is what makes the feature feel like help
   * rather than a hand on the shoulder, and the way to keep a hard requirement
   * out of that argument is to settle it before the argument starts.
   *
   * @param keepPosition Whether where a course leaves us is worth ranking above
   *   survival. False once nothing clears the window: with no gap to thread,
   *   backing off is the answer rather than the mistake, and the best place to
   *   fight from is any place still alive.
   */
  #mostAligned(scored: number, situation: DodgeSituation, keepPosition: boolean): number {
    const steering = situation.intentX !== 0 || situation.intentY !== 0;
    const flowX = this.#field.flowX;
    const flowY = this.#field.flowY;
    const coherence = keepPosition ? this.#field.flowCoherence : 0;
    const bars = this.#bars;
    let best = -1;
    let bestDot = -Infinity;
    let bestSafety = -Infinity;
    let bestUrgentRoom = -Infinity;
    let bestStandoff = Infinity;
    let bestGround = -Infinity;
    let bestImpact = -Infinity;
    let bestLane = -Infinity;
    let bestRoom = -Infinity;

    for (let c = 0; c < scored; c += 1) {
      if ((this.#unsafeMs[c] ?? 0) <= bars.windowMs) continue;
      if ((this.#impactMs[c] ?? 0) <= bars.impactMs) continue;
      if ((this.#clearance[c] ?? -Infinity) < bars.roomTiles) continue;
      if (this.#standoffOf(c) >= bars.standoff) continue;
      const dirX = this.#dirX[c] ?? 0;
      const dirY = this.#dirY[c] ?? 0;
      const standing = dirX === 0 && dirY === 0;
      // **Standing still is the least like walking, and the most like not
      // walking.** A player pressing a key asked to move, so a course at right
      // angles to them is closer to what they asked for than one that stops
      // them dead — and a player who let go asked to stay, so it is the best
      // answer there. Both are "most like what they asked for"; they are simply
      // opposite ends of it. Kept selectable as a last resort either way, since
      // the first candidate to clear the bar is taken whatever it scores.
      //
      // **Unless standing is not a request worth honouring**, which is two
      // cases. One: where they are standing is out of position — something has
      // walked on top of them, or they have drifted out of range of everything —
      // and staying there is exactly what the terms below exist to leave. Two —
      // and this is what looked like the dodge shuffling on the spot instead of
      // getting out — nothing clears the window at all. Holding still then
      // outranked *every* moving course before their room was so much as looked
      // at, because it is index nought and wins the first key outright; so under
      // saturated fire the planner stood there and took it while a course with
      // most of a tile of clearance sat unexamined. A player who let go of the
      // keys asked to stay where they are. They did not ask to be shot.
      const dot = standing
        ? steering
          ? -Infinity
          : this.#crowded || this.#tooFar || this.#caught || !keepPosition
            ? 0
            : 1
        : steering
          ? inQuanta(dirX * situation.intentX + dirY * situation.intentY, ALIGNMENT_QUANTUM)
          : 0;
      if (dot < bestDot) continue;
      // **Ahead of everything about position, and that is the fix for trying to
      // squeeze through gaps that do not fit.** Both terms below it — staying in
      // weapon range, not running with the fire — were ranked above survival, so
      // a course that got hit could win over one that did not on the strength of
      // ending a tile nearer the monster. The filter above only guarantees the
      // course is clear for the *reaction* window; being hit at eight hundred
      // milliseconds still counted as eligible, and then position picked among
      // them.
      const safety = this.#safety(c);
      const standoff = keepPosition ? this.#standoffOf(c) : 0;
      // How much ground this gives up: nought for standing, crossing the fire or
      // closing on it, negative for running with it. Faded out by how much the
      // shots agree on a direction, so a crossfire — where there is no "back" —
      // is decided by the terms below instead.
      const ground = standing
        ? 0
        : -inQuanta(Math.max(0, dirX * flowX + dirY * flowY) * coherence, RETREAT_QUANTUM);
      const impact = this.#survival(c);
      const lane = this.#lane(c);
      // Among courses that are equally good places to be, the one that answers
      // what is arriving beats the one that answers what is still crossing the
      // room. See {@link #urgentRoom} for why it sits exactly here.
      const urgentRoom = this.#urgentRoom(c);
      const room = this.#room(c);
      const better =
        best < 0 ||
        dot > bestDot ||
        safety > bestSafety ||
        (safety === bestSafety &&
          (ground > bestGround ||
            (ground === bestGround &&
              (standoff < bestStandoff ||
                (standoff === bestStandoff &&
                  (urgentRoom > bestUrgentRoom ||
                    (urgentRoom === bestUrgentRoom &&
                      (impact > bestImpact ||
                        (impact === bestImpact &&
                          (lane > bestLane || (lane === bestLane && room > bestRoom)))))))))));
      if (!better) continue;
      best = c;
      bestDot = dot;
      bestSafety = safety;
      bestUrgentRoom = urgentRoom;
      bestStandoff = standoff;
      bestGround = ground;
      bestImpact = impact;
      bestLane = lane;
      bestRoom = room;
    }
    // Nothing cleared the bar, which happens when the bar came from a course
    // that has since been excluded. Survival is always answerable.
    return best >= 0 ? best : this.#bestSurvival(scored);
  }

  /**
   * Turns a chosen course into a plan, keeping the last one while the two are
   * near enough that switching would be noise.
   */
  #commit(
    verdict: DodgeVerdict,
    candidate: number,
    scored: number,
    situation: DodgeSituation,
    tracked: number,
    blasts: number,
  ): DodgePlan {
    let chosen = candidate;

    // **Urgency no longer lifts this, and that was the mistake.** The dwell used
    // to stand down whenever trouble was close — which in a dense pattern is
    // always, so the one situation that most needs a steady answer was the one
    // with no hysteresis at all. What makes a long dwell safe is not picking the
    // moments to apply it, it is {@link #noWorse}: a held course is kept only
    // while it is no worse than the fresh answer on time-to-trouble,
    // time-to-impact and room. A course that has gone bad is dropped the plan it
    // goes bad, urgent or not.
    if (this.#held && situation.nowMs < this.#heldUntilMs) {
      const held = this.#heldCandidate(scored);
      if (held >= 0 && held !== chosen && this.#noWorse(held, chosen)) chosen = held;
    }

    const dirX = this.#dirX[chosen] ?? 0;
    const dirY = this.#dirY[chosen] ?? 0;
    const scale = chosen === HOLD ? 0 : (this.#scale[chosen] ?? 1);
    // Only a *direction* change restarts the clock. Walking the same way a
    // little slower is the same decision being carried out, not a new one, and
    // renewing the commitment for it would make a dwell that never expires.
    if (dirX !== this.#heldX || dirY !== this.#heldY || !this.#held) {
      this.#heldUntilMs = situation.nowMs + DWELL_MS;
    }
    this.#held = true;
    this.#heldX = dirX;
    this.#heldY = dirY;
    this.#heldScale = scale;

    return {
      verdict,
      steer: (dirX !== 0 || dirY !== 0) && scale > 0,
      dirX,
      dirY,
      speedScale: scale,
      unsafeAtMs: this.#unsafeMs[chosen] ?? Infinity,
      impactMs: this.#impactMs[chosen] ?? Infinity,
      clearanceTiles: this.#clearance[chosen] ?? -Infinity,
      crowded: this.#crowded,
      trackedShots: tracked,
      trackedBlasts: blasts,
    };
  }

  /**
   * The candidate carrying on the committed course, or -1 when none does.
   *
   * **Bounded by what was actually scored**, which is the whole point of the
   * question. Most plans score only the first speed tier, and the arrays past it
   * still hold the *previous* plan's numbers — so searching the whole table
   * hands back a course whose safety was measured against a field that has since
   * moved. That is a dwell keeping a commitment nobody re-checked.
   *
   * **Matched on direction, not on direction and speed.** The same heading is
   * offered at three speeds and which of them wins moves with the field, so an
   * exact match failed constantly and dropped the commitment — the character
   * kept its bearing and stuttered between full and a third of a step. The speed
   * the course is walked at is re-decided every plan; the direction is what is
   * being committed to. The held speed is preferred where it is still an option,
   * so a steady course does not change pace for nothing.
   */
  #heldCandidate(scored: number): number {
    let best = -1;
    for (let c = 0; c < scored; c += 1) {
      if (this.#dirX[c] !== this.#heldX || this.#dirY[c] !== this.#heldY) continue;
      if ((this.#scale[c] ?? 1) === this.#heldScale) return c;
      if (best < 0 || this.#survival(c) > this.#survival(best)) best = c;
    }
    return best;
  }

  /**
   * Whether carrying on is at least as good as the fresh answer.
   *
   * The guard that makes a long commitment safe: every measure the choice was
   * made on has to be no worse, and room is allowed to be worse only by less
   * than the noise the whole dwell exists to absorb.
   */
  #noWorse(held: number, chosen: number): boolean {
    return (
      (this.#unsafeMs[held] ?? 0) >= (this.#unsafeMs[chosen] ?? 0) &&
      (this.#impactMs[held] ?? 0) >= (this.#impactMs[chosen] ?? 0) &&
      (this.#urgentClearance[chosen] ?? -Infinity) <
        (this.#urgentClearance[held] ?? -Infinity) + DWELL_BREAK_TILES &&
      (this.#clearance[chosen] ?? -Infinity) <
        (this.#clearance[held] ?? -Infinity) + DWELL_BREAK_TILES
    );
  }

  #nothing(verdict: DodgeVerdict, tracked: number, blasts: number): DodgePlan {
    this.#forget();
    return {
      verdict,
      steer: false,
      dirX: 0,
      dirY: 0,
      speedScale: 0,
      unsafeAtMs: Infinity,
      impactMs: Infinity,
      clearanceTiles: Infinity,
      crowded: false,
      trackedShots: tracked,
      trackedBlasts: blasts,
    };
  }

  // ── Hazard ────────────────────────────────────────────────────────────────

  /**
   * Off damaging ground, soonest, taking the least damage on the way.
   *
   * Ordered by *when* the course leaves rather than by how safe it is, because
   * the ground is already costing health every tick and no amount of bullet
   * clearance is worth standing in it. Ties inside a bucket — courses that leave
   * at about the same moment — are settled by survival, which is what stops the
   * escape running through a volley.
   */
  #leaveHazard(situation: DodgeSituation, scored: number): number {
    const bucketMs = 60;
    let best = HOLD;
    let bestBucket = Infinity;
    let bestImpact = -Infinity;
    let bestRoom = -Infinity;
    let bestDot = -Infinity;

    for (let c = 0; c < scored; c += 1) {
      const exit = this.#exitMs[c] ?? Infinity;
      const bucket = exit === Infinity ? Infinity : Math.floor(exit / bucketMs);
      if (bucket > bestBucket) continue;
      const impact = this.#survival(c);
      const room = this.#room(c);
      const dot = inQuanta(
        (this.#dirX[c] ?? 0) * situation.intentX + (this.#dirY[c] ?? 0) * situation.intentY,
        ALIGNMENT_QUANTUM,
      );
      const better =
        bucket < bestBucket ||
        impact > bestImpact ||
        (impact === bestImpact && (room > bestRoom || (room === bestRoom && dot > bestDot)));
      if (!better) continue;
      best = c;
      bestBucket = bucket;
      bestImpact = impact;
      bestRoom = room;
      bestDot = dot;
    }
    return best;
  }
}
