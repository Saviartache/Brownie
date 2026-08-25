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
import { followPoint, nearestPlayerTo } from '../src/features/autofollow/followMath.js';
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
    pickPending: { value: boolean };
    steer: { direction: Position | undefined };
  }

  function harness(): Harness {
    const enemies: EntityView[] = [];
    const players: EntityView[] = [];
    const self = { objectId: 99, x: 0, y: 0, walkSpeedTilesPerSecond: 5, alive: true };
    const follow = { id: undefined as number | undefined };
    const cursor = { point: undefined as Position | undefined };
    const pickPending = { value: false };
    const steer = { direction: undefined as Position | undefined };

    const session = {
      id: 's1',
      self,
      world: {
        mapName: 'Ocean Trench',
        gameTimeMs: 100_000,
        enemies: () => enemies,
        players: () => players,
        entity: (id: number) => [...enemies, ...players].find((e) => e.objectId === id),
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
      pick: {
        pending: () => {
          const pressed = pickPending.value;
          pickPending.value = false;
          return pressed;
        },
      },
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
      pickPending,
      steer,
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
    h.pickPending.value = true;
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
    h.pickPending.value = true;
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
    h.pickPending.value = true;
    tick(h);
    expect(h.moveTo).toHaveBeenCalledWith(1.5, 0, 5, expect.any(Number));
    h.moveTo.mockClear();

    h.cursor.point = { x: 3, y: 4 };
    h.pickPending.value = true;
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
