/**
 * How far round a turret its own next shot is out of reach of a step aside.
 *
 * A spawner, a turret or a trap that can never be hurt is no body to keep room
 * from, and most of them are drawn as nothing — so the planner walked straight
 * onto them, and a shot fired from where the character stands is inside them
 * before anything can answer it. These tests hold the arithmetic that decides
 * how much ground round one is refused: the shot's own square, carried as far as
 * the game's own motion code flies it in a command lead and a step aside.
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_POINT_BLANK_TILES,
  PointBlankReach,
  type PointBlankTiming,
} from '../src/features/dodge/PointBlank.js';
import type { ProjectileDefinition } from '../src/gamedata/projectiles.js';
import { projectileDefinition } from './fakes.js';

/**
 * Sixty milliseconds of lead and a character that steps aside at five tiles a
 * second, which is round numbers near where the plugin runs by default. With
 * the planner's own pad on a standard square, getting out of one takes 120 ms
 * after the lead — so the shots below are judged over 180 ms of their flight.
 */
const TIMING: PointBlankTiming = {
  leadMs: 60,
  walkTilesPerSecond: 5,
  hitScale: 1,
  padTiles: 0.1,
};

/** A standard square with the planner's pad on it. */
const HALF = 0.6;

const TURRET = 800;

/** Eight tiles a second, which is an ordinary enemy shot. */
const EIGHT_A_SECOND = projectileDefinition({ speed: 80, lifetimeMs: 2000, damage: 60 });

/** One that sits where it was fired for its whole life — a damage field. */
const STANDING = projectileDefinition({ speed: 0, lifetimeMs: 2000, damage: 60 });

function reachOf(
  shots: readonly ProjectileDefinition[],
  timing: PointBlankTiming = TIMING,
  speedMultiplier = 1,
): number {
  const reach = new PointBlankReach((type) => (type === TURRET ? shots : []));
  return reach.radiusOf(TURRET, speedMultiplier, timing);
}

describe('point blank', () => {
  // Standing in its square is a hit whatever anybody does; the disc has to
  // cover the square's corners, so it is the square circumscribed.
  it('is the square itself, circumscribed, for a shot that never moves', () => {
    expect(reachOf([STANDING])).toBeCloseTo(HALF * Math.SQRT2, 5);
  });

  it('carries the square as far as the shot gets while the step aside is made', () => {
    // 180 ms at eight tiles a second.
    expect(reachOf([EIGHT_A_SECOND])).toBeCloseTo(HALF + 1.44, 5);
  });

  it('is further for a character who takes longer to step aside', () => {
    const slow = reachOf([EIGHT_A_SECOND], { ...TIMING, walkTilesPerSecond: 3 });
    // 60 ms of lead and 200 ms of stepping.
    expect(slow).toBeCloseTo(HALF + 8 * 0.26, 5);
    expect(slow).toBeGreaterThan(reachOf([EIGHT_A_SECOND]));
  });

  it('is further for a longer command lead', () => {
    expect(reachOf([EIGHT_A_SECOND], { ...TIMING, leadMs: 160 })).toBeCloseTo(HALF + 8 * 0.28, 5);
  });

  // **A speed times a time is the wrong answer for a fifth of what these
  // things fire.** The orbs are written with no launch speed at all and an
  // acceleration that takes them to their clamp almost at once; read off the
  // speed, they would be standing still.
  it('flies the shot the way the game does, so one that starts still is not a standstill', () => {
    const snapping = projectileDefinition({
      speed: 0,
      acceleration: 999_999,
      speedClamp: 80,
      lifetimeMs: 2000,
      damage: 60,
    });
    expect(reachOf([snapping])).toBeCloseTo(HALF + 1.44, 2);
  });

  it('counts a shot that flies backwards as far as it flies', () => {
    const backwards = projectileDefinition({ speed: -40, lifetimeMs: 2000, damage: 60 });
    expect(reachOf([backwards])).toBeCloseTo(HALF + 4 * 0.18, 5);
  });

  it('stops counting once the shot is gone', () => {
    const short = projectileDefinition({ speed: 80, lifetimeMs: 100, damage: 60 });
    // A tenth of a second at eight tiles a second, and no further.
    expect(reachOf([short])).toBeCloseTo(HALF + 0.8, 5);
  });

  it('takes the widest of everything the type fires', () => {
    expect(reachOf([STANDING, EIGHT_A_SECOND])).toBeCloseTo(reachOf([EIGHT_A_SECOND]), 10);
  });

  it('judges the square the way the planner does', () => {
    // Twice the size, and the same pad on top.
    expect(reachOf([STANDING], { ...TIMING, hitScale: 2 })).toBeCloseTo(1.1 * Math.SQRT2, 5);
  });

  it('flies faster for an owner that speeds its shots up', () => {
    const plain = reachOf([EIGHT_A_SECOND]);
    const quicker = reachOf([EIGHT_A_SECOND], TIMING, 1.5);
    expect(quicker - HALF).toBeCloseTo((plain - HALF) * 1.5, 5);
  });

  // **The helpers fire arrows and chains ahead of the real attack**, and a
  // disc round a picture is a wall round nothing. What decides it is the
  // game's own data: a square nothing overlaps, or no harm in it at all.
  it('keeps no distance from shots that cannot hurt anybody', () => {
    expect(reachOf([projectileDefinition({ collisionMult: 0, damage: 60 })])).toBe(0);
    expect(reachOf([projectileDefinition({ speed: 200, damage: 0 })])).toBe(0);
    // Nor from one with no lifetime, which the client never tracks at all.
    expect(reachOf([projectileDefinition({ lifetimeMs: 0, damage: 60 })])).toBe(0);
    // A condition is harm enough, whatever the damage says.
    expect(
      reachOf([projectileDefinition({ speed: 0, damage: 0, debuffSeverity: 0.5 })]),
    ).toBeCloseTo(HALF * Math.SQRT2, 5);
  });

  it('is a margin and never a wall, however fast the shot', () => {
    expect(reachOf([projectileDefinition({ speed: 600, damage: 60 })])).toBe(MAX_POINT_BLANK_TILES);
  });

  it('times a character that cannot walk as the slowest one that can', () => {
    const still = reachOf([EIGHT_A_SECOND], { ...TIMING, walkTilesPerSecond: 0 });
    expect(Number.isFinite(still)).toBe(true);
    expect(still).toBe(MAX_POINT_BLANK_TILES);
  });

  // The catalog is read from disk while sessions are already running, so a
  // type it has not described yet is one it will describe a moment later.
  it('says nothing about a type the catalog has not described, and asks again later', () => {
    let loaded = false;
    const reach = new PointBlankReach((type) =>
      loaded && type === TURRET ? [EIGHT_A_SECOND] : [],
    );

    expect(reach.radiusOf(TURRET, 1, TIMING)).toBe(0);
    loaded = true;
    expect(reach.radiusOf(TURRET, 1, TIMING)).toBeCloseTo(HALF + 1.44, 5);
  });

  it('works a type out once, and a harmless one is settled as harmless', () => {
    let asked = 0;
    const picture = projectileDefinition({ damage: 0 });
    const reach = new PointBlankReach(() => {
      asked += 1;
      return [picture];
    });

    expect(reach.radiusOf(TURRET, 1, TIMING)).toBe(0);
    expect(reach.radiusOf(TURRET, 1, TIMING)).toBe(0);
    expect(asked).toBe(1);
  });
});
