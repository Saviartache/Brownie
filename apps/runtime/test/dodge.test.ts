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
  type BodySighting,
} from '../src/features/dodge/EnemyBodies.js';
import { Blasts, type BlastView } from '../src/features/dodge/Blasts.js';
import {
  DodgeMarkAnchor,
  DodgeMarkKind,
  dodgeMarks,
  MAX_DRAWN_MARKS,
  type DodgeMark,
} from '../src/features/dodge/DodgeMarks.js';
import { SecondLeg, type SecondLegOptions } from '../src/features/dodge/SecondLeg.js';
import { MAX_PATH_POINTS, shotPaths } from '../src/features/dodge/ShotPaths.js';
import { SteerTracker } from '../src/features/dodge/SteerIntent.js';
import { ThreatField, type DodgeShot, type Sweep } from '../src/features/dodge/ThreatField.js';
import { GroundCache, type GroundSource } from '../src/features/dodge/GroundCache.js';
import { WalkReach, type Ground } from '../src/features/dodge/WalkReach.js';
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

/** Every entity counts, none is going anywhere, and all are ordinary sized. */
const ANY_BODY = (enemy: EntityView): BodySighting => ({
  x: enemy.x,
  y: enemy.y,
  velocityX: 0,
  velocityY: 0,
  halfTiles: ENEMY_CONTACT_HALF_TILES,
});

/** The same, for a body walking at `tilesPerSecond` in a direction. */
function chasing(x: number, y: number): (enemy: EntityView) => BodySighting {
  return (enemy) => ({ ...ANY_BODY(enemy), velocityX: x / 1000, velocityY: y / 1000 });
}

/** The same, for a body of a stated width in tiles. */
function sized(tiles: number): (enemy: EntityView) => BodySighting {
  return (enemy) => ({ ...ANY_BODY(enemy), halfTiles: tiles / 2 });
}

/** Nothing in the way, nothing that hurts, nobody to bump into. */
const OPEN_GROUND: DodgeWorld = {
  canStand: () => true,
  isDamaging: () => false,
  crowdingAt: () => 0,
};

/** Open ground with monsters in it, judged against one keep-away distance. */
function standingOff(bodies: EnemyBodies, keepAwayTiles: number): DodgeWorld {
  return {
    canStand: () => true,
    isDamaging: () => false,
    crowdingAt: (x, y, aheadMs) => bodies.crowdingAt(x, y, keepAwayTiles, aheadMs),
  };
}

