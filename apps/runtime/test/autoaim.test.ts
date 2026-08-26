import {
  MutablePacket,
  type EntityView,
  type NativeApi,
  type Position,
  type SessionApi,
  type SessionView,
} from '@brownie/plugin-api';
import { createBundledRegistry } from '@brownie/protocol/bundled';
import { createPacket, decodeFrame, encodePacket } from '@brownie/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConditionEffect, conditionBitLow } from '../src/constants/ConditionEffect.js';
import { solveIntercept } from '../src/features/autoaim/intercept.js';
import { MotionTracker } from '../src/state/MotionTracker.js';
import { CURSOR_FRESH_MS, CursorTracker } from '../src/native/CursorTracker.js';
import { BossRule, TargetPriority, selectTarget } from '../src/features/autoaim/selectTarget.js';
import {
  createAutoAimPlugin,
  type WeaponProjectile,
} from '../src/features/autoaim/autoAimPlugin.js';
import { PluginHost } from '../src/plugins/PluginHost.js';
import { testLogger } from './fakes.js';

const registry = createBundledRegistry();

function packetOf(name: string, fields: Record<string, unknown>): MutablePacket {
  const packet = createPacket(registry, name);
  for (const [key, value] of Object.entries(fields)) {
    packet.fields[key] = value as never;
  }
  return new MutablePacket(decodeFrame(registry, encodePacket(registry, packet)));
}

describe('solveIntercept', () => {
  const still = {
    shooterX: 0,
    shooterY: 0,
    targetVelocityX: 0,
    targetVelocityY: 0,
    targetAngularVelocityPerMs: 0,
    bulletSpeedTilesPerMs: 0.01,
    maxFlightMs: 1500,
  };

  it('is the plain distance over the speed when nothing is moving', () => {
    const solution = solveIntercept({ ...still, targetX: 5, targetY: 0 });
    expect(solution?.x).toBeCloseTo(5);
    expect(solution?.y).toBeCloseTo(0);
    expect(solution?.flightMs).toBeCloseTo(500);
  });

  it('aims where a crossing target will be, not where it is', () => {
    // Five tiles east, walking north at half the shot's speed.
    const solution = solveIntercept({
      ...still,
      targetX: 5,
      targetY: 0,
      targetVelocityY: 0.005,
    });
    expect(solution).toBeDefined();
    // The point it names must be one the target and the shot both reach at the
    // same moment — which is the whole claim, so it is checked rather than the
    // number being pinned.
    const flight = solution?.flightMs ?? 0;
    expect(solution?.y).toBeCloseTo(0.005 * flight);
    expect(Math.hypot(solution?.x ?? 0, solution?.y ?? 0)).toBeCloseTo(
      still.bulletSpeedTilesPerMs * flight,
    );
    // And it is genuinely ahead of the target, not at it.
    expect(solution?.y).toBeGreaterThan(0);
  });

  it('follows a turning target around its circle instead of past it', () => {
    const solution = solveIntercept({
      ...still,
      targetX: 3,
      targetY: 0,
      targetVelocityX: 0,
      targetVelocityY: 0.006,
      targetAngularVelocityPerMs: 0.002,
      bulletSpeedTilesPerMs: 0.008,
    });

    // The target stays three tiles from the shooter, so the shot takes 375 ms.
    // Linear prediction would put it more than three tiles ahead on the tangent.
    expect(solution?.flightMs).toBeCloseTo(375, 2);
    expect(solution?.x).toBeCloseTo(3 * Math.cos(0.75), 4);
    expect(solution?.y).toBeCloseTo(3 * Math.sin(0.75), 4);
  });

  it('refuses a target running away faster than the shot travels', () => {
    expect(
      solveIntercept({
        ...still,
        targetX: 5,
        targetY: 0,
        targetVelocityX: 0.02,
      }),
    ).toBeUndefined();
  });

  it('catches a target running away slower than the shot travels', () => {
    const solution = solveIntercept({
      ...still,
      targetX: 5,
      targetY: 0,
      targetVelocityX: 0.005,
    });
    expect(solution?.flightMs).toBeCloseTo(1000);
    expect(solution?.x).toBeCloseTo(10);
  });

  it('refuses a meeting the shot expires before reaching', () => {
    expect(solveIntercept({ ...still, targetX: 20, targetY: 0, maxFlightMs: 100 })).toBeUndefined();
  });

  it('refuses a shot with no speed rather than dividing by it', () => {
    expect(
      solveIntercept({ ...still, targetX: 5, targetY: 0, bulletSpeedTilesPerMs: 0 }),
    ).toBeUndefined();
  });

  // Every one of these would otherwise come back out as a pair of `NaN`, which
  // is an angle handed to the module that points the player's shots.
  it('refuses a problem stated in numbers that are not numbers', () => {
    const at = { ...still, targetX: 5, targetY: 0 };
    expect(solveIntercept({ ...at, targetX: Number.NaN })).toBeUndefined();
    expect(solveIntercept({ ...at, shooterY: Number.NaN })).toBeUndefined();
    expect(solveIntercept({ ...at, targetVelocityY: Number.NaN })).toBeUndefined();
    expect(solveIntercept({ ...at, targetAngularVelocityPerMs: Number.NaN })).toBeUndefined();
    expect(solveIntercept({ ...at, bulletSpeedTilesPerMs: Number.NaN })).toBeUndefined();
    expect(solveIntercept({ ...at, maxFlightMs: Number.NaN })).toBeUndefined();
    // Unbounded is not a bound: it is every solution accepted, however far off.
    expect(solveIntercept({ ...at, maxFlightMs: Number.POSITIVE_INFINITY })).toBeUndefined();
  });

  it('is a zero-length flight when the target is already on top of you', () => {
    expect(solveIntercept({ ...still, targetX: 0, targetY: 0 })?.flightMs).toBe(0);
  });
});

