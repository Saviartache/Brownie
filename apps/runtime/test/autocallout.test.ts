import {
  MutablePacket,
  type EntityView,
  type Position,
  type SessionApi,
  type SessionView,
} from '@brownie/plugin-api';
import { createPacket, decodeFrame, encodePacket, type FieldValue } from '@brownie/protocol';
import { createBundledRegistry } from '@brownie/protocol/bundled';
import { describe, expect, it, vi } from 'vitest';

import { createAutoCalloutPlugin } from '../src/features/autocallout/autoCalloutPlugin.js';
import {
  ANNOUNCE_INTERVAL_MS,
  MAX_PENDING,
  PORTAL_CALLOUT_TYPE,
  REACH_TILES,
  SETTLE_MS,
} from '../src/features/autocallout/constants.js';
import { announceablePortals } from '../src/features/autocallout/portals.js';
import { PluginHost } from '../src/plugins/PluginHost.js';
import type { DungeonPortal } from '../src/state/ObjectCatalog.js';
import { testLogger } from './fakes.js';

const registry = createBundledRegistry();

const PUPPET = 0x2353;
const SHATTERS = 0x0900;
const SNAKE_PIT = 0x0718;
/** A portal object the catalog has never heard of — a dungeon added since. */
const UNKNOWN_PORTAL = 0x7fff;
/** Not a portal at all, so nothing may announce it. */
const LOOT_BAG = 0x0500;

const PORTALS: readonly DungeonPortal[] = [
  {
    type: PUPPET,
    name: 'Puppet Theatre Portal',
    dungeonName: "Puppet Master's Theatre",
    keyType: undefined,
  },
  { type: SHATTERS, name: 'Shatters Portal', dungeonName: 'Shatters', keyType: undefined },
  { type: SNAKE_PIT, name: 'Snake Pit Portal', dungeonName: 'Snake Pit', keyType: undefined },
];

const NAMES = new Map(PORTALS.map((portal) => [portal.type, portal.dungeonName]));
const dungeonName = (objectType: number): string | undefined => NAMES.get(objectType);
const isDungeonPortal = (objectType: number): boolean =>
  NAMES.has(objectType) || objectType === UNKNOWN_PORTAL;

