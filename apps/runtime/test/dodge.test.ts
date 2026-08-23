import {
  MutablePacket,
  type EntityView,
  type NativeApi,
  type Position,
  type ProjectileView,
  type SessionApi,
  type SessionView,
} from '@brownie/plugin-api';
import { createBundledRegistry } from '@brownie/protocol/bundled';
import { createPacket, decodeFrame, encodePacket } from '@brownie/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DodgeController,
  type DodgePlan,
  type DodgeSettings,
  type DodgeSituation,
  type DodgeWorld,
} from '../src/features/dodge/DodgeController.js';
import {
  ENEMY_CONTACT_HALF_TILES,
  EnemyBodies,
  MAX_BODY_LOOKAHEAD_MS,
  OUT_OF_RANGE_CAP_TILES,
  type StandoffBand,
} from '../src/features/dodge/EnemyBodies.js';
import { Blasts, type BlastView } from '../src/features/dodge/Blasts.js';
import { MAX_PATH_POINTS, shotPaths } from '../src/features/dodge/ShotPaths.js';
import { SteerTracker } from '../src/features/dodge/SteerIntent.js';
import { ThreatField, type DodgeShot, type Sweep } from '../src/features/dodge/ThreatField.js';
import { createDodgePlugin } from '../src/features/dodge/dodgePlugin.js';
import {
  DODGE_PRESETS,
  DodgePresetId,
  presetMatches,
  type DodgeTuning,
} from '../src/features/dodge/dodgePresets.js';
import { nearestOtherPlayer } from '../src/features/dodge/hitRedirect.js';
import {
  PLAYER_HALF_TILES,
  effectiveHalf,
  minChebyshevOnSegment,
  overlaps,
  projectileHalfTiles,
} from '../src/features/dodge/hitbox.js';
import { PluginHost } from '../src/plugins/PluginHost.js';
import type { SettingsRegistry } from '../src/plugins/SettingsRegistry.js';
import type { Motion } from '../src/state/MotionTracker.js';
import { testLogger } from './fakes.js';
import {
  MAX_SPEED_STAT,
  MAX_WALK_TILES_PER_SECOND,
  MIN_WALK_TILES_PER_SECOND,
  SelfState,
} from '../src/state/SelfState.js';

/** A shot travelling in a straight line, which is what most of them do. */
function straightShot(
  from: Position,
  headingRadians: number,
  tilesPerSecond: number,
  firedAtMs: number,
  lifetimeMs: number,
  collisionHalfTiles?: number,
): DodgeShot & { firedAtMs: number; expiresAtMs: number } {
  return {
    ...(collisionHalfTiles === undefined ? {} : { collisionHalfTiles }),
    // Carried so the same fake serves the planner and the drawing, which read
    // different halves of what the store holds about a shot.
    firedAtMs,
    expiresAtMs: firedAtMs + lifetimeMs,
    positionAt(gameTimeMs: number): Position | undefined {
      const elapsed = gameTimeMs - firedAtMs;
      if (elapsed < 0 || elapsed > lifetimeMs) return undefined;
      const distance = (tilesPerSecond * elapsed) / 1000;
      return {
        x: from.x + distance * Math.cos(headingRadians),
        y: from.y + distance * Math.sin(headingRadians),
      };
    },
  };
}

/** A sweep result before anything has been swept into it. */
function emptySweep(): Sweep {
  return {
    impactMs: Infinity,
    clearanceTiles: Infinity,
    urgentClearanceTiles: Infinity,
    unsafeAtMs: Infinity,
  };
}

/** Every entity counts and none of them is going anywhere. */
const ANY_BODY = (): Motion => ({ velocityX: 0, velocityY: 0 });

/** The same, for a body walking at `tilesPerSecond` in a direction. */
function chasing(x: number, y: number): (enemy: EntityView) => Motion {
  return () => ({ velocityX: x / 1000, velocityY: y / 1000 });
}

/** Nothing in the way, nothing that hurts, nobody to bump into. */
const OPEN_GROUND: DodgeWorld = {
  canStand: () => true,
  isDamaging: () => false,
  standoffAt: () => 0,
};

/** Open ground with monsters in it, judged against one band. */
function standingOff(bodies: EnemyBodies, band: StandoffBand): DodgeWorld {
  return {
    canStand: () => true,
    isDamaging: () => false,
    standoffAt: (x, y, aheadMs) => bodies.standoffAt(x, y, band, aheadMs),
  };
}

/** The plugin's own defaults, so a unit test and a live session agree. */
const SETTINGS: DodgeSettings = {
  horizonMs: 1000,
  reactWithinMs: 420,
  // Wide enough that the tests below are about the geometry they set up rather
  // than about the distance gate, which has its own coverage.
  reactWithinTiles: 100,
  sampleStepMs: 60,
  headings: 16,
  hitScale: 1,
  padTiles: 0.1,
  leadMs: 60,
  driftTilesPerSecond: 0.2,
  safeClearanceTiles: 0.08,
  urgentWithinMs: 160,
  avoidWalls: true,
  avoidDamagingGround: true,
};

function situation(overrides: Partial<DodgeSituation> = {}): DodgeSituation {
  return {
    x: 10,
    y: 10,
    intentX: 0,
    intentY: 0,
    speedTilesPerSecond: 6,
    gameTimeMs: 0,
    nowMs: 1_000_000,
    ...overrides,
  };
}

describe('the hit test', () => {
  // The game's test is a square, not a circle. These two cases are where the
  // shapes disagree, and getting them wrong is the whole reason this is not a
  // distance comparison.
  it('is a square, so a corner at the same distance behaves differently', () => {
    const half = 0.5;
    expect(overlaps(0.49, 0, 0, 0, half)).toBe(true);
    expect(overlaps(0.45, 0.45, 0, 0, half)).toBe(true);
    // A circle of radius 0.5 would have called this a miss.
    expect(Math.hypot(0.45, 0.45)).toBeGreaterThan(half);
  });

  it('folds the projectile, the player and the pad into one half-extent', () => {
    expect(effectiveHalf(0.5, 1, 0)).toBeCloseTo(0.5 + PLAYER_HALF_TILES, 6);
    expect(effectiveHalf(0.5, 2, 0.1)).toBeCloseTo(1 + PLAYER_HALF_TILES + 0.1, 6);
  });

  // A boss's shot can be several times the width of a rat's, and the game says
  // so in its own data. Assuming the standard size is wrong in both directions.
  it('takes a shot at the size its own data declares', () => {
    expect(projectileHalfTiles(1)).toBeCloseTo(0.5, 6);
    expect(projectileHalfTiles(3)).toBeCloseTo(1.5, 6);
    // A multiplier that did not parse must not become a shot with no hitbox.
    expect(projectileHalfTiles(0)).toBeCloseTo(0.5, 6);
    expect(projectileHalfTiles(Number.NaN)).toBeCloseTo(0.5, 6);
  });
});

describe('the closest a moving pair comes', () => {
  it('is exact where the two cross, not at either end', () => {
    // Straight through the origin: both endpoints are three units away and the
    // answer is nought. A planner that only looked at the ends sees a miss.
    expect(minChebyshevOnSegment(-3, 0, 3, 0)).toBeCloseTo(0, 9);
  });

  it('agrees with the endpoints when the segment is moving away', () => {
    expect(minChebyshevOnSegment(1, 0, 4, 0)).toBeCloseTo(1, 9);
    expect(minChebyshevOnSegment(0, 0, 0, 0)).toBeCloseTo(0, 9);
  });

  it('measures the square, so the larger coordinate is the answer', () => {
    // The nearest point of this segment is two units away by either measure,
    // and a circle would have said the diagonal ends were further.
    expect(minChebyshevOnSegment(-2, 2, 2, 2)).toBeCloseTo(2, 9);
  });
});

