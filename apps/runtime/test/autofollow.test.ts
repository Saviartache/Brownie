import {
  MutablePacket,
  type EntityView,
  type Position,
  type SessionApi,
  type SessionView,
} from '@brownie/plugin-api';
import { createPacket, decodeFrame, encodePacket } from '@brownie/protocol';
import { createBundledRegistry } from '@brownie/protocol/bundled';
import { describe, expect, it, vi } from 'vitest';

import {
  createAutoFollowPlugin,
  type AutoFollowInputs,
} from '../src/features/autofollow/autoFollowPlugin.js';
import { FollowTrail } from '../src/features/autofollow/FollowTrail.js';
import {
  clearLineBetween,
  followPoint,
  nearestPlayerTo,
} from '../src/features/autofollow/followMath.js';
import { PluginHost } from '../src/plugins/PluginHost.js';
import { testLogger } from './fakes.js';

const registry = createBundledRegistry();

const BOSS_TYPE = 0x0aaa;

function entity(
  overrides: Partial<EntityView> & Pick<EntityView, 'objectId' | 'x' | 'y'>,
): EntityView {
  return {
    objectType: 0,
    name: '',
    hp: 100,
    maxHp: 100,
    isEnemy: false,
    isPlayer: false,
    conditions: 0,
    guildName: '',
    stat: () => undefined,
    text: () => undefined,
    ...overrides,
  };
}

describe('follow geometry', () => {
  it('walks to a point short of the target by the keep distance', () => {
    expect(followPoint({ x: 0, y: 0 }, { x: 10, y: 0 }, 1.5)).toEqual({ x: 8.5, y: 0 });
  });

  it('says stand still once already within the keep distance', () => {
    expect(followPoint({ x: 0, y: 0 }, { x: 1, y: 0 }, 1.5)).toBeUndefined();
  });

  it('picks the nearest player within reach of the cursor, never ourselves', () => {
    const players = [
      entity({ objectId: 99, x: 4, y: 0, isPlayer: true }), // us, nearest but excluded
      entity({ objectId: 11, x: 3.5, y: 0, isPlayer: true }),
      entity({ objectId: 12, x: 4.6, y: 0, isPlayer: true }),
    ];
    expect(nearestPlayerTo(players, { x: 4, y: 0 }, 99, 1)?.objectId).toBe(11);
  });

  it('picks nobody when every player is out of reach of the cursor', () => {
    const players = [entity({ objectId: 11, x: 3, y: 0, isPlayer: true })];
    expect(nearestPlayerTo(players, { x: 4.5, y: 0 }, 99, 1)).toBeUndefined();
  });

  it('sees a wall standing between two points and not beside them', () => {
    const blocked = (x: number, y: number): boolean => !(x > 4 && x < 5 && y > -1 && y < 1);
    expect(clearLineBetween({ x: 0, y: 0 }, { x: 10, y: 0 }, blocked)).toBe(false);
    expect(clearLineBetween({ x: 0, y: 3 }, { x: 10, y: 3 }, blocked)).toBe(true);
  });

  it('refuses a pillar narrower than the gap between the two ends', () => {
    const open = (x: number, y: number): boolean => !(Math.abs(x - 5) < 0.2 && Math.abs(y) < 0.2);
    expect(clearLineBetween({ x: 0, y: 0 }, { x: 10, y: 0 }, open)).toBe(false);
  });
});