describe('MotionTracker', () => {
  /** One server tick, arriving at `atMs`, carrying one entity's position. */
  const sight = (tracker: MotionTracker, atMs: number, x: number, y: number): void => {
    tracker.tick(atMs);
    tracker.observe(1, x, y);
  };

  it('has no opinion after a single sighting', () => {
    const tracker = new MotionTracker();
    sight(tracker, 0, 0, 0);
    expect(tracker.motionAt(1, 0)).toBeUndefined();
  });

  it('has no opinion about a sighting that arrived outside any tick', () => {
    // A velocity is a displacement per tick, so a sighting belonging to no tick
    // has no interval to be one over.
    const tracker = new MotionTracker();
    tracker.observe(1, 0, 0);
    tracker.observe(1, 2, 0);
    expect(tracker.motionAt(1, 0)).toBeUndefined();
    expect(tracker.size).toBe(0);
  });

  it('derives a velocity from two sightings', () => {
    const tracker = new MotionTracker();
    sight(tracker, 0, 0, 0);
    sight(tracker, 200, 2, 0);
    expect(tracker.motionAt(1, 200)?.velocityX).toBeCloseTo(0.01);
    expect(tracker.motionAt(1, 200)?.velocityY).toBeCloseTo(0);
  });

  // **The bug this class exists to not have.** A stalled connection does not
  // deliver ticks late one at a time; it delivers the backlog at once, and a
  // velocity measured against our own clock reads a tick of walking as having
  // happened in the millisecond it was unpacked in. That number is two hundred
  // tiles a second, and an aim led by it lands on the far side of the room.
  it('measures a tick of walking as a tick, however late the tick arrives', () => {
    const tracker = new MotionTracker();
    sight(tracker, 1000, 0, 0);
    sight(tracker, 1001, 2, 0);
    sight(tracker, 1002, 4, 0);
    expect(tracker.motionAt(1, 1002)?.velocityX).toBeCloseTo(0.01);
  });

  it('says the same about a tick that states its own length', () => {
    const tracker = new MotionTracker();
    tracker.tick(1000, 100);
    tracker.observe(1, 0, 0);
    tracker.tick(1001, 100);
    tracker.observe(1, 1, 0);
    expect(tracker.motionAt(1, 1001)?.velocityX).toBeCloseTo(0.01);
  });

  it('ignores a tick length nothing could have run at', () => {
    const tracker = new MotionTracker();
    tracker.tick(0, 0);
    tracker.observe(1, 0, 0);
    tracker.tick(200, Number.NaN);
    tracker.observe(1, 2, 0);
    // Both readings fell back to the game's own tick, so this is the ordinary
    // two tiles in two hundred milliseconds.
    expect(tracker.motionAt(1, 200)?.velocityX).toBeCloseTo(0.01);
  });

  it('is not two sightings when one tick describes the same thing twice', () => {
    const tracker = new MotionTracker();
    tracker.tick(0);
    tracker.observe(1, 0, 0);
    tracker.observe(1, 2, 0);
    expect(tracker.motionAt(1, 0)).toBeUndefined();
  });

  it('takes a step nothing could have walked as a reposition, not a velocity', () => {
    const tracker = new MotionTracker();
    sight(tracker, 0, 0, 0);
    sight(tracker, 200, 2, 0);
    expect(tracker.motionAt(1, 200)).toBeDefined();

    // Forty tiles in one tick is a teleport, a `GOTO` or the server putting it
    // back where it belongs. None of the three is a heading to lead.
    sight(tracker, 400, 42, 0);
    expect(tracker.motionAt(1, 400)).toBeUndefined();
  });

  it('settles towards a steady velocity rather than following one tick', () => {
    const tracker = new MotionTracker();
    sight(tracker, 0, 0, 0);
    sight(tracker, 200, 2, 0);
    // One tick where it did not move: a follower would call it stopped.
    sight(tracker, 400, 2, 0);
    const velocity = tracker.motionAt(1, 400)?.velocityX ?? 0;
    expect(velocity).toBeGreaterThan(0);
    expect(velocity).toBeLessThan(0.01);
  });

  it('recognises a steady turn and reports the tangent at the latest sighting', () => {
    const tracker = new MotionTracker();
    const radius = 3;
    const observeAt = (angle: number, atMs: number): void => {
      sight(tracker, atMs, radius * Math.cos(angle), radius * Math.sin(angle));
    };

    observeAt(0, 0);
    observeAt(0.4, 200);
    observeAt(0.8, 400);

    const motion = tracker.motionAt(1, 400);
    expect(motion?.angularVelocityPerMs).toBeCloseTo(0.002, 6);
    expect(motion?.velocityX).toBeCloseTo(-0.006 * Math.sin(0.8), 6);
    expect(motion?.velocityY).toBeCloseTo(0.006 * Math.cos(0.8), 6);
  });

  // A monster that turns about has not started going round in a circle, and
  // saying it has puts the aim on the far side of one — a worse answer than the
  // straight line the reversal replaced.
  it('does not read a reversal as a circle to follow', () => {
    const tracker = new MotionTracker();
    sight(tracker, 0, 0, 0);
    sight(tracker, 200, 1, 0);
    sight(tracker, 400, 0, 0);
    sight(tracker, 600, -1, 0);

    const motion = tracker.motionAt(1, 600);
    expect(motion?.angularVelocityPerMs).toBe(0);
    // Settling back the way it is actually going, not swinging round an arc.
    expect(motion?.velocityX).toBeLessThan(0);
    expect(motion?.y).toBeCloseTo(0);
  });

  it('restarts rather than averaging over a gap it did not watch', () => {
    const tracker = new MotionTracker();
    sight(tracker, 0, 0, 0);
    sight(tracker, 100, 1, 0);
    // Out of view for five seconds, then somewhere else entirely.
    sight(tracker, 5100, 40, 40);
    expect(tracker.motionAt(1, 5100)).toBeUndefined();
  });

  it('carries a track forward to the moment it is asked about', () => {
    const tracker = new MotionTracker();
    sight(tracker, 0, 0, 0);
    sight(tracker, 200, 2, 0);
    // Where the sighting put it, and where a hundred more milliseconds of the
    // same walking would have.
    expect(tracker.motionAt(1, 200)?.x).toBeCloseTo(2);
    expect(tracker.motionAt(1, 300)?.x).toBeCloseTo(3);
  });

  it('stops carrying a track that nothing has confirmed for a while', () => {
    const tracker = new MotionTracker();
    sight(tracker, 0, 0, 0);
    sight(tracker, 200, 2, 0);
    // A second of silence is not a second of walking: the monster has been free
    // to turn, stop or die, and nothing here saw it.
    const carried = tracker.motionAt(1, 1200)?.x ?? 0;
    expect(carried).toBeLessThan(2 + 0.01 * 1000);
  });

  it('has nothing to say about a moment that is not a number', () => {
    const tracker = new MotionTracker();
    sight(tracker, 0, 0, 0);
    sight(tracker, 200, 2, 0);
    expect(tracker.motionAt(1, Number.NaN)).toBeUndefined();
  });

  it('drops a position that did not parse rather than tracking it', () => {
    const tracker = new MotionTracker();
    tracker.tick(0);
    tracker.observe(1, Number.NaN, 0);
    tracker.observe(2, 0, Number.POSITIVE_INFINITY);
    expect(tracker.size).toBe(0);
  });

  // **Not the same claim as having a velocity.** Two sightings of a thing that
  // has not budged derive a velocity of nought perfectly well, and what tells a
  // monster from a spawn anchor is whether it has ever gone anywhere at all.
  it('tells a thing that has walked from one that has only been measured', () => {
    const tracker = new MotionTracker();
    sight(tracker, 0, 5, 5);
    expect(tracker.hasMoved(1)).toBe(false);

    sight(tracker, 200, 5, 5);
    expect(tracker.motionAt(1, 200)).toBeDefined();
    expect(tracker.hasMoved(1)).toBe(false);

    sight(tracker, 400, 6, 5);
    expect(tracker.hasMoved(1)).toBe(true);
    // And it stays true once it stops: having walked is a fact about what the
    // thing is, not about what it is doing this tick.
    sight(tracker, 600, 6, 5);
    expect(tracker.hasMoved(1)).toBe(true);
  });

  it('does not call a rounding a step', () => {
    const tracker = new MotionTracker();
    sight(tracker, 0, 5, 5);
    sight(tracker, 200, 5.01, 4.99);
    expect(tracker.hasMoved(1)).toBe(false);
  });

  it('knows nothing about an entity it has never seen', () => {
    expect(new MotionTracker().hasMoved(99)).toBe(false);
  });

  it('forgets what it has not seen, so it cannot grow without bound', () => {
    const tracker = new MotionTracker();
    tracker.tick(0);
    tracker.observe(1, 0, 0);
    tracker.observe(2, 0, 0);
    tracker.tick(200);
    tracker.observe(2, 1, 0);
    tracker.tick(2000);
    expect(tracker.size).toBe(0);
  });
});