describe('the threat field', () => {
  const OPTIONS = {
    horizonMs: 600,
    sampleStepMs: 40,
    hitScale: 1,
    padTiles: 0,
    driftTilesPerSecond: 0,
    reachTiles: 4,
    // Wider than anything these place, so the distance gate is out of the way
    // of the tests that are about the geometry. It has its own three below.
    reactTiles: 100,
    // The whole horizon counts as now, for the same reason.
    reactWithinMs: 600,
  };

  function sweepStanding(field: ThreatField, at: Position): Sweep {
    const out = emptySweep();
    field.sweep(at.x, at.y, 0, 0, 0.006, 0, 600, Infinity, 0, out);
    return out;
  }

  // The failure every stepped planner has and cannot see: a shot fast enough to
  // be on one side at one sample and past the player at the next.
  it('sees a shot that crosses between two samples', () => {
    const field = new ThreatField();
    // 150 tiles a second: six tiles between two 40 ms samples, and the player
    // sits in the middle of that gap.
    field.build(0, 0, 0, [straightShot({ x: -3, y: 0 }, 0, 150, 0, 2000)], OPTIONS);

    expect(field.tracked).toBe(1);
    const swept = sweepStanding(field, { x: 0, y: 0 });
    expect(swept.impactMs).toBe(0);
    expect(swept.clearanceTiles).toBeLessThan(0);
  });

  it('reports how much room a miss had, not just that it missed', () => {
    const field = new ThreatField();
    // Passing above, close enough that how close is still worth knowing.
    field.build(0, 0, 0, [straightShot({ x: -4, y: 1.2 }, 0, 10, 0, 2000)], OPTIONS);
    const swept = sweepStanding(field, { x: 0, y: 0 });

    expect(swept.impactMs).toBe(Infinity);
    expect(swept.clearanceTiles).toBeCloseTo(1.2 - effectiveHalf(0.5, 1, 0), 2);
  });

  // Room past a point is room enough, and measuring it is what a broad phase
  // exists not to do. A course with acres of space and one with rather more are
  // the same answer to every question the planner asks.
  it('stops measuring room once there is plenty of it', () => {
    const field = new ThreatField();
    field.build(0, 0, 0, [straightShot({ x: -4, y: 3 }, 0, 10, 0, 2000)], OPTIONS);

    expect(sweepStanding(field, { x: 0, y: 0 }).clearanceTiles).toBe(Infinity);
  });

  it('drops a shot whose whole path stays out of reach', () => {
    const field = new ThreatField();
    // Ten tiles away and travelling further away: nowhere the player can get.
    field.build(0, 0, 0, [straightShot({ x: 10, y: 10 }, 0, 10, 0, 2000)], OPTIONS);

    expect(field.considered).toBe(1);
    expect(field.tracked).toBe(0);
  });

  it('has nothing to say about a shot that has already expired', () => {
    const field = new ThreatField();
    field.build(5000, 0, 0, [straightShot({ x: 0, y: 0 }, 0, 10, 0, 100)], OPTIONS);

    expect(field.considered).toBe(1);
    expect(field.tracked).toBe(0);
  });

  // Prediction is worth less the further ahead it is asked. The drift term is
  // how that is paid for, and it must widen a shot with time.
  it('widens a shot in proportion to how far ahead it is predicted', () => {
    const near = new ThreatField();
    const far = new ThreatField();
    // Grazing rather than landing, so the widening is what shows.
    const bullet = straightShot({ x: -5, y: 0.9 }, 0, 10, 0, 2000);

    near.build(0, 0, 0, [bullet], OPTIONS);
    far.build(0, 0, 0, [bullet], { ...OPTIONS, driftTilesPerSecond: 0.5 });

    expect(sweepStanding(near, { x: 0, y: 0 }).clearanceTiles).toBeGreaterThan(
      sweepStanding(far, { x: 0, y: 0 }).clearanceTiles,
    );
  });

  // A course that runs out of ground stops; it does not carry on through the
  // wall, and it does not count as having been hit by one either.
  it('stops a course where the ground stops, and keeps sweeping', () => {
    const field = new ThreatField();
    // Coming down onto a player who tries to walk east out of the way.
    field.build(0, 0, 0, [straightShot({ x: 3, y: -4 }, Math.PI / 2, 10, 0, 2000)], OPTIONS);

    const free = emptySweep();
    const boxed = emptySweep();
    field.sweep(0, 0, 1, 0, 0.006, 0, 600, Infinity, 0, free);
    // The same walk, with a wall a tenth of a tile away.
    field.sweep(0, 0, 1, 0, 0.006, 0, 600, 0.1, 0, boxed);

    // Walking east takes the player under the shot; being stopped short of it
    // leaves them clear, which the swept clearance has to show.
    expect(free.clearanceTiles).toBeLessThan(boxed.clearanceTiles);
  });

  // The distance half of "is this trouble now". A shot far enough away is still
  // predicted, still swept and still ranks the courses — it simply cannot be
  // the reason a dodge starts.
  it('does not call a far shot trouble, and still measures it', () => {
    const field = new ThreatField();
    // Coming straight at the player from six tiles out at ten tiles a second,
    // so it lands well inside the horizon — but two hundred milliseconds from
    // now it is still four tiles outside the reaction distance.
    field.build(0, 0, 0, [straightShot({ x: -6, y: 0 }, 0, 10, 0, 2000)], {
      ...OPTIONS,
      reactTiles: 2,
      reactWithinMs: 200,
    });

    const swept = sweepStanding(field, { x: 0, y: 0 });
    expect(field.tracked).toBe(1);
    expect(swept.impactMs).toBeLessThan(Infinity);
    expect(swept.clearanceTiles).toBeLessThan(0);
    expect(swept.unsafeAtMs).toBe(Infinity);
  });

  it('calls the same shot trouble once it is near', () => {
    const field = new ThreatField();
    field.build(0, 0, 0, [straightShot({ x: -1.5, y: 0 }, 0, 10, 0, 2000)], {
      ...OPTIONS,
      reactTiles: 2,
      reactWithinMs: 200,
    });

    expect(sweepStanding(field, { x: 0, y: 0 }).unsafeAtMs).toBeLessThan(Infinity);
  });

  // **The gate read the wrong number.** Where a shot is at the instant of
  // planning says very little: a bullet six tiles out doing thirty tiles a
  // second is through the player in two hundred milliseconds, and calling it
  // "far" left the fastest fire in the game — the fire hardest to dodge — unable
  // to raise its hand at all.
  it('calls a fast shot trouble while it is still a room away', () => {
    const field = new ThreatField();
    field.build(0, 0, 0, [straightShot({ x: -6, y: 0 }, 0, 30, 0, 2000)], {
      ...OPTIONS,
      reactTiles: 2,
      reactWithinMs: 200,
    });

    expect(sweepStanding(field, { x: 0, y: 0 }).unsafeAtMs).toBeLessThan(Infinity);
  });

  // **What decides which way to go when the field is busy.** The full-horizon
  // clearance is a minimum over a second of prediction, so it is set by whatever
  // passes closest at the far end; the urgent one is set by what is arriving.
  it('measures the room it has now apart from the room it has later', () => {
    const field = new ThreatField();
    field.build(
      0,
      0,
      0,
      [
        // Alongside from the start, and never nearer than a comfortable margin.
        straightShot({ x: -1, y: 1.4 }, 0, 10, 0, 2000),
        // And shaving past much closer, but not until the far end of the
        // horizon: four tiles away for the whole of the reaction window.
        straightShot({ x: -4, y: 0.9 }, 0, 6, 0, 2000),
      ],
      { ...OPTIONS, reactWithinMs: 200 },
    );

    const swept = sweepStanding(field, { x: 0, y: 0 });
    expect(swept.clearanceTiles).toBeCloseTo(0.9 - effectiveHalf(0.5, 1, 0), 2);
    expect(swept.urgentClearanceTiles).toBeCloseTo(1.4 - effectiveHalf(0.5, 1, 0), 2);
  });
});

// **The defect that reads as "very jerky".** A plan is made fifty times a
// second, so two near-equal courses swapping places on noise is a character
// vibrating — and the transition that showed it worst was steering to standing
// and back, which had no hysteresis at all because holding still was not
// something the dwell could hold. Counted rather than eyeballed: a number is the
// only way to tell "settled down" from "settled down in the one case I tried".
describe('how steady the answer is', () => {
  /** What {@link situation} gives a character, so the harness walks it correctly. */
  const WALK_TILES_PER_SECOND = 6;

  /** Plans every 20 ms while the world advances, and counts the flapping. */
  function drive(
    shots: readonly DodgeShot[],
    steps: number,
  ): { flips: number; courses: number; steered: number } {
    const controller = new DodgeController();
    let x = 10;
    let y = 10;
    let flips = 0;
    let courses = 0;
    let steered = 0;
    let wasSteering = false;
    let last = '';
    // The command takes `leadMs` to reach the game, which is what the planner
    // now assumes — see `ThreatField.sweep`. Applying it instantly would measure
    // the harness rather than the planner.
    const queued: { dirX: number; dirY: number; scale: number }[] = [];

    for (let step = 0; step < steps; step += 1) {
      const gameTimeMs = step * 20;
      const plan = controller.plan(
        situation({ x, y, gameTimeMs, nowMs: 1_000_000 + gameTimeMs }),
        SETTINGS,
        OPEN_GROUND,
        shots,
      );
      if (plan.steer !== wasSteering) flips += 1;
      wasSteering = plan.steer;
      if (plan.steer) steered += 1;
      const course = plan.steer
        ? `${String(plan.dirX)},${String(plan.dirY)},${String(plan.speedScale)}`
        : 'hold';
      if (course !== last) courses += 1;
      last = course;

      queued.push({ dirX: plan.dirX, dirY: plan.dirY, scale: plan.steer ? plan.speedScale : 0 });
      const live = queued[queued.length - 4];
      if (live !== undefined) {
        x += live.dirX * WALK_TILES_PER_SECOND * live.scale * 0.02;
        y += live.dirY * WALK_TILES_PER_SECOND * live.scale * 0.02;
      }
    }
    return { flips, courses, steered };
  }

  it('does not hand the wheel back and take it again every other plan', () => {
    // A steady stream from the west, one every 260 ms on slightly different
    // lines: an ordinary monster doing an ordinary thing, and the case where
    // the stutter was most obvious.
    const stream: DodgeShot[] = [];
    for (let i = 0; i < 20; i += 1) {
      stream.push(straightShot({ x: 2, y: 10 + (i % 3) * 0.35 - 0.35 }, 0, 9, i * 260, 2000));
    }

    const driven = drive(stream, 150);

    // It does take the wheel — a test that passes by never dodging is worthless.
    expect(driven.steered).toBeGreaterThan(10);
    // Three seconds, and the wheel changes hands a handful of times rather than
    // once a frame. Measured at six before the commitment was fixed.
    expect(driven.flips).toBeLessThanOrEqual(3);
    expect(driven.courses).toBeLessThanOrEqual(5);
  });

  it('stays steady in dense fire, which is where it used to be worst', () => {
    // Waves of a wide fan: the situation where trouble is always inside the
    // urgent window, which is exactly when the dwell used to switch itself off.
    const fan: DodgeShot[] = [];
    for (let wave = 0; wave < 5; wave += 1) {
      for (let i = 0; i < 11; i += 1) {
        fan.push(straightShot({ x: 2, y: 10 }, (i - 5) * 0.09, 10, wave * 420, 2200));
      }
    }

    const driven = drive(fan, 150);

    // Measured at forty-seven course changes over these three seconds before
    // the commitment was fixed, and under half that after.
    expect(driven.courses).toBeLessThanOrEqual(30);
    expect(driven.flips).toBeLessThanOrEqual(6);
  });
});

