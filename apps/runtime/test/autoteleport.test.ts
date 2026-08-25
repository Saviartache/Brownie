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
  createAutoTeleportPlugin,
  type AutoTeleportInputs,
} from '../src/features/autoteleport/autoTeleportPlugin.js';
import { MAX_FAILURES, TELEPORT_INTERVAL_MS } from '../src/features/autoteleport/constants.js';
import { nearestApproacher, nearestBoss } from '../src/features/autoteleport/bossApproach.js';
import { PluginHost } from '../src/plugins/PluginHost.js';
import { testLogger } from './fakes.js';

const registry = createBundledRegistry();

const BOSS_TYPE = 0x0aaa;
const RAT_TYPE = 0x0bbb;

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

describe('finding the boss and its approachers', () => {
  const isBoss = (type: number): boolean => type === BOSS_TYPE;

  it('picks the nearest quest boss and ignores the trash', () => {
    const enemies = [
      entity({ objectId: 1, objectType: RAT_TYPE, x: 1, y: 0, isEnemy: true }),
      entity({ objectId: 2, objectType: BOSS_TYPE, x: 30, y: 0, isEnemy: true }),
      entity({ objectId: 3, objectType: BOSS_TYPE, x: 10, y: 0, isEnemy: true }),
    ];
    expect(nearestBoss(enemies, isBoss, { x: 0, y: 0 })?.objectId).toBe(3);
  });

  it('returns nothing when no quest boss is present', () => {
    const enemies = [entity({ objectId: 1, objectType: RAT_TYPE, x: 1, y: 0, isEnemy: true })];
    expect(nearestBoss(enemies, isBoss, { x: 0, y: 0 })).toBeUndefined();
  });

  it('finds the nearest other player within reach of the boss', () => {
    const boss: Position = { x: 0, y: 0 };
    const players = [
      entity({ objectId: 10, x: 100, y: 0, isPlayer: true }), // too far
      entity({ objectId: 11, x: 5, y: 0, isPlayer: true }),
      entity({ objectId: 99, x: 1, y: 0, isPlayer: true }), // us
    ];
    expect(nearestApproacher(players, boss, 99, 8)?.objectId).toBe(11);
  });

  it('never counts ourselves as an approacher', () => {
    const boss: Position = { x: 0, y: 0 };
    const players = [entity({ objectId: 99, x: 1, y: 0, isPlayer: true })];
    expect(nearestApproacher(players, boss, 99, 8)).toBeUndefined();
  });
});