describe('selectTarget', () => {
  const enemy = (objectId: number, x: number, y: number, hp = 100): EntityView =>
    ({
      objectId,
      objectType: 1,
      name: '',
      hp,
      maxHp: 100,
      isEnemy: true,
      isPlayer: false,
      conditions: 0,
      guildName: '',
      stat: () => undefined,
      text: () => undefined,
      x,
      y,
    }) satisfies EntityView;

  const at = { shooterX: 0, shooterY: 0, maxRangeTiles: 10, priority: TargetPriority.Closest };

  it('takes the closest one', () => {
    const chosen = selectTarget([enemy(1, 5, 0), enemy(2, 2, 0), enemy(3, 8, 0)], at);
    expect(chosen?.objectId).toBe(2);
  });

  it('takes the weakest one when asked to', () => {
    const chosen = selectTarget([enemy(1, 2, 0, 90), enemy(2, 9, 0, 10)], {
      ...at,
      priority: TargetPriority.LowestHp,
    });
    expect(chosen?.objectId).toBe(2);
  });

  it('takes the toughest one when asked to, which is the boss', () => {
    const chosen = selectTarget([enemy(1, 2, 0, 90), enemy(2, 9, 0, 10_000)], {
      ...at,
      priority: TargetPriority.HighestHp,
    });
    expect(chosen?.objectId).toBe(2);
  });

  it('breaks a tie on health by distance, whichever way it is ranking', () => {
    for (const priority of [TargetPriority.LowestHp, TargetPriority.HighestHp]) {
      const chosen = selectTarget([enemy(1, 9, 0, 50), enemy(2, 2, 0, 50)], { ...at, priority });
      expect(chosen?.objectId).toBe(2);
    }
  });

  it('ignores anything out of range', () => {
    expect(selectTarget([enemy(1, 20, 0)], at)).toBeUndefined();
  });

  it('ignores something already dead', () => {
    expect(selectTarget([enemy(1, 2, 0, 0)], at)).toBeUndefined();
  });

  it('moves on to the next best when the closest cannot be hit', () => {
    const chosen = selectTarget([enemy(1, 2, 0), enemy(2, 4, 0)], {
      ...at,
      accept: (candidate) => candidate.objectId !== 1,
    });
    expect(chosen?.objectId).toBe(2);
  });

  it('is not asked about candidates that could not win anyway', () => {
    const accept = vi.fn(() => true);
    selectTarget([enemy(1, 2, 0), enemy(2, 9, 0)], { ...at, accept });
    expect(accept).toHaveBeenCalledTimes(1);
  });

  describe('pointed at by the cursor', () => {
    const pointing = { ...at, priority: TargetPriority.ClosestToCursor };

    it('takes the one nearest the cursor, not the one nearest the player', () => {
      // Two tiles east of the player, and eight tiles north of them — with the
      // cursor sitting on the second one.
      const chosen = selectTarget([enemy(1, 2, 0), enemy(2, 0, 8)], {
        ...pointing,
        cursorPoint: { x: 0, y: 8 },
      });
      expect(chosen?.objectId).toBe(2);
    });

    it('picks nothing at all without a reading', () => {
      // The whole point of the mode is the cursor. Falling back to the closest
      // enemy is the mode pretending to work — which is what the reference
      // implementation did, its cursor position never having been written.
      expect(selectTarget([enemy(1, 2, 0)], pointing)).toBeUndefined();
    });

    it('ignores anything outside the radius, including what is behind you', () => {
      const behind = selectTarget([enemy(1, -3, 0)], {
        ...pointing,
        cursorPoint: { x: 3, y: 0 },
        cursorRadiusTiles: 4,
      });
      expect(behind).toBeUndefined();
    });

    it('has no bound to apply when none was given', () => {
      const chosen = selectTarget([enemy(1, -3, 0)], { ...pointing, cursorPoint: { x: 3, y: 0 } });
      expect(chosen?.objectId).toBe(1);
    });

    it('measures from the cursor, not along the line to it', () => {
      // The far enemy is nearly on the line from the player to the cursor; the
      // near one is off that line but sitting on the cursor itself. A mode
      // ranking by direction picks the first, which is the bug this replaced.
      const chosen = selectTarget([enemy(1, 6, 0.2), enemy(2, 3, 1)], {
        ...pointing,
        cursorPoint: { x: 3, y: 1 },
      });
      expect(chosen?.objectId).toBe(2);
    });

    it('breaks a tie on distance to the cursor by distance to the player', () => {
      // Both two tiles from the cursor, on either side of it.
      const chosen = selectTarget([enemy(1, 7, 0), enemy(2, 3, 0)], {
        ...pointing,
        cursorPoint: { x: 5, y: 0 },
      });
      expect(chosen?.objectId).toBe(2);
    });
  });

  describe('with a boss in the room', () => {
    /** The one at the far end of it, with the minion standing on the player. */
    const room = [enemy(1, 2, 0), enemy(2, 9, 0)];
    const isBoss = (candidate: EntityView): boolean => candidate.objectId === 2;

    it('ranks a boss with everything else unless asked otherwise', () => {
      expect(selectTarget(room, at)?.objectId).toBe(1);
      expect(selectTarget(room, { ...at, bosses: { rule: BossRule.Any, isBoss } })?.objectId).toBe(
        1,
      );
    });

    it('takes the boss over whatever is standing closer', () => {
      const chosen = selectTarget(room, { ...at, bosses: { rule: BossRule.Prefer, isBoss } });
      expect(chosen?.objectId).toBe(2);
    });

    it('falls back to the rest of the room when no boss is in range', () => {
      // The whole difference between the two rules: preferring is a tier, not a
      // filter, so a realm with nothing marked in it still gets an answer.
      const chosen = selectTarget([enemy(1, 2, 0)], {
        ...at,
        bosses: { rule: BossRule.Prefer, isBoss },
      });
      expect(chosen?.objectId).toBe(1);
    });

    it('picks nothing at all with nothing but minions, when asked for bosses only', () => {
      const chosen = selectTarget([enemy(1, 2, 0), enemy(3, 4, 0)], {
        ...at,
        bosses: { rule: BossRule.Only, isBoss },
      });
      expect(chosen).toBeUndefined();
    });

    it('ranks bosses against each other by the priority underneath', () => {
      // Two of them, which is a phase change and half of Oryx's Sanctuary. The
      // rule says which class of enemy; the priority still says which one.
      const bosses = { rule: BossRule.Prefer, isBoss: () => true };
      expect(selectTarget(room, { ...at, bosses })?.objectId).toBe(1);
      expect(
        selectTarget([enemy(1, 2, 0, 90), enemy(2, 9, 0, 10)], {
          ...at,
          priority: TargetPriority.LowestHp,
          bosses,
        })?.objectId,
      ).toBe(2);
    });

    it('moves on to the next boss when the first cannot be hit', () => {
      // The tier is not a commitment: an invulnerable boss phase leaves the
      // second one, and dropping to a minion would be the mode giving up.
      const chosen = selectTarget([enemy(1, 2, 0), enemy(2, 4, 0), enemy(3, 6, 0)], {
        ...at,
        bosses: { rule: BossRule.Prefer, isBoss: (candidate) => candidate.objectId !== 1 },
        accept: (candidate) => candidate.objectId !== 2,
      });
      expect(chosen?.objectId).toBe(3);
    });

    it('is not asked whether a minion can be hit once a boss is standing', () => {
      // The expensive test, kept off everything the tier has already ruled out.
      const accept = vi.fn(() => true);
      selectTarget([enemy(2, 9, 0), enemy(1, 2, 0)], {
        ...at,
        bosses: { rule: BossRule.Prefer, isBoss },
        accept,
      });
      expect(accept).toHaveBeenCalledTimes(1);
    });
  });
});