// Both of these came out of a live log rather than out of a hunch, and both
// read as "the dodge is not really working" long before anyone could say why.
describe('what the verdict is allowed to claim', () => {
  /** Sustained fire from every side: waves overlapping, never quite quiet. */
  function crossfire(): DodgeShot[] {
    const shots: DodgeShot[] = [];
    for (let wave = 0; wave < 14; wave += 1) {
      const from = (wave * 1.1) % (Math.PI * 2);
      for (let i = 0; i < 5; i += 1) {
        shots.push(
          straightShot(
            { x: 10 + Math.cos(from) * 8, y: 10 + Math.sin(from) * 8 },
            from + Math.PI + (i - 2) * 0.11,
            9,
            wave * 210,
            2200,
          ),
        );
      }
    }
    return shots;
  }

  /** Every plan over four seconds of it, walked as the module would walk it. */
  function drivenPlans(settings: DodgeSettings = SETTINGS): DodgePlan[] {
    const controller = new DodgeController();
    const shots = crossfire();
    const plans: DodgePlan[] = [];
    const queued: { dirX: number; dirY: number; scale: number }[] = [];
    let x = 10;
    let y = 10;

    for (let step = 0; step < 200; step += 1) {
      const gameTimeMs = step * 20;
      const plan = controller.plan(
        situation({ x, y, gameTimeMs, nowMs: 1_000_000 + gameTimeMs }),
        settings,
        OPEN_GROUND,
        shots,
      );
      plans.push(plan);
      queued.push({ dirX: plan.dirX, dirY: plan.dirY, scale: plan.steer ? plan.speedScale : 0 });
      const live = queued[queued.length - 4];
      if (live !== undefined) {
        x += live.dirX * 6 * live.scale * 0.02;
        y += live.dirY * 6 * live.scale * 0.02;
      }
    }
    return plans;
  }

  // The live log was full of `unavoidable ... room 0.01t ... hit in never`: the
  // planner calling a moment hopeless when nothing was going to hit it, and
  // throwing away its sense of position to survive a hit that was not coming.
  // Being grazed is not being hit.
  it('never calls a moment hopeless while nothing would actually land', () => {
    const doomedButUnhit = drivenPlans().filter(
      (plan) => plan.verdict === 'unavoidable' && plan.impactMs === Infinity,
    );

    expect(doomedButUnhit).toHaveLength(0);
  });

  // And full of `clear ... hit in 480ms, at 0% speed`: the wheel handed back
  // with an impact already inside the window it is supposed to act on.
  it('never hands the wheel back with a hit already inside the window', () => {
    const abandoned = drivenPlans().filter(
      (plan) =>
        (plan.verdict === 'clear' || plan.verdict === 'intent-safe') &&
        plan.impactMs <= SETTINGS.reactWithinMs,
    );

    expect(abandoned).toHaveLength(0);
  });

  // **The complaint in the user's own words: "we do not dodge, we take the
  // hits."** Every branch below `unavoidable` claims to have found a course
  // that survives the window, and one of them was admitting courses that do
  // not: the filter asked when a course first runs *low on room*, which only
  // the shots already near can answer, and then let alignment with the
  // player's own heading outrank being hit. The only honest reason to settle
  // for a course with a hit inside the window is that every course has one,
  // which is what `unavoidable` is for.
  it('never settles on a course it has already predicted a hit on', () => {
    // At the tightest reaction distance the overlay offers, which is where the
    // two questions genuinely come apart: a character covers four tiles inside
    // the reaction window, so at two tiles of gate a shot can be predicted to
    // land on a course without ever having counted as near.
    const caught = drivenPlans({ ...SETTINGS, reactWithinTiles: 2 }).filter(
      (plan) =>
        (plan.verdict === 'guide' || plan.verdict === 'evade' || plan.verdict === 'spacing') &&
        plan.impactMs <= SETTINGS.reactWithinMs,
    );

    expect(caught).toHaveLength(0);
  });

  // Standing still *is* sometimes the answer — when every course is hit and
  // this one is hit latest. That is the honest verdict, and it must not be
  // confused with the two above.
  it('still says so plainly when standing is the least bad thing available', () => {
    const plans = drivenPlans();
    // It does take the wheel in this fight rather than passing every check by
    // never doing anything.
    expect(plans.filter((plan) => plan.steer).length).toBeGreaterThan(40);
  });
});

describe('blasts on their way down', () => {
  /** A bomb landing on a spot, in `armsInMs` from the plan's clock. */
  const blast = (x: number, y: number, radiusTiles: number, armsInMs: number): BlastView => ({
    x,
    y,
    radiusTiles,
    armsAtMs: armsInMs,
  });

  it('catches a course that walks into where one lands', () => {
    const blasts = new Blasts();
    // Three tiles east, landing in half a second.
    blasts.collect([blast(13, 10, 2, 500)], 0, 10, 10, 8, 1000, 420);
    expect(blasts.count).toBe(1);

    const out = emptySweep();
    // Walking east at six tiles a second is inside it when it goes off.
    blasts.sweep(10, 10, 1, 0, 0.006, 0.006, 60, 1000, Infinity, 0.08, out);
    expect(out.impactMs).toBe(500);
    expect(out.clearanceTiles).toBeLessThan(0);
  });

  // **The whole reason a blast is not modelled as a bullet.** The ground it will
  // take is walkable right up until it lands, and afterwards it is the safest
  // place on the screen. A planner that refused the disc for the bomb's whole
  // flight would be a leash.
  it('leaves a course alone that is gone before it lands', () => {
    const blasts = new Blasts();
    blasts.collect([blast(13, 10, 2, 500)], 0, 10, 10, 8, 1000, 420);

    const out = emptySweep();
    // Walking the other way: through none of it by the time it goes off.
    blasts.sweep(10, 10, -1, 0, 0.006, 0.006, 60, 1000, Infinity, 0.08, out);
    expect(out.impactMs).toBe(Infinity);
    expect(out.clearanceTiles).toBeGreaterThan(0);
  });

  it('forgets one that has already gone off, and one landing past the horizon', () => {
    const blasts = new Blasts();
    blasts.collect(
      [blast(10, 10, 3, -50), blast(10, 10, 3, 4000), blast(10, 10, 3, 400)],
      0,
      10,
      10,
      8,
      1000,
      420,
    );
    expect(blasts.count).toBe(1);
  });

  it('forgets one whose edge no course could reach', () => {
    const blasts = new Blasts();
    // Forty tiles away: the player can cover six inside the horizon.
    blasts.collect([blast(50, 10, 2, 500)], 0, 10, 10, 6.4, 1000, 420);
    expect(blasts.count).toBe(0);
  });

  // A radius is a radius. Measuring it as a square — which is right for the
  // game's projectile collision and wrong here — would call this a hit.
  it('measures a circle, so a corner of the bounding box is outside it', () => {
    const blasts = new Blasts();
    blasts.collect([blast(10, 10, 3, 700)], 0, 10, 10, 8, 1000, 420);

    const out = emptySweep();
    // Diagonally out to (12.6, 12.6) by the time it lands: 3.68 tiles from the
    // centre as a radius, against the 3.56 the blast and the body come to — but
    // only 2.6 by the square the projectile sweep measures in, which would have
    // called this a hit.
    blasts.sweep(10, 10, Math.SQRT1_2, Math.SQRT1_2, 0.006, 0.006, 0, 1000, 3.68, 0.08, out);
    expect(out.impactMs).toBe(Infinity);
    expect(out.clearanceTiles).toBeGreaterThan(0);
  });

  it('takes the wheel to get out of one, and gets out', () => {
    const controller = new DodgeController();
    // Landing on the player's head in six hundred milliseconds, with nothing
    // else in the air at all. Small enough and far enough off to be escapable:
    // the walk covers 3.24 tiles once the lead is paid, against the 2.06 the
    // blast and the body come to.
    const plan = controller.plan(situation(), SETTINGS, OPEN_GROUND, [], [blast(10, 10, 1.5, 600)]);

    expect(plan.steer).toBe(true);
    expect(plan.impactMs).toBe(Infinity);
  });

  it('reports being caught when the blast is too wide to leave', () => {
    const controller = new DodgeController();
    // Three tiles of radius landing in a third of a second: 1.62 tiles of walk
    // against 3.56 of blast. Nothing to be done, and it says so rather than
    // pretending a course escaped.
    const plan = controller.plan(situation(), SETTINGS, OPEN_GROUND, [], [blast(10, 10, 3, 330)]);

    expect(plan.verdict).toBe('unavoidable');
    expect(plan.impactMs).toBe(330);
  });

  it('says nothing about a blast landing somewhere else', () => {
    const controller = new DodgeController();
    const plan = controller.plan(situation(), SETTINGS, OPEN_GROUND, [], [blast(24, 10, 3, 330)]);

    expect(plan.verdict).toBe('clear');
    expect(plan.steer).toBe(false);
  });
});

