import { describe, expect, it } from 'vitest';
import type { ProjectileDefinition } from '../src/gamedata/projectiles.js';
import { ProjectileStore } from '../src/state/projectiles/ProjectileStore.js';
import { positionAt } from '../src/state/projectiles/positionAt.js';

/** A straight shot: 10 000 speed units is exactly one tile per millisecond. */
function definition(overrides: Partial<ProjectileDefinition> = {}): ProjectileDefinition {
  return {
    bulletType: 0,
    speed: 10_000,
    lifetimeMs: 1000,
    damage: 50,
    size: 100,
    collisionMult: 1,
    wavy: false,
    multiHit: false,
    passesCover: false,
    parametric: false,
    boomerang: false,
    amplitude: 0,
    frequency: 0,
    magnitude: 0,
    acceleration: 0,
    accelerationDelayMs: 0,
    speedClamp: 0,
    turnRate: 0,
    ...overrides,
  };
}

const ORIGIN = { bulletId: 0, x: 10, y: 20, angle: 0 };

describe('positionAt', () => {
  it('travels in a straight line at the speed the file states', () => {
    const straight = definition();
    expect(positionAt(straight, ORIGIN, 0)).toEqual({ x: 10, y: 20 });
    expect(positionAt(straight, ORIGIN, 500)).toEqual({ x: 510, y: 20 });
  });

  it('follows the angle it was fired at', () => {
    const at = positionAt(definition(), { ...ORIGIN, angle: Math.PI / 2 }, 100);
    expect(at?.x).toBeCloseTo(10);
    expect(at?.y).toBeCloseTo(120);
  });

  it('stops existing once its lifetime is over', () => {
    const straight = definition({ lifetimeMs: 1000 });
    expect(positionAt(straight, ORIGIN, 1000)).toBeDefined();
    // Gone is different from "at its last position".
    expect(positionAt(straight, ORIGIN, 1001)).toBeUndefined();
    expect(positionAt(straight, ORIGIN, -1)).toBeUndefined();
  });

  it('turns a boomerang around at half its lifetime', () => {
    const boomerang = definition({ boomerang: true, lifetimeMs: 1000 });
    const out = positionAt(boomerang, ORIGIN, 250);
    const far = positionAt(boomerang, ORIGIN, 500);
    const back = positionAt(boomerang, ORIGIN, 750);
    const home = positionAt(boomerang, ORIGIN, 1000);

    expect(far!.x).toBeGreaterThan(out!.x);
    expect(back!.x).toBeCloseTo(out!.x);
    expect(home!.x).toBeCloseTo(ORIGIN.x);
  });

  it('gives alternating bullets opposite phases, which is what fans a volley out', () => {
    // Dropping the parity collapses a spread into a single line — the one thing
    // a dodge cannot afford to get wrong.
    const wavy = definition({ wavy: true });
    const even = positionAt(wavy, { ...ORIGIN, bulletId: 0 }, 120);
    const odd = positionAt(wavy, { ...ORIGIN, bulletId: 1 }, 120);
    expect(even!.y).not.toBeCloseTo(odd!.y);
  });

  it('offsets a sine shot sideways, not along its path', () => {
    const sine = definition({ amplitude: 2, frequency: 1, lifetimeMs: 1000 });
    const at = positionAt(sine, ORIGIN, 250);
    // A quarter through, the lateral offset is at its peak; along-track
    // distance is unchanged.
    expect(at!.x).toBeCloseTo(10 + 250);
    expect(at!.y).toBeCloseTo(20 + 2);
  });

  it('sweeps a parametric shot through a closed figure', () => {
    const parametric = definition({ parametric: true, magnitude: 3, lifetimeMs: 1000 });
    // A figure of eight: it leaves the origin, moves in both axes, and comes
    // back to where it started at the end of its life.
    expect(positionAt(parametric, ORIGIN, 0)).toEqual({ x: 10, y: 20 });

    const eighth = positionAt(parametric, ORIGIN, 125);
    expect(eighth!.x).toBeCloseTo(10 - 3 * Math.SQRT1_2);
    expect(eighth!.y).toBeCloseTo(23);

    const end = positionAt(parametric, ORIGIN, 1000);
    expect(end!.x).toBeCloseTo(10);
    expect(end!.y).toBeCloseTo(20);
  });

  it('refuses a definition that says nothing about how long it lives', () => {
    expect(positionAt(definition({ lifetimeMs: 0 }), ORIGIN, 0)).toBeUndefined();
  });
});