function entity(objectId: number, objectType: number, at: Position): EntityView {
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

describe('the portals that can be called out', () => {
  const world = (entities: EntityView[]): { entities(): Iterable<EntityView> } => ({
    entities: () => entities,
  });
  const find = (
    entities: EntityView[],
    reach = REACH_TILES,
  ): ReturnType<typeof announceablePortals> =>
    announceablePortals(
      world(entities) as never,
      { x: 0, y: 0 },
      isDungeonPortal,
      dungeonName,
      reach,
    );

  it('keeps the dungeon portals on this map, nearest first', () => {
    const found = find([
      entity(1, SHATTERS, { x: 20, y: 0 }),
      entity(2, PUPPET, { x: 5, y: 0 }),
      entity(3, LOOT_BAG, { x: 1, y: 0 }),
    ]);
    expect(found.map((portal) => portal.objectId)).toEqual([2, 1]);
    expect(found[0]?.dungeonName).toBe("Puppet Master's Theatre");
  });

  it('skips a portal the catalog cannot name', () => {
    expect(find([entity(1, UNKNOWN_PORTAL, { x: 1, y: 0 })])).toEqual([]);
  });

  it('skips a portal beyond reach', () => {
    expect(find([entity(1, PUPPET, { x: 5, y: 0 })], 2)).toEqual([]);
  });
});

describe('the auto-callout plugin', () => {
  interface Harness {
    host: PluginHost;
    session: SessionView;
    entities: EntityView[];
    world: { gameTimeMs: number };
    sent: ReturnType<typeof vi.fn>;
    /** Moves the clock on and offers a tick, which is what drives the plugin. */
    tick: (advanceMs?: number) => void;
    mapinfo: () => void;
    /** Every object id called out so far, in the order it went out. */
    calledOut: () => number[];
  }

  function harness(): Harness {
    const entities: EntityView[] = [];
    const world = { gameTimeMs: 100_000 };
    const sent = vi.fn();

    const session = {
      id: 's1',
      self: { x: 0, y: 0 },
      world: {
        mapName: 'Nexus',
        get gameTimeMs(): number {
          return world.gameTimeMs;
        },
        entities: () => entities,
        entity: (id: number) => entities.find((e) => e.objectId === id),
      },
      sendToServer: sent,
      notify: () => undefined,
    } as unknown as SessionView;

    const sessions: SessionApi = {
      current: () => session,
      all: () => [session],
      onConnected: () => () => undefined,
      onDisconnected: () => () => undefined,
    };

    const host = new PluginHost({
      log: testLogger(),
      native: { connected: false, setFeature: () => undefined, onConnected: () => () => undefined },
      sessions,
      onChanged: () => undefined,
    });
    host.load(createAutoCalloutPlugin({ isDungeonPortal, dungeonPortals: () => PORTALS }));
    host.setEnabled('auto-callout', true);

    const rebuilt = (name: string, fields: Record<string, FieldValue>): MutablePacket => {
      const packet = createPacket(registry, name);
      for (const [key, value] of Object.entries(fields)) packet.fields[key] = value;
      return new MutablePacket(decodeFrame(registry, encodePacket(registry, packet)));
    };

    return {
      host,
      session,
      entities,
      world,
      sent,
      tick: (advanceMs = 200): void => {
        world.gameTimeMs += advanceMs;
        host.dispatchPacket(
          rebuilt('NEWTICK', {
            tickId: 0,
            tickTime: 200,
            serverRealTimeMs: 0,
            serverLastRttMs: 0,
            statuses: [],
          }),
          session,
        );
      },
      mapinfo: (): void => {
        host.dispatchPacket(
          rebuilt('MAPINFO', {
            width: 1,
            height: 1,
            name: 'Nexus',
            displayName: 'Nexus',
            realmName: '',
            fp: 0,
            background: 0,
            difficulty: 0,
            allowTeleport: true,
            showDisplays: true,
            maxPlayers: 0,
            gameOpenedTime: 0,
            buildVersion: '',
            unknown: 0,
          }),
          session,
        );
      },
      calledOut: (): number[] =>
        sent.mock.calls.map((call) => (call[1] as { value: number }).value),
    };
  }

  /**
   * Moves past the settle window, so what appears afterwards counts as new.
   *
   * The first tick is what creates the session's state and starts the window,
   * so it has to happen before the clock is moved past it.
   */
  const settle = (h: Harness): void => {
    h.tick();
    h.tick(SETTLE_MS + 1);
  };

  it('calls out a portal that drops, by its object id', () => {
    const h = harness();
    settle(h);
    h.entities.push(entity(88, PUPPET, { x: 4, y: 0 }));
    h.tick();

    expect(h.sent).toHaveBeenCalledWith('PLAYERCALLOUT', {
      calloutType: PORTAL_CALLOUT_TYPE,
      value: 88,
    });
  });

  it('names each of three portals that drop together, one at a time', () => {
    const h = harness();
    settle(h);
    h.entities.push(
      entity(1, PUPPET, { x: 1, y: 0 }),
      entity(2, SHATTERS, { x: 2, y: 0 }),
      entity(3, SNAKE_PIT, { x: 3, y: 0 }),
    );

    h.tick();
    expect(h.calledOut()).toEqual([1]);

    // Still inside the interval: the queue waits rather than bursting.
    h.tick();
    expect(h.calledOut()).toEqual([1]);

    h.tick(ANNOUNCE_INTERVAL_MS);
    h.tick(ANNOUNCE_INTERVAL_MS);
    expect(h.calledOut()).toEqual([1, 2, 3]);
  });

  it('never names the same portal twice, however long it stands there', () => {
    const h = harness();
    settle(h);
    h.entities.push(entity(88, PUPPET, { x: 4, y: 0 }));
    for (let i = 0; i < 40; i += 1) h.tick(ANNOUNCE_INTERVAL_MS);

    expect(h.calledOut()).toEqual([88]);
  });

  it('stays quiet about the portals that were already there on arrival', () => {
    const h = harness();
    h.entities.push(entity(1, PUPPET, { x: 1, y: 0 }), entity(2, SHATTERS, { x: 2, y: 0 }));
    h.tick();
    settle(h);
    h.tick(ANNOUNCE_INTERVAL_MS);

    expect(h.sent).not.toHaveBeenCalled();
  });

  it('calls out a portal that pops just after the map has settled', () => {
    const h = harness();
    h.entities.push(entity(1, PUPPET, { x: 1, y: 0 }));
    h.tick();
    settle(h);
    h.entities.push(entity(2, SHATTERS, { x: 2, y: 0 }));
    h.tick();

    expect(h.calledOut()).toEqual([2]);
  });

  it('settles again on a new map, and forgets what the last one held', () => {
    const h = harness();
    settle(h);
    h.entities.push(entity(1, PUPPET, { x: 1, y: 0 }));
    h.tick();
    expect(h.calledOut()).toEqual([1]);

    h.mapinfo();
    h.entities.length = 0;
    // Same object id, a different map, and it arrived with it — so silence.
    h.entities.push(entity(1, SHATTERS, { x: 1, y: 0 }));
    h.tick();
    h.tick(ANNOUNCE_INTERVAL_MS);
    expect(h.calledOut()).toEqual([1]);
  });

  it('caps the queue, dropping the oldest so the newest still get named', () => {
    const h = harness();
    settle(h);
    const dropped = MAX_PENDING + 5;
    for (let i = 1; i <= dropped; i += 1) h.entities.push(entity(i, PUPPET, { x: i, y: 0 }));

    for (let i = 0; i <= dropped; i += 1) h.tick(ANNOUNCE_INTERVAL_MS);

    // The five oldest gave way, and every portal the queue could hold was
    // named — the newest among them included.
    expect(h.calledOut()).toHaveLength(MAX_PENDING);
    expect(h.calledOut()[0]).toBe(dropped - MAX_PENDING + 1);
    expect(h.calledOut().at(-1)).toBe(dropped);
  });

  it('ignores anything on the map that is not a dungeon portal', () => {
    const h = harness();
    settle(h);
    h.entities.push(
      entity(9, LOOT_BAG, { x: 1, y: 0 }),
      entity(10, UNKNOWN_PORTAL, { x: 2, y: 0 }),
    );
    h.tick(ANNOUNCE_INTERVAL_MS);

    expect(h.sent).not.toHaveBeenCalled();
  });
});