describe('who is driving', () => {
  it('says nothing at all when nothing can reach the player', () => {
    const controller = new DodgeController();
    const plan = controller.plan(situation(), SETTINGS, OPEN_GROUND, []);

    expect(plan.verdict).toBe('clear');
    expect(plan.steer).toBe(false);
  });

  it('leaves the player alone while their own course is safe', () => {
    const controller = new DodgeController();
    // A shot on its way past, four tiles north of where they are walking.
    const shot = straightShot({ x: 14, y: 14 }, Math.PI, 10, 0, 2000);

    const plan = controller.plan(situation({ intentX: 0, intentY: -1 }), SETTINGS, OPEN_GROUND, [
      shot,
    ]);

    expect(plan.steer).toBe(false);
  });

  it('takes the wheel when their own course walks into a shot', () => {
    const controller = new DodgeController();
    // Coming east along y = 10, close enough to matter.
    const shot = straightShot({ x: 0, y: 10 }, 0, 8, 0, 2000);

    const plan = controller.plan(
      // Walking west, straight into it.
      situation({ intentX: -1, intentY: 0, gameTimeMs: 900 }),
      SETTINGS,
      OPEN_GROUND,
      [shot],
    );

    expect(plan.steer).toBe(true);
    // Sideways, not a backpedal along the shot's own line.
    expect(Math.abs(plan.dirY)).toBeGreaterThan(0.5);
  });

  it('moves out of the way of a shot while the player stands still', () => {
    const controller = new DodgeController();
    const shot = straightShot({ x: 0, y: 10 }, 0, 8, 0, 2000);

    const plan = controller.plan(situation({ gameTimeMs: 900 }), SETTINGS, OPEN_GROUND, [shot]);

    expect(plan.steer).toBe(true);
    expect(Math.abs(plan.dirY)).toBeGreaterThan(0.5);
  });

  // Re-walked against the field rather than trusting the planner's own report
  // of itself, which is the only check that would have caught a planner that
  // scored one course and committed another.
  it('verifies its own answer: the chosen course is genuinely clear', () => {
    const controller = new DodgeController();
    const shot = straightShot({ x: 0, y: 10 }, 0, 8, 0, 2000);
    const plan = controller.plan(situation({ gameTimeMs: 900 }), SETTINGS, OPEN_GROUND, [shot]);

    const field = new ThreatField();
    field.build(900, 10, 10, [shot], {
      horizonMs: SETTINGS.horizonMs,
      sampleStepMs: SETTINGS.sampleStepMs,
      hitScale: SETTINGS.hitScale,
      padTiles: SETTINGS.padTiles,
      driftTilesPerSecond: SETTINGS.driftTilesPerSecond,
      reachTiles: 4,
      reactTiles: SETTINGS.reactWithinTiles,
      reactWithinMs: SETTINGS.reactWithinMs,
    });
    const swept = emptySweep();
    field.sweep(
      10,
      10,
      plan.dirX,
      plan.dirY,
      0.006 * plan.speedScale,
      SETTINGS.leadMs,
      SETTINGS.horizonMs,
      Infinity,
      SETTINGS.safeClearanceTiles,
      swept,
    );

    // Clear for at least as long as the decision was about, which is the whole
    // claim a plan makes — not that it is safe forever.
    expect(swept.unsafeAtMs).toBeGreaterThan(SETTINGS.reactWithinMs);
    expect(swept.impactMs).toBeGreaterThan(SETTINGS.reactWithinMs);
  });

  it('still answers when every course is hit', () => {
    const controller = new DodgeController();
    // Closing from every side at once, from close enough that nothing outruns it.
    const shots: DodgeShot[] = [];
    for (let i = 0; i < 16; i += 1) {
      const angle = (i / 16) * 2 * Math.PI;
      shots.push(
        straightShot(
          { x: 10 + 2 * Math.cos(angle), y: 10 + 2 * Math.sin(angle) },
          angle + Math.PI,
          14,
          0,
          2000,
        ),
      );
    }

    const plan = controller.plan(situation(), SETTINGS, OPEN_GROUND, shots);

    expect(plan.verdict).toBe('unavoidable');
    expect(plan.impactMs).toBeLessThan(SETTINGS.horizonMs);
  });
});

// The complaint this answers, in the user's words: "why are you saving me from
// shots that are miles away? I cannot even walk up to the monster."
describe('what counts as trouble now', () => {
  /** Closing on the player down the y axis, from `tiles` away. */
  const closingFrom = (tiles: number): DodgeShot =>
    straightShot({ x: 10, y: 10 + tiles }, -Math.PI / 2, 8, 0, 4000);

  it('leaves fire alone while it is still a walk away', () => {
    const controller = new DodgeController();
    // Seven tiles out at eight tiles a second: it *will* arrive inside the
    // horizon, and it is nobody's problem for most of a second.
    const plan = controller.plan(situation(), SETTINGS, OPEN_GROUND, [closingFrom(7)]);

    expect(plan.verdict).toBe('clear');
    expect(plan.steer).toBe(false);
  });

  it('keeps the player going towards what is shooting at them', () => {
    const controller = new DodgeController();
    // Walking straight at it closes the gap at fourteen tiles a second, so this
    // *is* soon enough to answer — but the answer is a step aside, not a
    // retreat. Walking away from everything that fires is the behaviour this
    // whole window exists to stop.
    const plan = controller.plan(situation({ intentX: 0, intentY: 1 }), SETTINGS, OPEN_GROUND, [
      closingFrom(7),
    ]);

    expect(plan.dirY).toBeGreaterThan(0);
  });

  it('acts on the same shot once it is close', () => {
    const controller = new DodgeController();
    const plan = controller.plan(situation(), SETTINGS, OPEN_GROUND, [closingFrom(2.5)]);

    expect(plan.steer).toBe(true);
  });

  // **And the other half of the same question, which the gate had backwards.**
  // Distance was read at the instant of planning, so a bullet crossing the room
  // at twenty-four tiles a second counted as far — and being far it could not
  // raise its hand, so the planner left the player standing exactly where it
  // had predicted the shot would land. The fastest fire in the game was the one
  // class it could not answer at all.
  it('acts on a fast shot while it is still on the other side of the room', () => {
    const controller = new DodgeController();
    // The plugin's own reaction distance, not the wide one the tests above use.
    const settings: DodgeSettings = { ...SETTINGS, reactWithinTiles: 6 };
    const plan = controller.plan(situation(), settings, OPEN_GROUND, [
      straightShot({ x: 10, y: 18 }, -Math.PI / 2, 24, 0, 4000),
    ]);

    expect(plan.steer).toBe(true);
    // And the course it picked is one the shot does not reach.
    expect(plan.impactMs).toBe(Infinity);
  });
});

// The other complaint: a wall of shots with a hole in it, answered by backing
// away from the whole thing instead of stepping through the hole.
describe('a wall of shots with a window in it', () => {
  /**
   * A solid line sweeping down the map, with one column missing.
   *
   * Spaced closer than the columns are wide, so there is no way through it
   * except the gap — and the gap is a short step, not a sprint.
   */
  function wall(missingAt: number, fromY: number): DodgeShot[] {
    const shots: DodgeShot[] = [];
    for (let x = 4; x <= 16.01; x += 0.9) {
      if (Math.abs(x - missingAt) < 0.01) continue;
      shots.push(straightShot({ x, y: fromY }, Math.PI / 2, 8, 0, 4000, 0.25));
    }
    return shots;
  }

  // Nothing the model cannot describe, so the geometry below is exact rather
  // than approximately right.
  const EXACT: DodgeSettings = { ...SETTINGS, padTiles: 0, driftTilesPerSecond: 0 };
  /** Where the missing column leaves room, given the half-extents above. */
  const HALF = 0.25 + PLAYER_HALF_TILES;

  /** Where the player is when the wall is level with them, walking this plan. */
  function whereItCrosses(plan: DodgePlan, fromY: number): number {
    const speed = 6 * plan.speedScale;
    // The walk starts `leadMs` from now and not before, which is the same model
    // the sweep uses — see `ThreatField.sweep`. Standing still until then is the
    // whole of the correction, and a check that assumed the old head start
    // would be measuring a place the planner never claimed.
    const walked = (t: number): number => (speed * Math.max(0, t - EXACT.leadMs)) / 1000;
    let closest = Infinity;
    let at = 0;
    for (let t = 0; t <= EXACT.horizonMs; t += 5) {
      const player = 10 + plan.dirY * walked(t);
      const gap = Math.abs(player - (fromY + (8 * t) / 1000));
      if (gap < closest) {
        closest = gap;
        at = t;
      }
    }
    return 10 + plan.dirX * walked(at);
  }

  it('goes through the window rather than backing away from the pattern', () => {
    const controller = new DodgeController();
    const plan = controller.plan(situation(), EXACT, OPEN_GROUND, wall(9.4, 6.6));

    expect(plan.steer).toBe(true);
    // Not giving ground: the wall sweeps towards +y and this does not run with
    // it. Whether it slips sideways into the hole or goes straight through it —
    // both are the window, and the planner is free to pick either.
    expect(plan.dirY).toBeLessThanOrEqual(0);
    expect(whereItCrosses(plan, 6.6)).toBeGreaterThan(8.5 + HALF);
    expect(whereItCrosses(plan, 6.6)).toBeLessThan(10.3 - HALF);
  });

  // **The window that is not one.** A second rank behind the first with its hole
  // somewhere else, so diving through the near one only arrives at the far one's
  // solid part. Threading it is the mistake the player reported as "squeezing
  // through where it will not fit", and what the planner owes here is an answer
  // that survives — not a brave one.
  it('does not dive through a window with a solid rank behind it', () => {
    const controller = new DodgeController();
    const ranks = wall(9.4, 6.6).concat(wall(12.1, 5.0));
    const plan = controller.plan(situation(), EXACT, OPEN_GROUND, ranks);

    expect(plan.steer).toBe(true);
    // A real answer rather than the least bad of a doomed set: nothing touches
    // this course for as long as the decision is about.
    expect(plan.unsafeAtMs).toBeGreaterThan(EXACT.reactWithinMs);
    expect(plan.clearanceTiles).toBeGreaterThan(0);
    // And it is not a dive *into* the ranks, which are coming up from below.
    expect(plan.dirY).toBeGreaterThanOrEqual(0);
  });

  it('backs off when the same wall has no window at all', () => {
    const controller = new DodgeController();
    // Nothing missing, and close enough that there is no time to look for a way
    // through: outrunning it is the whole of what is left.
    const plan = controller.plan(situation(), EXACT, OPEN_GROUND, wall(99, 8.6));

    expect(plan.steer).toBe(true);
    // With the wall sweeping towards +y, giving ground is the only survival.
    expect(plan.dirY).toBeGreaterThan(0.5);
  });
});

