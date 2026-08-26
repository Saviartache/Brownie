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

import { GameId } from '../src/constants/GameId.js';
import { REACH_TILES } from '../src/features/portalentry/constants.js';
import { createPortalEntryPlugin } from '../src/features/portalentry/portalEntryPlugin.js';
import { portalUnder } from '../src/features/portalentry/portals.js';
import { PluginHost } from '../src/plugins/PluginHost.js';
import { testLogger } from './fakes.js';

const registry = createBundledRegistry();

const REALM = 0x0704;
const UNDEAD = 0x71a;
const LOOT_BAG = 0x500; // something on the same square that is not a portal

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

function entity(objectId: number, objectType: number, at: Position, name = ''): EntityView {
  return {
    objectId,
    objectType,
    x: at.x,
    y: at.y,
    name,
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

describe('the portal under the player', () => {
  const world = (entities: EntityView[]): { entities(): Iterable<EntityView> } => ({
    entities: () => entities,
  });
  const isPortal = (type: number): boolean => type === REALM || type === UNDEAD;

  it('ignores everything on the square that is not a portal', () => {
    const entities = [entity(1, LOOT_BAG, { x: 0, y: 0 }), entity(2, REALM, { x: 0.2, y: 0 })];
    expect(
      portalUnder(world(entities) as never, { x: 0, y: 0 }, isPortal, REACH_TILES)?.objectId,
    ).toBe(2);
  });

  it('takes the nearest when two are within reach', () => {
    const entities = [entity(1, REALM, { x: 0.9, y: 0 }), entity(2, UNDEAD, { x: 0.3, y: 0 })];
    expect(
      portalUnder(world(entities) as never, { x: 0, y: 0 }, isPortal, REACH_TILES)?.objectId,
    ).toBe(2);
  });

  it('finds nothing when the only portal is out of reach', () => {
    const entities = [entity(1, UNDEAD, { x: REACH_TILES + 0.1, y: 0 })];
    expect(
      portalUnder(world(entities) as never, { x: 0, y: 0 }, isPortal, REACH_TILES),
    ).toBeUndefined();
  });

  it('finds nothing in an empty world', () => {
    expect(portalUnder(world([]) as never, { x: 0, y: 0 }, isPortal, REACH_TILES)).toBeUndefined();
  });
});

describe('the portal commands', () => {
  interface Sent {
    readonly name: string;
    readonly fields: Readonly<Record<string, unknown>>;
  }

  interface Harness {
    host: PluginHost;
    session: SessionView;
    /** A second connection, as a reconnect produces — same player, new session. */
    other: SessionView;
    entities: EntityView[];
    self: { x: number; y: number };
    world: { gameTimeMs: number };
    toServer: Sent[];
    toClient: Sent[];
    said: string[];
  }

  function harness(): Harness {
    const entities: EntityView[] = [];
    const self = { x: 0, y: 0 };
    const world = { gameTimeMs: 100_000 };
    const toServer: Sent[] = [];
    const toClient: Sent[] = [];
    const said: string[] = [];

    const sessionAs = (id: string): SessionView =>
      ({
        id,
        self,
        // Getters, so a test moving the clock is seen by the next tick without
        // rebuilding the session.
        world: {
          get gameTimeMs(): number {
            return world.gameTimeMs;
          },
          entities: () => entities,
        },
        sendToServer: (name: string, fields: Readonly<Record<string, unknown>>) => {
          toServer.push({ name, fields });
        },
        sendToClient: (name: string, fields: Readonly<Record<string, unknown>>) => {
          toClient.push({ name, fields });
        },
        notify: (text: string) => said.push(text),
      }) as unknown as SessionView;

    const host = new PluginHost({ log: testLogger(), native: NATIVE, sessions: SESSIONS });
    host.load(
      createPortalEntryPlugin({
        isPortal: (type) => type === REALM || type === UNDEAD,
        displayName: (type) => (type === UNDEAD ? 'Undead Lair Portal' : undefined),
      }),
    );
    host.setEnabled('portal-entry', true);

    return {
      host,
      session: sessionAs('s1'),
      other: sessionAs('s2'),
      entities,
      self,
      world,
      toServer,
      toClient,
      said,
    };
  }

  /** A reconnect as it arrives from the server, through the real codec. */
  const reconnect = (fields: {
    name: string;
    host: string;
    port: number;
    gameId: number;
    keyTime: number;
    key: Buffer;
  }): MutablePacket => {
    const packet = createPacket(registry, 'RECONNECT');
    Object.assign(packet.fields, fields);
    return new MutablePacket(decodeFrame(registry, encodePacket(registry, packet)));
  };

  const ENTERED = {
    name: 'Undead Lair',
    host: '52.207.206.31',
    port: 2050,
    gameId: 4711,
    keyTime: 1234,
    key: Buffer.from([1, 2, 3, 4]),
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
  const tick = (h: Harness, session: SessionView = h.session): void => {
    h.host.dispatchPacket(newtick(), session);
  };

  const retryFor = (h: Harness, seconds: number): void => {
    h.host.settingsOf('portal-entry')?.apply('retrySeconds', seconds);
  };

  describe('/back', () => {
    it('says so while no portal has been gone through', () => {
      const h = harness();
      expect(h.host.dispatchCommand('back', [], h.session)).toBe(true);

      expect(h.toClient).toEqual([]);
      expect(h.said).toEqual(['No portal to go back through yet.']);
    });

    it('replays the reconnect the server sent, seat and all', () => {
      const h = harness();
      h.host.dispatchPacket(reconnect(ENTERED), h.session);
      h.host.dispatchCommand('back', [], h.session);

      expect(h.toClient).toHaveLength(1);
      expect(h.toClient[0]?.name).toBe('RECONNECT');
      expect(h.toClient[0]?.fields).toEqual(ENTERED);
      expect(h.said).toEqual(['Going back to Undead Lair...']);
    });

    it('sends fields the encoder accepts', () => {
      // `SessionContext` logs a bad field rather than throwing, so a name or a
      // type that is wrong here is a command that silently does nothing.
      const h = harness();
      h.host.dispatchPacket(reconnect(ENTERED), h.session);
      h.host.dispatchCommand('back', [], h.session);

      const packet = createPacket(registry, h.toClient[0]?.name ?? '');
      Object.assign(packet.fields, h.toClient[0]?.fields);
      expect(() => encodePacket(registry, packet)).not.toThrow();
    });

    it('keeps the way back after the session that captured it has gone', () => {
      // The escape to the Nexus *is* a new session, so a seat forgotten with
      // the old one is forgotten at exactly the moment `/back` is typed.
      const h = harness();
      h.host.dispatchPacket(reconnect(ENTERED), h.session);
      h.host.dispatchCommand('back', [], h.other);

      expect(h.toClient[0]?.fields).toEqual(ENTERED);
    });

    it('does not offer to send the player back to the Nexus', () => {
      const h = harness();
      h.host.dispatchPacket(reconnect(ENTERED), h.session);
      h.host.dispatchPacket(
        reconnect({ ...ENTERED, name: 'Nexus', gameId: GameId.Nexus }),
        h.session,
      );
      h.host.dispatchCommand('back', [], h.session);

      expect(h.toClient[0]?.fields).toEqual(ENTERED);
    });

    it('remembers the latest world, not the first', () => {
      const h = harness();
      h.host.dispatchPacket(reconnect(ENTERED), h.session);
      const deeper = { ...ENTERED, name: 'Oryx Chamber', gameId: 4712 };
      h.host.dispatchPacket(reconnect(deeper), h.session);
      h.host.dispatchCommand('back', [], h.session);

      expect(h.toClient[0]?.fields).toEqual(deeper);
    });
  });

  describe('/enter', () => {
    it('uses the portal under the player', () => {
      const h = harness();
      h.entities.push(entity(11, UNDEAD, { x: 0.4, y: 0 }));
      expect(h.host.dispatchCommand('enter', [], h.session)).toBe(true);

      expect(h.toServer).toEqual([{ name: 'USEPORTAL', fields: { objectId: 11 } }]);
      expect(h.said).toEqual(['Entering Undead Lair Portal...']);
    });

    it('says so when the player is standing on nothing', () => {
      const h = harness();
      h.entities.push(entity(11, UNDEAD, { x: 8, y: 0 }));
      h.host.dispatchCommand('enter', [], h.session);

      expect(h.toServer).toEqual([]);
      expect(h.said).toEqual(['No portal under you.']);
    });

    it('keeps asking while the dungeon refuses, spaced rather than once a tick', () => {
      const h = harness();
      h.entities.push(entity(11, REALM, { x: 0, y: 0 }));
      h.host.dispatchCommand('enter', [], h.session);
      expect(h.toServer).toHaveLength(1);

      tick(h); // same instant: still inside the interval
      expect(h.toServer).toHaveLength(1);

      h.world.gameTimeMs += 1000;
      tick(h);
      expect(h.toServer).toHaveLength(2);
    });

    it('gives up at the deadline, and says so once', () => {
      const h = harness();
      retryFor(h, 5);
      h.entities.push(entity(11, REALM, { x: 0, y: 0 }));
      h.host.dispatchCommand('enter', [], h.session);

      h.world.gameTimeMs += 5000;
      tick(h);
      tick(h);
      expect(h.said).toEqual(['Entering the portal...', 'Still no room. Stopped asking.']);

      h.world.gameTimeMs += 5000;
      tick(h);
      expect(h.toServer).toHaveLength(1);
    });

    it('asks once and no more when the player asked for no retries', () => {
      const h = harness();
      retryFor(h, 0);
      h.entities.push(entity(11, REALM, { x: 0, y: 0 }));
      h.host.dispatchCommand('enter', [], h.session);

      h.world.gameTimeMs += 60_000;
      tick(h);
      expect(h.toServer).toHaveLength(1);
      expect(h.said).toEqual(['Entering the portal...']);
    });

    it('stops asking the moment the server lets us in', () => {
      const h = harness();
      h.entities.push(entity(11, REALM, { x: 0, y: 0 }));
      h.host.dispatchCommand('enter', [], h.session);
      h.host.dispatchPacket(reconnect(ENTERED), h.session);

      h.world.gameTimeMs += 1000;
      tick(h);
      expect(h.toServer).toHaveLength(1);
    });

    it('is called off by typing it again', () => {
      const h = harness();
      h.entities.push(entity(11, REALM, { x: 0, y: 0 }));
      h.host.dispatchCommand('enter', [], h.session);
      h.host.dispatchCommand('enter', [], h.session);

      h.world.gameTimeMs += 1000;
      tick(h);
      expect(h.toServer).toHaveLength(1);
      expect(h.said[1]).toBe('Stopped asking.');
    });

    it('forgets an attempt on a map change, where its object id means nothing', () => {
      const h = harness();
      h.entities.push(entity(11, REALM, { x: 0, y: 0 }));
      h.host.dispatchCommand('enter', [], h.session);
      h.host.dispatchPacket(new MutablePacket(createPacket(registry, 'MAPINFO')), h.session);

      h.world.gameTimeMs += 1000;
      tick(h);
      expect(h.toServer).toHaveLength(1);
    });

    it("keeps one session's attempt out of another's", () => {
      const h = harness();
      h.entities.push(entity(11, REALM, { x: 0, y: 0 }));
      h.host.dispatchCommand('enter', [], h.session);

      h.world.gameTimeMs += 1000;
      tick(h, h.other);
      expect(h.toServer).toHaveLength(1);
    });

    it('names a portal by the name the server gave it', () => {
      const h = harness();
      h.entities.push(entity(11, REALM, { x: 0, y: 0 }, 'Fenrir'));
      h.host.dispatchCommand('enter', [], h.session);

      expect(h.said).toEqual(['Entering Fenrir...']);
    });
  });

  it('claims neither command while the plugin is switched off', () => {
    const h = harness();
    h.host.setEnabled('portal-entry', false);

    // False is what tells the command stage the line is not ours, so it reaches
    // the game server as typed rather than being swallowed.
    expect(h.host.dispatchCommand('back', [], h.session)).toBe(false);
    expect(h.host.dispatchCommand('enter', [], h.session)).toBe(false);
    expect(h.toServer).toEqual([]);
    expect(h.toClient).toEqual([]);
  });
});

describe('the catalog behind /enter', () => {
  it('is asked for portals of every kind, not only the ones a key opens', () => {
    // A realm portal is `<Class>Portal</Class>` and not `<DungeonPortal/>`, and
    // it is the case `/enter` is typed for most often.
    const isPortal = vi.fn(() => false);
    portalUnder(
      { entities: () => [entity(1, REALM, { x: 0, y: 0 })] } as never,
      { x: 0, y: 0 },
      isPortal,
      REACH_TILES,
    );
    expect(isPortal).toHaveBeenCalledWith(REALM);
  });
});
