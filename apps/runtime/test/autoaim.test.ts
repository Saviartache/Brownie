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
import { MotionTracker } from '../src/features/autoaim/MotionTracker.js';
import { CURSOR_FRESH_MS, CursorTracker } from '../src/native/CursorTracker.js';
import { TargetPriority, selectTarget } from '../src/features/autoaim/selectTarget.js';
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

  it('is a zero-length flight when the target is already on top of you', () => {
    expect(solveIntercept({ ...still, targetX: 0, targetY: 0 })?.flightMs).toBe(0);
  });
});

describe('MotionTracker', () => {
  it('has no opinion after a single sighting', () => {
    const tracker = new MotionTracker();
    tracker.observe(1, 0, 0, 0);
    expect(tracker.motionAt(1, 0)).toBeUndefined();
  });

  it('derives a velocity from two sightings', () => {
    const tracker = new MotionTracker();
    tracker.observe(1, 0, 0, 0);
    tracker.observe(1, 2, 0, 200);
    expect(tracker.motionAt(1, 200)?.velocityX).toBeCloseTo(0.01);
    expect(tracker.motionAt(1, 200)?.velocityY).toBeCloseTo(0);
  });

  it('settles towards a steady velocity rather than following one tick', () => {
    const tracker = new MotionTracker();
    tracker.observe(1, 0, 0, 0);
    tracker.observe(1, 2, 0, 200);
    // One tick where it did not move: a follower would call it stopped.
    tracker.observe(1, 2, 0, 400);
    const velocity = tracker.motionAt(1, 400)?.velocityX ?? 0;
    expect(velocity).toBeGreaterThan(0);
    expect(velocity).toBeLessThan(0.01);
  });

  it('restarts rather than averaging over a gap it did not watch', () => {
    const tracker = new MotionTracker();
    tracker.observe(1, 0, 0, 0);
    tracker.observe(1, 1, 0, 100);
    // Out of view for five seconds, then somewhere else entirely.
    tracker.observe(1, 40, 40, 5100);
    expect(tracker.motionAt(1, 5100)).toBeUndefined();
  });

  it('carries a track forward to the moment it is asked about', () => {
    const tracker = new MotionTracker();
    tracker.observe(1, 0, 0, 0);
    tracker.observe(1, 2, 0, 200);
    // Where the sighting put it, and where a hundred more milliseconds of the
    // same walking would have.
    expect(tracker.motionAt(1, 200)?.x).toBeCloseTo(2);
    expect(tracker.motionAt(1, 300)?.x).toBeCloseTo(3);
  });

  it('stops carrying a track that nothing has confirmed for a while', () => {
    const tracker = new MotionTracker();
    tracker.observe(1, 0, 0, 0);
    tracker.observe(1, 2, 0, 200);
    // A second of silence is not a second of walking: the monster has been free
    // to turn, stop or die, and nothing here saw it.
    const carried = tracker.motionAt(1, 1200)?.x ?? 0;
    expect(carried).toBeLessThan(2 + 0.01 * 1000);
  });

  it('forgets what it has not seen, so it cannot grow without bound', () => {
    const tracker = new MotionTracker();
    tracker.observe(1, 0, 0, 0);
    tracker.observe(2, 0, 0, 0);
    tracker.observe(2, 1, 0, 200);
    tracker.prune(2000);
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
    /** One sighting followed by one decision, which is a server tick's worth. */
    tick: () => void;
    /** A decision with no packet behind it, which is the usual case now. */
    plan: () => void;
  } {
    const aimAt = vi.fn();
    const enemies: EntityView[] = [];
    let gameTimeMs = 0;
    let cursorPoint: Position | undefined;

    const session = {
      id: 's1',
      self: {
        objectId: 1,
        hp: 100,
        maxHp: 100,
        x: 0,
        y: 0,
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
      setCursor: (point: Position | undefined) => {
        cursorPoint = point;
      },
      plan,
      tick: () => {
        host.dispatchPacket(newtick(), session);
        plan();
      },
    };
  }

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