describe('where it refuses to go', () => {
  /** Lava everywhere east of a line, and open ground behind it. */
  const lavaEastOf = (edge: number): DodgeWorld => ({
    canStand: () => true,
    isDamaging: (x) => x > edge,
    standoffAt: () => 0,
  });

  it('steers the player around ground that is about to hurt them', () => {
    const controller = new DodgeController();
    const plan = controller.plan(
      // Walking due east, with the pool half a tile away and nothing in the air.
      situation({ intentX: 1, intentY: 0 }),
      SETTINGS,
      lavaEastOf(10.5),
      [],
    );

    expect(plan.steer).toBe(true);
    // Turned, not stopped and not reversed: still going roughly their way.
    expect(plan.dirX).toBeLessThan(1);
    expect(Math.abs(plan.dirY)).toBeGreaterThan(0);
  });

  it('leaves them alone when the same ground is still a walk away', () => {
    const controller = new DodgeController();
    const plan = controller.plan(
      situation({ intentX: 1, intentY: 0 }),
      SETTINGS,
      lavaEastOf(14),
      [],
    );

    expect(plan.verdict).toBe('clear');
    expect(plan.steer).toBe(false);
  });

  it('gets off damaging ground it is already standing on', () => {
    const controller = new DodgeController();
    // Standing in it, with the clean edge to the west.
    const plan = controller.plan(situation(), SETTINGS, lavaEastOf(9.5), []);

    expect(plan.verdict).toBe('escape');
    expect(plan.steer).toBe(true);
    expect(plan.dirX).toBeLessThan(0);
  });

  it('does not walk through a wall to dodge', () => {
    const controller = new DodgeController();
    const walled: DodgeWorld = {
      // Everything north of the player is solid.
      canStand: (_x, y) => y <= 10.2,
      isDamaging: () => false,
      standoffAt: () => 0,
    };
    const shot = straightShot({ x: 0, y: 10 }, 0, 8, 0, 2000);

    const plan = controller.plan(situation({ gameTimeMs: 900 }), SETTINGS, walled, [shot]);

    expect(plan.steer).toBe(true);
    // A course into the wall stops at it and earns no distance from the shot,
    // so the answer has to come from the open side.
    expect(plan.dirY).toBeLessThanOrEqual(0);
  });

  it('prefers the lane that does not run through a monster', () => {
    const controller = new DodgeController();
    const bodies = new EnemyBodies();
    // One directly north, at the range a dodge would reach.
    bodies.collect([{ x: 10, y: 12 } as EntityView], 10, 10, 6, ANY_BODY);
    const shot = straightShot({ x: 0, y: 10 }, 0, 8, 0, 2000);

    const plan = controller.plan(
      situation({ gameTimeMs: 900 }),
      SETTINGS,
      standingOff(bodies, { keepAwayTiles: 2, stayWithinTiles: Infinity }),
      [shot],
    );

    expect(plan.steer).toBe(true);
    expect(plan.dirY).toBeLessThan(0);
  });
});

// What the module draws over the map when "Show where we are dodging" is on.
describe('the shot paths that get drawn', () => {
  /** A shot with a real life, which is what the colour along the line is made of. */
  function tracked(firedAtMs: number, expiresAtMs: number): ProjectileView {
    return {
      firedAtMs,
      expiresAtMs,
      positionAt(gameTimeMs: number): Position | undefined {
        if (gameTimeMs < firedAtMs || gameTimeMs > expiresAtMs) return undefined;
        return { x: (gameTimeMs - firedAtMs) / 100, y: 0 };
      },
    } as unknown as ProjectileView;
  }

  it('describes the part of the path that is still to come', () => {
    const [path] = shotPaths(400, [tracked(0, 1000)], 8);

    expect(path).toBeDefined();
    // Six tenths of its life left, which is what makes it a colour.
    expect(path?.lifePermille).toBe(600);
    // The first point is where it is *now*: the part already travelled is not
    // information, it is where the shot has visibly been.
    expect(path?.points.slice(0, 2)).toEqual([4, 0]);
    // And the last is where it stops existing.
    const points = path?.points ?? [];
    expect(points[points.length - 2]).toBeCloseTo(10, 5);
  });

  it('draws a fresh shot green and a spent one red, by saying how much is left', () => {
    const fresh = shotPaths(10, [tracked(0, 1000)], 8)[0];
    const spent = shotPaths(900, [tracked(0, 1000)], 8)[0];

    expect(fresh?.lifePermille).toBeGreaterThan(950);
    expect(spent?.lifePermille).toBeLessThan(150);
  });

  it('says nothing about a shot with nothing left of it', () => {
    expect(shotPaths(995, [tracked(0, 1000)], 8)).toHaveLength(0);
    expect(shotPaths(2000, [tracked(0, 1000)], 8)).toHaveLength(0);
  });

  it('keeps a busy screen bounded, in shots and in points', () => {
    const many = Array.from({ length: 40 }, () => tracked(0, 4000));
    const paths = shotPaths(0, many, 8);

    expect(paths).toHaveLength(8);
    for (const path of paths) {
      expect(path.points.length).toBeLessThanOrEqual(MAX_PATH_POINTS * 2);
    }
  });
});

