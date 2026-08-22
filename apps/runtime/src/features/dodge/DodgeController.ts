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
 * **A wall is not damage.** Walking into one costs a step, so geometry here
 * *shortens* a course rather than condemning it: the sweep keeps going with the
 * player standing where the wall stopped them, and that course simply stops
 * earning distance from what is coming. Damaging ground is the opposite — it
 * costs health, so reaching it is scored exactly like being hit, and heading
 * into it is worth taking the wheel for even when nothing is in the air.
 *
 * **What is deliberately not here.** No goal-seeking, no orbit, no enemy lock,
 * no path drawing. Those are movement features that happen to share a planner,
 * and folding them in is how the reference ended up with a nine-hundred-line
 * arbiter and a mode-hysteresis timer. This decides one thing.
 */

import { ThreatField, type DodgeShot, type Sweep, type ThreatFieldOptions } from './ThreatField.js';
import { WalkReach, type Ground, type Reach } from './WalkReach.js';

/** Why the controller did what it did. Reported so a log can say so. */
export type DodgeVerdict =
  /** Nothing that could reach us in time. The player has the wheel throughout. */
  | 'clear'
  /** Their own course is fine for the window that matters. Left alone. */
  | 'intent-safe'
  /** Not urgent: moved to the nearest course that is safe and still theirs. */
  | 'guide'
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
  /** Spacing of predicted shot positions. See {@link ThreatFieldOptions}. */
  readonly sampleStepMs: number;
  /** How many directions to consider, evenly spaced. */
  readonly headings: number;
  /** Multiplies every shot's extent. Above 1 is more cautious. */
  readonly hitScale: number;
  /** A flat margin on every shot. */
  readonly padTiles: number;
  /**
   * How far into the future a plan starts.
   *
   * A decision made here reaches the module a frame later and the server later
   * still. Planning from where the player *is* aims the dodge at where the shot
   * used to be going.
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
  /** How many shots could reach the player at all. */
  readonly trackedShots: number;
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
   * How much room a course has from the nearest enemy body, in tiles.
   *
   * **Scored, never a veto.** Contact damage is real, but the only lane out of a
   * volley sometimes runs past a monster, and a planner that refuses it stands
   * in the volley instead. `Infinity` when nothing is near.
   */
  enemyRoomAt(x: number, y: number): number;
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
 * **Urgency lifts it entirely.** A dwell that outlives the situation it was
 * committed to is a dwell that kills, so it never applies while trouble is
 * inside {@link DodgeSettings.urgentWithinMs}.
 */
const DWELL_MS = 120;

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
 * How much the shots must agree on a direction before "back" means anything.
 *
 * In a crossfire there is no back, and a rule about not retreating would be a
 * rule about nothing. Below this the whole idea switches itself off.
 */
const COHERENT_FLOW = 0.35;

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

export class DodgeController {
  readonly #field = new ThreatField();
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
  #enemyRoom = new Float64Array(0);
  #headings = -1;
  /** Slots per speed tier: the ring plus the player's own direction. */
  #stride = 0;

  /** How high a course's survival may count towards a lane. See {@link #lane}. */
  #survivalCapMs = 0;

  /** Why {@link #choose} chose what it did, for the plan to report. */
  #verdict: DodgeVerdict = 'clear';

  /** The course last committed to, and until when it stands. */
  #heldX = 0;
  #heldY = 0;
  #heldScale = 0;
  #heldUntilMs = 0;

  readonly #sweep: Sweep = { impactMs: Infinity, clearanceTiles: Infinity, unsafeAtMs: Infinity };
  readonly #probe: Reach = { wallTiles: Infinity, hazardTiles: Infinity, exitTiles: Infinity };

  /** Drops the commitment. Called when the session or the character changes. */
  reset(): void {
    this.#heldX = 0;
    this.#heldY = 0;
    this.#heldScale = 0;
    this.#heldUntilMs = 0;
  }