describe('ProjectileStore', () => {
  it('tracks a shot and answers where it is', () => {
    const store = new ProjectileStore();
    expect(
      store.add(definition(), {
        ownerId: 1,
        bulletId: 0,
        bulletType: 0,
        x: 0,
        y: 0,
        angle: 0,
        firedAtMs: 1000,
      }),
    ).toBe(true);

    const [shot] = [...store.values(1000)];
    expect(shot?.ownerId).toBe(1);
    expect(shot?.damage).toBe(50);
    expect(shot?.positionAt(1500)).toEqual({ x: 500, y: 0 });
  });

  it('does not track a shot it has no definition for', () => {
    const store = new ProjectileStore();
    // Tracking it as a straight line would be worse than not tracking it: a
    // dodge would then confidently avoid the wrong curve.
    expect(
      store.add(undefined, {
        ownerId: 1,
        bulletId: 0,
        bulletType: 0,
        x: 0,
        y: 0,
        angle: 0,
        firedAtMs: 0,
      }),
    ).toBe(false);
    expect(store.size).toBe(0);
  });

  it('forgets a shot once its lifetime is over', () => {
    const store = new ProjectileStore();
    store.add(definition({ lifetimeMs: 500 }), {
      ownerId: 1,
      bulletId: 0,
      bulletType: 0,
      x: 0,
      y: 0,
      angle: 0,
      firedAtMs: 0,
    });

    expect([...store.values(400)]).toHaveLength(1);
    expect([...store.values(600)]).toHaveLength(0);
    expect(store.size).toBe(0);
  });

  it('keeps shots from different shooters apart, even with the same bullet id', () => {
    const store = new ProjectileStore();
    store.add(definition(), {
      ownerId: 1,
      bulletId: 7,
      bulletType: 0,
      x: 0,
      y: 0,
      angle: 0,
      firedAtMs: 0,
    });
    store.add(definition(), {
      ownerId: 2,
      bulletId: 7,
      bulletType: 0,
      x: 5,
      y: 5,
      angle: 0,
      firedAtMs: 0,
    });

    expect(store.size).toBe(2);
  });

  // A lifetime is when a shot runs out, not when it stops existing. Most end
  // early, by landing — and the client is what decides that, which is why it is
  // an outgoing packet that says so.
  it('forgets a shot the client says has hit something', () => {
    const store = new ProjectileStore();
    store.add(definition(), {
      ownerId: 4,
      bulletId: 9,
      bulletType: 0,
      x: 0,
      y: 0,
      angle: 0,
      firedAtMs: 0,
    });

    expect(store.retire(4, 9, false)).toBe(true);
    expect(store.size).toBe(0);
    expect(store.retire(4, 9, false)).toBe(false);
  });

  it('keeps a shot that goes through whatever it just hit', () => {
    const store = new ProjectileStore();
    const shot = {
      ownerId: 4,
      bulletId: 9,
      bulletType: 0,
      x: 0,
      y: 0,
      angle: 0,
      firedAtMs: 0,
    };
    store.add(definition({ multiHit: true }), shot);
    expect(store.retire(4, 9, false)).toBe(false);
    // It passes through people, not through walls.
    expect(store.retire(4, 9, true)).toBe(true);

    store.add(definition({ passesCover: true }), shot);
    expect(store.retire(4, 9, true)).toBe(false);
    expect(store.retire(4, 9, false)).toBe(true);
  });

  it('matches a bullet id the wire declared signed', () => {
    const store = new ProjectileStore();
    // `ENEMYSHOOT` and `PLAYERHIT` both declare it signed, so an id past
    // 0x7fff arrives negative on both — and `OTHERHIT` declares it unsigned, so
    // the same shot comes back positive. One masked key answers all three.
    store.add(definition(), {
      ownerId: 4,
      bulletId: -2,
      bulletType: 0,
      x: 0,
      y: 0,
      angle: 0,
      firedAtMs: 0,
    });

    expect(store.retire(4, 0xfffe, false)).toBe(true);
  });

  it('clears everything, as a map change requires', () => {
    const store = new ProjectileStore();
    store.add(definition(), {
      ownerId: 1,
      bulletId: 0,
      bulletType: 0,
      x: 0,
      y: 0,
      angle: 0,
      firedAtMs: 0,
    });
    store.clear();
    expect(store.size).toBe(0);
  });
});