describe('where the module says the cursor is', () => {
  it('has nothing to say before the module has reported anything', () => {
    expect(new CursorTracker({ now: () => 1000 }).point()).toBeUndefined();
  });

  it('holds what it was last told', () => {
    const tracker = new CursorTracker();
    tracker.observe(12.5, 40.25);
    expect(tracker.point()).toEqual({ x: 12.5, y: 40.25 });
  });

  it('drops a point that did not parse rather than aiming at it', () => {
    const tracker = new CursorTracker({ now: () => 1000 });
    tracker.observe(Number.NaN, 3);
    tracker.observe(3, Number.NaN);
    expect(tracker.point()).toBeUndefined();
  });

  it('lets go the moment it is told to', () => {
    const tracker = new CursorTracker();
    tracker.observe(1, 2);
    tracker.release();
    expect(tracker.point()).toBeUndefined();
  });

  it('lets go on its own when the module stops saying it', () => {
    let now = 1000;
    const tracker = new CursorTracker({ now: () => now });
    tracker.observe(1, 2);

    now = 1000 + CURSOR_FRESH_MS;
    expect(tracker.point()).toEqual({ x: 1, y: 2 });
    now = 1001 + CURSOR_FRESH_MS;
    expect(tracker.point()).toBeUndefined();
  });
});