describe('the distance to fight from', () => {
  const BAND: StandoffBand = { keepAwayTiles: 2, stayWithinTiles: 7 };

  it('has no opinion when there is nobody to have one about', () => {
    expect(new EnemyBodies().standoffAt(0, 0, BAND)).toBe(0);
  });

  it('is content anywhere inside the band', () => {
    const bodies = new EnemyBodies();
    bodies.collect([{ x: 5, y: 0 } as EntityView], 0, 0, 10, ANY_BODY);
    expect(bodies.standoffAt(0, 0, BAND)).toBe(0);
  });

  it('says how far inside the near edge a place is', () => {
    const bodies = new EnemyBodies();
    bodies.collect([{ x: 1.5, y: 0 } as EntityView], 0, 0, 10, ANY_BODY);
    expect(bodies.standoffAt(0, 0, BAND)).toBeCloseTo(-0.5, 6);
  });

  // The bodies touching is a floor under whatever the setting says, so nought
  // still means "not standing inside it".
  it('keeps the contact distance even when the setting is nought', () => {
    const bodies = new EnemyBodies();
    bodies.collect([{ x: 0.4, y: 0 } as EntityView], 0, 0, 10, ANY_BODY);
    const touching = bodies.standoffAt(0, 0, { keepAwayTiles: 0, stayWithinTiles: Infinity });
    expect(touching).toBeCloseTo(0.4 - (ENEMY_CONTACT_HALF_TILES + PLAYER_HALF_TILES), 6);
  });

  it('says how far past weapon range a place is', () => {
    const bodies = new EnemyBodies();
    bodies.collect([{ x: 8, y: 0 } as EntityView], 0, 0, 12, ANY_BODY);
    expect(bodies.standoffAt(0, 0, BAND)).toBeCloseTo(1, 6);
  });

  // Past the cap it stops being a preference and would be a chase. Two places
  // both well out of range are the same answer, so nothing pulls between them.
  it('stops caring once out of range is simply far away', () => {
    const bodies = new EnemyBodies();
    bodies.collect([{ x: 20, y: 0 } as EntityView], 0, 0, 30, ANY_BODY);
    expect(bodies.standoffAt(0, 0, BAND)).toBe(OUT_OF_RANGE_CAP_TILES);
    expect(bodies.standoffAt(1, 0, BAND)).toBe(OUT_OF_RANGE_CAP_TILES);
  });

  it('judges by the nearest body, whoever that is', () => {
    const bodies = new EnemyBodies();
    bodies.collect(
      [{ x: 9, y: 0 } as EntityView, { x: 1, y: 0 } as EntityView],
      0,
      0,
      12,
      ANY_BODY,
    );
    expect(bodies.standoffAt(0, 0, BAND)).toBeCloseTo(-1, 6);
  });

  it('forgets everybody too far to matter', () => {
    const bodies = new EnemyBodies();
    bodies.collect([{ x: 30, y: 0 } as EntityView], 0, 0, 5, ANY_BODY);
    expect(bodies.count).toBe(0);
  });

  // **Better than a quarter of what the catalog marks as an enemy is scenery.**
  // A wall in this game is an object with hit points and the enemy flag, and
  // spawners, emitters and room controllers all answer to it — so "how near is
  // the nearest monster" was being answered by the room.
  it('does not let the scenery answer for the monsters', () => {
    const bodies = new EnemyBodies();
    const pillar = { objectId: 1, objectType: 10, x: 0.5, y: 0 } as EntityView;
    const monster = { objectId: 2, objectType: 20, x: 5, y: 0 } as EntityView;

    bodies.collect([pillar, monster], 0, 0, 12, (enemy) =>
      enemy.objectType === 10 ? undefined : { velocityX: 0, velocityY: 0 },
    );

    expect(bodies.count).toBe(1);
    // Content: the monster five tiles off is inside the band, and the pillar
    // half a tile away is not a monster.
    expect(bodies.standoffAt(0, 0, BAND)).toBe(0);
  });

  // **The near edge means nothing against something that follows.** Every
  // course that walks away scores as making room while the monsters are frozen
  // where they were last seen, which is how a melee minion matching the
  // player's speed was answered with "you are already dealing with it".
  it('asks where a body will be, not only where it was', () => {
    const bodies = new EnemyBodies();
    bodies.collect([{ x: 5, y: 0 } as EntityView], 0, 0, 12, chasing(-6, 0));

    expect(bodies.standoffAt(0, 0, BAND)).toBe(0);
    expect(bodies.standoffAt(0, 0, BAND, 600)).toBeCloseTo(-0.6, 6);
  });

  // A velocity carried a whole second is a claim about a decision the monster
  // has not made yet.
  it('stops believing a velocity long before the horizon does', () => {
    const bodies = new EnemyBodies();
    bodies.collect([{ x: 5, y: 0 } as EntityView], 0, 0, 12, chasing(-6, 0));

    expect(bodies.standoffAt(0, 0, BAND, 5000)).toBe(
      bodies.standoffAt(0, 0, BAND, MAX_BODY_LOOKAHEAD_MS),
    );
  });
});

describe('keeping the fight', () => {
  const CLOSE_BAND: StandoffBand = { keepAwayTiles: 2.5, stayWithinTiles: 7 };

  it('makes room when something walks onto the player', () => {
    const controller = new DodgeController();
    const bodies = new EnemyBodies();
    // A body a tile north, with nothing in the air at all.
    bodies.collect([{ x: 10, y: 11 } as EntityView], 10, 10, 12, ANY_BODY);

    const plan = controller.plan(situation(), SETTINGS, standingOff(bodies, CLOSE_BAND), []);

    expect(plan.verdict).toBe('spacing');
    expect(plan.steer).toBe(true);
    // Any course that leaves the bubble is as good as any other — the band is a
    // band, not a gradient — so what is asserted is that it does not walk in.
    expect(plan.dirY).toBeLessThanOrEqual(0);
  });

  it('stands still once the room is made', () => {
    const controller = new DodgeController();
    const bodies = new EnemyBodies();
    bodies.collect([{ x: 10, y: 14 } as EntityView], 10, 10, 12, ANY_BODY);

    const plan = controller.plan(situation(), SETTINGS, standingOff(bodies, CLOSE_BAND), []);

    expect(plan.verdict).toBe('clear');
    expect(plan.steer).toBe(false);
  });

  // The player asked to be there. A knight walking into a boss is not a mistake
  // to correct, and a dodge that argues about it is one they will switch off.
  // Their course is *checked* now rather than waved through on the strength of
  // a key being down — see the crowding test above — and it passes, because
  // where it ends is further out than where they are.
  it('does not push back against a player walking in', () => {
    const controller = new DodgeController();
    const bodies = new EnemyBodies();
    bodies.collect([{ x: 10, y: 11 } as EntityView], 10, 10, 12, ANY_BODY);

    const plan = controller.plan(
      situation({ intentX: 0, intentY: 1 }),
      SETTINGS,
      standingOff(bodies, CLOSE_BAND),
      [],
    );

    expect(plan.steer).toBe(false);
    expect(plan.verdict).toBe('intent-safe');
  });

  // **The complaint this answers: "they just walk up and kill me."** Crowding
  // stood down the moment a key went down, so a melee minion closing on a
  // player who was walking anywhere at all went unanswered — and walking is
  // what a player under fire spends their time doing. What replaced the key
  // test is whether their own walking is opening a gap, which against something
  // matching their speed it is not.
  it('answers a monster keeping pace with a player who is already walking', () => {
    const controller = new DodgeController();
    const bodies = new EnemyBodies();
    // A tile behind, following east at the character's own six tiles a second
    // while the player walks east.
    bodies.collect([{ x: 8.5, y: 10 } as EntityView], 10, 10, 12, chasing(6, 0));

    const plan = controller.plan(
      situation({ intentX: 1, intentY: 0 }),
      SETTINGS,
      standingOff(bodies, CLOSE_BAND),
      [],
    );

    expect(plan.verdict).toBe('spacing');
    expect(plan.steer).toBe(true);
    // Off its line, because running from something as fast as you are is not an
    // escape — but only just off it, because the least it can overrule them by
    // is the most it should. Still broadly the way they were going.
    expect(plan.dirY).not.toBe(0);
    expect(plan.dirX).toBeGreaterThan(0);
  });

  // And the other side of the same test: something standing still is something
  // the player walked up to, which is a decision and not a mistake.
  it('leaves the same player alone when the monster is not following', () => {
    const controller = new DodgeController();
    const bodies = new EnemyBodies();
    bodies.collect([{ x: 8.5, y: 10 } as EntityView], 10, 10, 12, ANY_BODY);

    const plan = controller.plan(
      situation({ intentX: 1, intentY: 0 }),
      SETTINGS,
      standingOff(bodies, CLOSE_BAND),
      [],
    );

    expect(plan.steer).toBe(false);
  });

  // The whole point of the far edge. Both ways out of this shot are safe; the
  // one that stays in range is the one that keeps doing damage.
  it('dodges across the fire rather than out of weapon range', () => {
    const controller = new DodgeController();
    const bodies = new EnemyBodies();
    // The shooter due south, at the edge of what the weapon reaches.
    bodies.collect([{ x: 10, y: 3.5 } as EntityView], 10, 10, 12, ANY_BODY);
    // Its shot coming straight up at the player.
    const shot = straightShot({ x: 10, y: 3.5 }, Math.PI / 2, 9, 0, 1400);

    const plan = controller.plan(
      situation({ gameTimeMs: 400 }),
      SETTINGS,
      standingOff(bodies, { keepAwayTiles: 2, stayWithinTiles: 7 }),
      [shot],
    );

    expect(plan.steer).toBe(true);
    // Sideways or forwards, but not straight back up the shot's own line.
    expect(plan.dirY).toBeLessThan(0.5);
  });
});

describe('which way the player is walking', () => {
  it('has no direction until the module says one', () => {
    expect(new SteerTracker().direction()).toBeUndefined();
  });

  it('normalises what the module sent', () => {
    const tracker = new SteerTracker();
    tracker.observe(3, 4);
    const direction = tracker.direction();
    expect(direction?.x).toBeCloseTo(0.6, 6);
    expect(direction?.y).toBeCloseTo(0.8, 6);
  });

  it('drops a direction that did not parse, and one of no length', () => {
    const tracker = new SteerTracker();
    tracker.observe(Number.NaN, 1);
    expect(tracker.direction()).toBeUndefined();
    tracker.observe(0, 0);
    expect(tracker.direction()).toBeUndefined();
  });

  it('lets go the moment the keys come up', () => {
    const tracker = new SteerTracker();
    tracker.observe(1, 0);
    tracker.release();
    expect(tracker.direction()).toBeUndefined();
  });

  // The safety that matters: this direction is *subtracted* from what the dodge
  // commands, so believing in one nobody is holding pushes the character.
  it('lets go on its own when the module stops saying it', () => {
    let now = 1000;
    const tracker = new SteerTracker({ now: () => now, freshForMs: 300 });
    tracker.observe(1, 0);

    now = 1200;
    expect(tracker.direction()).toBeDefined();

    now = 1400;
    expect(tracker.direction()).toBeUndefined();
  });
});

