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
  createAutoPortalPlugin,
  type AutoPortalInputs,
} from '../src/features/autoportal/autoPortalPlugin.js';
import { ENTER_RADIUS_TILES } from '../src/features/autoportal/constants.js';
import { findChosenPortals, isNexus } from '../src/features/autoportal/portals.js';
import { PluginHost } from '../src/plugins/PluginHost.js';
import { testLogger } from './fakes.js';

const registry = createBundledRegistry();

const UNDEAD = 0x71a;
const ABYSS = 0x71b;
const REALM = 0x0703; // a portal type the player did not choose

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

function portal(objectId: number, objectType: number, at: Position): EntityView {
  return {
    objectId,
    objectType,
    x: at.x,
    y: at.y,
    name: '',
    hp: 0,
    maxHp: 0,
    isEnemy: false,
    isPlayer: false,
    conditions: 0,
    guildName: '',
    stat: () => undefined,
    text: () => undefined,
  };
}

describe('finding chosen portals', () => {
  const world = (entities: EntityView[]): { entities(): Iterable<EntityView> } => ({
    entities: () => entities,
  });
  const isDungeon = (type: number): boolean => type === UNDEAD || type === ABYSS;

  it('keeps only chosen dungeon portals, nearest first', () => {
    const entities = [
      portal(1, ABYSS, { x: 20, y: 0 }),
      portal(2, UNDEAD, { x: 5, y: 0 }),
      portal(3, REALM, { x: 1, y: 0 }), // a dungeon it is not — never returned
    ];
    const found = findChosenPortals(
      world(entities) as never,
      { x: 0, y: 0 },
      isDungeon,
      new Set([UNDEAD, ABYSS]),
    );
    expect(found.map((p) => p.entity.objectId)).toEqual([2, 1]);
  });

  it('returns nothing when nothing is chosen', () => {
    const entities = [portal(1, UNDEAD, { x: 5, y: 0 })];
    expect(
      findChosenPortals(world(entities) as never, { x: 0, y: 0 }, isDungeon, new Set()),
    ).toEqual([]);
  });

  it('knows the Nexus by name, however it is cased or padded', () => {
    expect(isNexus('Nexus')).toBe(true);
    expect(isNexus('  nexus ')).toBe(true);
    expect(isNexus('Undead Lair')).toBe(false);
  });
});

describe('the auto-portal plugin', () => {
  interface Harness {
    host: PluginHost;
    session: SessionView;
    entities: EntityView[];
    self: { x: number; y: number; walkSpeedTilesPerSecond: number; alive: boolean };
    world: { mapName: string; gameTimeMs: number };
    moveTo: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    sent: ReturnType<typeof vi.fn>;
    steer: Position | undefined;
  }

  function harness(options: { map?: string } = {}): Harness {
    const entities: EntityView[] = [];
    const self = { x: 0, y: 0, walkSpeedTilesPerSecond: 5, alive: true };
    const world = { mapName: options.map ?? 'Nexus', gameTimeMs: 100_000 };
    const state = { steer: undefined as Position | undefined };
    const sent = vi.fn();

    const session = {
      id: 's1',
      self,
      // Getters, so a test moving the clock or changing the map is seen by the
      // next tick without rebuilding the session.
      world: {
        get mapName(): string {
          return world.mapName;
        },
        get gameTimeMs(): number {
          return world.gameTimeMs;
        },
        entities: () => entities,
        entity: (id: number) => entities.find((e) => e.objectId === id),
      },
      sendToServer: sent,
      notify: () => undefined,
    } as unknown as SessionView;

    const moveTo = vi.fn();
    const stop = vi.fn();
    const inputs: AutoPortalInputs = {
      output: { moveTo, stop },
      isDungeonPortal: (type) => type === UNDEAD || type === ABYSS,
      displayName: (type) => (type === UNDEAD ? 'Undead Lair Portal' : undefined),
      dungeonPortals: () => [
        { type: UNDEAD, name: 'Undead Lair Portal' },
        { type: ABYSS, name: 'Abyss of Demons Portal' },
      ],
      steer: { direction: () => state.steer },
    };

    const host = new PluginHost({
      log: testLogger(),
      native: NATIVE,
      sessions: SESSIONS,
      onChanged: () => undefined,
    });
    host.load(createAutoPortalPlugin(inputs));
    host.setEnabled('auto-portal', true);

    return {
      host,
      session,
      entities,
      self,
      world,
      moveTo,
      stop,
      sent,
      get steer(): Position | undefined {
        return state.steer;
      },
      set steer(value: Position | undefined) {
        state.steer = value;
      },
    };
  }

  const choose = (h: Harness, ...types: number[]): void => {
    h.host.settingsOf('auto-portal')!.apply('portals', types.map(String).join(','));
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

  it('walks toward a chosen portal that someone opened', () => {
    const h = harness();
    h.entities.push(portal(11, UNDEAD, { x: 10, y: 0 }));
    choose(h, UNDEAD);
    tick(h);

    expect(h.moveTo).toHaveBeenCalledWith(10, 0, 5, expect.any(Number));
    expect(h.sent).not.toHaveBeenCalled();
  });

  it('enters the portal once it is standing on it', () => {
    const h = harness();
    h.entities.push(portal(11, UNDEAD, { x: ENTER_RADIUS_TILES / 2, y: 0 }));
    choose(h, UNDEAD);
    tick(h);

    expect(h.sent).toHaveBeenCalledWith('USEPORTAL', { objectId: 11 });
  });

  it('spaces repeated entry attempts rather than sending one a tick', () => {
    const h = harness();
    h.entities.push(portal(11, UNDEAD, { x: 0, y: 0 }));
    choose(h, UNDEAD);

    tick(h);
    tick(h); // same instant: still inside the interval
    expect(h.sent).toHaveBeenCalledTimes(1);

    h.world.gameTimeMs += 2000;
    tick(h);
    expect(h.sent).toHaveBeenCalledTimes(2);
  });

  it('leaves a portal the player did not choose alone', () => {
    const h = harness();
    h.entities.push(portal(11, ABYSS, { x: 3, y: 0 }));
    choose(h, UNDEAD); // chose the Undead Lair, not the Abyss
    tick(h);

    expect(h.moveTo).not.toHaveBeenCalled();
    expect(h.sent).not.toHaveBeenCalled();
  });

  it('does nothing outside the Nexus', () => {
    const h = harness({ map: 'Undead Lair' });
    h.entities.push(portal(11, UNDEAD, { x: 10, y: 0 }));
    choose(h, UNDEAD);
    tick(h);

    expect(h.moveTo).not.toHaveBeenCalled();
    expect(h.sent).not.toHaveBeenCalled();
  });

  it('gives the wheel back while the player steers by hand', () => {
    const h = harness();
    h.entities.push(portal(11, UNDEAD, { x: 10, y: 0 }));
    choose(h, UNDEAD);

    tick(h); // walking
    expect(h.moveTo).toHaveBeenCalledTimes(1);

    h.steer = { x: 1, y: 0 };
    tick(h);
    expect(h.moveTo).toHaveBeenCalledTimes(1); // did not walk again
    expect(h.stop).toHaveBeenCalled(); // stood the walk down
  });

  it('does nothing while dead', () => {
    const h = harness();
    h.self.alive = false;
    h.entities.push(portal(11, UNDEAD, { x: 10, y: 0 }));
    choose(h, UNDEAD);
    tick(h);

    expect(h.moveTo).not.toHaveBeenCalled();
    expect(h.sent).not.toHaveBeenCalled();
  });
});