describe('the auto-aim plugin', () => {
  const NATIVE: NativeApi = {
    connected: true,
    setFeature: () => undefined,
    onConnected: () => () => undefined,
  };

  /** A bow-like weapon: 0.008 tiles a millisecond for 750 ms, so six tiles. */
  const WEAPON: WeaponProjectile = { speedTilesPerMs: 0.008, lifetimeMs: 750, reachTiles: 6 };

  /** The only wall in these tests, so "is scenery" is one object type. */
  const WALL_TYPE = 99;

  /** A spawn anchor: `<Enemy />` and `<Invincible />`, like a quarter of them. */
  const SPAWNER_TYPE = 98;

  /**
   * Longer than the plugin's planning interval, so one call to
   * {@link vi.advanceTimersByTime} is exactly one decision.
   */
  const A_PLAN_MS = 30;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function harness(
    options: {
      weapon?: WeaponProjectile | undefined;
      weaponType?: number;
    } = {},
  ): {
    /** Where the module says the cursor is, or nothing. */
    setCursor: (point: Position | undefined) => void;
    host: PluginHost;
    aimAt: ReturnType<typeof vi.fn>;
    session: SessionView;
    enemies: EntityView[];
    setTime: (ms: number) => void;
    /** Where the character stands, as the world model holds it. */
    setSelf: (x: number, y: number) => void;
    /** One sighting followed by one decision, which is a server tick's worth. */
    tick: () => void;
    /** The client's own statement of where it has been this tick. */
    move: () => void;
    /** A decision with no packet behind it, which is the usual case now. */
    plan: () => void;
  } {
    const aimAt = vi.fn();
    const enemies: EntityView[] = [];
    let gameTimeMs = 0;
    let cursorPoint: Position | undefined;
    let selfX = 0;
    let selfY = 0;

    const session = {
      id: 's1',
      self: {
        objectId: 1,
        hp: 100,
        maxHp: 100,
        get x() {
          return selfX;
        },
        get y() {
          return selfY;
        },
        alive: true,
        weaponType: options.weaponType ?? 0x0a00,
      },
      world: {
        get gameTimeMs() {
          return gameTimeMs;
        },
        mapName: 'Dungeon',
        enemies: () => enemies,
      },
      sendToServer: () => undefined,
      notify: () => undefined,
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
      createAutoAimPlugin({
        output: { aimAt },
        weapon: () => ('weapon' in options ? options.weapon : WEAPON),
        isObstacle: (objectType) => objectType === WALL_TYPE,
        isInvincible: (objectType) => objectType === SPAWNER_TYPE,
        cursorPoint: () => cursorPoint,
      }),
    );
    host.setEnabled('auto-aim', true);

    const plan = (): void => {
      vi.advanceTimersByTime(A_PLAN_MS);
    };

    return {
      host,
      aimAt,
      session,
      enemies,
      setTime: (ms: number) => {
        gameTimeMs = ms;
      },
      setSelf: (x: number, y: number) => {
        selfX = x;
        selfY = y;
      },
      setCursor: (point: Position | undefined) => {
        cursorPoint = point;
      },
      plan,
      tick: () => {
        host.dispatchPacket(newtick(), session);
        plan();
      },
      move: () => {
        host.dispatchPacket(movement(), session);
      },
    };
  }

  /**
   * The client's reply to a tick.
   *
   * The records carry nothing the plugin reads — the state stage has already
   * applied them, so what it samples is the world model's own position — but
   * the packet has to be a real one, because an empty body is an opaque packet
   * and this deliberately ignores those.
   */
  const movement = () =>
    packetOf('MOVE', {
      tickId: 0,
      serverRealTimeMSofLastNewTick: 0,
      records: [{ time: 0, x: 0, y: 0 }],
    });

  const newtick = () =>
    packetOf('NEWTICK', {
      tickId: 0,
      tickTime: 200,
      serverRealTimeMs: 0,
      serverLastRttMs: 0,
      statuses: [],
    });

  const enemy = (
    objectId: number,
    x: number,
    y: number,
    over: Partial<EntityView> = {},
  ): EntityView =>
    ({
      objectId,
      objectType: 1,
      name: '',
      hp: 100,
      maxHp: 100,
      isEnemy: true,
      isPlayer: false,
      conditions: 0,
      guildName: '',
      stat: () => undefined,
      text: () => undefined,
      x,
      y,
      ...over,
    }) satisfies EntityView;

  it('points at a standing enemy, and holds it for a while', () => {
    const { aimAt, enemies, tick } = harness();
    enemies.push(enemy(1, 3, 0));
    tick();
    expect(aimAt).toHaveBeenCalledTimes(1);
    expect(aimAt.mock.calls[0]?.[0]).toBeCloseTo(3);
    expect(aimAt.mock.calls[0]?.[1]).toBeCloseTo(0);
    // The aim expires on its own, so silence means "your aim is yours again".
    expect(aimAt.mock.calls[0]?.[2]).toBeGreaterThan(0);
  });

  it('points at an enemy without waiting for a server tick', () => {
    const { aimAt, enemies, plan } = harness();
    // What arrived is an `UPDATE` — a monster in view, and no tick behind it.
    // Waiting for one is up to 200 ms of standing there not shooting at it.
    enemies.push(enemy(1, 3, 0));
    plan();
    expect(aimAt).toHaveBeenCalledTimes(1);
    expect(aimAt.mock.calls[0]?.[0]).toBeCloseTo(3);
  });

  // **The point on its own cannot be corrected.** A shot is tested against the
  // client's own copy of the monster, and only the module can see that copy —
  // so it shifts the point by however far the two disagree. It can only do that
  // if it is told which enemy the lead belongs to and where this side had it.
  it('names the enemy it led, and where it had it', () => {
    const { aimAt, enemies, setTime, tick } = harness();
    const walker = { ...enemy(7, 3, 0) };
    enemies.push(walker);

    tick();
    setTime(200);
    walker.y = 0.8;
    tick();

    const subject = aimAt.mock.calls.at(-1)?.[3] as
      { objectId: number; x: number; y: number } | undefined;
    expect(subject?.objectId).toBe(7);
    // Where the enemy is *now* by this side's reckoning — which is what the
    // lead was measured from, not the sample the last tick carried.
    expect(subject?.x).toBeCloseTo(3);
    expect(subject?.y).toBeCloseTo(0.8);
    // And the point itself is ahead of it, which is the part that must survive
    // the shift.
    expect(Number(aimAt.mock.calls.at(-1)?.[1])).toBeGreaterThan(subject?.y ?? 0);
  });

  it('names an enemy it has only seen once at the place it saw it', () => {
    const { aimAt, enemies, tick } = harness();
    enemies.push(enemy(4, 3, 1));
    tick();

    const subject = aimAt.mock.calls.at(-1)?.[3] as
      { objectId: number; x: number; y: number } | undefined;
    expect(subject).toEqual({ objectId: 4, x: 3, y: 1 });
  });

  it('says nothing while no weapon is held', () => {
    const { aimAt, enemies, tick } = harness({ weaponType: -1 });
    enemies.push(enemy(1, 3, 0));
    tick();
    expect(aimAt).not.toHaveBeenCalled();
  });

  it('says nothing about a weapon the game data does not describe', () => {
    const { aimAt, enemies, tick } = harness({ weapon: undefined });
    enemies.push(enemy(1, 3, 0));
    tick();
    expect(aimAt).not.toHaveBeenCalled();
  });

  it('leads an enemy that has been seen moving', () => {
    const { aimAt, enemies, setTime, tick } = harness();
    const moving = { ...enemy(1, 3, 0) };
    enemies.push(moving);

    // First tick learns where it is; the second gives it a velocity.
    tick();
    setTime(200);
    moving.y = 0.6;
    tick();

    const last = aimAt.mock.calls.at(-1);
    // Three tiles away at 0.008 tiles/ms is a flight of about 375 ms, in which
    // a target moving 3 tiles a second travels a little over a tile.
    expect(last?.[1]).toBeGreaterThan(0.6);
  });

  it('carries a moving enemy forward between sightings', () => {
    const { aimAt, enemies, setTime, tick, plan } = harness();
    const moving = { ...enemy(1, 3, 0) };
    enemies.push(moving);

    tick();
    setTime(200);
    moving.y = 0.6;
    tick();
    const onTheTick = Number(aimAt.mock.calls.at(-1)?.[1]);

    // Half a tick later, with nothing new said about it. The enemy has kept
    // walking, and an aim that has not moved is an aim behind it.
    setTime(300);
    plan();
    expect(Number(aimAt.mock.calls.at(-1)?.[1])).toBeGreaterThan(onTheTick);
  });

  // **The complaint this was rewritten for.** A stalled connection does not
  // deliver its ticks late one at a time; it delivers the backlog at once, and
  // a velocity measured against our own clock reads a tick of walking as having
  // happened in the millisecond it was unpacked in. The monster then appears to
  // be moving faster than the shot, and the aim is either sent across the room
  // after it or given up on entirely — both of which are a shot at nothing.
  it('is not fooled by a stall that delivers three ticks at once', () => {
    const { aimAt, enemies, setTime, tick } = harness();
    const walker = { ...enemy(1, 3, 0) };
    enemies.push(walker);

    setTime(1000);
    tick();
    walker.y = 0.8;
    setTime(1001);
    tick();
    walker.y = 1.6;
    setTime(1002);
    tick();

    const last = aimAt.mock.calls.at(-1);
    const x = Number(last?.[0]);
    const y = Number(last?.[1]);
    // Ahead of it, because it is walking — and inside what the weapon reaches,
    // which is the bound a lead cannot argue with.
    expect(y).toBeGreaterThan(1.6);
    expect(Math.hypot(x, y)).toBeLessThanOrEqual(WEAPON.reachTiles);
  });

  // **The other half of the same complaint, and the one that shows.** A shot
  // leaves from the player, the client says where the player is once a server
  // tick, and this decides eight times in one — so the position it measures
  // from is a character standing where they were up to two tiles ago. The
  // error does not average out: running *at* something always puts the world
  // model further from it than the game is, so the flight is always
  // over-estimated and the aim always lands past the monster.
  it('measures the shot from where the player is, not from their last report', () => {
    /** The same fight, with the player having covered `stepTiles` this tick. */
    const leadAfterHalfATick = (stepTiles: number): number => {
      const scene = harness();
      const walker = { ...enemy(1, 5, 0) };
      scene.enemies.push(walker);

      scene.setSelf(1.6 - stepTiles, 0);
      scene.tick();
      scene.move();

      // Both runs end the tick reported in the same place, so the only thing
      // that differs below is whether the character is known to be moving.
      scene.setTime(200);
      scene.setSelf(1.6, 0);
      walker.y = 0.8;
      scene.tick();
      scene.move();

      // Half a tick on, and nobody has said anything about anybody since.
      scene.setTime(300);
      scene.plan();
      return Number(scene.aimAt.mock.calls.at(-1)?.[1]);
    };

    // The runner has closed the best part of a tile the world model does not
    // know about, so the shot has less ground to cross and the enemy less of
    // the flight to walk through.
    expect(leadAfterHalfATick(1.6)).toBeLessThan(leadAfterHalfATick(0));
  });

  it('stands still until the player has been seen to move', () => {
    // Nothing to carry forward on the first report of a session, and where the
    // last packet put them is the only answer there is.
    const { aimAt, enemies, setSelf, tick, move } = harness();
    enemies.push(enemy(1, 3, 0));
    setSelf(1, 0);
    move();
    tick();
    expect(aimAt.mock.calls.at(-1)?.[0]).toBeCloseTo(3);
    expect(aimAt.mock.calls.at(-1)?.[1]).toBeCloseTo(0);
  });

  it('drops a track the server moved rather than leading where it was thrown', () => {
    const { aimAt, enemies, setTime, tick } = harness();
    const blinker = { ...enemy(1, 3, 0) };
    enemies.push(blinker);

    tick();
    setTime(200);
    blinker.y = 0.8;
    tick();
    expect(Number(aimAt.mock.calls.at(-1)?.[1])).toBeGreaterThan(0.8);

    // A teleport, a `GOTO`, or the server putting it back where it belongs.
    // None of the three is a heading, and none of them may be led.
    setTime(400);
    blinker.x = -3;
    tick();
    expect(aimAt.mock.calls.at(-1)?.[0]).toBeCloseTo(-3);
    expect(aimAt.mock.calls.at(-1)?.[1]).toBeCloseTo(0.8);
  });

  it('will not name a meeting the shot stops short of', () => {
    // A weapon whose reach the data states outright instead of as speed times
    // life — a fixed-arc one. Bounding the lead by the lifetime alone names a
    // meeting well beyond anywhere the shot gets, which is a shot at nothing.
    const { aimAt, enemies, setTime, tick } = harness({
      weapon: { speedTilesPerMs: 0.008, lifetimeMs: 1500, reachTiles: 4 },
    });
    const runner = { ...enemy(1, 3.5, 0) };
    enemies.push(runner);

    tick();
    expect(aimAt).toHaveBeenCalledTimes(1);

    setTime(200);
    runner.y = 1;
    tick();
    expect(aimAt).toHaveBeenCalledTimes(1);
  });

  it('leads harder when asked to, rather than falling silent', () => {
    // The lead is a share of the offset the solution names, not of the speed
    // fed into it. Scaling the speed asks a different question — at 150% a
    // target at three quarters of the shot's speed becomes one faster than it,
    // which has no meeting at all — so turning the slider up used to turn the
    // feature off against exactly the targets it was turned up for.
    const { host, aimAt, enemies, setTime, tick, plan } = harness();
    const walker = { ...enemy(1, 3, 0) };
    enemies.push(walker);

    tick();
    setTime(200);
    walker.y = 0.8;
    tick();
    const at100 = Number(aimAt.mock.calls.at(-1)?.[1]);

    host.settingsOf('auto-aim')?.apply('leadPercent', 150);
    plan();
    const at150 = Number(aimAt.mock.calls.at(-1)?.[1]);

    expect(at100).toBeGreaterThan(0.8);
    expect(at150).toBeGreaterThan(at100);
  });

  it('says nothing about an enemy that cannot be hurt', () => {
    const { aimAt, enemies, tick } = harness();
    enemies.push(enemy(1, 3, 0, { conditions: conditionBitLow(ConditionEffect.Invulnerable) }));
    tick();
    expect(aimAt).not.toHaveBeenCalled();
  });

  it('shoots past a spawner at the monster it spawned', () => {
    const { aimAt, enemies, tick } = harness();
    // A spawn anchor has health, answers to `<Enemy />` and never loses a hit
    // point. Ranked by distance it is the closest enemy, and a whole fight's
    // shots go into it.
    enemies.push(enemy(1, 2, 0, { objectType: SPAWNER_TYPE }), enemy(2, 4, 0));
    tick();
    expect(aimAt).toHaveBeenCalledTimes(1);
    expect(aimAt.mock.calls[0]?.[0]).toBeCloseTo(4);
  });

  it('keeps ignoring a spawner even when told not to skip untouchable enemies', () => {
    // An invulnerable boss phase ends; a spawner does not. The setting is about
    // the first, and letting it reach the second would be the whole fight's
    // shots going into a prop again.
    const { host, aimAt, enemies, tick } = harness();
    host.settingsOf('auto-aim')?.apply('skipUntouchable', false);
    enemies.push(enemy(1, 2, 0, { objectType: SPAWNER_TYPE }), enemy(2, 4, 0));
    tick();
    expect(aimAt).toHaveBeenCalledTimes(1);
    expect(aimAt.mock.calls[0]?.[0]).toBeCloseTo(4);
  });

  it('says nothing about an enemy the server never gave any health', () => {
    // Health with no maximum behind it is not a monster at half strength; it is
    // something the server never described as having health to lose.
    const { aimAt, enemies, tick } = harness();
    enemies.push(enemy(1, 3, 0, { maxHp: 0 }));
    tick();
    expect(aimAt).not.toHaveBeenCalled();
  });

  it('shoots past a wall at the monster behind it', () => {
    const { aimAt, enemies, tick } = harness();
    // A wall in this game is an object with hit points, so to anything ranking
    // by distance it is simply the closest enemy.
    enemies.push(enemy(1, 2, 0, { objectType: WALL_TYPE }), enemy(2, 4, 0));
    tick();
    expect(aimAt).toHaveBeenCalledTimes(1);
    expect(aimAt.mock.calls[0]?.[0]).toBeCloseTo(4);
  });

  it('ignores an enemy beyond what the weapon can reach', () => {
    const { aimAt, enemies, tick } = harness();
    // Six tiles is the whole of it — there is no setting to widen it with.
    enemies.push(enemy(1, 7, 0));
    tick();
    expect(aimAt).not.toHaveBeenCalled();
  });

  // The slider that used to bound this defaulted to eight tiles, which was too
  // short for a wand and too long for a sword. A longer weapon has to reach
  // further without anyone changing a setting.
  it('reaches as far as the weapon does, whatever weapon that is', () => {
    const { aimAt, enemies, tick } = harness({
      weapon: { speedTilesPerMs: 0.008, lifetimeMs: 1500, reachTiles: 12 },
    });
    enemies.push(enemy(1, 11, 0));
    tick();
    expect(aimAt).toHaveBeenCalledTimes(1);
  });

  it('does nothing at all while switched off', () => {
    const { host, aimAt, enemies, tick } = harness();
    host.setEnabled('auto-aim', false);
    enemies.push(enemy(1, 3, 0));
    tick();
    expect(aimAt).not.toHaveBeenCalled();
  });

  describe('following the cursor', () => {
    const pointing = (host: PluginHost): void => {
      host.settingsOf('auto-aim')?.apply('priority', TargetPriority.ClosestToCursor);
    };

    it('points at the enemy the player is pointing at, not the nearest one', () => {
      const { host, aimAt, enemies, setCursor, tick } = harness();
      pointing(host);
      setCursor({ x: 0, y: 4 });
      enemies.push(enemy(1, 2, 0), enemy(2, 0, 4));
      tick();
      expect(aimAt).toHaveBeenCalledTimes(1);
      expect(aimAt.mock.calls[0]?.[0]).toBeCloseTo(0);
      expect(aimAt.mock.calls[0]?.[1]).toBeCloseTo(4);
    });

    it('leaves the shot alone while nobody has said where the player points', () => {
      // Silence is not "aim at the closest thing instead": an aim that is never
      // published is a shot that goes exactly where the player pointed, which
      // is the only right answer to not knowing where that is.
      const { host, aimAt, enemies, tick } = harness();
      pointing(host);
      enemies.push(enemy(1, 3, 0));
      tick();
      expect(aimAt).not.toHaveBeenCalled();
    });

    it('says nothing about an enemy outside the radius', () => {
      const { host, aimAt, enemies, setCursor, tick } = harness();
      pointing(host);
      // The cursor three tiles north, the monster three tiles east: over four
      // tiles apart, and the radius is four.
      setCursor({ x: 0, y: 3 });
      enemies.push(enemy(1, 3, 0));
      tick();
      expect(aimAt).not.toHaveBeenCalled();
    });

    it('still leads a moving target it was pointed at', () => {
      const { host, aimAt, enemies, setCursor, setTime, tick } = harness();
      pointing(host);
      setCursor({ x: 3, y: 0 });
      const walker = { ...enemy(1, 3, 0) };
      enemies.push(walker);
      tick();

      // A tick of walking north, and the same cursor. Choosing by the cursor
      // decides *which* enemy; where the shot goes is still the intercept.
      setTime(200);
      walker.y = 1;
      tick();
      expect(Number(aimAt.mock.calls.at(-1)?.[1])).toBeGreaterThan(1);
    });
  });
});