describe('how fast the character walks', () => {
  // Derived from the stat the server sends, never measured from movement.
  it('runs from the game floor to the game ceiling across the stat', () => {
    const self = new SelfState();

    expect(self.walkSpeedTilesPerSecond).toBe(MIN_WALK_TILES_PER_SECOND);

    self.speedStat = MAX_SPEED_STAT;
    expect(self.walkSpeedTilesPerSecond).toBeCloseTo(MAX_WALK_TILES_PER_SECOND, 5);

    self.speedStat = MAX_SPEED_STAT / 2;
    expect(self.walkSpeedTilesPerSecond).toBeCloseTo(
      (MIN_WALK_TILES_PER_SECOND + MAX_WALK_TILES_PER_SECOND) / 2,
      5,
    );
  });

  it('refuses to report more than the game allows, whatever the stat says', () => {
    const self = new SelfState();

    self.speedStat = MAX_SPEED_STAT * 10;
    expect(self.walkSpeedTilesPerSecond).toBeCloseTo(MAX_WALK_TILES_PER_SECOND, 5);

    self.speedStat = -50;
    expect(self.walkSpeedTilesPerSecond).toBe(MIN_WALK_TILES_PER_SECOND);
  });
});

// Driven through the real host, so the enable gate and the settings run as they
// do in production — and so does the clock the plugin plans on.
describe('when the plugin decides', () => {
  const NATIVE: NativeApi = {
    connected: false,
    setFeature: () => undefined,
    onConnected: () => () => undefined,
  };

  /** Longer than the plugin's planning interval, so one call is one decision. */
  const A_PLAN_MS = 30;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  interface Harness {
    host: PluginHost;
    moveTo: ReturnType<typeof vi.fn>;
    plan: () => void;
    /** Where the module says the chord is pointing, driven by hand. */
    cursor: { target: Position | undefined };
    /** Which way the module says the player is walking, driven by hand. */
    steer: { direction: Position | undefined };
    /** Whether the module says it is drawing the shot paths. */
    view: { on: boolean };
    showShotPaths: ReturnType<typeof vi.fn>;
  }

  /**
   * A player with one shot on its way to them.
   *
   * Nothing dispatches a packet: that is the point. The shot was announced at
   * some earlier moment and what makes it worth dodging is time passing, not
   * anything arriving on the wire.
   */
  function underFire(
    gameTimeMs: number,
    map: {
      canStandAt?: (x: number, y: number, clearanceTiles?: number) => boolean;
    } = {},
  ): Harness {
    const moveTo = vi.fn();
    const showShotPaths = vi.fn();
    const cursor: { target: Position | undefined } = { target: undefined };
    const steer: { direction: Position | undefined } = { direction: undefined };
    const view = { on: false };
    // Fired ten tiles west of the player and travelling east at eight tiles a
    // second, so it reaches them a little over a second later.
    const shot = straightShot({ x: 0, y: 10 }, 0, 8, 0, 2000);

    const session = {
      id: 's1',
      self: { objectId: 1, x: 10, y: 10, alive: true, walkSpeedTilesPerSecond: 6 },
      world: {
        gameTimeMs,
        projectiles: () => [shot],
        blasts: () => [],
        enemies: () => [],
        canStandAt: map.canStandAt ?? ((): boolean => true),
        tileAt: () => ({ type: 0, blocking: false, damaging: false }),
      },
      sendToServer: () => undefined,
    } as unknown as SessionView;

    const host = new PluginHost({
      log: testLogger(),
      native: NATIVE,
      sessions: {
        current: () => session,
        all: () => [session],
        onConnected: () => () => undefined,
        onDisconnected: () => () => undefined,
      } satisfies SessionApi,
      onChanged: () => undefined,
    });
    host.load(
      createDodgePlugin({
        output: { moveTo, showShotPaths },
        cursorWalk: { target: () => cursor.target },
        steer: { direction: () => steer.direction },
        view: { wanted: () => view.on },
        weaponRange: () => undefined,
        isObstacle: () => false,
        isInvincible: () => false,
      }),
    );
    host.setEnabled('auto-dodge', true);

    return {
      host,
      moveTo,
      showShotPaths,
      cursor,
      steer,
      view,
      plan: () => {
        vi.advanceTimersByTime(A_PLAN_MS);
      },
    };
  }

  it('acts on a shot that has come close enough, with no packet to prompt it', () => {
    // 900 ms in, the shot is two and a half tiles out — a third of a second from
    // landing. On the server's tick that would have been noticed up to 200 ms
    // later, which is most of the warning spent waiting.
    const { moveTo, plan } = underFire(900);
    plan();
    expect(moveTo).toHaveBeenCalled();
  });

  it('leaves a shot that is still far off alone', () => {
    const { moveTo, plan } = underFire(0);
    plan();
    expect(moveTo).not.toHaveBeenCalled();
  });

  it('does nothing at all while switched off', () => {
    const { host, moveTo, plan } = underFire(900);
    host.setEnabled('auto-dodge', false);
    plan();
    expect(moveTo).not.toHaveBeenCalled();
  });

  // The whole of "does not get in your way": a player already walking somewhere
  // safe is told nothing, so their own movement is untouched.
  it('says nothing while the player is walking somewhere safe', () => {
    const { moveTo, plan, steer } = underFire(900);
    // North, out of the shot's line.
    steer.direction = { x: 0, y: -1 };

    plan();

    expect(moveTo).not.toHaveBeenCalled();
  });

  it('takes over when the player is walking into it', () => {
    const { moveTo, plan, steer } = underFire(900);
    steer.direction = { x: -1, y: 0 };

    plan();

    expect(moveTo).toHaveBeenCalled();
  });

  // Taking the wheel means cancelling their input rather than adding to it: the
  // command has to *oppose* what they are holding, or the two sum to neither.
  it('cancels the input it is overriding', () => {
    const { moveTo, plan, steer } = underFire(900);
    const intent = { x: -1, y: 0 };
    steer.direction = intent;

    plan();

    expect(moveTo).toHaveBeenCalled();
    const [x, y] = moveTo.mock.calls[0] as [number, number, number, number];
    expect((x - 10) * intent.x + (y - 10) * intent.y).toBeLessThan(0);
  });

  it('walks to the cursor when the module names a place, planner or no planner', () => {
    const { moveTo, plan, cursor } = underFire(0);
    cursor.target = { x: 13, y: 7 };

    plan();

    expect(moveTo).toHaveBeenCalledTimes(1);
    const [x, y, speed] = moveTo.mock.calls[0] as [number, number, number, number];
    expect(x).toBe(13);
    expect(y).toBe(7);
    expect(speed).toBeCloseTo(5.52);
  });

  it('takes the wheel from the planner while the chord is pointing somewhere', () => {
    const { moveTo, plan, cursor } = underFire(900);
    cursor.target = { x: 13, y: 7 };

    plan();

    expect(moveTo).toHaveBeenCalled();
    expect(moveTo.mock.calls[0]?.slice(0, 2)).toEqual([13, 7]);
  });

  // The target the module holds keeps being walked towards until it lapses, so
  // a planner that merely stops speaking leaves the player walking somewhere it
  // has already stopped choosing — against whatever they are pressing.
  it('hands the wheel back the moment it no longer needs it', () => {
    const { moveTo, plan, cursor } = underFire(0);
    cursor.target = { x: 13, y: 7 };
    plan();
    cursor.target = undefined;

    plan();

    expect(moveTo).toHaveBeenCalledTimes(2);
    const [x, y, , hold] = moveTo.mock.calls[1] as [number, number, number, number];
    // Their own feet, which the module has by definition already arrived at.
    expect(x).toBe(10);
    expect(y).toBe(10);
    expect(hold).toBe(1);
  });

  // Nothing is predicted for a picture nobody is looking at: the switch lives
  // on the module, because the module owns the pixels.
  it('describes the shot paths only while the module is drawing them', () => {
    const { plan, showShotPaths, view } = underFire(900);

    plan();
    expect(showShotPaths).not.toHaveBeenCalled();

    view.on = true;
    plan();
    expect(showShotPaths).toHaveBeenCalledTimes(1);
    const paths = showShotPaths.mock.calls[0]?.[0] as { lifePermille: number }[];
    expect(paths).toHaveLength(1);
    expect(paths[0]?.lifePermille).toBeGreaterThan(0);
  });

  it('clears what is drawn once, when the switch goes up', () => {
    const { plan, showShotPaths, view } = underFire(900);
    view.on = true;
    plan();
    view.on = false;

    plan();
    plan();

    expect(showShotPaths).toHaveBeenCalledTimes(2);
    expect(showShotPaths.mock.calls[1]?.[0]).toEqual([]);
  });

  it('says nothing at all when it was not driving in the first place', () => {
    const { moveTo, plan } = underFire(0);

    plan();
    plan();

    expect(moveTo).not.toHaveBeenCalled();
  });

  it('plans with room to spare around walls', () => {
    const canStandAt = vi.fn((_x: number, _y: number, _clearanceTiles?: number) => true);
    const { plan } = underFire(900, { canStandAt });

    plan();

    // The first question is whether the player has that room where they stand;
    // every question after it carries the same margin.
    expect(canStandAt).toHaveBeenCalledWith(10, 10, 0.25);
    expect(canStandAt.mock.calls.every((call) => call[2] === 0.25)).toBe(true);
  });

  it('drops the margin once the player is already inside it', () => {
    // Everything fits, but nothing fits with room to spare: a player hugging a
    // wall, which is exactly the case where demanding the margin would refuse
    // every step out of it and pin them there.
    const canStandAt = (_x: number, _y: number, clearanceTiles?: number): boolean =>
      clearanceTiles === 0;
    const { moveTo, plan } = underFire(900, { canStandAt });

    plan();

    expect(moveTo).toHaveBeenCalled();
  });

  // **Twenty-odd numbers is homework, not a feature.** They all earn their
  // place and almost nobody wants to answer them, so the panel asks one
  // question and files the rest under Advanced.
  describe('the presets', () => {
    function settingsOf(): SettingsRegistry {
      const { host } = underFire(0);
      const settings = host.settingsOf('auto-dodge');
      if (settings === undefined) throw new Error('the plugin declared no settings');
      return settings;
    }

    it('asks one question, and puts everything else behind Advanced', () => {
      const everyday = settingsOf()
        .descriptors()
        .filter((setting) => setting.advanced !== true);

      expect(everyday.map((setting) => setting.key)).toEqual(['preset']);
    });

    it('starts on a preset rather than on a mix nobody chose', () => {
      const settings = settingsOf();

      expect(settings.values()['preset']).toBe(DodgePresetId.Balanced);
      expect(presetMatches(readTuning(settings), DODGE_PRESETS[DodgePresetId.Balanced])).toBe(true);
    });

    it('writes its whole assignment, so nothing survives from the last one', () => {
      const settings = settingsOf();

      settings.apply('preset', DodgePresetId.Cautious);
      expect(readTuning(settings)).toEqual(DODGE_PRESETS[DodgePresetId.Cautious]);

      settings.apply('preset', DodgePresetId.Relaxed);
      expect(readTuning(settings)).toEqual(DODGE_PRESETS[DodgePresetId.Relaxed]);
    });

    // The label has to stop claiming a preset the moment the numbers stop being
    // that preset's, or it is a label that lies.
    it('drops the label once one of its numbers is moved by hand', () => {
      const settings = settingsOf();

      settings.apply('preset', DodgePresetId.Cautious);
      expect(settings.values()['preset']).toBe(DodgePresetId.Cautious);

      settings.apply('hitScale', 1.4);
      expect(settings.values()['preset']).toBe('custom');
      // And the number they moved is the one they moved, not the preset's.
      expect(settings.values()['hitScale']).toBe(1.4);
    });

    // The ones a preset has no business rewriting: latency, the character's own
    // speed, and every switch. Trying another preset must not undo a setup.
    it('leaves the numbers it does not own alone', () => {
      const settings = settingsOf();
      settings.apply('leadMs', 100);
      settings.apply('speedPercent', 80);
      settings.apply('avoidBlasts', false);

      settings.apply('preset', DodgePresetId.Cautious);

      expect(settings.values()['leadMs']).toBe(100);
      expect(settings.values()['speedPercent']).toBe(80);
      expect(settings.values()['avoidBlasts']).toBe(false);
      expect(settings.values()['preset']).toBe(DodgePresetId.Cautious);
    });

    it('plans on the preset it was given', () => {
      const relaxed = underFire(700);
      relaxed.host.settingsOf('auto-dodge')?.apply('preset', DodgePresetId.Relaxed);
      relaxed.plan();
      // Three hundred milliseconds of window and four and a half tiles of
      // reach: at 700 ms the shot is still 4.4 tiles out and most of a second
      // from landing, which is nobody's problem yet.
      expect(relaxed.moveTo).not.toHaveBeenCalled();

      const cautious = underFire(700);
      cautious.host.settingsOf('auto-dodge')?.apply('preset', DodgePresetId.Cautious);
      cautious.plan();
      expect(cautious.moveTo).toHaveBeenCalled();
    });
  });
});

