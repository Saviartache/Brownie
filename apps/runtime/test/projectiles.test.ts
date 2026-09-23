import { describe, expect, it } from 'vitest';
import type { ProjectileDefinition } from '../src/gamedata/projectiles.js';
import { flightEndMs, type StopsShots } from '../src/state/projectiles/flightEnd.js';
import { ProjectileStore, type AnnouncedShot } from '../src/state/projectiles/ProjectileStore.js';
import {
  ShotMotion,
  clientBulletId,
  staysPut,
  statMultiplier,
  type ShotLaunch,
} from '../src/state/projectiles/ShotMotion.js';
import { projectileDefinition } from './fakes.js';

/**
 * A straight shot: the file's speed is tenths of a tile a second, so the
 * default 10 000 is exactly one tile a millisecond.
 */
const definition = projectileDefinition;

const ORIGIN: ShotLaunch = {
  bulletId: 0,
  x: 10,
  y: 20,
  angle: 0,
  speedMultiplier: 1,
  lifetimeMultiplier: 1,
};

function motion(overrides: Partial<ProjectileDefinition> = {}, launch: Partial<ShotLaunch> = {}) {
  return new ShotMotion(definition(overrides), { ...ORIGIN, ...launch });
}

describe('ShotMotion', () => {
  it('travels in a straight line at the speed the file states', () => {
    const straight = motion();
    expect(straight.positionAt(0)).toEqual({ x: 10, y: 20 });
    expect(straight.positionAt(500)).toEqual({ x: 510, y: 20 });
  });

  it('follows the angle it was fired at', () => {
    const at = motion({}, { angle: Math.PI / 2 }).positionAt(100);
    expect(at?.x).toBeCloseTo(10);
    expect(at?.y).toBeCloseTo(120);
  });

  // Stats 102 and 103, which the game reads off the owner the moment it fires.
  it('flies as fast and as long as its owner made it', () => {
    const quick = motion({}, { speedMultiplier: 1.2 });
    expect(quick.positionAt(500)?.x).toBeCloseTo(610);

    const lasting = motion({}, { lifetimeMultiplier: 1.5 });
    expect(lasting.lifetimeMs).toBe(1500);
    expect(lasting.positionAt(1400)).toBeDefined();
    expect(lasting.positionAt(1501)).toBeUndefined();
  });

  it('accelerates after its delay until it reaches its clamp', () => {
    // Ten tiles a second, gaining ten a second after one second, up to thirty.
    const accelerating = motion({
      speed: 100,
      lifetimeMs: 30_000,
      acceleration: 100,
      accelerationDelayMs: 1000,
      speedClamp: 300,
    });
    expect(accelerating.positionAt(1000)?.x).toBeCloseTo(20);
    expect(accelerating.positionAt(2000)?.x).toBeCloseTo(35);
    // Two seconds to gain its twenty, then thirty a second.
    expect(accelerating.positionAt(4000)?.x).toBeCloseTo(90);
  });

  it('brakes after its delay until it reaches its clamp', () => {
    const braking = motion({
      speed: 300,
      lifetimeMs: 30_000,
      acceleration: -100,
      accelerationDelayMs: 1000,
      speedClamp: 100,
    });
    expect(braking.positionAt(2000)?.x).toBeCloseTo(65);
    expect(braking.positionAt(4000)?.x).toBeCloseTo(90);
    expect(braking.positionAt(20_000)?.x).toBeCloseTo(250);
  });

  // Eighty-odd shots in the game's data accelerate towards a clamp they are
  // already past. The client keeps their speed; an integration that let the
  // clamp pull them back had them stop dead or leap.
  it('only ever lets a clamp be reached, never pull a shot back to it', () => {
    const past = motion({ speed: 300, lifetimeMs: 30_000, acceleration: 100, speedClamp: 100 });
    expect(past.positionAt(4000)?.x).toBeCloseTo(10 + 120);

    const short = motion({ speed: 100, lifetimeMs: 30_000, acceleration: -100, speedClamp: 300 });
    expect(short.positionAt(4000)?.x).toBeCloseTo(10 + 40);
  });

  it('stops existing once its lifetime is over', () => {
    const straight = motion({ lifetimeMs: 1000 });
    expect(straight.positionAt(1000)).toBeDefined();
    // Gone is different from "at its last position".
    expect(straight.positionAt(1001)).toBeUndefined();
    expect(straight.positionAt(-1)).toBeUndefined();
  });

  it('turns a boomerang around at half its lifetime', () => {
    const boomerang = motion({ boomerang: true, lifetimeMs: 1000 });
    expect(boomerang.positionAt(250)?.x).toBeCloseTo(260);
    expect(boomerang.positionAt(500)?.x).toBeCloseTo(510);
    expect(boomerang.positionAt(750)?.x).toBeCloseTo(260);
    expect(boomerang.positionAt(1000)?.x).toBeCloseTo(10);
  });

  it('swings a wavy shot either side of its heading, odd and even opposite ways', () => {
    // π/64 either side, three full swings a second, and an odd bullet starts
    // half a swing on — which is what fans a volley out.
    const swing = (odd: boolean) =>
      (Math.PI / 64) * Math.sin((odd ? Math.PI : 0) + (120 * 6 * Math.PI) / 1000);
    const even = motion({ wavy: true }, { bulletId: 0 }).positionAt(120);
    const odd = motion({ wavy: true }, { bulletId: 1 }).positionAt(120);
    expect(even?.y).toBeCloseTo(20 + 120 * Math.sin(swing(false)));
    expect(odd?.y).toBeCloseTo(20 + 120 * Math.sin(swing(true)));
    expect(even?.y).toBeGreaterThan(20);
    expect(odd?.y).toBeLessThan(20);
  });

  it('offsets a sine shot sideways, not along its path', () => {
    const sine = motion({ amplitude: 2, frequency: 1, lifetimeMs: 1000 });
    // A quarter through, the lateral offset is at its peak; along-track
    // distance is unchanged.
    expect(sine.positionAt(250)?.x).toBeCloseTo(10 + 250);
    expect(sine.positionAt(250)?.y).toBeCloseTo(20 + 2);
  });

  it('sweeps a parametric shot through a figure of eight and home again', () => {
    const parametric = motion({ parametric: true, magnitude: 3, lifetimeMs: 1000 });
    expect(parametric.positionAt(0)).toEqual({ x: 10, y: 20 });
    const eighth = parametric.positionAt(125);
    expect(eighth?.x).toBeCloseTo(10 - 3 * Math.SQRT1_2);
    expect(eighth?.y).toBeCloseTo(23);
    const end = parametric.positionAt(1000);
    expect(end?.x).toBeCloseTo(10);
    expect(end?.y).toBeCloseTo(20);
  });

  // The client turns the heading and measures the whole distance along it from
  // where the shot started: the turn is spread over the life, so a quarter turn
  // is half done halfway.
  it('turns a shot through its whole turn rate over its life', () => {
    const turning = motion({ speed: 100, lifetimeMs: 1000, turnRate: 90 });
    const halfway = turning.positionAt(500);
    expect(halfway?.x).toBeCloseTo(10 + 5 * Math.cos(Math.PI / 4));
    expect(halfway?.y).toBeCloseTo(20 + 5 * Math.sin(Math.PI / 4));
    const end = turning.positionAt(1000);
    expect(end?.x).toBeCloseTo(10);
    expect(end?.y).toBeCloseTo(30);
    // A path that curves can cross the ground faster than it travels, so it
    // is given no speed bound rather than a wrong one.
    expect(turning.maxSpeedTilesPerSecond).toBe(Infinity);
  });

  it('flies out and then circles at the distance it had reached', () => {
    const circling = motion({
      speed: 100,
      lifetimeMs: 1000,
      circleTurnDelayMs: 500,
      circleTurnAngle: 360,
    });
    expect(circling.positionAt(500)?.x).toBeCloseTo(15);
    const across = circling.positionAt(750);
    expect(across?.x).toBeCloseTo(5);
    expect(across?.y).toBeCloseTo(20);
    expect(circling.positionAt(1000)?.x).toBeCloseTo(15);
  });

  it('refuses a definition that says nothing about how long it lives', () => {
    expect(motion({ lifetimeMs: 0 }).positionAt(0)).toBeUndefined();
  });
});