describe('the follow trail', () => {
  const OPEN = (): boolean => true;
  const BLIND = (): boolean => false;

  it('collapses to the straight line while the ally is in sight', () => {
    const trail = new FollowTrail();
    trail.aim(11);
    for (let x = 1; x <= 6; x += 1) trail.record({ x, y: 0 });

    const point = trail.steer({ x: 0, y: 0 }, { x: 6, y: 0 }, 1.5, OPEN);

    expect(point).toEqual({ x: 4.5, y: 0 });
    // One place kept, so an ally who steps behind something next tick leaves
    // the near side of it to walk to.
    expect(trail.length).toBe(1);
  });

  it('walks the ally round a corner rather than into it', () => {
    const trail = new FollowTrail();
    trail.aim(11);
    // The ally ran east along a corridor and turned north at its end.
    trail.record({ x: 4, y: 0 });
    trail.record({ x: 8, y: 0 });
    trail.record({ x: 8, y: 4 });

    // A wall hides everything north of the corridor from where we stand.
    const visible = (_from: Position, to: Position): boolean => to.y < 1;
    const point = trail.steer({ x: 0, y: 0 }, { x: 8, y: 8 }, 1.5, visible);

    expect(point).toEqual({ x: 8, y: 0 }); // the corner, not the ally
  });

  it('skips the places it can reach past, rather than retracing every one', () => {
    const trail = new FollowTrail();
    trail.aim(11);
    // The ally dithered along the way; none of it is worth copying.
    trail.record({ x: 1, y: 0 });
    trail.record({ x: 2, y: 1 });
    trail.record({ x: 3, y: 0 });
    trail.record({ x: 4, y: 1 });
    trail.record({ x: 5, y: 0 });

    const visible = (_from: Position, to: Position): boolean => to.x <= 5;
    const point = trail.steer({ x: 0, y: 0 }, { x: 9, y: 9 }, 1.5, visible);

    expect(point).toEqual({ x: 5, y: 0 });
    expect(trail.length).toBe(1); // everything older is gone, not walked
  });

  it('drops the places already underfoot', () => {
    const trail = new FollowTrail();
    trail.aim(11);
    trail.record({ x: 1, y: 0 });
    trail.record({ x: 2, y: 0 });
    trail.record({ x: 3, y: 0 });

    // Standing on the first crumb with nothing in sight: it must not be the
    // answer to "where next", or the follow shuffles on the spot.
    const point = trail.steer({ x: 1, y: 0 }, { x: 4, y: 0 }, 1.5, BLIND);

    expect(point).toEqual({ x: 2, y: 0 });
  });

  it('forgets the route when the ally changes', () => {
    const trail = new FollowTrail();
    trail.aim(11);
    trail.record({ x: 5, y: 5 });
    trail.aim(22);

    expect(trail.length).toBe(0);
  });

  it('records the shape of a route and not every tick of it', () => {
    const trail = new FollowTrail();
    trail.aim(11);
    for (let i = 0; i < 100; i += 1) trail.record({ x: i * 0.05, y: 0 });

    expect(trail.length).toBeLessThan(10);
  });

  it('never grows past its cap, however far the ally runs', () => {
    const trail = new FollowTrail();
    trail.aim(11);
    for (let x = 0; x < 2000; x += 1) trail.record({ x, y: 0 });

    expect(trail.length).toBeLessThanOrEqual(48);
  });
});