/** The plugin's own defaults, so a unit test and a live session agree. */
const SETTINGS: DodgeSettings = {
  horizonMs: 1000,
  reactWithinMs: 420,
  // Wide enough that the tests below are about the geometry they set up rather
  // than about the distance gate, which has its own coverage.
  engageWithinTiles: 100,
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

/**
 * How far one frame of a plan actually carries the character, in tiles.
 *
 * The module walks towards the offset at full speed and stops on arrival, so a
 * step shorter than a frame is walked in part — which is what makes "into the
 * gap and stand" come out as standing rather than as walking through it.
 */
function stepped(plan: DodgePlan, tilesPerSecond: number, frameMs = 20): number {
  if (!plan.steer) return 0;
  return Math.min(plan.stepTiles, (tilesPerSecond * frameMs) / 1000);
}

function situation(overrides: Partial<DodgeSituation> = {}): DodgeSituation {
  return {
    x: 10,
    y: 10,
    intentX: 0,
    intentY: 0,
    onDamagingGround: false,
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
    engageTiles: 100,
    // The whole horizon counts as now, for the same reason.
    reactWithinMs: 600,
  };

  function sweepStanding(field: ThreatField, at: Position): Sweep {
    const out = emptySweep();
    field.sweep(at.x, at.y, 0, 0, 0.006, 0.006, 0, 0, 600, Infinity, 0, out);
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
    field.sweep(0, 0, 1, 0, 0.006, 0.006, 0, 0, 600, Infinity, 0, free);
    // The same walk, with a wall a tenth of a tile away.
    field.sweep(0, 0, 1, 0, 0.006, 0.006, 0, 0, 600, 0.1, 0, boxed);

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
      engageTiles: 2,
      reactWithinMs: 200,
    });

    const swept = sweepStanding(field, { x: 0, y: 0 });
    expect(field.tracked).toBe(1);
    expect(swept.impactMs).toBeLessThan(Infinity);
    expect(swept.clearanceTiles).toBeLessThan(0);
    // Not this decision's problem: a moment to act on is one inside the window,
    // and this is well outside it. It is not `Infinity` — the escape deadline
    // answers every shot whether or not it is inside the ring, which is what
    // stops a fast one arriving unannounced — but the deadline is late, because
    // there is plenty of time to step out of one bullet.
    expect(swept.unsafeAtMs).toBeGreaterThan(200);
  });

  it('calls the same shot trouble once it is near', () => {
    const field = new ThreatField();
    field.build(0, 0, 0, [straightShot({ x: -1.5, y: 0 }, 0, 10, 0, 2000)], {
      ...OPTIONS,
      engageTiles: 2,
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
      engageTiles: 2,
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

  // **A course described in two calls, and the second one owes nothing to the
  // first's part of the horizon.** Without a start moment the second leg is
  // swept as though the player had stood at its beginning the whole time, which
  // in a pattern is a place a shot has just been through — every way through
  // reads as a hit it never takes.
  it('answers only for the part of the horizon a leg is walked in', () => {
    const field = new ThreatField();
    // Straight through where the player stands, and gone again by 200 ms.
    field.build(0, 0, 0, [straightShot({ x: -3, y: 0 }, 0, 30, 0, 2000)], OPTIONS);

    const whole = emptySweep();
    field.sweep(0, 0, 0, 0, 0, 0.006, 0, 0, 600, Infinity, 0, whole);
    expect(whole.impactMs).toBeLessThan(200);

    const after = emptySweep();
    field.sweep(0, 0, 0, 0, 0, 0.006, 300, 300, 600, Infinity, 0, after);
    expect(after.impactMs).toBe(Infinity);
  });
});

// **What a straight course cannot say, and the whole reason a pattern with
// offset gaps read as having no way through it.**
describe('the step off the end of a course', () => {
  const OPTIONS = {
    horizonMs: 600,
    sampleStepMs: 40,
    hitScale: 1,
    padTiles: 0,
    driftTilesPerSecond: 0,
    reachTiles: 4,
    engageTiles: 100,
    reactWithinMs: 600,
  };

  /** Eight ways out, which is what the search is offered. */
  const RING = {
    headingX: new Float64Array(8),
    headingY: new Float64Array(8),
    headings: 8,
  };
  for (let i = 0; i < 8; i += 1) {
    RING.headingX[i] = Math.cos((i / 8) * 2 * Math.PI);
    RING.headingY[i] = Math.sin((i / 8) * 2 * Math.PI);
  }

  const STEP: SecondLegOptions = {
    ...RING,
    horizonMs: OPTIONS.horizonMs,
    tilesPerMs: 0.006,
    stepTiles: 1.2,
    safeClearanceTiles: 0,
    avoidWalls: true,
    avoidDamagingGround: false,
  };

  const OPEN: Ground = { canStand: () => true, isDamaging: () => false };

  /** A field of shots converging on `(0, 0)` from `count` evenly spaced sides. */
  function closingIn(count: number, arrivesAtMs: number): DodgeShot[] {
    const shots: DodgeShot[] = [];
    const tilesPerSecond = 10;
    const from = (tilesPerSecond * arrivesAtMs) / 1000;
    for (let i = 0; i < count; i += 1) {
      const angle = (i / count) * 2 * Math.PI;
      shots.push(
        straightShot(
          { x: from * Math.cos(angle), y: from * Math.sin(angle) },
          angle + Math.PI,
          tilesPerSecond,
          0,
          2000,
        ),
      );
    }
    return shots;
  }

  it('is nothing at all when there is no horizon left to walk one in', () => {
    const field = new ThreatField();
    field.build(0, 0, 0, [], OPTIONS);

    expect(new SecondLeg().best(0, 0, 600, field, new Blasts(), OPEN, STEP)).toBe(600);
  });

  it('finds the way out that the shot closing on this spot leaves open', () => {
    const field = new ThreatField();
    // One shot, arriving at this spot at 300 ms: standing here is a hit and
    // seven of the eight ways off it are not.
    field.build(0, 0, 0, closingIn(1, 300), OPTIONS);

    expect(new SecondLeg().best(0, 0, 100, field, new Blasts(), OPEN, STEP)).toBe(Infinity);
  });

  it('says so when every way off is shut', () => {
    const field = new ThreatField();
    // Closing from all sides at once, from near enough that a step clears none
    // of them: this is what being caught looks like, and the planner has to be
    // able to tell it from a pattern with holes in it.
    field.build(0, 0, 0, closingIn(16, 200), OPTIONS);

    const stepped = new SecondLeg().best(0, 0, 100, field, new Blasts(), OPEN, STEP);
    expect(stepped).toBeLessThan(300);
  });

  // A turn the ground stops dead is standing still with a heading attached, and
  // the planner already has standing still.
  it('refuses a turn the ground will not give half a step of', () => {
    const field = new ThreatField();
    field.build(0, 0, 0, closingIn(1, 300), OPTIONS);
    const boxedIn: Ground = { canStand: (x, y) => Math.hypot(x, y) < 0.3, isDamaging: () => false };

    expect(new SecondLeg().best(0, 0, 100, field, new Blasts(), boxedIn, STEP)).toBe(100);
  });
});

// **How wide the thing coming at you is, which is what a reaction window on its
// own can never ask.** One bullet is a step out of the way; a wall is a run, and
// the run has to begin long before the first shot is close enough to count as
// this moment's problem.
describe('how far across the fire is out of it', () => {
  const OPTIONS = {
    horizonMs: 1000,
    sampleStepMs: 60,
    hitScale: 1,
    padTiles: 0,
    driftTilesPerSecond: 0,
    reachTiles: 6,
    engageTiles: 100,
    reactWithinMs: 1000,
  };

  /** A rank of shots sweeping north, `spread` tiles either side of `centre`. */
  function rank(spread: number, atY: number, centre = 0): DodgeShot[] {
    const shots: DodgeShot[] = [];
    for (let x = centre - spread; x <= centre + spread + 0.01; x += 0.8) {
      shots.push(straightShot({ x, y: atY }, Math.PI / 2, 8, 0, 4000));
    }
    return shots;
  }

  it('is about a body wide for one shot, and half the rank for a rank', () => {
    const one = new ThreatField();
    one.build(0, 0, 0, [straightShot({ x: 0, y: -6 }, Math.PI / 2, 8, 0, 4000)], OPTIONS);
    expect(one.escapeTiles).toBeGreaterThan(0);
    expect(one.escapeTiles).toBeLessThan(1.5);

    const wall = new ThreatField();
    wall.build(0, 0, 0, rank(6, -6), OPTIONS);
    expect(wall.escapeTiles).toBeGreaterThan(6);
  });

  // Standing at the edge of a pattern is already most of the way out of it, and
  // a width measured from its middle would say otherwise.
  it('is nothing at all when the fire is all to one side', () => {
    const field = new ThreatField();
    field.build(0, 0, 0, rank(3, -6, 6), OPTIONS);
    expect(field.escapeTiles).toBe(0);
  });

  // **The live report: "we should dodge the projectile, not the source."** A
  // rank crossing the far side of the room is going somewhere else, and every
  // shot in it agrees about the direction — so as a *pattern* it looked wide
  // and urgent, and the planner started running from something that was never
  // going to be near. What decides is how close a shot ever gets to where the
  // player could walk, which is a fact about the shot rather than about the
  // volley it belongs to.
  it('is nothing at all for a rank that never comes near', () => {
    const field = new ThreatField();
    // Twelve tiles off to one side, sweeping past on its own business, with a
    // long enough life that it is still in flight at the end of the horizon.
    field.build(0, 0, 0, rank(6, -6, 14), { ...OPTIONS, reachTiles: 6 });
    expect(field.escapeTiles).toBe(0);
  });

  // In a crossfire there is no across, so claiming a width for one would be
  // claiming to know the shape of something that has none.
  it('has no answer when the shots do not agree on a direction', () => {
    const field = new ThreatField();
    field.build(
      0,
      0,
      0,
      [
        straightShot({ x: 0, y: -6 }, Math.PI / 2, 8, 0, 4000),
        straightShot({ x: 0, y: 6 }, -Math.PI / 2, 8, 0, 4000),
        straightShot({ x: -6, y: 0 }, 0, 8, 0, 4000),
        straightShot({ x: 6, y: 0 }, Math.PI, 8, 0, 4000),
      ],
      OPTIONS,
    );
    expect(field.escapeTiles).toBe(0);
  });

  // **The whole point of measuring it.** Both of these land at the same moment;
  // one of them can still be stepped out of when it gets here and the other
  // cannot, and only the width says so.
  it('makes a wall this decision’s problem while one shot is not', () => {
    const walkTilesPerMs = 0.006;
    const swept = (shots: DodgeShot[]): Sweep => {
      const field = new ThreatField();
      // A window sized for sidestepping a bullet, as every preset's is.
      field.build(0, 0, 0, shots, { ...OPTIONS, reactWithinMs: 420 });
      const out = emptySweep();
      field.sweep(0, 0, 0, 0, 0, walkTilesPerMs, 60, 0, 1000, Infinity, 0.08, out);
      return out;
    };

    // Six tiles off and closing at eight tiles a second: three quarters of a
    // second before either of them arrives.
    const one = swept([straightShot({ x: 0, y: -6 }, Math.PI / 2, 8, 0, 4000)]);
    const wall = swept(rank(6, -6));

    expect(one.unsafeAtMs).toBeGreaterThan(420);
    expect(wall.unsafeAtMs).toBeLessThan(420);
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
    const queued: { dirX: number; dirY: number; tiles: number }[] = [];

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
        ? `${String(plan.dirX)},${String(plan.dirY)},${String(plan.stepTiles)}`
        : 'hold';
      if (course !== last) courses += 1;
      last = course;

      queued.push({
        dirX: plan.dirX,
        dirY: plan.dirY,
        tiles: stepped(plan, WALK_TILES_PER_SECOND),
      });
      const live = queued[queued.length - 4];
      if (live !== undefined) {
        x += live.dirX * live.tiles;
        y += live.dirY * live.tiles;
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
    const queued: { dirX: number; dirY: number; tiles: number }[] = [];
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
      queued.push({ dirX: plan.dirX, dirY: plan.dirY, tiles: stepped(plan, 6) });
      const live = queued[queued.length - 4];
      if (live !== undefined) {
        x += live.dirX * live.tiles;
        y += live.dirY * live.tiles;
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
    const caught = drivenPlans({ ...SETTINGS, engageWithinTiles: 2 }).filter(
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
    blasts.sweep(10, 10, 1, 0, 0.006, 0.006, 60, 0, 1000, Infinity, 0.08, out);
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
    blasts.sweep(10, 10, -1, 0, 0.006, 0.006, 60, 0, 1000, Infinity, 0.08, out);
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
    blasts.sweep(10, 10, Math.SQRT1_2, Math.SQRT1_2, 0.006, 0.006, 0, 0, 1000, 3.68, 0.08, out);
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
      engageTiles: SETTINGS.engageWithinTiles,
      reactWithinMs: SETTINGS.reactWithinMs,
    });
    const swept = emptySweep();
    field.sweep(
      10,
      10,
      plan.dirX,
      plan.dirY,
      plan.steer ? 0.006 : 0,
      0.006,
      SETTINGS.leadMs,
      0,
      SETTINGS.horizonMs,
      plan.stepTiles,
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

  // **And the other half of the same question, which no ring can answer.**
  // A bullet crossing the room at twenty-four tiles a second is on the player
  // in a third of a second, so by the time it is inside any ring worth calling
  // tight there is nothing left to do — and the planner used to leave them
  // standing exactly where it had predicted the shot would land. What answers it
  // is not a wider ring but the escape deadline, which asks how much time is
  // left rather than how far away anything is.
  it('acts on a fast shot while it is still on the other side of the room', () => {
    const controller = new DodgeController();
    // The plugin's own ring, not the wide one the tests above use — and the
    // shot is eight tiles outside it.
    const settings: DodgeSettings = { ...SETTINGS, engageWithinTiles: 2.5 };
    const plan = controller.plan(situation(), settings, OPEN_GROUND, [
      straightShot({ x: 10, y: 18 }, -Math.PI / 2, 24, 0, 4000),
    ]);

    expect(plan.steer).toBe(true);
    // And the course it picked is one the shot does not reach.
    expect(plan.impactMs).toBe(Infinity);
  });

  // **The complaint the ring exists for: "you start dodging them at the
  // spawn."** Shots in this game live a second or two, so acting on everything
  // that will eventually arrive is acting on everything on the screen — the
  // character shuffles from the moment a monster fires and is out of position by
  // the time anything is near.
  it('leaves an ordinary shot alone until it is actually close', () => {
    const controller = new DodgeController();
    const settings: DodgeSettings = { ...SETTINGS, engageWithinTiles: 2.5 };

    const far = controller.plan(situation(), settings, OPEN_GROUND, [closingFrom(6)]);
    expect(far.steer).toBe(false);
    expect(far.verdict).toBe('clear');

    // The same shot, a walk later. Nothing about it has changed but where it is.
    const near = new DodgeController().plan(situation(), settings, OPEN_GROUND, [closingFrom(2.2)]);
    expect(near.steer).toBe(true);
  });
});

// **A ring decides when to move, and it must not decide what is true.** The
// whole reason a tight one is safe is that everything on the screen is still
// predicted and still ranks the courses — so a dodge of the shot arriving does
// not walk into the wave behind it.
describe('what the engagement ring is allowed to change', () => {
  it('changes when to speak and nothing about the prediction', () => {
    const shots = [straightShot({ x: 10, y: 16 }, -Math.PI / 2, 8, 0, 4000)];
    const swept = (engageTiles: number): Sweep => {
      const field = new ThreatField();
      field.build(0, 10, 10, shots, {
        horizonMs: SETTINGS.horizonMs,
        sampleStepMs: SETTINGS.sampleStepMs,
        hitScale: SETTINGS.hitScale,
        padTiles: SETTINGS.padTiles,
        driftTilesPerSecond: SETTINGS.driftTilesPerSecond,
        reachTiles: 8,
        engageTiles,
        reactWithinMs: SETTINGS.reactWithinMs,
      });
      const out = emptySweep();
      field.sweep(
        10,
        10,
        0,
        0,
        0,
        0.006,
        SETTINGS.leadMs,
        0,
        SETTINGS.horizonMs,
        Infinity,
        0.08,
        out,
      );
      return out;
    };

    const tight = swept(1);
    const wide = swept(12);

    expect(tight.impactMs).toBe(wide.impactMs);
    expect(tight.clearanceTiles).toBe(wide.clearanceTiles);
    expect(tight.urgentClearanceTiles).toBe(wide.urgentClearanceTiles);
    // Only the moment it becomes worth saying something differs — and the tight
    // ring's answer is the escape deadline rather than nothing at all.
    expect(wide.unsafeAtMs).toBeLessThan(tight.unsafeAtMs);
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
    const speed = plan.steer ? 6 : 0;
    // The walk starts `leadMs` from now and not before, and stops once the
    // plan's step is walked — the same model the sweep uses, see
    // `ThreatField.sweep`. Standing still until then is the whole of the
    // correction, and a check that assumed the old head start would be
    // measuring a place the planner never claimed.
    const walked = (t: number): number =>
      Math.min(plan.stepTiles, (speed * Math.max(0, t - EXACT.leadMs)) / 1000);
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
    // both are the window, and the planner is free to pick either. Compared
    // loosely because a heading on the ring is a sine: due west comes out as
    // `sin(π)`, which is not exactly nought.
    expect(plan.dirY).toBeLessThan(0.05);
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

  // **The complaint this answers: "you stand still in front of huge attacks."**
  // A reaction window is an allowance for stepping out of the way of a bullet.
  // Spent on something twelve tiles across it buys nothing at all, so the
  // planner said nothing for the whole of the warning and then discovered, at
  // the moment the window opened, that there was nowhere left to go. What tells
  // the two apart is the width — see `ThreatField.escapeTiles`.
  it('starts running from a wide rank while it is still a second away', () => {
    const controller = new DodgeController();
    // Twelve tiles across, eight tiles below, sweeping north at eight tiles a
    // second: nearly nine hundred milliseconds before it arrives.
    const plan = controller.plan(situation(), EXACT, OPEN_GROUND, wall(99, 2));

    expect(plan.steer).toBe(true);
    // Not into it, and not a shuffle either: the course it picks is one nothing
    // touches for as long as the plan looks, which is what the extra second of
    // warning buys and what a sidestep at the last moment could not.
    expect(plan.dirY).toBeGreaterThan(0);
    expect(plan.impactMs).toBe(Infinity);
    // Across it as well as ahead of it. Staying ahead of a rank faster than the
    // character only postpones; the way out is its edge, six tiles away.
    expect(Math.abs(plan.dirX)).toBeGreaterThan(0.3);
  });

  // And the other half of it: one shot at the same distance, at the same
  // moment, is a step out of the way when it gets here — so it is nobody's
  // problem yet and the player keeps the wheel.
  it('leaves one shot at the same distance alone', () => {
    const controller = new DodgeController();
    const one = straightShot({ x: 10, y: 2 }, Math.PI / 2, 8, 0, 4000, 0.25);

    const plan = controller.plan(situation(), EXACT, OPEN_GROUND, [one]);

    expect(plan.steer).toBe(false);
    expect(plan.verdict).toBe('clear');
  });

  // **A course that cannot be walked is not a course.** Pressing into a wall,
  // the heading they are pressing is worth no distance at all — and ranked on
  // their intent alone it beat every open one, reported a step of nothing, and
  // handed the wheel back with the shots arriving. The answer has to come from a
  // course that actually moves.
  it('does not answer with a course the wall gives no distance to', () => {
    const controller = new DodgeController();
    const walled: DodgeWorld = {
      // Solid a hair east of the player, so every heading with an easterly
      // component is worth nothing at all.
      canStand: (x) => x <= 10.05,
      isDamaging: () => false,
      crowdingAt: () => 0,
    };

    const plan = controller.plan(
      situation({ intentX: 1, intentY: 0 }),
      EXACT,
      walled,
      wall(99, 9.9),
    );

    expect(plan.steer).toBe(true);
    // Compared loosely because a heading on the ring is a cosine: due north
    // comes out as `cos(π / 2)`, which is not exactly nought.
    expect(plan.dirX).toBeLessThan(0.05);
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

// **The complaint in the player's own words: "in a checkerboard I can walk
// through it by hand — why do we run from it?"** Ranks with the gaps offset have
// no straight line through them at all: whatever heading is taken, the hole in
// one rank has a shot of the next behind it. A planner whose whole vocabulary is
// straight courses therefore reads a pattern it could be walked through as
// having no way through, calls the moment hopeless, and backpedals in front of
// it until it is overtaken — which is what running away actually costs.
describe('fire with the gaps offset', () => {
  /**
   * How far apart two shots in the same rank are, in tiles.
   *
   * **Under four half-extents, which is what makes it a checkerboard rather than
   * a grid with a lane down it.** Wider than that and the safe strip between two
   * shots of one rank overlaps the safe strip of the next, so there is a spot
   * that is safe for both and standing in it is the whole answer. Narrower, and
   * there is no such spot at all: every place that survives this rank is under a
   * shot of the following one.
   */
  const COLUMN_TILES = 2;
  /**
   * And how far apart two ranks are.
   *
   * **Chosen so that a person could actually walk it**, which is the premise of
   * the whole complaint. A rank is over the player for two half-extents' worth
   * of its travel; what is left of the interval is the time there is to cross a
   * column and stand in the next gap. At these numbers that is two tenths of a
   * second against the sixth of a second the shortest step takes — and three
   * ranks inside the planning horizon, so no one step answers the pattern.
   */
  const RANK_TILES = 3;
  const SHOT_TILES_PER_SECOND = 9;
  const SHOT_HALF = 0.25;

  /**
   * Ranks sweeping north, every other one shifted half a column across.
   *
   * The first is far enough off to be answerable and there are five more behind
   * it, so this is seconds of sustained pattern rather than one volley — which
   * is the difference between a sidestep and having to keep finding the next
   * gap. The player starts on a column of the first rank, so standing where they
   * are is not among the answers either. Nothing outruns it: the ranks are
   * faster than the character.
   */
  function checkerboard(): ReturnType<typeof straightShot>[] {
    const shots: ReturnType<typeof straightShot>[] = [];
    for (let rank = 0; rank < 6; rank += 1) {
      const y = 7 - RANK_TILES * rank;
      const shift = rank % 2 === 0 ? 0 : COLUMN_TILES / 2;
      for (let x = 2 + shift; x <= 18.01; x += COLUMN_TILES) {
        shots.push(straightShot({ x, y }, Math.PI / 2, SHOT_TILES_PER_SECOND, 0, 6000, SHOT_HALF));
      }
    }
    return shots;
  }

  /** What the planner is given here: margins on, nothing the model cannot describe. */
  const WEAVE: DodgeSettings = { ...SETTINGS, driftTilesPerSecond: 0 };

  /**
   * A second of it, planned and walked exactly as the module would walk it.
   *
   * Four ticks of command latency, one frame of walking per tick, and the hit
   * test done against the real geometry rather than against the planner's own
   * report of itself — the only check that would catch a planner confident about
   * a way through that is not there.
   */
  function walkedThrough(shots: readonly ReturnType<typeof straightShot>[]) {
    const controller = new DodgeController();
    const queued: { dirX: number; dirY: number; tiles: number }[] = [];
    const half = effectiveHalf(SHOT_HALF, WEAVE.hitScale, 0);
    let x = 10;
    let y = 10;
    let hits = 0;
    let ground = 0;

    for (let step = 0; step < 90; step += 1) {
      const gameTimeMs = step * 20;
      const plan = controller.plan(
        situation({ x, y, gameTimeMs, nowMs: 1_000_000 + gameTimeMs }),
        WEAVE,
        OPEN_GROUND,
        shots,
      );
      queued.push({ dirX: plan.dirX, dirY: plan.dirY, tiles: stepped(plan, 6) });
      const live = queued[queued.length - 4];
      if (live !== undefined) {
        x += live.dirX * live.tiles;
        y += live.dirY * live.tiles;
      }
      // Giving ground is walking the way the ranks are going, which is +y.
      if (y - 10 > ground) ground = y - 10;
      for (const shot of shots) {
        const at = shot.positionAt(gameTimeMs);
        if (at !== undefined && overlaps(at.x, at.y, x, y, half)) hits += 1;
      }
    }
    return { hits, ground };
  }

  // **The premise, stated as a test rather than as a comment, and it is the
  // whole trap.** Standing still is hit and so is every step, in every
  // direction, at every length the planner would call a step rather than a run.
  // A planner whose answers are straight courses therefore has nothing to offer
  // here but a run — which is the reading that is wrong, and the reason the test
  // below cannot be passed by finding a better heading.
  it('leaves no step that answers it, in any direction', () => {
    const field = new ThreatField();
    field.build(0, 10, 10, checkerboard(), {
      horizonMs: WEAVE.horizonMs,
      sampleStepMs: WEAVE.sampleStepMs,
      hitScale: WEAVE.hitScale,
      padTiles: WEAVE.padTiles,
      driftTilesPerSecond: 0,
      reachTiles: 6.36,
      engageTiles: WEAVE.engageWithinTiles,
      reactWithinMs: WEAVE.reactWithinMs,
    });

    const swept = emptySweep();
    /** How long a straight course at this heading and length lasts. */
    const lasts = (dirX: number, dirY: number, tiles: number): number => {
      field.sweep(
        10,
        10,
        dirX,
        dirY,
        tiles > 0 ? 0.006 : 0,
        0.006,
        WEAVE.leadMs,
        0,
        WEAVE.horizonMs,
        tiles,
        WEAVE.safeClearanceTiles,
        swept,
      );
      return swept.impactMs;
    };

    // The two step lengths the planner offers below a full horizon's walk, which
    // at this character's speed are a sidestep and twice one.
    let answered = lasts(0, 0, 0) === Infinity ? 1 : 0;
    for (let i = 0; i < 64; i += 1) {
      const angle = (i / 64) * 2 * Math.PI;
      for (const tiles of [2.54, 1.27]) {
        if (lasts(Math.cos(angle), Math.sin(angle), tiles) === Infinity) answered += 1;
      }
    }

    expect(answered).toBe(0);
  });

  it('walks through it instead of giving ground', () => {
    const walked = walkedThrough(checkerboard());

    // Not once touched, which is the floor rather than the point: backing away
    // survives this too, for a while.
    expect(walked.hits).toBe(0);
    // And it did it from about where it started: less ground given up over the
    // whole pattern than there is between two of its ranks. Running the same
    // second and a half is ten tiles, and it does not even work — the ranks are
    // faster than the character and take back whatever is given.
    expect(walked.ground).toBeLessThan(RANK_TILES);
  });
});

// **A tile is not a point, and neither is a player.** The ground was probed by
// asking about the single point at the middle of the character, so a course
// that put most of the body over lava and the centre a hair outside it read as
// clear — and then the next thing that moved the character put them in it.
describe('the ground, one tile at a time', () => {
  /** A cache pointed at `source`, with the player standing at (5.5, 5.5). */
  function aimedAt(source: GroundSource): GroundCache {
    const cache = new GroundCache();
    cache.aim(source, 5.5, 5.5, 0);
    return cache;
  }

  /** One damaging tile at (5, 5), open floor everywhere else. */
  function pool(): GroundCache {
    return aimedAt({
      canStandAt: () => true,
      tileAt: (x, y) => ({
        type: 0,
        blocking: false,
        damaging: Math.floor(x) === 5 && Math.floor(y) === 5,
      }),
    });
  }

  it('refuses a place whose body overlaps it, margin or no margin', () => {
    // Centre in tile 4, body reaching into tile 5.
    expect(pool().isDamaging(4.9, 5.5, 0)).toBe(true);
    // And the same centre with the whole body clear of it.
    expect(pool().isDamaging(4.5, 5.5, 0)).toBe(false);
  });

  it('refuses a place the margin reaches into', () => {
    expect(pool().isDamaging(4.5, 5.5, 0)).toBe(false);
    expect(pool().isDamaging(4.5, 5.5, 0.5)).toBe(true);
  });

  it('sweeps the whole box rather than its corners', () => {
    // A margin wide enough that the box spans three tiles across, with the
    // damaging one in the middle column where no corner lands.
    expect(pool().isDamaging(5.5, 3.7, 1.5)).toBe(true);
  });

  // The server sends tiles around the player and no further. A body may not be
  // planned into ground nobody has described; calling it a fire as well would
  // have the planner flee the edge of its own knowledge.
  it('refuses ground it has never been told about, and does not call it damaging', () => {
    const unknown = aimedAt({ canStandAt: () => false, tileAt: () => undefined });
    expect(unknown.canStand(5.5, 5.5, 0)).toBe(false);
    expect(unknown.isDamaging(5.5, 5.5, 1)).toBe(false);
  });

  it('keeps a body off a wall by the margin it is given', () => {
    const beside = aimedAt({
      canStandAt: (x) => Math.floor(x) !== 11,
      tileAt: () => undefined,
    });

    // Body clear of tile 11, margin reaching into it.
    expect(beside.canStand(10.6, 5.5, 0)).toBe(true);
    expect(beside.canStand(10.6, 5.5, 0.25)).toBe(false);
  });

  it('never shrinks the body below its own size', () => {
    const inside = aimedAt({
      canStandAt: (x) => Math.floor(x) !== 11,
      tileAt: () => undefined,
    });

    // A negative margin unclamped would pull the body clear of the wall it is
    // already overlapping.
    expect(inside.canStand(10.9, 5.5, -1)).toBe(false);
  });

  it('asks the map about a tile once, and about the body every time', () => {
    const canStandAt = vi.fn(() => true);
    const cache = aimedAt({ canStandAt, tileAt: () => undefined });

    cache.canStand(5.5, 5.5, 0);
    cache.canStand(5.5, 5.5, 0);
    expect(canStandAt).toHaveBeenCalledTimes(1);

    // A step inside the same tile is a fresh box, over three tiles this has not
    // been asked about yet.
    cache.canStand(5.9, 5.9, 0);
    expect(canStandAt).toHaveBeenCalledTimes(4);
  });

  it('asks again once the player has stepped into the next tile', () => {
    const canStandAt = vi.fn(() => true);
    const source: GroundSource = { canStandAt, tileAt: () => undefined };
    const cache = new GroundCache();

    cache.aim(source, 5.5, 5.5, 0);
    cache.canStand(5.5, 5.5, 0);
    cache.aim(source, 6.5, 5.5, 0);
    cache.canStand(5.5, 5.5, 0);

    expect(canStandAt).toHaveBeenCalledTimes(2);
  });
});

describe('how far each course can be walked', () => {
  /** Open floor, with everything from x = 12 eastwards solid. */
  const wallEastOf12: Ground = {
    canStand: (x) => x < 12,
    isDamaging: () => false,
  };
  const east = new Float64Array([1]);
  const level = new Float64Array([0]);

  // A reach is a distance from the player, so it stops being true the moment
  // they move. Kept until their *tile* changed, it was measured from wherever
  // they entered that tile and reused while they crossed it — which is a wall
  // reported most of a tile further off than it is.
  it('measures from where the player is, not from where they entered the tile', () => {
    const reach = new WalkReach();

    reach.measure(10, 10, east, level, 1, 6, wallEastOf12);
    expect(reach.wallTilesFor(0)).toBeCloseTo(1.8, 5);

    reach.measure(10.9, 10, east, level, 1, 6, wallEastOf12);
    expect(reach.wallTilesFor(0)).toBeCloseTo(1, 5);
  });
});

describe('where it refuses to go', () => {
  /** Lava everywhere east of a line, and open ground behind it. */
  const lavaEastOf = (edge: number): DodgeWorld => ({
    canStand: () => true,
    isDamaging: (x) => x > edge,
    crowdingAt: () => 0,
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

  // The probe used to be kept until the player's *tile* changed, so a course
  // that was a walk from the pool when they entered the tile was still a walk
  // from it once they had crossed to the far edge. That is the dodge stepping
  // into lava it had already been told about.
  it('sees the pool it has walked up to inside one tile', () => {
    const controller = new DodgeController();
    const lava = lavaEastOf(11.4);

    // Entering the tile, with the pool still a walk away: nothing to say.
    expect(controller.plan(situation({ intentX: 1 }), SETTINGS, lava, []).steer).toBe(false);

    // Most of a tile later, and half a step from the edge of it.
    const plan = controller.plan(situation({ x: 10.9, intentX: 1 }), SETTINGS, lava, []);
    expect(plan.steer).toBe(true);
    expect(plan.dirX).toBeLessThan(1);
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
    // Standing in it, with the clean edge to the west. Said by the caller
    // rather than read off the ground: what the game charges for is the tile
    // under the character, and what a course is refused for is the body and a
    // margin around it — two questions with two answers.
    const plan = controller.plan(
      situation({ onDamagingGround: true }),
      SETTINGS,
      lavaEastOf(9.5),
      [],
    );

    expect(plan.verdict).toBe('escape');
    expect(plan.steer).toBe(true);
    expect(plan.dirX).toBeLessThan(0);
  });

  // **The margin, and why standing beside a pool is not standing in one.** A
  // player fighting at the edge of the lava has chosen to be there; the planner
  // keeps *courses* well clear of it and never announces an escape from ground
  // that is not costing them anything.
  it('does not call the edge of a pool an escape', () => {
    const controller = new DodgeController();
    const plan = controller.plan(situation(), SETTINGS, lavaEastOf(10.1), []);

    expect(plan.verdict).toBe('clear');
    expect(plan.steer).toBe(false);
  });

  it('does not walk through a wall to dodge', () => {
    const controller = new DodgeController();
    const walled: DodgeWorld = {
      // Everything north of the player is solid.
      canStand: (_x, y) => y <= 10.2,
      isDamaging: () => false,
      crowdingAt: () => 0,
    };
    const shot = straightShot({ x: 0, y: 10 }, 0, 8, 0, 2000);

    const plan = controller.plan(situation({ gameTimeMs: 900 }), SETTINGS, walled, [shot]);

    expect(plan.steer).toBe(true);
    // A course into the wall stops at it and earns no distance from the shot,
    // so the answer has to come from the open side.
    expect(plan.dirY).toBeLessThanOrEqual(0);
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

describe('the room a place leaves to dodge in', () => {
  const KEEP_AWAY = 2;

  it('has no opinion when there is nobody to have one about', () => {
    expect(new EnemyBodies().crowdingAt(0, 0, KEEP_AWAY)).toBe(0);
  });

  it('is content anywhere with room to spare', () => {
    const bodies = new EnemyBodies();
    bodies.collect([{ x: 5, y: 0 } as EntityView], 0, 0, 10, ANY_BODY);
    expect(bodies.crowdingAt(0, 0, KEEP_AWAY)).toBe(0);
  });

  it('says how far inside the distance a place is', () => {
    const bodies = new EnemyBodies();
    bodies.collect([{ x: 1.5, y: 0 } as EntityView], 0, 0, 10, ANY_BODY);
    expect(bodies.crowdingAt(0, 0, KEEP_AWAY)).toBeCloseTo(0.5, 6);
  });

  // The bodies touching is a floor under whatever the setting says, so nought
  // still means "not standing inside it".
  it('keeps the contact distance even when the setting is nought', () => {
    const bodies = new EnemyBodies();
    bodies.collect([{ x: 0.4, y: 0 } as EntityView], 0, 0, 10, ANY_BODY);
    expect(bodies.crowdingAt(0, 0, 0)).toBeCloseTo(
      ENEMY_CONTACT_HALF_TILES + PLAYER_HALF_TILES - 0.4,
      6,
    );
  });

  // Being crowded by the second-nearest of two is being crowded.
  it('takes the worst offender, whoever that is', () => {
    const bodies = new EnemyBodies();
    bodies.collect(
      [{ x: 9, y: 0 } as EntityView, { x: 1, y: 0 } as EntityView],
      0,
      0,
      12,
      ANY_BODY,
    );
    expect(bodies.crowdingAt(0, 0, KEEP_AWAY)).toBeCloseTo(1, 6);
  });

  it('forgets everybody too far to matter', () => {
    const bodies = new EnemyBodies();
    bodies.collect([{ x: 30, y: 0 } as EntityView], 0, 0, 5, ANY_BODY);
    expect(bodies.count).toBe(0);
  });

  // **Better than a quarter of what the catalog marks as an enemy is scenery.**
  // A wall in this game is an object with hit points and the enemy flag, and
  // spawners, emitters and room controllers all answer to it — so a three-tile
  // no-go circle went round every decoration in the room.
  it('does not let the scenery answer for the monsters', () => {
    const bodies = new EnemyBodies();
    const pillar = { objectId: 1, objectType: 10, x: 0.5, y: 0 } as EntityView;
    const monster = { objectId: 2, objectType: 20, x: 5, y: 0 } as EntityView;

    bodies.collect([pillar, monster], 0, 0, 12, (enemy) =>
      enemy.objectType === 10 ? undefined : ANY_BODY(enemy),
    );

    expect(bodies.count).toBe(1);
    // Content: the monster five tiles off leaves room, and the pillar half a
    // tile away is not a monster.
    expect(bodies.crowdingAt(0, 0, KEEP_AWAY)).toBe(0);
  });

  // **The distance means nothing against something that follows.** Every course
  // that walks away scores as making room while the monsters are frozen where
  // they were last seen, which is how a melee minion matching the player's
  // speed was answered with "you are already dealing with it".
  it('asks where a body will be, not only where it was', () => {
    const bodies = new EnemyBodies();
    bodies.collect([{ x: 5, y: 0 } as EntityView], 0, 0, 12, chasing(-6, 0));

    expect(bodies.crowdingAt(0, 0, KEEP_AWAY)).toBe(0);
    expect(bodies.crowdingAt(0, 0, KEEP_AWAY, 600)).toBeCloseTo(0.6, 6);
  });

  // **The live report: "they walk right up to me and I die."** The setting that
  // keeps an ordinary monster at arm's length was measured from its middle, so
  // against a boss four tiles across it left the player standing inside the
  // body. The gap the setting asks for is what has to hold, whatever is
  // standing there.
  it('keeps the same gap from a big body as from a small one', () => {
    const gap = KEEP_AWAY - ENEMY_CONTACT_HALF_TILES;

    const ordinary = new EnemyBodies();
    ordinary.collect([{ x: KEEP_AWAY, y: 0 } as EntityView], 0, 0, 12, ANY_BODY);
    expect(ordinary.crowdingAt(0, 0, KEEP_AWAY)).toBe(0);

    // Four tiles across, so its edge sits where the ordinary one's did only if
    // the distance moved out with it.
    const boss = new EnemyBodies();
    boss.collect([{ x: 2 + gap, y: 0 } as EntityView], 0, 0, 12, sized(4));
    expect(boss.crowdingAt(0, 0, KEEP_AWAY)).toBe(0);
    // And half a tile nearer is half a tile inside it.
    expect(boss.crowdingAt(0.5, 0, KEEP_AWAY)).toBeCloseTo(0.5, 6);
  });

  // A velocity carried a whole second is a claim about a decision the monster
  // has not made yet.
  it('stops believing a velocity long before the horizon does', () => {
    const bodies = new EnemyBodies();
    bodies.collect([{ x: 5, y: 0 } as EntityView], 0, 0, 12, chasing(-6, 0));

    expect(bodies.crowdingAt(0, 0, KEEP_AWAY, 5000)).toBe(
      bodies.crowdingAt(0, 0, KEEP_AWAY, MAX_BODY_LOOKAHEAD_MS),
    );
  });
});

describe('room to dodge in', () => {
  const KEEP_AWAY = 2.5;

  // **The live report: "they just walk up and kill me."** By the time contact
  // damage says a monster is on top of you, the room every sidestep is made in
  // has already been taken.
  it('makes room when something walks onto the player', () => {
    const controller = new DodgeController();
    const bodies = new EnemyBodies();
    // A body a tile north, with nothing in the air at all.
    bodies.collect([{ x: 10, y: 11 } as EntityView], 10, 10, 12, ANY_BODY);

    const plan = controller.plan(situation(), SETTINGS, standingOff(bodies, KEEP_AWAY), []);

    expect(plan.verdict).toBe('spacing');
    expect(plan.steer).toBe(true);
    expect(plan.crowded).toBe(true);
    // Any course that leaves the bubble is as good as any other — it is a
    // distance, not a gradient — so what is asserted is that it does not walk
    // further in.
    expect(plan.dirY).toBeLessThanOrEqual(0);
    // And a step out of it, not a sprint across the room.
    expect(plan.stepTiles).toBeLessThan(3);
  });

  it('stands still once the room is made', () => {
    const controller = new DodgeController();
    const bodies = new EnemyBodies();
    bodies.collect([{ x: 10, y: 14 } as EntityView], 10, 10, 12, ANY_BODY);

    const plan = controller.plan(situation(), SETTINGS, standingOff(bodies, KEEP_AWAY), []);

    expect(plan.verdict).toBe('clear');
    expect(plan.steer).toBe(false);
  });

  // The player asked to be there. A knight walking into a boss is not a mistake
  // to correct, and a dodge that argues about it is one they will switch off.
  it('does not push back against a player walking in', () => {
    const controller = new DodgeController();
    const bodies = new EnemyBodies();
    bodies.collect([{ x: 10, y: 11 } as EntityView], 10, 10, 12, ANY_BODY);

    const plan = controller.plan(
      situation({ intentX: 0, intentY: 1 }),
      SETTINGS,
      standingOff(bodies, KEEP_AWAY),
      [],
    );

    expect(plan.steer).toBe(false);
    expect(plan.verdict).toBe('intent-safe');
  });

  // **What replaced the key test.** Crowding used to stand down the moment a
  // key went down, so a melee minion closing on a player who was walking
  // anywhere at all went unanswered — and walking is what a player under fire
  // spends their time doing. What decides it now is whether their own walking
  // is opening a gap, which against something matching their speed it is not.
  it('answers a monster keeping pace with a player who is already walking', () => {
    const controller = new DodgeController();
    const bodies = new EnemyBodies();
    // A tile behind, following east at the character's own six tiles a second
    // while the player walks east.
    bodies.collect([{ x: 8.5, y: 10 } as EntityView], 10, 10, 12, chasing(6, 0));

    const plan = controller.plan(
      situation({ intentX: 1, intentY: 0 }),
      SETTINGS,
      standingOff(bodies, KEEP_AWAY),
      [],
    );

    expect(plan.verdict).toBe('spacing');
    expect(plan.steer).toBe(true);
    // Off its line, because running from something as fast as you are is not an
    // escape. Still broadly the way they were going.
    expect(plan.dirY).not.toBe(0);
    expect(plan.dirX).toBeGreaterThan(0);
  });

  // And the other side of it: something standing still is something the player
  // walked up to, which is a decision and not a mistake.
  it('leaves the same player alone when the monster is not following', () => {
    const controller = new DodgeController();
    const bodies = new EnemyBodies();
    bodies.collect([{ x: 8.5, y: 10 } as EntityView], 10, 10, 12, ANY_BODY);

    const plan = controller.plan(
      situation({ intentX: 1, intentY: 0 }),
      SETTINGS,
      standingOff(bodies, KEEP_AWAY),
      [],
    );

    expect(plan.steer).toBe(false);
  });

  // **A preference and never a veto.** The only lane out of a volley sometimes
  // runs past a monster, and a planner that refuses it stands in the volley.
  it('takes a lane past a monster rather than a shot in the face', () => {
    const controller = new DodgeController();
    const bodies = new EnemyBodies();
    // Standing in the one direction that is clear of the shot.
    bodies.collect([{ x: 10, y: 11.5 } as EntityView], 10, 10, 12, ANY_BODY);
    const shot = straightShot({ x: 0, y: 10 }, 0, 8, 0, 2000);

    const plan = controller.plan(
      situation({ gameTimeMs: 900 }),
      SETTINGS,
      standingOff(bodies, KEEP_AWAY),
      [shot],
    );

    expect(plan.steer).toBe(true);
    expect(plan.impactMs).toBe(Infinity);
  });

  // **The other half of the same live report, and the case where being crowded
  // costs most.** The distance is stated against an ordinary monster, so a body
  // four times the width has to be kept four times as far off its middle to
  // leave the same room — and it is the big ones that kill you for standing in
  // them.
  it('makes more room for a bigger body', () => {
    const at = (read: (enemy: EntityView) => BodySighting): DodgePlan => {
      const controller = new DodgeController();
      const bodies = new EnemyBodies();
      // Two and a half tiles north, which is exactly the stated distance.
      bodies.collect([{ x: 10, y: 12.5 } as EntityView], 10, 10, 12, read);
      return controller.plan(situation(), SETTINGS, standingOff(bodies, KEEP_AWAY), []);
    };

    // An ordinary monster there is where it should be, and nothing is said.
    expect(at(ANY_BODY).steer).toBe(false);
    // Something four tiles across at the same place is on top of the player.
    const boss = at(sized(4));
    expect(boss.verdict).toBe('spacing');
    expect(boss.crowded).toBe(true);
    expect(boss.dirY).toBeLessThanOrEqual(0);
  });
});

// **The complaint the whole ordering exists to answer**: "why do we run away
// from shots there is room to walk between?" Every measurement a planner has of
// a course that survives — its room, how long it lives, how wide its lane is —
// is maximised by being somewhere else entirely, so a planner that ranks on any
// of them answers a gap by backing away from it.
describe('how far it moves to get out of the way', () => {
  it('steps out of a shot rather than running from it', () => {
    const controller = new DodgeController();
    // Straight at the player from the west, near enough to be answered.
    const shot = straightShot({ x: 0, y: 10 }, 0, 8, 0, 2000);

    const plan = controller.plan(situation({ gameTimeMs: 900 }), SETTINGS, OPEN_GROUND, [shot]);

    expect(plan.steer).toBe(true);
    // A second of walking is six tiles; getting out of one bullet's way is one.
    expect(plan.stepTiles).toBeLessThan(2);
    // And across its line rather than along it, either way.
    expect(Math.abs(plan.dirY)).toBeGreaterThan(0.5);
  });

  // The other half of it: a step is preferred because it is enough, not because
  // short is always right. Nothing is allowed to shorten a course that has to
  // cross a pattern to survive.
  it('still runs when a step would not do', () => {
    const controller = new DodgeController();
    const shots: DodgeShot[] = [];
    // Twelve tiles of solid rank sweeping north, four tiles below: too wide to
    // cross and too near to stand a step out of.
    for (let x = 4; x <= 16.01; x += 0.9) {
      shots.push(straightShot({ x, y: 6 }, Math.PI / 2, 8, 0, 4000, 0.25));
    }

    const plan = controller.plan(situation(), SETTINGS, OPEN_GROUND, shots);

    expect(plan.steer).toBe(true);
    expect(plan.stepTiles).toBeGreaterThan(2);
  });

  // **The screenshot this was reported from**: a wall of fire with a window in
  // it, and the planner backing away from the window instead of stepping into
  // it. Running with the shots survives the horizon here — they are faster than
  // the character but not by much — so every measurement of safety preferred it,
  // and only a rule about *where* an answer leaves you says otherwise.
  it('steps into the window rather than running from the pattern', () => {
    const controller = new DodgeController();
    const shots: DodgeShot[] = [];
    // Sweeping south at the player from six tiles up, and wide enough that
    // there is no getting round the end of it. Two columns missing to the east,
    // which is the only way through.
    for (let x = 2; x <= 18.01; x += 0.9) {
      if (Math.abs(x - 11) < 0.01 || Math.abs(x - 11.9) < 0.01) continue;
      shots.push(straightShot({ x, y: 16 }, -Math.PI / 2, 8, 0, 4000, 0.25));
    }
    // Nothing the model cannot describe, so the window below is exactly where
    // the arithmetic says it is.
    const exact: DodgeSettings = { ...SETTINGS, padTiles: 0, driftTilesPerSecond: 0 };

    const plan = controller.plan(situation(), exact, OPEN_GROUND, shots);

    expect(plan.steer).toBe(true);
    // Across the fire, not away from it, and not a shuffle in front of it.
    expect(Math.abs(plan.dirX)).toBeGreaterThan(0.7);
    // Standing in the window when the rank arrives, rather than outrunning it.
    const landsAt = 10 + plan.dirX * plan.stepTiles;
    expect(landsAt).toBeGreaterThan(10.564);
    expect(landsAt).toBeLessThan(12.336);
    expect(plan.impactMs).toBe(Infinity);
  });

  // **Crossing the fire and closing on it are not the same thing, and running
  // with it is worse than either.** The axis a pattern sweeps along is the axis
  // it has no gaps along, so the way between two shots is square to it — which
  // is the quantity the reference implementation weighs heaviest of everything
  // it scores. See `ZDodgePlanner`'s `perpScore`.
  it('crosses a wave rather than running in front of it', () => {
    const controller = new DodgeController();
    const shots: DodgeShot[] = [];
    // A short rank sweeping north, straight at the player and no wider than a
    // sidestep — so running in front of it survives the window too.
    for (let x = 9.1; x <= 10.91; x += 0.9) {
      shots.push(straightShot({ x, y: 7 }, Math.PI / 2, 8, 0, 4000, 0.25));
    }

    const plan = controller.plan(situation(), SETTINGS, OPEN_GROUND, shots);

    expect(plan.steer).toBe(true);
    // Out to one side, not up the lane it is sweeping.
    expect(Math.abs(plan.dirX)).toBeGreaterThan(0.7);
  });
});

// **Every complaint this feature has had was about a distance**, and every one
// of those distances is a number in a panel nobody can check against a moving
// fight. Drawn on the ground they check themselves.
describe('the picture of what it is thinking', () => {
  function scene(overrides: Partial<Parameters<typeof dodgeMarks>[0]> = {}) {
    return {
      selfX: 10,
      selfY: 10,
      gameTimeMs: 0,
      engageTiles: 2.5,
      keepAwayTiles: 2.5 as number | undefined,
      bodies: new EnemyBodies(),
      blasts: [] as BlastView[],
      ...overrides,
    };
  }

  const of = (marks: readonly DodgeMark[], kind: DodgeMarkKind): DodgeMark[] =>
    marks.filter((mark) => mark.kind === kind);

  it('draws the character and the ring it answers inside', () => {
    const marks = dodgeMarks(scene());

    expect(of(marks, DodgeMarkKind.Player)).toHaveLength(1);
    expect(of(marks, DodgeMarkKind.Engage)[0]?.radiusTiles).toBe(2.5);
  });

  // **The picture is drawn far more often than it is published, and where the
  // player is arrives here five times a second.** A ring stated in tiles sat
  // still for a whole server tick and then jumped, under a character that had
  // not. Saying which circles belong to the player lets the module — which
  // reads the position every frame — put them where the character is.
  it('says which circles belong to the character', () => {
    const marks = dodgeMarks(scene());

    for (const kind of [DodgeMarkKind.Player, DodgeMarkKind.Engage]) {
      expect(of(marks, kind)[0]?.anchor).toBe(DodgeMarkAnchor.Player);
    }
  });

  // And the other half of the same problem: a monster's circle is published
  // twenty times a second, so it needs to be able to move between publishes.
  it('carries what a monster is doing, and nothing for a blast', () => {
    const bodies = new EnemyBodies();
    // Two tiles a second east, a tile a second south — as the tracker states
    // it, which is per millisecond.
    bodies.collect([{ x: 12, y: 10 } as EntityView], 10, 10, 12, chasing(2, -1));
    const blast: BlastView = { x: 4, y: 4, radiusTiles: 3, armsAtMs: 2000 };

    const marks = dodgeMarks(scene({ bodies, blasts: [blast] }));

    const body = of(marks, DodgeMarkKind.Body)[0];
    expect(body?.anchor).toBe(DodgeMarkAnchor.Place);
    expect(body?.velocityX).toBeCloseTo(2, 6);
    expect(body?.velocityY).toBeCloseTo(-1, 6);
    // The room around it moves with it, or the pair comes apart on the screen.
    expect(of(marks, DodgeMarkKind.KeepAway)[0]?.velocityX).toBeCloseTo(2, 6);
    // A blast is ground that will be dangerous at a moment. It goes nowhere.
    expect(of(marks, DodgeMarkKind.Blast)[0]?.velocityX).toBe(0);
  });

  it('draws each monster and the room it is being given', () => {
    const bodies = new EnemyBodies();
    bodies.collect([{ x: 12, y: 10 } as EntityView], 10, 10, 12, sized(4));

    const marks = dodgeMarks(scene({ bodies }));

    // The body at the size the catalog gave it, so a boss drawn as a rat is
    // visible as one.
    expect(of(marks, DodgeMarkKind.Body)[0]?.radiusTiles).toBe(2);
    // And the circle the planner refuses to be inside, which is the body plus
    // the gap the setting asks for.
    expect(of(marks, DodgeMarkKind.KeepAway)[0]?.radiusTiles).toBeCloseTo(4, 6);
  });

  it('draws nothing about the monsters while it is not minding them', () => {
    const bodies = new EnemyBodies();
    bodies.collect([{ x: 12, y: 10 } as EntityView], 10, 10, 12, ANY_BODY);

    const marks = dodgeMarks(scene({ bodies, keepAwayTiles: undefined }));

    expect(of(marks, DodgeMarkKind.Body)).toHaveLength(0);
    expect(of(marks, DodgeMarkKind.KeepAway)).toHaveLength(0);
  });

  // A bomb two seconds out and one landing this instant are the same circle in
  // the same place, and only one of them is a reason to move.
  it('draws a blast where it lands, reddening as it does', () => {
    const soon: BlastView = { x: 12, y: 12, radiusTiles: 3, armsAtMs: 200 };
    const later: BlastView = { x: 4, y: 4, radiusTiles: 3, armsAtMs: 2000 };

    const marks = dodgeMarks(scene({ blasts: [soon, later] }));
    const blasts = of(marks, DodgeMarkKind.Blast);

    expect(blasts).toHaveLength(2);
    expect(blasts[0]?.radiusTiles).toBe(3);
    expect(blasts[0]?.permille).toBeLessThan(blasts[1]?.permille ?? 0);
  });

  // One already down is history, and the ground it took is the safest on the
  // screen. Drawing it would be drawing a crater.
  it('says nothing about a blast that has already gone off', () => {
    const gone: BlastView = { x: 12, y: 12, radiusTiles: 3, armsAtMs: 100 };

    const marks = dodgeMarks(scene({ blasts: [gone], gameTimeMs: 500 }));

    expect(of(marks, DodgeMarkKind.Blast)).toHaveLength(0);
  });

  // A busy screen is unreadable whatever is drawn, and every one of these
  // crosses a pipe fifty times a second.
  it('keeps a busy screen bounded, and never half a monster', () => {
    const bodies = new EnemyBodies();
    const crowd = Array.from(
      { length: 200 },
      (_unused, i) => ({ x: 10 + (i % 20) * 0.1, y: 10 }) as EntityView,
    );
    bodies.collect(crowd, 10, 10, 40, ANY_BODY);

    const marks = dodgeMarks(scene({ bodies }));

    expect(marks.length).toBeLessThanOrEqual(MAX_DRAWN_MARKS);
    expect(of(marks, DodgeMarkKind.Body)).toHaveLength(of(marks, DodgeMarkKind.KeepAway).length);
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
  const registry = createBundledRegistry();

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
    /** A place on the map, which only the chord names. */
    moveTo: ReturnType<typeof vi.fn>;
    /** An offset from wherever the player is, which is what the planner says. */
    moveBy: ReturnType<typeof vi.fn>;
    plan: () => void;
    /** Where the module says the chord is pointing, driven by hand. */
    cursor: { target: Position | undefined };
    /** Which way the module says the player is walking, driven by hand. */
    steer: { direction: Position | undefined };
    /** Whether the module says it is drawing the shot paths. */
    view: { on: boolean };
    showPicture: ReturnType<typeof vi.fn>;
    /**
     * The world's own clock, which the test moves by hand.
     *
     * Separate from the planning interval on purpose: a plan happens far more
     * often than a server tick, and what the tracker is *for* is the gap
     * between two of them.
     */
    clock: { ms: number };
    /** A server tick arriving, which is when a sighting is taken. */
    tick: () => void;
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
      damagingAt?: (x: number, y: number) => boolean;
      /** What the world says is standing about, for the spacing band. */
      enemies?: readonly EntityView[];
      /** Which types the catalog calls scenery — a lever, a pot, a monument. */
      scenery?: (objectType: number) => boolean;
      /**
       * Which types the catalog says have an attack. An ordinary monster does,
       * which is why that is the default; a spawner is exactly the thing that
       * does not.
       */
      shots?: (objectType: number) => boolean;
    } = {},
  ): Harness {
    const moveTo = vi.fn();
    const moveBy = vi.fn();
    const showPicture = vi.fn();
    const cursor: { target: Position | undefined } = { target: undefined };
    const steer: { direction: Position | undefined } = { direction: undefined };
    const view = { on: false };
    // Fired ten tiles west of the player and travelling east at eight tiles a
    // second, so it reaches them a little over a second later.
    const shot = straightShot({ x: 0, y: 10 }, 0, 8, 0, 2000);

    const clock = { ms: gameTimeMs };
    const session = {
      id: 's1',
      self: { objectId: 1, x: 10, y: 10, alive: true, walkSpeedTilesPerSecond: 6 },
      world: {
        get gameTimeMs(): number {
          return clock.ms;
        },
        projectiles: () => [shot],
        blasts: () => [],
        enemies: () => map.enemies ?? [],
        canStandAt: map.canStandAt ?? ((): boolean => true),
        tileAt: (x: number, y: number) => ({
          type: 0,
          blocking: false,
          damaging: map.damagingAt?.(x, y) ?? false,
        }),
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
        output: { moveTo, moveBy, showPicture },
        cursorWalk: { target: () => cursor.target },
        steer: { direction: () => steer.direction },
        view: { wanted: () => view.on },
        isObstacle: () => false,
        isInvincible: () => false,
        isScenery: map.scenery ?? ((): boolean => false),
        hasShots: map.shots ?? ((): boolean => true),
        bodyTiles: () => undefined,
      }),
    );
    host.setEnabled('auto-dodge', true);

    return {
      host,
      moveTo,
      moveBy,
      showPicture,
      cursor,
      steer,
      view,
      clock,
      plan: () => {
        vi.advanceTimersByTime(A_PLAN_MS);
      },
      // The packet carries nothing the plugin reads — a sighting is taken of
      // whatever the world says is standing about — so a bare one is a tick.
      tick: () => {
        const packet = createPacket(registry, 'NEWTICK');
        packet.fields = { tickId: 1, tickTime: 200, statuses: [] };
        host.dispatchPacket(
          new MutablePacket(decodeFrame(registry, encodePacket(registry, packet))),
          session,
        );
      },
    };
  }

  /**
   * How many monsters the last published picture drew a body for.
   *
   * The circles are the complaint itself — "there is a no-go ring round empty
   * floor" — so what the culling rule is asserted against is the picture rather
   * than the move it happened to produce, which is a decision several other
   * settings also have a say in.
   */
  function bodiesDrawn(showPicture: ReturnType<typeof vi.fn>): number {
    const marks = (showPicture.mock.lastCall?.[1] ?? []) as DodgeMark[];
    return marks.filter((mark) => mark.kind === DodgeMarkKind.Body).length;
  }

  it('acts on a shot that has come close enough, with no packet to prompt it', () => {
    // 900 ms in, the shot is two and a half tiles out — a third of a second from
    // landing. On the server's tick that would have been noticed up to 200 ms
    // later, which is most of the warning spent waiting.
    const { moveBy, plan } = underFire(900);
    plan();
    expect(moveBy).toHaveBeenCalled();
  });

  it('leaves a shot that is still far off alone', () => {
    const { moveBy, plan } = underFire(0);
    plan();
    expect(moveBy).not.toHaveBeenCalled();
  });

  it('does nothing at all while switched off', () => {
    const { host, moveBy, plan } = underFire(900);
    host.setEnabled('auto-dodge', false);
    plan();
    expect(moveBy).not.toHaveBeenCalled();
  });

  // The whole of "does not get in your way": a player already walking somewhere
  // safe is told nothing, so their own movement is untouched.
  it('says nothing while the player is walking somewhere safe', () => {
    const { moveBy, plan, steer } = underFire(900);
    // North, out of the shot's line.
    steer.direction = { x: 0, y: -1 };

    plan();

    expect(moveBy).not.toHaveBeenCalled();
  });

  it('takes over when the player is walking into it', () => {
    const { moveBy, plan, steer } = underFire(900);
    steer.direction = { x: -1, y: 0 };

    plan();

    expect(moveBy).toHaveBeenCalled();
  });

  // Taking the wheel means cancelling their input rather than adding to it: the
  // command has to *oppose* what they are holding, or the two sum to neither.
  it('cancels the input it is overriding', () => {
    const { moveBy, plan, steer } = underFire(900);
    const intent = { x: -1, y: 0 };
    steer.direction = intent;

    plan();

    expect(moveBy).toHaveBeenCalled();
    const [offsetX, offsetY] = moveBy.mock.calls[0] as [number, number, number, number];
    expect(offsetX * intent.x + offsetY * intent.y).toBeLessThan(0);
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
    const { moveTo, moveBy, plan, cursor } = underFire(0);
    cursor.target = { x: 13, y: 7 };
    plan();
    cursor.target = undefined;

    plan();

    expect(moveTo).toHaveBeenCalledTimes(1);
    expect(moveBy).toHaveBeenCalledTimes(1);
    const [x, y, , hold] = moveBy.mock.calls[0] as [number, number, number, number];
    // No distance at all, which the module has by definition already covered.
    expect(x).toBe(0);
    expect(y).toBe(0);
    expect(hold).toBe(1);
  });

  // Nothing is predicted for a picture nobody is looking at: the switch lives
  // on the module, because the module owns the pixels.
  it('describes what it is thinking only while the module is drawing it', () => {
    const { plan, showPicture, view } = underFire(900);

    plan();
    expect(showPicture).not.toHaveBeenCalled();

    view.on = true;
    plan();
    expect(showPicture).toHaveBeenCalledTimes(1);
    const paths = showPicture.mock.calls[0]?.[0] as { lifePermille: number }[];
    expect(paths).toHaveLength(1);
    expect(paths[0]?.lifePermille).toBeGreaterThan(0);
    // And the distances beside them, which is what says why it did or did not
    // answer that shot. The engagement ring at least, with nobody else about.
    const marks = showPicture.mock.calls[0]?.[1] as { kind: number; radiusTiles: number }[];
    expect(marks.some((mark) => mark.kind === DodgeMarkKind.Engage)).toBe(true);
  });

  // **Sampling is packet work, and doing it on the planning interval is what
  // made every monster look like it was standing still.** A position is only
  // news when the server sends one, so two readings twenty milliseconds apart
  // are two readings of the same tick — a velocity of nought, blended into the
  // estimate ten times before the next tick arrives.
  it('learns which way a monster is going, and draws it where it is', () => {
    // Walked by hand between ticks, which is the whole subject of the test.
    const monster = { objectId: 9, objectType: 500, x: 16, y: 10, hp: 4000, maxHp: 4000 };
    const { plan, tick, clock, showPicture, view } = underFire(0, {
      enemies: [monster as EntityView],
    });
    view.on = true;

    tick();
    // A tile west over one server tick, which is five tiles a second closing.
    monster.x = 15;
    clock.ms = 200;
    tick();
    // And a moment later, before the next tick has anything to say.
    clock.ms = 260;
    plan();

    const marks = showPicture.mock.lastCall?.[1] as DodgeMark[];
    const body = marks.find((mark) => mark.kind === DodgeMarkKind.Body);
    expect(body?.velocityX).toBeCloseTo(-5, 1);
    // Ahead of the packet, because the packet is already a moment old.
    expect(body?.x).toBeLessThan(15);
    expect(body?.x).toBeGreaterThan(14);
  });

  it('clears what is drawn once, when the switch goes up', () => {
    const { plan, showPicture, view } = underFire(900);
    view.on = true;
    plan();
    view.on = false;

    plan();
    plan();

    expect(showPicture).toHaveBeenCalledTimes(2);
    // Both halves, because a picture with only its circles left is a picture of
    // a fight that is not happening.
    expect(showPicture.mock.calls[1]?.[0]).toEqual([]);
    expect(showPicture.mock.calls[1]?.[1]).toEqual([]);
  });

  // **The live report: "I cannot get through there."** A wall in this game is an
  // object with hit points and the enemy flag, and a brazier is `<Enemy/>` with
  // no health bar at all — so a three-tile no-go circle went round every
  // decoration in the room. The rule that answers it is the one auto-aim already
  // uses to decide what is worth shooting: the two lists are the same list.
  it('keeps its distance from monsters and not from the scenery', () => {
    const decoration = { objectId: 9, objectType: 500, x: 11, y: 10, maxHp: 0 } as EntityView;
    const monster = { objectId: 9, objectType: 500, x: 11, y: 10, maxHp: 4000 } as EntityView;

    // Nothing near enough to dodge, so the only thing that could move the
    // player is the room being taken. Standing beside a torch is not a mistake.
    const past = underFire(0, { enemies: [decoration] });
    past.plan();
    expect(past.moveBy).not.toHaveBeenCalled();

    const crowded = underFire(0, { enemies: [monster] });
    crowded.plan();
    expect(crowded.moveBy).toHaveBeenCalled();
  });

  // **The live report: a Shatters lever.** It is `<Enemy/>` and it carries five
  // thousand hit points until somebody pulls it, so it is neither a wall nor
  // invincible and every cull there was let it through — and the planner spent
  // the village walking round a thing that cannot move and cannot fire. The rule
  // auto-aim uses cannot answer this one, because a lever is shot on purpose;
  // the catalog's own word for it is what does.
  it('keeps no distance from a lever it is meant to shoot', () => {
    const lever = { objectId: 9, objectType: 600, x: 11, y: 10, maxHp: 5000 } as EntityView;

    const beside = underFire(0, { enemies: [lever], scenery: (type) => type === 600 });
    beside.plan();
    expect(beside.moveBy).not.toHaveBeenCalled();

    // The same entity with the same health, and the only difference is what the
    // catalog calls it.
    const crowded = underFire(0, { enemies: [lever] });
    crowded.plan();
    expect(crowded.moveBy).toHaveBeenCalled();
  });

  // **The live report: a room full of no-go circles around empty floor.** A
  // spawner is `<Enemy/>` with a health bar, is not a wall, is not a structure
  // kill, is not marked invincible, and the game draws it as nothing — so it
  // passed every cull there was and the planner spent the fight walking around
  // places where there was nobody. What gives it away is that it has no attack
  // in the game's own data *and* has never gone anywhere.
  it('keeps no distance from a spawner that has never moved and cannot fire', () => {
    const spawner = {
      objectId: 9,
      objectType: 700,
      x: 11,
      y: 10,
      hp: 4000,
      maxHp: 4000,
    } as EntityView;

    const beside = underFire(0, { enemies: [spawner], shots: (type) => type !== 700 });
    beside.view.on = true;
    beside.tick();
    beside.tick();
    beside.plan();
    // Nothing drawn on the ground where there is nothing, and no reason to
    // leave a place that is empty.
    expect(bodiesDrawn(beside.showPicture)).toBe(0);
    expect(beside.moveBy).not.toHaveBeenCalled();

    // The same entity in the same place, and the only difference is that the
    // catalog says this one shoots.
    const crowded = underFire(0, { enemies: [spawner] });
    crowded.tick();
    crowded.tick();
    crowded.plan();
    expect(crowded.moveBy).toHaveBeenCalled();
  });

  // Either half alone describes an ordinary monster: a melee minion has no
  // shots of its own, and anything at all has yet to move on the tick it comes
  // into view. So one step is all it takes to become a body again.
  it('starts keeping its distance the moment the thing takes a step', () => {
    const walker = { objectId: 9, objectType: 700, x: 12, y: 10, hp: 4000, maxHp: 4000 };
    const { plan, tick, clock, showPicture, view } = underFire(0, {
      enemies: [walker as EntityView],
      shots: () => false,
    });
    view.on = true;

    tick();
    plan();
    expect(bodiesDrawn(showPicture)).toBe(0);

    // A tile east over one server tick, which is a minion closing.
    walker.x = 11;
    clock.ms = 200;
    tick();
    // Twice, because the picture goes out slower than a plan is made.
    plan();
    plan();
    expect(bodiesDrawn(showPicture)).toBe(1);
  });

  it('says nothing at all when it was not driving in the first place', () => {
    const { moveTo, moveBy, plan } = underFire(0);

    plan();
    plan();

    expect(moveTo).not.toHaveBeenCalled();
    expect(moveBy).not.toHaveBeenCalled();
  });

  it('drops the margin once the player is already inside it', () => {
    // A corridor two tiles wide, running north and south. The body fits in it
    // and the body plus the margin below does not fit anywhere in it — which is
    // exactly the case where demanding the margin would refuse every step out
    // and pin the player against the wall with the setting meant to keep them
    // off it. The way out is along the corridor, and the shot is crossing it.
    const corridor = (x: number): boolean => Math.floor(x) === 9 || Math.floor(x) === 10;
    const { host, moveBy, plan } = underFire(900, { canStandAt: corridor });
    host.settingsOf('auto-dodge')?.apply('wallClearanceTiles', 0.8);

    plan();

    expect(moveBy).toHaveBeenCalled();
  });

  // **Standing beside a pool is not standing in one.** The margin keeps
  // *courses* well clear of lava; reading "am I in it" off that same widened
  // answer would have the planner hauling a player off ground that is costing
  // them nothing, every time they chose to fight at the edge of one.
  it('does not haul the player off the tile next to the lava', () => {
    // Damaging everywhere east of the player's own tile, so their body is
    // inside the margin and their feet are not.
    const { moveBy, plan } = underFire(0, { damagingAt: (x) => x >= 11 });

    plan();

    expect(moveBy).not.toHaveBeenCalled();
  });

  // The complaint, end to end: a shot forces a sidestep and one of the two
  // sides is a lava pool the planner used to be happy to stop at the edge of.
  it('takes the sidestep that is not into the lava', () => {
    const { moveBy, plan } = underFire(900, { damagingAt: (_x, y) => y >= 11 });

    plan();

    expect(moveBy).toHaveBeenCalled();
    const [, offsetY] = moveBy.mock.calls[0] as [number, number];
    expect(offsetY).toBeLessThan(0);
  });

  it('still walks them out of it once they are actually in it', () => {
    const { moveBy, plan } = underFire(0, { damagingAt: (x) => x >= 10 });

    plan();

    expect(moveBy).toHaveBeenCalled();
    const [offsetX] = moveBy.mock.calls[0] as [number, number];
    expect(offsetX).toBeLessThan(0);
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
      expect(relaxed.moveBy).not.toHaveBeenCalled();

      const cautious = underFire(700);
      cautious.host.settingsOf('auto-dodge')?.apply('preset', DodgePresetId.Cautious);
      cautious.plan();
      expect(cautious.moveBy).toHaveBeenCalled();
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
    engageWithinTiles: number('engageWithinTiles'),
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
        output: {
          moveTo: () => undefined,
          moveBy: () => undefined,
          showPicture: () => undefined,
        },
        cursorWalk: { target: () => undefined },
        steer: { direction: () => undefined },
        view: { wanted: () => false },
        isObstacle: () => false,
        isInvincible: () => false,
        isScenery: () => false,
        hasShots: () => true,
        bodyTiles: () => undefined,
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