describe('what the client makes of an announcement', () => {
  // `Convert.ToUInt32(id + index) % 32767`, in the client's own handler.
  it('numbers a volley the way the client does', () => {
    expect(clientBulletId(100, 3)).toBe(103);
    expect(clientBulletId(65535, 1)).toBe(2);
    // A wire id past 0x7fff arrives negative; the client sees it unsigned.
    expect(clientBulletId(-2, 0)).toBe(0);
  });

  it('reads a multiplier from thousandths, and nonsense as one', () => {
    expect(statMultiplier(1200)).toBeCloseTo(1.2);
    expect(statMultiplier(undefined)).toBe(1);
    expect(statMultiplier(0)).toBe(1);
    expect(statMultiplier(Number.NaN)).toBe(1);
  });

  it('knows a shot that never leaves where it was fired', () => {
    expect(staysPut(definition({ speed: 0 }))).toBe(true);
    expect(staysPut(definition({ speed: 0, laserTiles: 6 }))).toBe(false);
    expect(staysPut(definition({ speed: 0, parametric: true }))).toBe(false);
    expect(staysPut(definition({ speed: 0, acceleration: 10, speedClamp: 50 }))).toBe(false);
  });
});

describe('flightEndMs', () => {
  /** A tenth of a tile every ten milliseconds, so ten tiles is its whole life. */
  const SLOW = definition({ speed: 100, lifetimeMs: 1000 });
  const WEST_TO_EAST: ShotLaunch = { ...ORIGIN, x: 0.5, y: 0.5 };
  const wallAt =
    (at: number): StopsShots =>
    (tileX) =>
      tileX === at;
  const end = (shot: ProjectileDefinition, stops: StopsShots): number =>
    flightEndMs(new ShotMotion(shot, WEST_TO_EAST), shot, WEST_TO_EAST, stops);

  it('lets a shot with nothing in its way live out its lifetime', () => {
    expect(end(SLOW, () => false)).toBe(1000);
  });

  // The bullet was four and a half tiles from the wall's near edge, which is
  // four hundred and fifty milliseconds of flight at a hundredth of a tile a
  // millisecond.
  it('ends the flight at the wall rather than at the lifetime', () => {
    const at = end(SLOW, wallAt(5));
    expect(at).toBeGreaterThan(400);
    expect(at).toBeLessThan(450);
    // And the shot is nowhere inside the wall it died against.
    expect(new ShotMotion(SLOW, WEST_TO_EAST).positionAt(at)!.x).toBeLessThan(5);
  });

  // Monsters stand in doorways, on the far side of destructibles and inside the
  // objects they guard. A shot deleted at its own muzzle is a shot nothing ever
  // dodges, which is the one failure worse than the one this fixes.
  it('is never stopped by the square it was fired from', () => {
    expect(end(SLOW, wallAt(0))).toBe(1000);
  });

  it('flies a shot that passes cover straight through the wall', () => {
    expect(end(definition({ speed: 100, lifetimeMs: 1000, passesCover: true }), wallAt(5))).toBe(
      1000,
    );
  });

  it('gives a laser its whole life, because its beam is drawn the moment it fires', () => {
    expect(end(definition({ speed: 0, lifetimeMs: 1000, laserTiles: 8 }), wallAt(5))).toBe(1000);
  });

  // Now that the client's turn is modelled, its path is the path: a wall on it
  // is a wall the shot meets.
  it('walks a turning shot along the curve it really takes', () => {
    const turning = definition({ speed: 100, lifetimeMs: 1000, turnRate: 90 });
    // Turned a quarter north by the end, it never gets five tiles east.
    expect(end(turning, wallAt(7))).toBe(1000);
    expect(end(turning, wallAt(3))).toBeLessThan(1000);
  });

  it('does not let an accelerating shot skip a wall between samples', () => {
    const accelerating = definition({
      speed: 100,
      lifetimeMs: 1000,
      acceleration: 100,
      speedClamp: 300,
    });
    expect(end(accelerating, wallAt(5))).toBeLessThan(1000);
  });

  // A boomerang turns round at the halfway point and retraces its path, so the
  // wall it meets is the one on the way out.
  it('walks the path the shot really takes, not the line it points along', () => {
    const boomerang = definition({ speed: 100, lifetimeMs: 1000, boomerang: true });
    // It only ever reaches five tiles out, so a wall seven tiles away is one it
    // never touches.
    expect(end(boomerang, wallAt(7))).toBe(1000);
    expect(end(boomerang, wallAt(3))).toBeLessThan(500);
  });
});