describe('the auto-follow plugin', () => {
  const NATIVE = {
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

  interface Harness {
    host: PluginHost;
    session: SessionView;
    enemies: EntityView[];
    players: EntityView[];
    self: {
      objectId: number;
      x: number;
      y: number;
      walkSpeedTilesPerSecond: number;
      alive: boolean;
    };
    moveTo: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    follow: { id: number | undefined };
    cursor: { point: Position | undefined };
    /** Says a Shift+left-click just happened. The plugin only compares stamps. */
    press: () => void;
    steer: { direction: Position | undefined };
    /** Tiles the body may not stand on, as `"x,y"`. Empty is open ground. */
    walls: Set<string>;
  }

  function harness(): Harness {
    const enemies: EntityView[] = [];
    const players: EntityView[] = [];
    const self = { objectId: 99, x: 0, y: 0, walkSpeedTilesPerSecond: 5, alive: true };
    const follow = { id: undefined as number | undefined };
    const cursor = { point: undefined as Position | undefined };
    const pick = { atMs: 0 };
    const steer = { direction: undefined as Position | undefined };
    const walls = new Set<string>();

    const session = {
      id: 's1',
      self,
      world: {
        mapName: 'Ocean Trench',
        gameTimeMs: 100_000,
        enemies: () => enemies,
        players: () => players,
        entity: (id: number) => [...enemies, ...players].find((e) => e.objectId === id),
        // The plugin probes tile centres and widens the body itself, so a
        // blocked tile here is a blocked tile there.
        canStandAt: (x: number, y: number) =>
          !walls.has(`${String(Math.floor(x))},${String(Math.floor(y))}`),
        tileAt: () => undefined,
      },
      notify: () => undefined,
    } as unknown as SessionView;

    const moveTo = vi.fn();
    const stop = vi.fn();
    const inputs: AutoFollowInputs = {
      output: { moveTo, stop },
      followTarget: {
        current: () => follow.id,
        clear: () => {
          follow.id = undefined;
        },
      },
      isBoss: (type) => type === BOSS_TYPE,
      cursorPoint: () => cursor.point,
      pick: { at: () => pick.atMs },
      steer: { direction: () => steer.direction },
    };

    const host = new PluginHost({
      log: testLogger(),
      native: NATIVE,
      sessions: SESSIONS,
      onChanged: () => undefined,
    });
    host.load(createAutoFollowPlugin(inputs));
    host.setEnabled('auto-follow', true);

    return {
      host,
      session,
      enemies,
      players,
      self,
      moveTo,
      stop,
      follow,
      cursor,
      press: () => {
        pick.atMs += 1;
      },
      steer,
      walls,
    };
  }

  const setting = (h: Harness, key: string, value: unknown): void => {
    h.host.settingsOf('auto-follow')!.apply(key, value);
  };

  const newtick = (): MutablePacket => {
    const packet = createPacket(registry, 'NEWTICK');
    packet.fields['tickId'] = 0;
    packet.fields['tickTime'] = 200;
    packet.fields['serverRealTimeMs'] = 0;
    packet.fields['serverLastRttMs'] = 0;
    packet.fields['statuses'] = [];
    return new MutablePacket(decodeFrame(registry, encodePacket(registry, packet)));
  };
  const tick = (h: Harness): void => {
    h.host.dispatchPacket(newtick(), h.session);
  };

  const player = (id: number, at: Position, name = 'Ally'): EntityView =>
    entity({ objectId: id, x: at.x, y: at.y, isPlayer: true, name });

  it('walks toward the ally auto-teleport named, keeping its distance', () => {
    const h = harness();
    setting(h, 'stopNearBoss', false);
    h.players.push(player(11, { x: 10, y: 0 }));
    h.follow.id = 11;
    tick(h);

    expect(h.moveTo).toHaveBeenCalledWith(8.5, 0, 5, expect.any(Number));
  });

  it('stands still once within the keep distance', () => {
    const h = harness();
    setting(h, 'stopNearBoss', false);
    h.players.push(player(11, { x: 1, y: 0 }));
    h.follow.id = 11;
    tick(h);

    expect(h.moveTo).not.toHaveBeenCalled();
  });

  it('lets a manual pick override the automatic target', () => {
    const h = harness();
    setting(h, 'stopNearBoss', false);
    h.players.push(player(11, { x: 10, y: 0 }, 'Auto'));
    h.players.push(player(22, { x: 0, y: 3 }, 'Picked'));
    h.follow.id = 11; // auto target
    h.cursor.point = { x: 0, y: 3 };
    h.press();
    tick(h);

    expect(h.moveTo).toHaveBeenCalledWith(0, 1.5, 5, expect.any(Number));
  });

  it('cancels the follow when the click lands where no ally is', () => {
    const h = harness();
    setting(h, 'stopNearBoss', false);
    h.players.push(player(11, { x: 10, y: 0 }));
    h.follow.id = 11;
    tick(h);
    h.moveTo.mockClear();

    h.cursor.point = { x: 0, y: 5 }; // empty ground, and the ally is far from it
    h.press();
    tick(h);

    expect(h.follow.id).toBeUndefined();
    expect(h.moveTo).not.toHaveBeenCalled();
    expect(h.stop).toHaveBeenCalled();
  });

  it('lets go of a hand-picked ally when the next click lands on nothing', () => {
    const h = harness();
    setting(h, 'stopNearBoss', false);
    h.players.push(player(11, { x: 3, y: 0 }));
    h.cursor.point = { x: 3, y: 0 };
    h.press();
    tick(h);
    expect(h.moveTo).toHaveBeenCalledWith(1.5, 0, 5, expect.any(Number));
    h.moveTo.mockClear();

    h.cursor.point = { x: 3, y: 4 };
    h.press();
    tick(h);

    expect(h.moveTo).not.toHaveBeenCalled();
    expect(h.stop).toHaveBeenCalled();
  });

  it('stops following once at the boss', () => {
    const h = harness();
    h.players.push(player(11, { x: 20, y: 0 }));
    h.enemies.push(entity({ objectId: 1, objectType: BOSS_TYPE, x: 3, y: 0, isEnemy: true }));
    h.follow.id = 11;
    tick(h);

    expect(h.moveTo).not.toHaveBeenCalled();
  });

  it('drops a target that has left the map', () => {
    const h = harness();
    setting(h, 'stopNearBoss', false);
    h.follow.id = 11; // no such entity present
    tick(h);

    expect(h.follow.id).toBeUndefined();
    expect(h.moveTo).not.toHaveBeenCalled();
  });

  it('yields to hand steering when told to', () => {
    const h = harness();
    setting(h, 'stopNearBoss', false);
    setting(h, 'respectSteer', true);
    h.players.push(player(11, { x: 10, y: 0 }));
    h.follow.id = 11;
    h.steer.direction = { x: 1, y: 0 };
    tick(h);

    expect(h.moveTo).not.toHaveBeenCalled();
  });

  it('walks the corner the ally turned instead of running at the wall', () => {
    const h = harness();
    setting(h, 'stopNearBoss', false);
    // A wall down the column at x = 5, with a gap at y = 0.
    for (let y = 1; y <= 12; y += 1) h.walls.add(`5,${String(y)}`);

    const ally = player(11, { x: 7, y: 0 });
    h.players.push(ally);
    h.follow.id = 11;
    tick(h); // in sight down the open row, so the trail learns the doorway

    // The ally carries on north, behind the wall.
    for (const at of [
      { x: 7, y: 2 },
      { x: 7, y: 5 },
      { x: 7, y: 8 },
    ]) {
      Object.assign(ally, at);
      h.moveTo.mockClear();
      tick(h);
    }

    const [x, y] = h.moveTo.mock.calls.at(-1)!;
    // Aimed through the gap rather than at the ally, which the wall is between.
    expect(y).toBeLessThan(2);
    expect(x).toBeGreaterThan(4);
  });

  it('does nothing while dead', () => {
    const h = harness();
    setting(h, 'stopNearBoss', false);
    h.players.push(player(11, { x: 10, y: 0 }));
    h.follow.id = 11;
    h.self.alive = false;
    tick(h);

    expect(h.moveTo).not.toHaveBeenCalled();
  });
});