describe('the auto-aim plugin: letting shots through walls', () => {
  const features: [string, boolean | number | string][] = [];

  function load(): PluginHost {
    const host = new PluginHost({
      log: testLogger(),
      native: {
        connected: true,
        setFeature: (key, value) => {
          features.push([key, value]);
        },
        onConnected: () => () => undefined,
      } satisfies NativeApi,
      // No session at all, deliberately: the detours this claims are in the
      // client, and they are as wanted between maps as they are in one.
      sessions: {
        current: () => undefined,
        all: () => [],
        onConnected: () => () => undefined,
        onDisconnected: () => () => undefined,
      } satisfies SessionApi,
      onChanged: () => undefined,
    });
    host.load(
      createAutoAimPlugin({
        output: { aimAt: () => undefined },
        weapon: () => undefined,
        isObstacle: () => false,
        isInvincible: () => false,
        cursorPoint: () => undefined,
      }),
    );
    host.setEnabled('auto-aim', true);
    return host;
  }

  beforeEach(() => {
    features.length = 0;
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('claims nothing until the switch is on', () => {
    const host = load();
    vi.advanceTimersByTime(3000);
    expect(features).toEqual([]);

    host.settingsOf('auto-aim')?.apply('passWalls', true);
    // On the next planning interval rather than at once: the claim rides the
    // loop that is already running, and a detour going in a frame later is not
    // something anybody can perceive.
    vi.advanceTimersByTime(25);

    expect(features).toEqual([['shots.noclip', true]]);
  });

  it('restates the claim once a second, because it is a lease', () => {
    const host = load();
    host.settingsOf('auto-aim')?.apply('passWalls', true);

    vi.advanceTimersByTime(3000);

    // Not once per planning interval, which is a hundred times as often as the
    // lease needs and a hundred times the messages.
    expect(features).toEqual([
      ['shots.noclip', true],
      ['shots.noclip', true],
      ['shots.noclip', true],
    ]);
  });

  it('says stop once when the switch goes off, and then nothing', () => {
    const host = load();
    host.settingsOf('auto-aim')?.apply('passWalls', true);
    vi.advanceTimersByTime(1000);
    features.length = 0;

    host.settingsOf('auto-aim')?.apply('passWalls', false);
    vi.advanceTimersByTime(3000);

    expect(features).toEqual([['shots.noclip', false]]);
  });

  it('stops restating when the plugin is switched off, and lets the lease end it', () => {
    const host = load();
    host.settingsOf('auto-aim')?.apply('passWalls', true);
    vi.advanceTimersByTime(1000);
    features.length = 0;

    host.setEnabled('auto-aim', false);
    vi.advanceTimersByTime(5000);

    expect(features).toEqual([]);
  });

  it('drops the claim outright when the plugin is unloaded', () => {
    const host = load();
    host.settingsOf('auto-aim')?.apply('passWalls', true);
    vi.advanceTimersByTime(1000);
    features.length = 0;

    host.unload('auto-aim');

    expect(features).toContainEqual(['shots.noclip', false]);
  });
});
