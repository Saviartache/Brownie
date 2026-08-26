/**
 * What the dodge should *do*, asked of the planner and of the plugin.
 *
 * The parts underneath — the index, the queue, the estimate, the search itself —
 * are `dodge-search.test.ts`. What is here is the behaviour every complaint this
 * feature has ever had was about: leave my walking alone, do not run away, get
 * out of the way in time, and do not walk me into the lava on the way.
 */

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
  DodgePlanner,
  type DodgePlan,
  type DodgeSettings,
  type DodgeSituation,
} from '../src/features/dodge/DodgePlanner.js';
import type { DodgeGround } from '../src/features/dodge/DodgeSearch.js';
import type { DodgeShot } from '../src/features/dodge/ShotTracks.js';
import {
  ENEMY_CONTACT_HALF_TILES,
  EnemyBodies,
  MAX_BODY_LOOKAHEAD_MS,
  type BodySighting,
} from '../src/features/dodge/EnemyBodies.js';
import { BLAST_MARGIN_TILES, Blasts, type BlastView } from '../src/features/dodge/Blasts.js';
import {
  DodgeMarkAnchor,
  DodgeMarkKind,
  dodgeMarks,
  MAX_DRAWN_MARKS,
  type DodgeMark,
} from '../src/features/dodge/DodgeMarks.js';
import { MAX_PATH_POINTS, shotPaths } from '../src/features/dodge/ShotPaths.js';
import { SteerTracker } from '../src/features/dodge/SteerIntent.js';
import { GroundCache, type GroundSource } from '../src/features/dodge/GroundCache.js';
import { HOP_SPEED_TILES_PER_SECOND, MAX_HOP_TILES } from '../src/features/dodge/Hop.js';
import { walkCommand } from '../src/features/dodge/dodgeCommand.js';
import { createDodgePlugin } from '../src/features/dodge/dodgePlugin.js';
import {
  DODGE_PRESETS,
  DodgePresetId,
  presetMatches,
  type DodgeTuning,
} from '../src/features/dodge/dodgePresets.js';
import { nearestOtherPlayer } from '../src/features/dodge/hitRedirect.js';
import {
  DEFAULT_PROJECTILE_HALF_TILES,
  PLAYER_ENVIRONMENT_HALF_TILES,
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
): DodgeShot & { firedAtMs: number; expiresAtMs: number } {
  return {
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

/**
 * A shot that slows to a halt and then sits where it stopped.
 *
 * The game builds these out of a negative acceleration and a speed clamp of
 * nought, which its own motion model integrates to exactly this: constant
 * deceleration to a standstill, and then nothing until the shot expires.
 */
function parkingShot(
  from: Position,
  headingRadians: number,
  tilesPerSecond: number,
  stopsAfterMs: number,
  firedAtMs: number,
  lifetimeMs: number,
): DodgeShot & { firedAtMs: number; expiresAtMs: number } {
  return {
    firedAtMs,
    expiresAtMs: firedAtMs + lifetimeMs,
    positionAt(gameTimeMs: number): Position | undefined {
      const elapsed = gameTimeMs - firedAtMs;
      if (elapsed < 0 || elapsed > lifetimeMs) return undefined;
      const moving = Math.min(elapsed, stopsAfterMs);
      const distance = (tilesPerSecond / 1000) * (moving - moving ** 2 / (2 * stopsAfterMs));
      return {
        x: from.x + distance * Math.cos(headingRadians),
        y: from.y + distance * Math.sin(headingRadians),
      };
    },
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
const OPEN_GROUND: DodgeGround = {
  canStand: () => true,
  hazardGapTiles: () => Infinity,
  crowdingAt: () => 0,
  contactAt: () => 0,
};

/** Open ground with monsters in it, judged against one keep-away distance. */
function standingOff(bodies: EnemyBodies, keepAwayTiles: number): DodgeGround {
  return {
    canStand: () => true,
    hazardGapTiles: () => Infinity,
    crowdingAt: (x, y, aheadMs) => bodies.crowdingAt(x, y, keepAwayTiles, aheadMs),
    contactAt: (x, y, aheadMs) => bodies.contactAt(x, y, aheadMs),
  };
}

/** The plugin's own defaults, so a unit test and a live session agree. */
const SETTINGS: DodgeSettings = {
  horizonMs: 900,
  tickMs: 100,
  reactWithinMs: 420,
  headings: 12,
  hitScale: 1,
  padTiles: 0.1,
  leadMs: 60,
  driftTilesPerSecond: 0.2,
  safeClearanceTiles: 0.25,
  hazardClearTiles: 0.5,
  holdGroundWeight: 1,
  greed: 1.6,
  maxExpansions: 500,
  hopEnabled: true,
  hopTiles: MAX_HOP_TILES,
  hopCooldownMs: 400,
};

/** What the character walks at once the panel has taken its margin off. */
const WALK = 5.52;

function situation(overrides: Partial<DodgeSituation> = {}): DodgeSituation {
  return {
    x: 10,
    y: 10,
    intentX: 0,
    intentY: 0,
    onDamagingGround: false,
    speedTilesPerSecond: WALK,
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
    // Nought is the game's own way of saying this one collides with nothing,
    // and it is declared by every warning telegraph in the file.
    expect(projectileHalfTiles(0)).toBe(0);
    // A multiplier that did not parse is a different thing entirely, and must
    // not become a shot with no hitbox.
    expect(projectileHalfTiles(Number.NaN)).toBeCloseTo(0.5, 6);
    expect(projectileHalfTiles(-1)).toBeCloseTo(0.5, 6);
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

describe('blasts on their way down', () => {
  const HERE = { x: 10, y: 10 };

  function landing(armsAtMs: number, at: Position = HERE, radiusTiles = 2): Blasts {
    const blasts = new Blasts();
    blasts.collect([{ ...at, radiusTiles, armsAtMs }], 0, HERE.x, HERE.y, 6, 1000);
    return blasts;
  }

  it('has nothing to say about a place no blast reaches', () => {
    // Room measured rather than a verdict, so the far side of the room is a
    // large number rather than a special case.
    expect(landing(300).clearanceAt(30, 30, 0, 1000)).toBeGreaterThan(20);
    // And nothing at all lands in the window this one asks about.
    expect(landing(300).clearanceAt(10, 10, 600, 900)).toBe(Infinity);
  });

  // **The whole shape of the thing.** A blast threatens one place at one
  // instant; standing there a moment before or a moment after costs nothing.
  it('only counts a blast that lands inside the window asked about', () => {
    const blasts = landing(300);

    expect(blasts.clearanceAt(HERE.x, HERE.y, 0, 200)).toBe(Infinity);
    expect(blasts.clearanceAt(HERE.x, HERE.y, 200, 400)).toBeLessThan(0);
    expect(blasts.clearanceAt(HERE.x, HERE.y, 400, 900)).toBe(Infinity);
  });

  it('measures a circle, and keeps a margin outside its edge', () => {
    const blasts = landing(300);
    // Two tiles of radius, the player's own half, and the margin.
    const clear = 2 + PLAYER_HALF_TILES + BLAST_MARGIN_TILES;

    expect(blasts.clearanceAt(HERE.x + clear, HERE.y, 200, 400)).toBeCloseTo(0, 6);
    expect(blasts.clearanceAt(HERE.x + clear + 1, HERE.y, 200, 400)).toBeCloseTo(1, 6);
  });

  // One that has gone off is history, and the ground it took is the safest on
  // the screen. One landing past the horizon is the next fifty plans' problem.
  it('forgets what has already landed and what lands too late to matter', () => {
    const gone = new Blasts();
    gone.collect([{ ...HERE, radiusTiles: 2, armsAtMs: -50 }], 0, HERE.x, HERE.y, 6, 1000);
    expect(gone.count).toBe(0);

    const later = new Blasts();
    later.collect([{ ...HERE, radiusTiles: 2, armsAtMs: 4000 }], 0, HERE.x, HERE.y, 6, 1000);
    expect(later.count).toBe(0);
  });

  it('forgets one no step could reach', () => {
    const across = new Blasts();
    across.collect([{ x: 40, y: 40, radiusTiles: 2, armsAtMs: 300 }], 0, HERE.x, HERE.y, 6, 1000);
    expect(across.count).toBe(0);
  });

  // A wide disc takes most of a second to walk out of, so what the planner has
  // to know is when the *first* one lands rather than that one exists.
  it('says how soon the earliest of them lands', () => {
    const blasts = new Blasts();
    blasts.collect(
      [
        { ...HERE, radiusTiles: 2, armsAtMs: 700 },
        { ...HERE, radiusTiles: 2, armsAtMs: 250 },
      ],
      0,
      HERE.x,
      HERE.y,
      6,
      1000,
    );

    expect(blasts.soonestMs()).toBe(250);
    expect(new Blasts().soonestMs()).toBe(Infinity);
  });
});

/**
 * A fast shot from across the room, arriving inside the reaction window.
 *
 * **Fast and far, and both halves are load-bearing.** Getting out of the way of
 * a bullet perpendicular to its line opens a gap at a rate set by the ratio of
 * the two speeds, so a slow shot close by is one there is no *comfortable* way
 * to step out of — a walking player clears it by a hair, and whether the planner
 * nudges them then is a question about hundredths of a tile. Twenty tiles a
 * second from seven and a half tiles away is the same third of a second of
 * warning with room to actually use it, which is the case worth asserting.
 */
const ACROSS_THE_ROOM = straightShot({ x: 2.3, y: 10 }, 0, 20, 0, 3000);

describe('who is driving', () => {
  it('says nothing at all when nothing could reach us', () => {
    const plan = new DodgePlanner().plan(situation(), SETTINGS, OPEN_GROUND, []);

    expect(plan.verdict).toBe('clear');
    expect(plan.steer).toBe(false);
    // And it never opened the search, which is what makes fifty plans a second
    // affordable: the great majority of them stop at the probe.
    expect(plan.expansions).toBe(0);
  });

  // The whole of "does not get in your way": a player already walking somewhere
  // safe is told nothing, so their own movement is untouched.
  it('leaves the player alone while their own walking is safe', () => {
    const plan = new DodgePlanner().plan(
      situation({ intentX: 0, intentY: -1 }),
      SETTINGS,
      OPEN_GROUND,
      [ACROSS_THE_ROOM],
    );

    expect(plan.verdict).toBe('intent-safe');
    expect(plan.steer).toBe(false);
  });

  it('takes the wheel when their own walking runs into it', () => {
    const plan = new DodgePlanner().plan(
      situation({ intentX: -1, intentY: 0 }),
      SETTINGS,
      OPEN_GROUND,
      [ACROSS_THE_ROOM],
    );

    expect(plan.steer).toBe(true);
    expect(plan.impactMs).toBe(Infinity);
  });

  // A shot that will reach them eventually is not this moment's problem. Shots
  // in this game live a second or two, so "eventually" describes nearly
  // everything on the screen — and acting on it is a planner that can never walk
  // towards anything that shoots.
  it('is not interested in a shot that arrives after the window', () => {
    const far = straightShot({ x: 0, y: 10 }, 0, 8, 0, 3000);
    const plan = new DodgePlanner().plan(situation(), SETTINGS, OPEN_GROUND, [far]);

    expect(plan.verdict).toBe('clear');
    expect(plan.steer).toBe(false);
  });

  it('answers one that arrives inside it', () => {
    const near = straightShot({ x: 7.2, y: 10 }, 0, 8, 0, 3000);
    const plan = new DodgePlanner().plan(situation(), SETTINGS, OPEN_GROUND, [near]);

    expect(plan.steer).toBe(true);
    expect(plan.verdict).toBe('weave');
    expect(plan.impactMs).toBe(Infinity);
  });

  it('reports what it was looking at', () => {
    const near = straightShot({ x: 7.2, y: 10 }, 0, 8, 0, 3000);
    const plan = new DodgePlanner().plan(
      situation(),
      SETTINGS,
      OPEN_GROUND,
      [near],
      [{ x: 12, y: 10, radiusTiles: 2, armsAtMs: 300 }],
    );

    expect(plan.trackedShots).toBe(1);
    expect(plan.trackedBlasts).toBe(1);
  });
});

describe('how far it moves to get out of the way', () => {
  /**
   * Plays the plan out, the way the module would: a step towards the offset
   * every frame, capped at what the character can walk.
   *
   * @returns where the character ends up, and how far it ever strayed.
   */
  function fly(
    shots: readonly DodgeShot[],
    frames: number,
    overrides: Partial<DodgeSituation> = {},
  ): { x: number; y: number; strayed: number } {
    const planner = new DodgePlanner();
    const start = situation(overrides);
    let x = start.x;
    let y = start.y;
    let strayed = 0;

    const FRAME_MS = 25;
    for (let frame = 0; frame < frames; frame += 1) {
      const at = frame * FRAME_MS;
      const plan = planner.plan(
        { ...start, x, y, gameTimeMs: at, nowMs: start.nowMs + at },
        SETTINGS,
        OPEN_GROUND,
        shots,
      );
      if (plan.steer && plan.stepTiles > 0) {
        const travel = Math.min(plan.stepTiles, (WALK * FRAME_MS) / 1000);
        x += plan.dirX * travel;
        y += plan.dirY * travel;
      }
      strayed = Math.max(strayed, Math.hypot(x - start.x, y - start.y));
    }
    return { x, y, strayed };
  }

  // **The complaint four generations of this feature had.** Over any finite
  // horizon retreating survives at least as long as standing your ground, so a
  // planner that ranks on survival backs away from everything, forever.
  it('sidesteps a shot rather than running from it', () => {
    // Six tiles west and closing at eight tiles a second: three quarters of a
    // second of warning, and a bullet nobody outruns.
    const { strayed } = fly([straightShot({ x: 4, y: 10 }, 0, 8, 0, 3000)], 60);

    // A run for the horizon is four or five tiles. Getting out of the way of one
    // bullet is worth about one.
    expect(strayed).toBeLessThan(2);
  });

  // **The way home is a course like any other, and the fire knows where home
  // is.** A monster aims at where the server last saw the character, which after
  // a sidestep is the very ground the planner is walking back to — so a return
  // planned for the anchor alone threads the next shot by a hundredth of a tile
  // and is clipped by the one after.
  it('leaves room on the way back, not only on the way out', () => {
    const planner = new DodgePlanner();
    let x = 10;
    let y = 10;
    let closest = Infinity;

    const FRAME_MS = 25;
    for (let frame = 0; frame < 100; frame += 1) {
      const at = frame * FRAME_MS;
      // One from the west to move them, and one across the ground they were
      // standing on, timed for the moment they would be walking back over it.
      const shots = [
        straightShot({ x: 6, y: 10 }, 0, 8, 0, 2000),
        straightShot({ x: 10, y: 4 }, Math.PI / 2, 8, 700, 2000),
      ].filter((shot) => shot.firedAtMs <= at && shot.expiresAtMs > at);

      const plan = planner.plan(
        { ...situation(), x, y, gameTimeMs: at, nowMs: 1_000_000 + at },
        SETTINGS,
        OPEN_GROUND,
        shots,
      );
      if (plan.steer && plan.stepTiles > 0) {
        const travel = Math.min(plan.stepTiles, (WALK * FRAME_MS) / 1000);
        x += plan.dirX * travel;
        y += plan.dirY * travel;
      }

      for (const shot of shots) {
        const where = shot.positionAt(at);
        if (where === undefined) continue;
        const gap =
          Math.max(Math.abs(where.x - x), Math.abs(where.y - y)) -
          (PLAYER_HALF_TILES + DEFAULT_PROJECTILE_HALF_TILES);
        if (gap < closest) closest = gap;
      }
    }

    // Room to spare rather than a graze, which is the difference between a miss
    // and a coin flip on the prediction.
    expect(closest).toBeGreaterThan(0.1);
  });

  // **And having stepped aside, it walks back.** Without a way home every plan
  // measures from where the character is now, so every plan is already content —
  // and a long fight walks somebody the length of the room one blameless step at
  // a time.
  it('gives the ground back once the shot has gone by', () => {
    const { x, y, strayed } = fly([straightShot({ x: 4, y: 10 }, 0, 8, 0, 3000)], 80);

    expect(strayed).toBeGreaterThan(0.4);
    // Back to within about a step of their ground rather than onto the exact
    // tile: the planner stops returning once it is near enough to have given the
    // ground back, and the last command it issued can carry a step past that.
    expect(Math.hypot(x - 10, y - 10)).toBeLessThan(0.9);
  });

  // **The live report: "enemies can still walk into us, and you try to go back
  // to where you started."** A return point is a claim that somewhere is worth
  // standing on, and a monster walking onto it makes that claim false — so the
  // planner was pulling the character back into the body it had just stepped
  // out of.
  it('walks the ground it returns to out from under a monster', () => {
    const planner = new DodgePlanner();
    const bodies = new EnemyBodies();
    const world = standingOff(bodies, 2.5);

    // Pushed off their ground by a shot, which is what makes it hold one.
    planner.plan(situation(), SETTINGS, world, [straightShot({ x: 7.2, y: 10 }, 0, 8, 0, 3000)]);

    // A monster takes the place they were standing on, and nothing else happens.
    bodies.collect([{ x: 10, y: 10 } as EntityView], 10, 10, 12, ANY_BODY);
    let y = 10.7;
    for (let step = 0; step < 12; step += 1) {
      const plan = planner.plan(
        situation({ x: 10, y, nowMs: 1_000_000 + step * 20 }),
        SETTINGS,
        world,
        [],
      );
      if (plan.steer && plan.stepTiles > 0) y += plan.dirY * Math.min(plan.stepTiles, 0.14);
    }

    // Further from the body than they started, never hauled back onto it.
    expect(y).toBeGreaterThan(10.7);
  });

  // **Some of this game's shots slow to a stop and then sit there.** The ground
  // under one of those is no more worth walking back to than the ground under a
  // monster — and unlike a monster, no amount of stepping the return point
  // sideways helps, because it will be there for the rest of its life.
  it('gives up on ground a shot has parked on', () => {
    const planner = new DodgePlanner();
    // Six tiles north to south at twelve tiles a second, decelerating for a
    // second: it comes to rest exactly on the ground the first shot pushed them
    // off, and sits there for the rest of the run.
    const parked = parkingShot({ x: 10, y: 4 }, Math.PI / 2, 12, 1000, 200, 6000);
    const pushing = straightShot({ x: 7.6, y: 10 }, 0, 8, 0, 1200);

    let x = 10;
    let y = 10;
    let driving = 0;
    let settled = 0;

    const FRAME_MS = 25;
    for (let frame = 0; frame < 140; frame += 1) {
      const at = frame * FRAME_MS;
      const shots = [pushing, parked].filter(
        (shot) => shot.firedAtMs <= at && shot.expiresAtMs > at,
      );
      const plan = planner.plan(
        { ...situation(), x, y, gameTimeMs: at, nowMs: 1_000_000 + at },
        SETTINGS,
        OPEN_GROUND,
        shots,
      );
      if (plan.steer && plan.stepTiles > 0) {
        const travel = Math.min(plan.stepTiles, (WALK * FRAME_MS) / 1000);
        x += plan.dirX * travel;
        y += plan.dirY * travel;
      }
      // Once the passing shot is long gone, the only thing left is the one
      // sitting on the ground they were holding.
      if (at >= 2200) {
        settled += 1;
        if (plan.steer) driving += 1;
      }
    }

    // It stops asking for the wheel rather than tugging at ground it cannot
    // have, and it is not standing on the parked shot either.
    expect(settled).toBeGreaterThan(10);
    expect(driving).toBe(0);
    expect(Math.max(Math.abs(x - 10), Math.abs(y - 10))).toBeGreaterThan(
      PLAYER_HALF_TILES + DEFAULT_PROJECTILE_HALF_TILES,
    );
  });

  // Their own ground is the line they are walking, not the place they started.
  it('keeps a walking player on their own line', () => {
    const { x, y } = fly([], 40, { intentX: 1, intentY: 0 });

    // Nothing in the air and nothing to answer, so it says nothing at all and
    // the character is exactly where their own walking left them.
    expect(x).toBe(10);
    expect(y).toBe(10);
  });
});

describe('where it refuses to go', () => {
  /** Lava everywhere east of a line, and open ground behind it. */
  function lavaEastOf(edge: number): DodgeGround {
    return {
      canStand: () => true,
      hazardGapTiles: (x) => edge - x,
      crowdingAt: () => 0,
      contactAt: () => 0,
    };
  }

  // **Ground that hurts is left the fast way**, because walking out costs a
  // tick of health per step and a frame of movement costs none.
  it('hops out of damaging ground it is already standing in', () => {
    const plan = new DodgePlanner().plan(
      situation({ onDamagingGround: true }),
      SETTINGS,
      lavaEastOf(9.8),
      [],
    );

    expect(plan.verdict).toBe('hop');
    expect(plan.steer).toBe(true);
    expect(plan.dirX).toBeLessThan(0);
  });

  it('still walks out of it when the emergency step is switched off', () => {
    const plan = new DodgePlanner().plan(
      situation({ onDamagingGround: true }),
      { ...SETTINGS, hopEnabled: false },
      lavaEastOf(9.8),
      [],
    );

    expect(plan.verdict).toBe('escape');
    expect(plan.hop).toBe(false);
    expect(plan.dirX).toBeLessThan(0);
  });

  // **A wall costs a step; a pool costs health every tick you are in it, with
  // nothing left to dodge.** So there is no arrangement of shots for which
  // *walking* into one is the answer — it is refused outright rather than
  // charged for, which is a harder rule than the one geometry gets.
  it('refuses to walk into damaging ground, whatever the shots say', () => {
    // A shot straight down the northern sidestep, so the cheap way out is
    // south — and the south is a pool.
    const shots = [
      straightShot({ x: 7.2, y: 10 }, 0, 8, 0, 3000),
      straightShot({ x: 7.2, y: 9.3 }, 0, 8, 0, 3000),
    ];
    const lavaSouth: DodgeGround = {
      canStand: () => true,
      hazardGapTiles: (_x, y) => 10.05 - y,
      crowdingAt: () => 0,
      contactAt: () => 0,
    };

    const plan = new DodgePlanner().plan(situation(), SETTINGS, lavaSouth, shots);

    // Never south, however much the fire is pressing from the north.
    expect(plan.dirY).toBeLessThanOrEqual(0);
  });

  // **Walking into a pool is a mistake worth answering on its own**, with
  // nothing in the air at all — and it is the one case where the planner has to
  // overrule a player who is not under fire.
  it('takes the wheel from a player walking into a pool', () => {
    const plan = new DodgePlanner().plan(
      // East, and the pool starts a tile that way.
      situation({ intentX: 1, intentY: 0 }),
      SETTINGS,
      lavaEastOf(11),
      [],
    );

    expect(plan.steer).toBe(true);
    // Not necessarily away from it — following the edge is a fine answer to
    // somebody walking along one — but never inside the margin it keeps.
    expect(11 - (10 + plan.dirX * plan.stepTiles)).toBeGreaterThanOrEqual(
      SETTINGS.hazardClearTiles - 1e-9,
    );
  });

  it('leaves them alone while their own walking keeps clear of it', () => {
    const plan = new DodgePlanner().plan(
      situation({ intentX: -1, intentY: 0 }),
      SETTINGS,
      lavaEastOf(11),
      [],
    );

    expect(plan.verdict).toBe('intent-safe');
    expect(plan.steer).toBe(false);
  });

  // The complaint, end to end: a shot forces a sidestep and one of the two sides
  // is a pool the planner used to be happy to stop at the edge of.
  it('takes the sidestep that is not into the lava', () => {
    const shot = straightShot({ x: 7.2, y: 10 }, 0, 8, 0, 3000);
    const lavaSouth: DodgeGround = {
      canStand: () => true,
      hazardGapTiles: (_x, y) => 10.4 - y,
      crowdingAt: () => 0,
      contactAt: () => 0,
    };

    const plan = new DodgePlanner().plan(situation(), SETTINGS, lavaSouth, [shot]);

    expect(plan.steer).toBe(true);
    expect(plan.dirY).toBeLessThan(0);
  });

  it('refuses to step into a wall, and finds the side that is open', () => {
    const shot = straightShot({ x: 7.2, y: 10 }, 0, 8, 0, 3000);
    const wallNorth: DodgeGround = {
      canStand: (_x, y) => y > 9.6,
      hazardGapTiles: () => Infinity,
      crowdingAt: () => 0,
      contactAt: () => 0,
    };

    const plan = new DodgePlanner().plan(situation(), SETTINGS, wallNorth, [shot]);

    expect(plan.steer).toBe(true);
    expect(plan.dirY).toBeGreaterThan(0);
    expect(plan.impactMs).toBe(Infinity);
  });
});

describe('room to dodge in', () => {
  const KEEP_AWAY = 2.5;

  // **The live report: "they just walk up and kill me."** By the time contact
  // damage says a monster is too close there is nowhere left to sidestep to, so
  // the distance is not a nicety — it is the room the dodge is made in.
  it('makes room from something standing on top of the player', () => {
    const bodies = new EnemyBodies();
    bodies.collect([{ x: 10.8, y: 10 } as EntityView], 10, 10, 12, ANY_BODY);

    const plan = new DodgePlanner().plan(situation(), SETTINGS, standingOff(bodies, KEEP_AWAY), []);

    expect(plan.verdict).toBe('spacing');
    expect(plan.crowded).toBe(true);
    expect(plan.steer).toBe(true);
    // Away from it, which is the only direction that opens a gap.
    expect(plan.dirX).toBeLessThan(0);
  });

  // The edge of the bubble is where an ordinary fight happens. A planner that
  // acts there is one that never stops acting.
  it('says nothing about one merely inside the bubble', () => {
    const bodies = new EnemyBodies();
    bodies.collect([{ x: 12.3, y: 10 } as EntityView], 10, 10, 12, ANY_BODY);

    const plan = new DodgePlanner().plan(situation(), SETTINGS, standingOff(bodies, KEEP_AWAY), []);

    expect(plan.steer).toBe(false);
  });

  // **The live report: "we build a path into the enemy".** A body is a soft
  // cost so that the only lane out of a volley is never refused — but charged
  // flat, a route straight through one was outvoted by a tile of their own
  // ground. What answers it is that the last half tile costs far more than the
  // first: see `StepCost`.
  it('goes round a monster rather than through it', () => {
    const bodies = new EnemyBodies();
    // Squarely on the northern sidestep, close enough to be walked into.
    bodies.collect([{ x: 10, y: 9.2 } as EntityView], 10, 10, 12, ANY_BODY);
    const shot = straightShot({ x: 7.2, y: 10 }, 0, 8, 0, 3000);

    const plan = new DodgePlanner().plan(situation(), SETTINGS, standingOff(bodies, KEEP_AWAY), [
      shot,
    ]);

    expect(plan.steer).toBe(true);
    // South, which is the other way out of the same shot.
    expect(plan.dirY).toBeGreaterThan(0);
  });

  // **The other half of the same report.** A monster that is already standing
  // in the character is too close for any route the lattice can describe: every
  // walk out of it starts inside it, and a body matching their speed is never
  // outwalked at all. One frame of movement, at once, is the only answer.
  it('hops out from under a monster that is standing in the character', () => {
    const bodies = new EnemyBodies();
    bodies.collect([{ x: 10.3, y: 10 } as EntityView], 10, 10, 12, ANY_BODY);

    const plan = new DodgePlanner().plan(situation(), SETTINGS, standingOff(bodies, KEEP_AWAY), []);

    expect(plan.verdict).toBe('hop');
    expect(plan.hop).toBe(true);
    expect(plan.stepTiles).toBeLessThanOrEqual(MAX_HOP_TILES + 1e-9);
  });

  it('walks rather than hopping while the monster is merely near', () => {
    const bodies = new EnemyBodies();
    bodies.collect([{ x: 11.4, y: 10 } as EntityView], 10, 10, 12, ANY_BODY);

    const plan = new DodgePlanner().plan(situation(), SETTINGS, standingOff(bodies, KEEP_AWAY), []);

    expect(plan.hop).toBe(false);
    expect(plan.verdict).toBe('spacing');
  });

  // **A preference, never a veto.** The only lane out of a volley sometimes runs
  // past a monster, and a planner that refuses it stands in the volley instead.
  it('will walk past a monster to get out of a shot', () => {
    const bodies = new EnemyBodies();
    // Sitting squarely on the northern sidestep.
    bodies.collect([{ x: 10, y: 8.8 } as EntityView], 10, 10, 12, ANY_BODY);
    const shot = straightShot({ x: 7.2, y: 10 }, 0, 8, 0, 3000);

    const plan = new DodgePlanner().plan(situation(), SETTINGS, standingOff(bodies, KEEP_AWAY), [
      shot,
    ]);

    expect(plan.steer).toBe(true);
    expect(plan.impactMs).toBe(Infinity);
  });
});

describe('the step there is no time to walk', () => {
  /** A shot already on top of the player, arriving before a step could finish. */
  const IMMEDIATE = straightShot({ x: 9.6, y: 10 }, 0, 8, 0, 3000);

  it('spends a frame of movement at once when walking is already too late', () => {
    const plan = new DodgePlanner().plan(situation(), SETTINGS, OPEN_GROUND, [IMMEDIATE]);

    expect(plan.verdict).toBe('hop');
    expect(plan.hop).toBe(true);
    expect(plan.steer).toBe(true);
    expect(plan.stepTiles).toBeLessThanOrEqual(MAX_HOP_TILES + 1e-9);
  });

  it('walks, rather than hopping, when there is time to walk', () => {
    const shot = straightShot({ x: 7.2, y: 10 }, 0, 8, 0, 3000);
    const plan = new DodgePlanner().plan(situation(), SETTINGS, OPEN_GROUND, [shot]);

    expect(plan.hop).toBe(false);
  });

  // **What stops it becoming a way of walking.** One frame at the limit is a
  // step the character could have taken; one every frame is a sprint, and the
  // server takes those back.
  it('will not spend another until the cooldown has run', () => {
    const planner = new DodgePlanner();
    expect(planner.plan(situation(), SETTINGS, OPEN_GROUND, [IMMEDIATE]).hop).toBe(true);

    const soon = planner.plan(situation({ nowMs: 1_000_100 }), SETTINGS, OPEN_GROUND, [IMMEDIATE]);
    expect(soon.hop).toBe(false);

    const later = planner.plan(situation({ nowMs: 1_000_500 }), SETTINGS, OPEN_GROUND, [IMMEDIATE]);
    expect(later.hop).toBe(true);
  });

  it('does nothing of the sort while it is switched off', () => {
    const plan = new DodgePlanner().plan(
      situation(),
      { ...SETTINGS, hopEnabled: false },
      OPEN_GROUND,
      [IMMEDIATE],
    );

    expect(plan.hop).toBe(false);
    expect(plan.verdict).toBe('unavoidable');
  });

  // Priced rather than forbidden, so a fight with no way out still has a best
  // answer instead of an exhausted open list and a special case to go with it.
  it('still answers when every way out is hit', () => {
    const wall: DodgeShot[] = [];
    for (let y = 4; y <= 16; y += 0.5) wall.push(straightShot({ x: 8.6, y }, 0, 12, 0, 3000));

    const plan = new DodgePlanner().plan(
      situation(),
      { ...SETTINGS, hopEnabled: false },
      OPEN_GROUND,
      wall,
    );

    expect(plan.verdict).toBe('unavoidable');
    expect(plan.impactMs).toBeLessThan(Infinity);
  });
});

describe('what to say to the module', () => {
  function planOf(overrides: Partial<DodgePlan> = {}): DodgePlan {
    return {
      verdict: 'weave',
      steer: true,
      dirX: 0,
      dirY: -1,
      stepTiles: 0.55,
      hop: false,
      impactMs: Infinity,
      clearanceTiles: 1,
      crowded: false,
      trackedShots: 1,
      trackedBlasts: 0,
      expansions: 40,
      ...overrides,
    };
  }

  const REQUEST = {
    intent: undefined as Position | undefined,
    speedTilesPerSecond: WALK,
    fullSpeedTilesPerSecond: 6,
    cancelIntent: true,
    holdMs: 120,
  };

  it('says nothing when the plan is not to steer', () => {
    expect(walkCommand({ ...REQUEST, plan: planOf({ steer: false }) })).toBeUndefined();
  });

  it('walks no further than the step the plan chose', () => {
    const command = walkCommand({ ...REQUEST, plan: planOf() });

    expect(command).toBeDefined();
    expect(Math.hypot(command?.offsetX ?? 0, command?.offsetY ?? 0)).toBeCloseTo(0.55, 6);
    expect(command?.hop).toBe(false);
  });

  // Taking the wheel means cancelling their input rather than adding to it: the
  // module's step lands on top of the game's own movement, so the two agreeing
  // about a direction used to travel at both speeds at once.
  it('subtracts what the player is contributing', () => {
    const intent = { x: 0, y: -1 };
    const command = walkCommand({ ...REQUEST, intent, plan: planOf({ dirX: 1, dirY: 0 }) });

    expect(command).toBeDefined();
    expect((command?.offsetY ?? 0) * intent.y).toBeLessThan(0);
  });

  it('says nothing when what they are already doing is the plan', () => {
    const intent = { x: 0, y: -1 };
    expect(walkCommand({ ...REQUEST, intent, plan: planOf() })).toBeUndefined();
  });

  // **Standing still deliberately, against a player walking somewhere that costs
  // them.** There is no step to correct — the correction *is* the command.
  it('turns their own input around when the plan is to stand', () => {
    const intent = { x: 1, y: 0 };
    const command = walkCommand({
      ...REQUEST,
      intent,
      plan: planOf({ dirX: 0, dirY: 0, stepTiles: 0 }),
    });

    expect(command).toBeDefined();
    expect(command?.offsetX).toBeLessThan(0);
  });

  it('has nothing to say about standing still while nobody is steering', () => {
    expect(
      walkCommand({ ...REQUEST, plan: planOf({ dirX: 0, dirY: 0, stepTiles: 0 }) }),
    ).toBeUndefined();
  });

  // A shove rather than a sidestep, and worth the margin the ordinary speed
  // keeps in hand — the whole complaint is that monsters get close anyway.
  it('spends the whole of the character speed on a shove', () => {
    const command = walkCommand({ ...REQUEST, plan: planOf({ crowded: true }) });
    expect(command?.speedTilesPerSecond).toBeCloseTo(6, 6);
  });

  // **The hop is not adjusted for what they are pressing.** It is a single
  // frame, and the module already subtracts their own walking from what it
  // carries — from the position only it can see.
  it('passes a hop through exactly, at the speed one frame needs', () => {
    const intent = { x: 0, y: -1 };
    const command = walkCommand({
      ...REQUEST,
      intent,
      plan: planOf({ hop: true, dirX: 0, dirY: -1, stepTiles: 0.7 }),
    });

    expect(command?.hop).toBe(true);
    expect(command?.offsetY).toBeCloseTo(-0.7, 6);
    expect(command?.speedTilesPerSecond).toBe(HOP_SPEED_TILES_PER_SECOND);
  });
});

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

  // **A distance rather than a verdict, and that is what a hard rule needs.**
  // Refusing to enter a pool says nothing about hugging its edge, so the
  // planner has to be able to ask how far off one a place is.
  it('says how far the body is from the nearest ground that hurts', () => {
    // The pool is tile (5, 5); the body is a shade under half a tile across.
    const clear = 0.5 - PLAYER_ENVIRONMENT_HALF_TILES;

    // Squarely on it.
    expect(pool().hazardGap(5.5, 5.5, 2)).toBeCloseTo(-PLAYER_ENVIRONMENT_HALF_TILES - 0.5, 6);
    // One tile west, so the gap is the tile edge less the body's own reach.
    expect(pool().hazardGap(4.5, 5.5, 2)).toBeCloseTo(clear, 6);
    // Two tiles west, a whole tile further off.
    expect(pool().hazardGap(3.5, 5.5, 2)).toBeCloseTo(clear + 1, 6);
    // And nothing at all when the pool is past the distance asked about.
    expect(pool().hazardGap(30, 30, 2)).toBe(Infinity);
  });

  it('measures the diagonal the way the collision does, by the wider axis', () => {
    // A tile up and a tile across: the gap is the larger of the two, not the
    // straight-line distance, because that is the shape both boxes are.
    const straightOn = pool().hazardGap(4.5, 5.5, 3);
    expect(pool().hazardGap(4.5, 4.5, 3)).toBeCloseTo(straightOn, 6);
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

  // **A different question from how crowded a place is, and the setting cannot
  // answer it.** How much room to dodge in is a preference somebody chose;
  // whether a monster is standing *in* you is a fact about two bodies, and it
  // is the one the game charges contact damage for.
  it('says when a body is standing in the character, whatever the setting says', () => {
    const bodies = new EnemyBodies();
    bodies.collect([{ x: 0.4, y: 0 } as EntityView], 0, 0, 10, ANY_BODY);
    const overlap = ENEMY_CONTACT_HALF_TILES + PLAYER_HALF_TILES - 0.4;

    expect(bodies.contactAt(0, 0)).toBeCloseTo(overlap, 6);
    // Nought everywhere they are apart, so "is this place occupied" needs no
    // second threshold — and unchanged by a keep-away distance it never reads.
    expect(bodies.contactAt(3, 0)).toBe(0);
    expect(bodies.crowdingAt(0, 0, 6)).toBeGreaterThan(bodies.contactAt(0, 0));
  });

  it('carries a body forward before asking whether it is touching', () => {
    const bodies = new EnemyBodies();
    bodies.collect([{ x: 2, y: 0 } as EntityView], 0, 0, 12, chasing(-6, 0));

    expect(bodies.contactAt(0, 0)).toBe(0);
    expect(bodies.contactAt(0, 0, 250)).toBeGreaterThan(0);
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
    /** The same, spent on one frame. See `Hop.ts`. */
    hopBy: ReturnType<typeof vi.fn>;
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
      /**
       * The one shot in flight, for a test whose geometry has to be its own.
       *
       * The default is deliberately marginal — a shot arriving just inside the
       * reaction window, which is what most of these are about — and a test
       * asking whether the planner *leaves somebody alone* needs the opposite:
       * a course with room to spare, so that what it measures is the decision
       * rather than a hundredth of a tile.
       */
      shot?: ProjectileView;
    } = {},
  ): Harness {
    const moveTo = vi.fn();
    const moveBy = vi.fn();
    const hopBy = vi.fn();
    const showPicture = vi.fn();
    const cursor: { target: Position | undefined } = { target: undefined };
    const steer: { direction: Position | undefined } = { direction: undefined };
    const view = { on: false };
    // Fired ten tiles west of the player and travelling east at eight tiles a
    // second, so it reaches them a little over a second later.
    const shot = map.shot ?? straightShot({ x: 0, y: 10 }, 0, 8, 0, 2000);

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
        output: { moveTo, moveBy, hopBy, showPicture },
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
      hopBy,
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

  /** How wide the last published picture drew the first monster. */
  function bodyRadius(showPicture: ReturnType<typeof vi.fn>): number {
    const marks = (showPicture.mock.lastCall?.[1] ?? []) as DodgeMark[];
    return marks.find((mark) => mark.kind === DodgeMarkKind.Body)?.radiusTiles ?? 0;
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
    // Fast and far, so that stepping out of its line has room to spare: a slow
    // shot close by is one a walking player clears by a hair, and whether the
    // planner tidies that up is a question about hundredths of a tile rather
    // than about who is driving. See {@link ACROSS_THE_ROOM}.
    const { moveBy, plan, steer } = underFire(0, {
      shot: ACROSS_THE_ROOM as unknown as ProjectileView,
    });
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

  // **A hop is a different record, and it has to be.** An offset is resolved
  // from wherever the character is on the frame it lands, so one left standing
  // is carried again on every frame of the hold — which is a sprint, not the
  // single step the planner chose.
  it('sends the emergency step as a record the module spends once', () => {
    // At 1200 ms the shot is at the player's feet: it lands before a step of
    // walking could finish, which is the only case a hop is for.
    const { moveBy, hopBy, plan } = underFire(1_200);

    plan();

    expect(hopBy).toHaveBeenCalledTimes(1);
    expect(moveBy).not.toHaveBeenCalled();
    const [offsetX, offsetY, speed] = hopBy.mock.calls[0] as [number, number, number, number];
    expect(Math.hypot(offsetX, offsetY)).toBeLessThanOrEqual(MAX_HOP_TILES + 1e-9);
    expect(speed).toBe(HOP_SPEED_TILES_PER_SECOND);
  });

  it('never hops while the emergency step is switched off', () => {
    const { host, hopBy, plan } = underFire(1_200);
    host.settingsOf('auto-dodge')?.apply('hopEnabled', false);

    plan();

    expect(hopBy).not.toHaveBeenCalled();
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
    // answer that shot. The reaction reach at least, with nobody else about.
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

  // **The live report: on the picture the monster moves in about ten frames.**
  // Where a body is, is not known — it is inferred from two sightings a fifth of
  // a second apart, and the inference ages. Widening it by that age is what
  // stops a route being planned through a place the runtime merely *believes*
  // is empty, and drawing it that wide is what makes the two agree.
  it('draws a monster wider the older the reading behind it is', () => {
    const monster = { objectId: 9, objectType: 500, x: 14, y: 10, hp: 4000, maxHp: 4000 };
    const { plan, tick, clock, showPicture, view } = underFire(0, {
      enemies: [monster as EntityView],
    });
    view.on = true;

    tick();
    plan();
    const fresh = bodyRadius(showPicture);
    expect(fresh).toBeGreaterThan(0);

    // Most of a server tick later, with nothing new said about it. Twice,
    // because the picture goes out slower than a plan is made.
    clock.ms = 190;
    plan();
    plan();

    expect(bodyRadius(showPicture)).toBeGreaterThan(fresh);
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

  // **Standing beside a pool is not standing in one.** The margin keeps *routes*
  // well clear of lava; reading "am I in it" off that same widened answer would
  // have the planner hauling a player off ground that is costing them nothing,
  // every time they chose to fight at the edge of one.
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

  // **Out the fast way once they are actually in it.** Walking out costs a tick
  // of health per step, and the record the module spends on one frame costs
  // none — which is the whole reason a hop is not only about bullets.
  it('hops them out of it once they are actually in it', () => {
    const { hopBy, moveBy, plan } = underFire(0, { damagingAt: (x) => x >= 10 });

    plan();

    expect(hopBy).toHaveBeenCalled();
    expect(moveBy).not.toHaveBeenCalled();
    const [offsetX] = hopBy.mock.calls[0] as [number, number];
    expect(offsetX).toBeLessThan(0);
  });

  it('walks them out instead when the emergency step is switched off', () => {
    const { host, hopBy, moveBy, plan } = underFire(0, { damagingAt: (x) => x >= 10 });
    host.settingsOf('auto-dodge')?.apply('hopEnabled', false);

    plan();

    expect(hopBy).not.toHaveBeenCalled();
    expect(moveBy).toHaveBeenCalled();
    const [offsetX] = moveBy.mock.calls[0] as [number, number];
    expect(offsetX).toBeLessThan(0);
  });

  // **A dozen numbers is homework, not a feature.** They all earn their place
  // and almost nobody wants to answer them, so the panel asks one question and
  // files the rest under Advanced.
  describe('the presets', () => {
    function settingsOf(): SettingsRegistry {
      const { host } = underFire(0);
      const settings = host.settingsOf('auto-dodge');
      if (settings === undefined) throw new Error('the plugin declared no settings');
      return settings;
    }

    it('puts everything behind Advanced except the question and the emergency', () => {
      const everyday = settingsOf()
        .descriptors()
        .filter((setting) => setting.advanced !== true);

      expect(everyday.map((setting) => setting.key)).toEqual(['preset', 'hopEnabled']);
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
      const relaxed = underFire(750);
      relaxed.host.settingsOf('auto-dodge')?.apply('preset', DodgePresetId.Relaxed);
      relaxed.plan();
      // Three hundred milliseconds of window: at 750 ms the shot is four tiles
      // out and half a second from landing, which is nobody's problem yet.
      expect(relaxed.moveBy).not.toHaveBeenCalled();

      const cautious = underFire(750);
      cautious.host.settingsOf('auto-dodge')?.apply('preset', DodgePresetId.Cautious);
      cautious.plan();
      expect(cautious.moveBy).toHaveBeenCalled();
    });
  });
});

/** The twelve numbers a preset owns, read back out of a live registry. */
function readTuning(settings: SettingsRegistry): DodgeTuning {
  const values = settings.values();
  const number = (key: string): number => {
    const value = values[key];
    if (typeof value !== 'number') throw new Error(`${key} is not a number`);
    return value;
  };
  return {
    horizonMs: number('horizonMs'),
    tickMs: number('tickMs'),
    reactWithinMs: number('reactWithinMs'),
    headings: number('headings'),
    hitScale: number('hitScale'),
    padTiles: number('latencyPadTiles'),
    driftTilesPerSecond: number('driftTilesPerSecond'),
    safeClearanceTiles: number('safeClearanceTiles'),
    holdGroundWeight: number('holdGroundWeight'),
    greed: number('greed'),
    maxExpansions: number('maxExpansions'),
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
          hopBy: () => undefined,
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