  plan(
    situation: DodgeSituation,
    settings: DodgeSettings,
    world: DodgeWorld,
    shots: Iterable<DodgeShot>,
  ): DodgePlan {
    const tilesPerMs = situation.speedTilesPerSecond / 1000;
    const steering = situation.intentX !== 0 || situation.intentY !== 0;

    // A character that cannot move has no plan to make — paralysed, petrified,
    // or simply between characters. Every candidate would be the same place.
    if (!(tilesPerMs > 0)) return this.#nothing('clear', 0);

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
    this.#survivalCapMs = horizonMs + settings.sampleStepMs;
    const reachTiles = tilesPerMs * (settings.leadMs + horizonMs);
    const fieldOptions: ThreatFieldOptions = {
      horizonMs,
      sampleStepMs: settings.sampleStepMs,
      hitScale: settings.hitScale,
      padTiles: settings.padTiles,
      driftTilesPerSecond: settings.driftTilesPerSecond,
      reachTiles,
    };
    this.#field.build(situation.gameTimeMs, situation.x, situation.y, shots, fieldOptions);

    const onHazard = settings.avoidDamagingGround && world.isDamaging(situation.x, situation.y);
    const tracked = this.#field.tracked;

    // The cheapest way out, and the common one: nothing can reach us, the ground
    // is fine, and nobody is walking anywhere. Asked before any probing, because
    // probing the map is the expensive half of a plan with nothing to decide.
    if (tracked === 0 && !onHazard && !steering) return this.#nothing('clear', 0);

    this.#measureGround(situation, settings, world, headings, reachTiles, tilesPerMs);

    // The same shortcut one probe later: nothing in the air, good ground now,
    // and the way they are walking stays good ground.
    if (tracked === 0 && !onHazard && (this.#hazardMs[own] ?? Infinity) > HAZARD_GUARD_MS) {
      return this.#nothing('clear', 0);
    }

    this.#score(situation, settings, 0, firstTier, tilesPerMs, horizonMs, onHazard, world);

    if (onHazard) {
      // Getting off it may well need part speed too — a pool with one clean
      // step out of it is exactly the case the extra tiers exist for.
      this.#score(situation, settings, firstTier, total, tilesPerMs, horizonMs, onHazard, world);
      return this.#commit('escape', this.#leaveHazard(situation, total), situation, tracked, true);
    }

    // What the player is already doing, which is the baseline every branch below
    // is measured against.
    const ownUnsafeAt = this.#unsafeMs[own] ?? Infinity;
    const ownHazard = this.#hazardMs[own] ?? Infinity;

    if (ownUnsafeAt > reactWithinMs && ownHazard > HAZARD_GUARD_MS) {
      // Their course is fine for as long as this decision is about. Nothing to
      // say, and not saying it *is* the feature — what the caller does with a
      // plan that steers nowhere is give the wheel back; see `dodgePlugin`.
      this.#heldUntilMs = 0;
      this.#heldX = 0;
      this.#heldY = 0;
      this.#heldScale = 0;
      return {
        verdict: steering ? 'intent-safe' : 'clear',
        steer: false,
        dirX: 0,
        dirY: 0,
        speedScale: 0,
        unsafeAtMs: ownUnsafeAt,
        impactMs: this.#impactMs[own] ?? Infinity,
        clearanceTiles: this.#clearance[own] ?? Infinity,
        trackedShots: tracked,
      };
    }

    // Full speed first, and then a closer look if the answer is unsatisfying.
    // **Two things make it worth three times the sweeps**: nothing at full speed
    // clearing the window at all, and — just as important — the only full-speed
    // answer being to give ground. A pattern with a window in it is walked
    // through, not backed away from, and the window is usually a short step
    // rather than a sprint. Neither happens in open fire, so the fast path stays
    // the fast path.
    const urgent = ownUnsafeAt < settings.urgentWithinMs;
    let scored = firstTier;
    let chosen = this.#choose(scored, reactWithinMs, urgent, situation);
    if (this.#worthACloserLook(chosen, scored, reactWithinMs)) {
      this.#score(situation, settings, firstTier, total, tilesPerMs, horizonMs, onHazard, world);
      scored = total;
      chosen = this.#choose(scored, reactWithinMs, urgent, situation);
    }

    return this.#commit(this.#verdict, chosen, situation, tracked, urgent);
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
    this.#enemyRoom = new Float64Array(slots);

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
    this.#hazardMs[HOLD] = world.isDamaging(situation.x, situation.y) ? 0 : Infinity;
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
      // Distance to time at *this* course's speed, undoing the head start the
      // lead gives it.
      const whenReached = (tiles: number): number =>
        tiles === Infinity || speed <= 0 ? Infinity : Math.max(0, tiles / speed - settings.leadMs);

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
        settings.leadMs,
        until,
        travel,
        settings.safeClearanceTiles,
        this.#sweep,
      );
      this.#impactMs[c] = Math.min(this.#sweep.impactMs, hazard);
      this.#unsafeMs[c] = Math.min(this.#sweep.unsafeAtMs, hazard);
      this.#clearance[c] = this.#sweep.clearanceTiles;
      this.#enemyRoom[c] = this.#roomFromEnemies(situation, world, c, speed, until, travel);
    }
  }

  /**
   * The nearest an enemy body comes to a course.
   *
   * Two points rather than every sample: enemies barely move over half a second,
   * this only ever breaks a tie between courses that are already equal on
   * survival, and the whole point of it is to prefer the lane that does not run
   * through a monster rather than to measure by how much.
   */
  #roomFromEnemies(
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
      return world.enemyRoomAt(situation.x, situation.y);
    }
    const far = Math.min(tilesPerMs * untilMs, maxTravelTiles);
    const near = far / 2;
    return Math.min(
      world.enemyRoomAt(situation.x + dirX * near, situation.y + dirY * near),
      world.enemyRoomAt(situation.x + dirX * far, situation.y + dirY * far),
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
    if (bestWindow <= reactWithinMs) {
      // Nothing clears the window, whatever speed it is walked at. Trade inside
      // a narrow band so the hit is still the latest and lightest available —
      // and giving ground stops being the mistake, because there is no window
      // left to walk through.
      const best = this.#bestSurvival(scored);
      this.#verdict = 'unavoidable';
      return this.#mostAligned(
        scored,
        -Infinity,
        // Capped before the subtraction: "a hair worse than never" is still
        // never, and a floor of `Infinity` would exclude every course including
        // the one it was derived from.
        Math.min(this.#impactMs[best] ?? 0, this.#survivalCapMs) - DOOMED_TRADE_MS,
        (this.#clearance[best] ?? -Infinity) - DOOMED_TRADE_TILES,
        situation,
        false,
      );
    }
    if (urgent) {
      // Survival is achievable but close. Spend a little of the safe window on
      // their heading and no more — capped for the reason above.
      this.#verdict = 'evade';
      return this.#mostAligned(
        scored,
        Math.max(reactWithinMs, Math.min(bestWindow, this.#survivalCapMs) - URGENT_TRADE_MS),
        -Infinity,
        -Infinity,
        situation,
        true,
      );
    }
    // There is time. Take the course closest to where they were going out of
    // everything that clears the window — the difference between a feature that
    // reads as help and one that reads as a hand on the shoulder.
    this.#verdict = 'guide';
    return this.#mostAligned(scored, reactWithinMs, -Infinity, -Infinity, situation, true);
  }

  /**
   * Whether the part-speed courses are worth scoring after all.
   *
   * Either because nothing survives the window, or because the answer so far is
   * to give ground — and a pattern with a window in it should be walked through
   * rather than backed away from. The window is usually a short step, which is
   * exactly what the full-speed ring cannot reach.
   */
  #worthACloserLook(chosen: number, scored: number, reactWithinMs: number): boolean {
    if (this.#longestSafeWindow(scored) <= reactWithinMs) return true;
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
    let bestRoom = this.#room(HOLD);
    let bestEnemy = this.#enemyRoom[HOLD] ?? 0;

    for (let c = 1; c < scored; c += 1) {
      const impact = this.#survival(c);
      if (impact < bestImpact) continue;
      const lane = this.#lane(c);
      const room = this.#room(c);
      const enemy = this.#enemyRoom[c] ?? 0;
      const better =
        impact > bestImpact ||
        lane > bestLane ||
        (lane === bestLane && (room > bestRoom || (room === bestRoom && enemy > bestEnemy)));
      if (!better) continue;
      best = c;
      bestImpact = impact;
      bestLane = lane;
      bestRoom = room;
      bestEnemy = enemy;
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
   * **Among courses that all clear the window, the one that gives least ground
   * wins.** Every acceptable course is safe for as long as this decision is
   * about, so choosing the *safest* of them is choosing to back away from a
   * pattern there was room to walk through — and a dodge that answers every
   * wave by retreating is one that can never be in range of anything. What is
   * penalised is specifically running *with* the shots; crossing them and
   * closing on them are alike, because the planner has no business preferring
   * one of those to the other and the enemy-room term is what keeps it off the
   * monster itself.
   *
   * @param minWindowMs Trouble must be at least this far off. `-Infinity` when
   *   nothing clears the window and the question becomes "which is least bad".
   * @param avoidRetreat Whether giving ground is worth ranking above survival.
   *   False once nothing clears the window: with no gap to thread, backing off
   *   is the answer rather than the mistake.
   */
  #mostAligned(
    scored: number,
    minWindowMs: number,
    minImpactMs: number,
    minRoomTiles: number,
    situation: DodgeSituation,
    avoidRetreat: boolean,
  ): number {
    const steering = situation.intentX !== 0 || situation.intentY !== 0;
    const flowX = this.#field.flowX;
    const flowY = this.#field.flowY;
    const coherence = avoidRetreat ? this.#field.flowCoherence : 0;
    let best = -1;
    let bestDot = -Infinity;
    let bestGround = -Infinity;
    let bestImpact = -Infinity;
    let bestLane = -Infinity;
    let bestRoom = -Infinity;
    let bestEnemy = -Infinity;

    for (let c = 0; c < scored; c += 1) {
      if ((this.#unsafeMs[c] ?? 0) <= minWindowMs) continue;
      if ((this.#impactMs[c] ?? 0) < minImpactMs) continue;
      if ((this.#clearance[c] ?? -Infinity) < minRoomTiles) continue;
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
      const dot = standing
        ? steering
          ? -Infinity
          : 1
        : steering
          ? inQuanta(dirX * situation.intentX + dirY * situation.intentY, ALIGNMENT_QUANTUM)
          : 0;
      if (dot < bestDot) continue;
      // How much ground this gives up: nought for standing, crossing the fire or
      // closing on it, negative for running with it. Faded out by how much the
      // shots agree on a direction, so a crossfire — where there is no "back" —
      // is decided by the terms below instead.
      const ground = standing
        ? 0
        : -inQuanta(Math.max(0, dirX * flowX + dirY * flowY) * coherence, RETREAT_QUANTUM);
      const impact = this.#survival(c);
      const lane = this.#lane(c);
      const room = this.#room(c);
      const enemy = this.#enemyRoom[c] ?? 0;
      const better =
        best < 0 ||
        dot > bestDot ||
        ground > bestGround ||
        (ground === bestGround &&
          (impact > bestImpact ||
            (impact === bestImpact &&
              (lane > bestLane ||
                (lane === bestLane &&
                  (room > bestRoom || (room === bestRoom && enemy > bestEnemy)))))));
      if (!better) continue;
      best = c;
      bestDot = dot;
      bestGround = ground;
      bestImpact = impact;
      bestLane = lane;
      bestRoom = room;
      bestEnemy = enemy;
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
    situation: DodgeSituation,
    tracked: number,
    urgent: boolean,
  ): DodgePlan {
    let chosen = candidate;

    const holding = this.#heldX !== 0 || this.#heldY !== 0;
    // **Never while it is urgent.** The dwell exists to absorb noise between
    // near-equal answers; a situation that has changed enough to be urgent is
    // not noise, and a commitment that outlives it is one that kills.
    if (holding && !urgent && situation.nowMs < this.#heldUntilMs) {
      const held = this.#candidateFor(this.#heldX, this.#heldY, this.#heldScale);
      if (
        held >= 0 &&
        held !== chosen &&
        (this.#unsafeMs[held] ?? 0) >= (this.#unsafeMs[chosen] ?? 0) &&
        (this.#clearance[chosen] ?? -Infinity) <
          (this.#clearance[held] ?? -Infinity) + DWELL_BREAK_TILES
      ) {
        chosen = held;
      }
    }

    const dirX = this.#dirX[chosen] ?? 0;
    const dirY = this.#dirY[chosen] ?? 0;
    const scale = chosen === HOLD ? 0 : (this.#scale[chosen] ?? 1);
    if (dirX !== this.#heldX || dirY !== this.#heldY || scale !== this.#heldScale) {
      this.#heldX = dirX;
      this.#heldY = dirY;
      this.#heldScale = scale;
      this.#heldUntilMs = situation.nowMs + DWELL_MS;
    }

    return {
      verdict,
      steer: (dirX !== 0 || dirY !== 0) && scale > 0,
      dirX,
      dirY,
      speedScale: scale,
      unsafeAtMs: this.#unsafeMs[chosen] ?? Infinity,
      impactMs: this.#impactMs[chosen] ?? Infinity,
      clearanceTiles: this.#clearance[chosen] ?? -Infinity,
      trackedShots: tracked,
    };
  }

  /** Which candidate this plan scored for a course, or -1 if none did. */
  #candidateFor(dirX: number, dirY: number, scale: number): number {
    const total = 1 + SPEED_TIERS.length * this.#stride;
    for (let c = 0; c < total; c += 1) {
      if (this.#dirX[c] === dirX && this.#dirY[c] === dirY && (this.#scale[c] ?? 1) === scale) {
        return c;
      }
    }
    return -1;
  }

  #nothing(verdict: DodgeVerdict, tracked: number): DodgePlan {
    this.#heldX = 0;
    this.#heldY = 0;
    this.#heldScale = 0;
    this.#heldUntilMs = 0;
    return {
      verdict,
      steer: false,
      dirX: 0,
      dirY: 0,
      speedScale: 0,
      unsafeAtMs: Infinity,
      impactMs: Infinity,
      clearanceTiles: Infinity,
      trackedShots: tracked,
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