/** The eleven numbers a preset owns, read back out of a live registry. */
function readTuning(settings: SettingsRegistry): DodgeTuning {
  const values = settings.values();
  const number = (key: string): number => {
    const value = values[key];
    if (typeof value !== 'number') throw new Error(`${key} is not a number`);
    return value;
  };
  return {
    horizonMs: number('horizonMs'),
    reactWithinMs: number('reactWithinMs'),
    reactWithinTiles: number('reactWithinTiles'),
    sampleStepMs: number('stepMs'),
    headings: number('headings'),
    urgentWithinMs: number('urgentWithinMs'),
    hitScale: number('hitScale'),
    padTiles: number('latencyPadTiles'),
    driftTilesPerSecond: number('driftTilesPerSecond'),
    safeClearanceTiles: number('safeClearanceTiles'),
    keepAwayTiles: number('keepAwayTiles'),
  };
}

describe('who takes the hit instead', () => {
  const player = (objectId: number, x: number, y: number): EntityView =>
    ({ objectId, x, y }) as EntityView;

  it('picks the closest, and never us', () => {
    const players = [player(1, 10, 10), player(2, 12, 10), player(3, 11, 10)];
    expect(nearestOtherPlayer({ x: 10, y: 10 }, 1, players, 4)).toBe(3);
  });

  it('refuses anyone past the radius', () => {
    const players = [player(1, 10, 10), player(2, 16, 10)];
    expect(nearestOtherPlayer({ x: 10, y: 10 }, 1, players, 4)).toBeUndefined();
  });

  it('has no answer when we are the only one there', () => {
    expect(nearestOtherPlayer({ x: 10, y: 10 }, 1, [player(1, 10, 10)], 4)).toBeUndefined();
  });
});

// Driven through the real host, so the enable gate, the settings and the
// dispatch order run as they do in production.
describe('the hit redirect', () => {
  const registry = createBundledRegistry();

  const NATIVE: NativeApi = {
    connected: false,
    setFeature: () => undefined,
    onConnected: () => () => undefined,
  };
  const SESSIONS: SessionApi = {
    current: () => undefined,
    all: () => [],
    onConnected: () => () => undefined,
    onDisconnected: () => () => undefined,
  };

  /** A `PLAYERHIT` round-tripped, so the plugin sees what a live one carries. */
  function playerHit(bulletId: number, objectId: number): MutablePacket {
    const packet = createPacket(registry, 'PLAYERHIT');
    packet.fields = { bulletId, objectId };
    return new MutablePacket(decodeFrame(registry, encodePacket(registry, packet)));
  }

  function fakeSession(others: readonly EntityView[]): {
    session: SessionView;
    sendToServer: ReturnType<typeof vi.fn>;
  } {
    const sendToServer = vi.fn();
    const session = {
      id: 's1',
      self: { objectId: 1, x: 10, y: 10 },
      world: { gameTimeMs: 4321, players: () => [{ objectId: 1, x: 10, y: 10 }, ...others] },
      sendToServer,
    } as unknown as SessionView;
    return { session, sendToServer };
  }

  function loadEnabled(redirect: boolean): PluginHost {
    const host = new PluginHost({
      log: testLogger(),
      native: NATIVE,
      sessions: SESSIONS,
      onChanged: () => undefined,
    });
    host.load(
      createDodgePlugin({
        output: { moveTo: () => undefined, showShotPaths: () => undefined },
        cursorWalk: { target: () => undefined },
        steer: { direction: () => undefined },
        view: { wanted: () => false },
        weaponRange: () => undefined,
        isObstacle: () => false,
        isInvincible: () => false,
      }),
    );
    host.setEnabled('auto-dodge', true);
    if (redirect) host.settingsOf('auto-dodge')?.apply('redirectHits', true);
    return host;
  }

  const nearby: EntityView[] = [{ objectId: 7, x: 11, y: 10 } as EntityView];

  it('leaves the hit alone while it is off', () => {
    const host = loadEnabled(false);
    const { session, sendToServer } = fakeSession(nearby);
    const hit = playerHit(100, 5);

    host.dispatchPacket(hit, session);

    expect(hit.verdict).toBe('forward');
    expect(sendToServer).not.toHaveBeenCalled();
  });

  it('answers for the shot as OTHERHIT, and never lets the hit through', () => {
    const host = loadEnabled(true);
    const { session, sendToServer } = fakeSession(nearby);
    const hit = playerHit(100, 5);

    host.dispatchPacket(hit, session);

    expect(hit.verdict).toBe('drop');
    expect(sendToServer).toHaveBeenCalledWith('OTHERHIT', {
      time: 4321,
      bulletId: 100,
      objectId: 5,
      targetId: 7,
    });
  });

  it('stays put when there is nobody to blame', () => {
    const host = loadEnabled(true);
    const { session, sendToServer } = fakeSession([]);
    const hit = playerHit(100, 5);

    host.dispatchPacket(hit, session);

    expect(hit.verdict).toBe('forward');
    expect(sendToServer).not.toHaveBeenCalled();
  });

  it('does not answer for a hit something ahead of it already refused', () => {
    const host = loadEnabled(true);
    const { session, sendToServer } = fakeSession(nearby);
    const hit = playerHit(100, 5);
    hit.drop();

    host.dispatchPacket(hit, session);

    expect(sendToServer).not.toHaveBeenCalled();
  });

  it('sends a bullet id the encoder will actually take', () => {
    const host = loadEnabled(true);
    const { session, sendToServer } = fakeSession(nearby);

    host.dispatchPacket(playerHit(-2, 5), session);

    const fields = sendToServer.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(fields['bulletId']).toBe(0xfffe);

    const encoded = createPacket(registry, 'OTHERHIT');
    encoded.fields = fields as typeof encoded.fields;
    expect(() => encodePacket(registry, encoded)).not.toThrow();

    const raw = createPacket(registry, 'OTHERHIT');
    raw.fields = { ...fields, bulletId: -2 };
    expect(() => encodePacket(registry, raw)).toThrow();
  });
});