describe('ProjectileStore', () => {
  const SHOT: AnnouncedShot = {
    ownerId: 1,
    bulletId: 0,
    bulletType: 0,
    x: 0,
    y: 0,
    angle: 0,
    speedMultiplier: 1,
    lifetimeMultiplier: 1,
    firedAtMs: 1000,
  };

  it('tracks a shot and answers where it is', () => {
    const store = new ProjectileStore();
    expect(store.add(definition(), SHOT)).toBe(true);

    const [shot] = [...store.values(1000)];
    expect(shot?.ownerId).toBe(1);
    expect(shot?.damage).toBe(50);
    expect(shot?.maxSpeedTilesPerSecond).toBe(1000);
    expect(shot?.collisionHalfTiles).toBe(0.5);
    expect(shot?.positionAt(1500)).toEqual({ x: 500, y: 0 });
  });

  it('charges the damage the announcement rolled over the one the file states', () => {
    const store = new ProjectileStore();
    store.add(definition(), { ...SHOT, damage: 130 });
    expect([...store.values(1000)][0]?.damage).toBe(130);
  });

  it('does not track a shot it has no definition for', () => {
    const store = new ProjectileStore();
    // Tracking it as a straight line would be worse than not tracking it: a
    // dodge would then confidently avoid the wrong curve.
    expect(store.add(undefined, SHOT)).toBe(false);
    expect(store.size).toBe(0);
  });

  it('forgets a shot once its lifetime is over', () => {
    const store = new ProjectileStore();
    store.add(definition({ lifetimeMs: 500 }), { ...SHOT, firedAtMs: 0 });

    expect([...store.values(400)]).toHaveLength(1);
    expect([...store.values(600)]).toHaveLength(0);
    expect(store.size).toBe(0);
  });

  it('keeps shots from different shooters apart, even with the same bullet id', () => {
    const store = new ProjectileStore();
    store.add(definition(), { ...SHOT, bulletId: 7 });
    store.add(definition(), { ...SHOT, ownerId: 2, bulletId: 7, x: 5, y: 5 });
    expect(store.size).toBe(2);
  });

  // A lifetime is when a shot runs out, not when it stops existing. Most end
  // early, by landing — and the client is what decides that, which is why it is
  // an outgoing packet that says so.
  it('forgets a shot the client says has hit something', () => {
    const store = new ProjectileStore();
    store.add(definition(), { ...SHOT, ownerId: 4, bulletId: 9 });

    expect(store.retire(4, 9, false)).toBe(true);
    expect(store.size).toBe(0);
    expect(store.retire(4, 9, false)).toBe(false);
  });

  it('keeps a shot that goes through whatever it just hit', () => {
    const store = new ProjectileStore();
    const shot = { ...SHOT, ownerId: 4, bulletId: 9 };
    store.add(definition({ multiHit: true }), shot);
    expect(store.retire(4, 9, false)).toBe(false);
    // It passes through people, not through walls.
    expect(store.retire(4, 9, true)).toBe(true);

    store.add(definition({ passesCover: true }), shot);
    expect(store.retire(4, 9, true)).toBe(false);
    expect(store.retire(4, 9, false)).toBe(true);
  });

  // The client destroying the object is not an acknowledgement to interpret:
  // whatever it passes through, it is not there any more.
  it('forgets a shot outright when the client no longer has it', () => {
    const store = new ProjectileStore();
    store.add(definition({ multiHit: true, passesCover: true }), { ...SHOT, ownerId: 4 });
    expect(store.forget(4, 0)).toBe(true);
    expect(store.size).toBe(0);
    expect(store.forget(4, 0)).toBe(false);
  });

  it('matches a bullet id the wire declared signed', () => {
    const store = new ProjectileStore();
    // `ENEMYSHOOT` and `PLAYERHIT` both declare it signed, so an id past
    // 0x7fff arrives negative on both — and `OTHERHIT` declares it unsigned, so
    // the same shot comes back positive. One masked key answers all three.
    store.add(definition(), { ...SHOT, ownerId: 4, bulletId: -2 });
    expect(store.retire(4, 0xfffe, false)).toBe(true);
  });

  // **The live report: it keeps dodging bullets that are already gone.** The
  // client tells the server about a shot it destroyed against the map, but only
  // about the ones it bothered to resolve and only a round trip later — so the
  // store works the wall out for itself, once, when the shot is announced.
  it('stops a shot at the wall it flies into, for everyone reading it', () => {
    const store = new ProjectileStore((tileX) => tileX === 5);
    store.add(definition({ speed: 100, lifetimeMs: 1000 }), { ...SHOT, x: 0.5, y: 0.5 });

    const [shot] = [...store.values(1000)];
    expect(shot?.expiresAtMs).toBeLessThan(1450);
    // Nothing predicts it past the wall — which is what the drawn path and the
    // threat field are both built out of.
    expect(shot?.positionAt(1500)).toBeUndefined();
    // And it is gone from the store by the time it would have got there.
    expect([...store.values(1500)]).toHaveLength(0);
  });

  describe('taking the client at its word', () => {
    const CLIENT = {
      firedAtMs: 1030,
      x: 0,
      y: 0,
      angle: Math.PI / 2,
      speedMultiplier: 1.5,
      lifetimeMs: 1500,
      halfTiles: 0.25,
    };

    // The client starts a shot on the frame it reads the packet, flies it with
    // its own copy of the owner's multipliers and hits with the square it gave
    // it. That is the shot that lands, so that is the shot that is dodged.
    it('flies a shot from when and how the client launched it', () => {
      const store = new ProjectileStore();
      store.add(definition(), SHOT);
      expect(store.confirm(1, 0, CLIENT)).toBe(true);

      const [shot] = [...store.values(1030)];
      expect(shot?.collisionHalfTiles).toBe(0.25);
      expect(shot?.maxSpeedTilesPerSecond).toBe(1500);
      // Thirty milliseconds later than the packet said, north rather than east,
      // and half as fast again.
      const at = shot?.positionAt(1130);
      expect(at?.x).toBeCloseTo(0);
      expect(at?.y).toBeCloseTo(150);
      // And for as long as the client lets it live.
      expect(shot?.expiresAtMs).toBe(1030 + 1500);
    });

    it('keeps what only the announcement knew', () => {
      const store = new ProjectileStore();
      store.add(definition({ multiHit: true }), { ...SHOT, damage: 130 });
      store.confirm(1, 0, CLIENT);
      const [shot] = [...store.values(1030)];
      expect(shot?.damage).toBe(130);
      // Still the kind of shot that goes through a player it hits.
      expect(store.retire(1, 0, false)).toBe(false);
    });

    it('works the wall out again for where the client really fired it', () => {
      const store = new ProjectileStore((_, tileY) => tileY === 3);
      store.add(definition({ speed: 100, lifetimeMs: 1000 }), { ...SHOT, x: 0.5, y: 0.5 });
      store.confirm(1, 0, { ...CLIENT, x: 0.5, y: 0.5, speedMultiplier: 1, lifetimeMs: 1000 });
      // Fired north now, into the wall three tiles up.
      expect([...store.values(1030)][0]?.expiresAtMs).toBeLessThan(1030 + 250);
    });

    it('refuses a launch that is not a shot, and keeps its own estimate', () => {
      const store = new ProjectileStore();
      store.add(definition(), SHOT);
      for (const nonsense of [
        { ...CLIENT, angle: Number.NaN },
        { ...CLIENT, speedMultiplier: 0 },
        { ...CLIENT, lifetimeMs: -1 },
        { ...CLIENT, halfTiles: 1000 },
        { ...CLIENT, x: Number.POSITIVE_INFINITY },
        { ...CLIENT, firedAtMs: Number.NaN },
      ]) {
        expect(store.confirm(1, 0, nonsense)).toBe(false);
      }
      expect([...store.values(1000)][0]?.positionAt(1500)).toEqual({ x: 500, y: 0 });
    });

    it('has nothing to confirm about a shot it never tracked', () => {
      expect(new ProjectileStore().confirm(1, 0, CLIENT)).toBe(false);
    });
  });

  it('clears everything, as a map change requires', () => {
    const store = new ProjectileStore();
    store.add(definition(), SHOT);
    store.clear();
    expect(store.size).toBe(0);
  });
});
