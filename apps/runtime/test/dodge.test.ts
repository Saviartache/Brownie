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
import { EnemyBodies } from '../src/features/dodge/EnemyBodies.js';
import { MAX_PATH_POINTS, shotPaths } from '../src/features/dodge/ShotPaths.js';
import { SteerTracker } from '../src/features/dodge/SteerIntent.js';
import { ThreatField, type DodgeShot, type Sweep } from '../src/features/dodge/ThreatField.js';
import { createDodgePlugin } from '../src/features/dodge/dodgePlugin.js';
import { nearestOtherPlayer } from '../src/features/dodge/hitRedirect.js';
import {
  PLAYER_HALF_TILES,
  effectiveHalf,
  minChebyshevOnSegment,
  overlaps,
  projectileHalfTiles,
} from '../src/features/dodge/hitbox.js';
import { PluginHost } from '../src/plugins/PluginHost.js';
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

/** Nothing in the way, nothing that hurts, nobody to bump into. */
const OPEN_GROUND: DodgeWorld = {
  canStand: () => true,
  isDamaging: () => false,
  enemyRoomAt: () => Infinity,
};

/** The plugin's own defaults, so a unit test and a live session agree. */
const SETTINGS: DodgeSettings = {
  horizonMs: 1000,
  reactWithinMs: 420,
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
  };

  function sweepStanding(field: ThreatField, at: Position): Sweep {
    const out: Sweep = { impactMs: Infinity, clearanceTiles: Infinity, unsafeAtMs: Infinity };
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

    const free: Sweep = { impactMs: Infinity, clearanceTiles: Infinity, unsafeAtMs: Infinity };
    const boxed: Sweep = { impactMs: Infinity, clearanceTiles: Infinity, unsafeAtMs: Infinity };
    field.sweep(0, 0, 1, 0, 0.006, 0, 600, Infinity, 0, free);
    // The same walk, with a wall a tenth of a tile away.
    field.sweep(0, 0, 1, 0, 0.006, 0, 600, 0.1, 0, boxed);

    // Walking east takes the player under the shot; being stopped short of it
    // leaves them clear, which the swept clearance has to show.
    expect(free.clearanceTiles).toBeLessThan(boxed.clearanceTiles);
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
    });
    const swept: Sweep = { impactMs: Infinity, clearanceTiles: Infinity, unsafeAtMs: Infinity };
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
    let closest = Infinity;
    let at = 0;
    for (let t = 0; t <= EXACT.horizonMs; t += 5) {
      const player = 10 + (plan.dirY * speed * (EXACT.leadMs + t)) / 1000;
      const gap = Math.abs(player - (fromY + (8 * t) / 1000));
      if (gap < closest) {
        closest = gap;
        at = t;
      }
    }
    return 10 + (plan.dirX * speed * (EXACT.leadMs + at)) / 1000;
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

  it('takes a short step when the window cannot be gone through', () => {
    const controller = new DodgeController();
    // A second rank behind the first with its hole somewhere else, so diving
    // through the near one only arrives at the far one's solid part. What is
    // left is to stand in the near hole and let it pass — which the full-speed
    // ring cannot reach, because full speed goes straight past it.
    const ranks = wall(9.4, 6.6).concat(wall(12.1, 5.0));
    const plan = controller.plan(situation(), EXACT, OPEN_GROUND, ranks);

    expect(plan.steer).toBe(true);
    expect(plan.speedScale).toBeLessThan(1);
    expect(whereItCrosses(plan, 6.6)).toBeGreaterThan(8.5 + HALF);
    expect(whereItCrosses(plan, 6.6)).toBeLessThan(10.3 - HALF);
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
    enemyRoomAt: () => Infinity,
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
      enemyRoomAt: () => Infinity,
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
    bodies.collect([{ x: 10, y: 12 } as EntityView], 10, 10, 6);
    const crowded: DodgeWorld = {
      canStand: () => true,
      isDamaging: () => false,
      enemyRoomAt: (x, y) => bodies.roomAt(x, y),
    };
    const shot = straightShot({ x: 0, y: 10 }, 0, 8, 0, 2000);

    const plan = controller.plan(situation({ gameTimeMs: 900 }), SETTINGS, crowded, [shot]);

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

describe('what enemy bodies are worth', () => {
  it('measures room to the nearest, and nothing when there is nobody', () => {
    const bodies = new EnemyBodies();
    expect(bodies.roomAt(0, 0)).toBe(Infinity);

    bodies.collect([{ x: 3, y: 0 } as EntityView], 0, 0, 10);
    expect(bodies.roomAt(0, 0)).toBeCloseTo(3 - 0.5 - PLAYER_HALF_TILES, 6);
  });

  it('forgets everybody too far to matter', () => {
    const bodies = new EnemyBodies();
    bodies.collect([{ x: 30, y: 0 } as EntityView], 0, 0, 5);
    expect(bodies.count).toBe(0);
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
});

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