describe('the auto-teleport plugin', () => {
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
      name: string;
    };
    world: { mapName: string; gameTimeMs: number };
    sent: ReturnType<typeof vi.fn>;
    requestFollow: ReturnType<typeof vi.fn>;
  }

  function harness(options: { map?: string } = {}): Harness {
    const enemies: EntityView[] = [];
    const players: EntityView[] = [];
    const self = {
      objectId: 99,
      x: 0,
      y: 0,
      walkSpeedTilesPerSecond: 5,
      alive: true,
      name: 'Me',
    };
    const world = { mapName: options.map ?? 'Ocean Trench', gameTimeMs: 100_000 };
    const sent = vi.fn();

    const session = {
      id: 's1',
      self,
      world: {
        get mapName(): string {
          return world.mapName;
        },
        get gameTimeMs(): number {
          return world.gameTimeMs;
        },
        enemies: () => enemies,
        players: () => players,
        entity: (id: number) => [...enemies, ...players].find((e) => e.objectId === id),
      },
      sendToServer: sent,
      notify: () => undefined,
    } as unknown as SessionView;

    const requestFollow = vi.fn();
    const inputs: AutoTeleportInputs = {
      isBoss: (type) => type === BOSS_TYPE,
      requestFollow,
    };

    const host = new PluginHost({
      log: testLogger(),
      native: NATIVE,
      sessions: SESSIONS,
      onChanged: () => undefined,
    });
    host.load(createAutoTeleportPlugin(inputs));
    host.setEnabled('auto-teleport', true);

    return { host, session, enemies, players, self, world, sent, requestFollow };
  }

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

  const mapinfo = (allowTeleport: boolean): MutablePacket => {
    const packet = createPacket(registry, 'MAPINFO');
    packet.fields['width'] = 1;
    packet.fields['height'] = 1;
    packet.fields['name'] = 'Ocean Trench';
    packet.fields['displayName'] = 'Ocean Trench';
    packet.fields['realmName'] = '';
    packet.fields['fp'] = 0;
    packet.fields['background'] = 0;
    packet.fields['difficulty'] = 0;
    packet.fields['allowPlayerTeleport'] = allowTeleport;
    packet.fields['noSave'] = false;
    return new MutablePacket(decodeFrame(registry, encodePacket(registry, packet)));
  };

  const boss = (at: Position): EntityView =>
    entity({ objectId: 1, objectType: BOSS_TYPE, x: at.x, y: at.y, isEnemy: true });
  const teammate = (id: number, at: Position, name = 'Ally'): EntityView =>
    entity({ objectId: id, x: at.x, y: at.y, isPlayer: true, name });

  it('teleports to a teammate at the boss when we are far off', () => {
    const h = harness();
    h.enemies.push(boss({ x: 100, y: 0 }));
    h.players.push(teammate(11, { x: 101, y: 0 }, 'Ally'));
    tick(h);

    expect(h.sent).toHaveBeenCalledWith('TELEPORT', { objectId: 11, playerName: 'Ally' });
  });

  it('names the teammate to follow once we have arrived', () => {
    const h = harness();
    h.enemies.push(boss({ x: 100, y: 0 }));
    const ally = teammate(11, { x: 101, y: 0 });
    h.players.push(ally);

    tick(h); // sends the teleport
    // The server "moves" us onto the ally; the next tick confirms arrival.
    h.self.x = 101;
    h.self.y = 0;
    tick(h);

    expect(h.requestFollow).toHaveBeenCalledWith(11);
  });

  it('does nothing without a boss on the map', () => {
    const h = harness();
    h.players.push(teammate(11, { x: 5, y: 0 }));
    tick(h);
    expect(h.sent).not.toHaveBeenCalled();
  });

  it('does not teleport when we are already at the boss', () => {
    const h = harness();
    h.enemies.push(boss({ x: 2, y: 0 })); // we are at 0,0 — within reach
    h.players.push(teammate(11, { x: 3, y: 0 }));
    tick(h);
    expect(h.sent).not.toHaveBeenCalled();
  });

  it('does nothing in a safe zone', () => {
    const h = harness({ map: 'Nexus' });
    h.enemies.push(boss({ x: 100, y: 0 }));
    h.players.push(teammate(11, { x: 101, y: 0 }));
    tick(h);
    expect(h.sent).not.toHaveBeenCalled();
  });

  it('respects the teleport flag the map states', () => {
    const h = harness();
    h.host.dispatchPacket(mapinfo(false), h.session); // this dungeon forbids it
    h.enemies.push(boss({ x: 100, y: 0 }));
    h.players.push(teammate(11, { x: 101, y: 0 }));
    tick(h);
    expect(h.sent).not.toHaveBeenCalled();
  });

  it('teleports again once a map re-states that it is allowed', () => {
    const h = harness();
    h.host.dispatchPacket(mapinfo(true), h.session);
    h.enemies.push(boss({ x: 100, y: 0 }));
    h.players.push(teammate(11, { x: 101, y: 0 }));
    tick(h);
    expect(h.sent).toHaveBeenCalledTimes(1);
  });

  it('spaces attempts rather than sending one a tick', () => {
    const h = harness();
    h.enemies.push(boss({ x: 100, y: 0 }));
    h.players.push(teammate(11, { x: 101, y: 0 }));

    tick(h);
    tick(h); // same instant, teleport still unconfirmed
    expect(h.sent).toHaveBeenCalledTimes(1);
  });

  it('gives up on a map that keeps refusing', () => {
    const h = harness();
    h.enemies.push(boss({ x: 100, y: 0 }));
    h.players.push(teammate(11, { x: 101, y: 0 }));

    // Each attempt is sent, never confirmed (we never arrive), then times out a
    // cooldown later. After MAX_FAILURES the map is given up on.
    for (let attempt = 0; attempt < MAX_FAILURES; attempt += 1) {
      tick(h); // sends
      h.world.gameTimeMs += TELEPORT_INTERVAL_MS + 100; // past confirm + cooldown
      tick(h); // times the attempt out
    }
    const sentSoFar = h.sent.mock.calls.length;
    h.world.gameTimeMs += TELEPORT_INTERVAL_MS + 100;
    tick(h);
    expect(h.sent.mock.calls.length).toBe(sentSoFar); // blocked — no more attempts
  });

  it('does nothing while dead', () => {
    const h = harness();
    h.self.alive = false;
    h.enemies.push(boss({ x: 100, y: 0 }));
    h.players.push(teammate(11, { x: 101, y: 0 }));
    tick(h);
    expect(h.sent).not.toHaveBeenCalled();
  });
});
