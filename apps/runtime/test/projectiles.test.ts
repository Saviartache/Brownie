import { describe, expect, it } from 'vitest';
import type { ProjectileDefinition } from '../src/gamedata/projectiles.js';
import { flightEndMs } from '../src/state/projectiles/flightEnd.js';
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

  it('integrates acceleration after its delay and stops at the speed clamp', () => {
    const accelerating = definition({
      speed: 100,
      lifetimeMs: 30_000,
      acceleration: 100,
      accelerationDelayMs: 1000,
      speedClamp: 300,
    });

    expect(positionAt(accelerating, ORIGIN, 1000)?.x).toBeCloseTo(20);
    expect(positionAt(accelerating, ORIGIN, 2000)?.x).toBeCloseTo(35);
    expect(positionAt(accelerating, ORIGIN, 4000)?.x).toBeCloseTo(90);
  });

  it('integrates deceleration without moving past the speed clamp', () => {
    const braking = definition({
      speed: 300,
      lifetimeMs: 30_000,
      acceleration: -100,
      accelerationDelayMs: 1000,
      speedClamp: 100,
    });

    expect(positionAt(braking, ORIGIN, 2000)?.x).toBeCloseTo(65);
    expect(positionAt(braking, ORIGIN, 4000)?.x).toBeCloseTo(90);
    expect(positionAt(braking, ORIGIN, 20_000)?.x).toBeCloseTo(250);
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

describe('flightEndMs', () => {
  /** A tenth of a tile every ten milliseconds, so ten tiles is its whole life. */
  const SLOW = definition({ speed: 100, lifetimeMs: 1000 });
  const WEST_TO_EAST = { bulletId: 0, x: 0.5, y: 0.5, angle: 0 };
  const wallAt =
    (at: number) =>
    (tileX: number): boolean =>
      tileX === at;

  it('lets a shot with nothing in its way live out its lifetime', () => {
    expect(flightEndMs(SLOW, WEST_TO_EAST, () => false)).toBe(1000);
  });

  // The bullet was five tiles from the wall's near edge, which is four and a
  // half tiles of flight at a hundredth of a tile a millisecond.
  it('ends the flight at the wall rather than at the lifetime', () => {
    const end = flightEndMs(SLOW, WEST_TO_EAST, wallAt(5));

    expect(end).toBeGreaterThan(400);
    expect(end).toBeLessThan(450);
    // And the shot is nowhere inside the wall it died against.
    expect(positionAt(SLOW, WEST_TO_EAST, end)!.x).toBeLessThan(5);
  });

  // Monsters stand in doorways, on the far side of destructibles and inside the
  // objects they guard. A shot deleted at its own muzzle is a shot nothing ever
  // dodges, which is the one failure worse than the one this fixes.
  it('is never stopped by the square it was fired from', () => {
    expect(flightEndMs(SLOW, WEST_TO_EAST, wallAt(0))).toBe(1000);
  });

  it('flies a shot that passes cover straight through the wall', () => {
    const ghost = definition({ speed: 100, lifetimeMs: 1000, passesCover: true });
    expect(flightEndMs(ghost, WEST_TO_EAST, wallAt(5))).toBe(1000);
  });

  // The path this would walk is not the path the bullet takes, so a wall found
  // along it is a wall the shot was never going to reach. Believing a shot too
  // long costs a sidestep; deleting a live one costs the run.
  it('leaves a shot whose curve is not modelled alone', () => {
    const turning = definition({ speed: 100, lifetimeMs: 1000, turnRate: 90 });
    expect(flightEndMs(turning, WEST_TO_EAST, wallAt(5))).toBe(1000);
  });

  it('does not let an accelerating shot skip a wall between samples', () => {
    const accelerating = definition({
      speed: 100,
      lifetimeMs: 1000,
      acceleration: 100,
      speedClamp: 300,
    });

    expect(flightEndMs(accelerating, WEST_TO_EAST, wallAt(5))).toBeLessThan(1000);
  });

  // A boomerang turns round at the halfway point and retraces its path, so the
  // wall it meets is the one on the way out.
  it('walks the path the shot really takes, not the line it points along', () => {
    const boomerang = definition({ speed: 100, lifetimeMs: 1000, boomerang: true });
    // It only ever reaches five tiles out, so a wall six tiles away is one it
    // never touches.
    expect(flightEndMs(boomerang, WEST_TO_EAST, wallAt(7))).toBe(1000);
    expect(flightEndMs(boomerang, WEST_TO_EAST, wallAt(3))).toBeLessThan(500);
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
    expect(shot?.maxSpeedTilesPerSecond).toBe(1000);
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

  // **The live report: it keeps dodging bullets that are already gone.** The
  // client tells the server about a shot it destroyed against the map, but only
  // about the ones it bothered to resolve and only a round trip later — so the
  // store works the wall out for itself, once, when the shot is announced.
  it('stops a shot at the wall it flies into, for everyone reading it', () => {
    const store = new ProjectileStore((tileX) => tileX === 5);
    store.add(definition({ speed: 100, lifetimeMs: 1000 }), {
      ownerId: 4,
      bulletId: 0,
      bulletType: 0,
      x: 0.5,
      y: 0.5,
      angle: 0,
      firedAtMs: 1000,
    });

    const [shot] = [...store.values(1000)];
    expect(shot?.expiresAtMs).toBeLessThan(1450);
    // Nothing predicts it past the wall — which is what the drawn path and the
    // threat field are both built out of.
    expect(shot?.positionAt(1500)).toBeUndefined();
    // And it is gone from the store by the time it would have got there.
    expect([...store.values(1500)]).toHaveLength(0);
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
