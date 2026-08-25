import { MutablePacket } from '@brownie/plugin-api';
import { createBundledRegistry } from '@brownie/protocol/bundled';
import {
  createPacket,
  decodeFrame,
  encodePacket,
  type FieldValue,
  type PacketFields,
  type PacketRegistry,
} from '@brownie/protocol';
import { describe, expect, it } from 'vitest';
import { PacketOrigin, type PacketContext } from '../src/pipeline/PacketPipeline.js';
import { StateStage } from '../src/pipeline/stages/StateStage.js';
import type { ProjectileDefinition } from '../src/gamedata/projectiles.js';
import type { ObjectCatalog } from '../src/state/ObjectCatalog.js';
import {
  BlastStore,
  DEFAULT_BLAST_RADIUS_TILES,
  DEFAULT_TELEGRAPH_MS,
  NOVA_EFFECT,
  THROW_EFFECT,
  UNKNOWN_ORIGIN_TYPE,
  type BlastTelegraph,
} from '../src/state/blasts/BlastStore.js';
import {
  BlastRadiusTable,
  MAX_BLAST_FLIGHT_MS,
  MAX_BLAST_RADIUS_TILES,
} from '../src/state/blasts/BlastRadiusTable.js';
import { StatType } from '../src/constants/StatType.js';
import type { TileCatalog } from '../src/state/TileMap.js';
import { WorldState } from '../src/state/WorldState.js';

const registry: PacketRegistry = createBundledRegistry();

/**
 * Builds a real packet and pushes it through encode/decode, so every test runs
 * against bytes the game could actually have sent rather than a hand-made
 * object shaped the way the stage happens to read it.
 */
function packetOf(name: string, fields: PacketFields): MutablePacket {
  const packet = createPacket(registry, name);
  packet.fields = fields;
  const decoded = decodeFrame(registry, encodePacket(registry, packet));
  expect(decoded.error, `${name} encodes and decodes cleanly`).toBeUndefined();
  return new MutablePacket(decoded);
}

function status(objectId: number, x: number, y: number, stats: PacketFields[] = []): FieldValue {
  return { objectId, position: { x, y }, data: stats } as FieldValue;
}

function stat(id: number, value: number | string): PacketFields {
  return { id, value, stackCount: 0 };
}

const FROM_SERVER: PacketContext = { origin: PacketOrigin.Server, sessionId: 's1' };
const FROM_CLIENT: PacketContext = { origin: PacketOrigin.Client, sessionId: 's1' };

function harness(catalog?: ObjectCatalog): { world: WorldState; feed: typeof feed } {
  const world = new WorldState(catalog === undefined ? {} : { objects: catalog });
  const stage = new StateStage(world);
  function feed(packet: MutablePacket, context: PacketContext = FROM_SERVER): void {
    stage.handle(packet, context);
  }
  return { world, feed };
}

describe('StateStage', () => {
  it('binds the local player when the server names it', () => {
    const { world, feed } = harness();
    expect(world.self.objectId).toBe(-1);

    feed(packetOf('CREATESUCCESS', { objectId: 77, charId: 1, stats: '' }));

    expect(world.self.objectId).toBe(77);
  });

  it('records the map and forgets the previous one', () => {
    const { world, feed } = harness();
    feed(packetOf('CREATESUCCESS', { objectId: 1, charId: 1, stats: '' }));
    feed(
      packetOf('UPDATE', {
        position: { x: 0, y: 0 },
        levelType: 0,
        tiles: [{ x: 3, y: 4, type: 9 }],
        newObjs: [{ objectType: 5, status: status(2, 1, 1) }],
        drops: [],
      }),
    );
    expect(world.entityStore.size).toBe(1);
    expect(world.tileMap.size).toBe(1);

    feed(mapInfo('nexus', 'Nexus'));

    // An object id is only unique within a map, and the tiles describe ground
    // the player is no longer standing on.
    expect(world.mapName).toBe('nexus');
    expect(world.map.displayName).toBe('Nexus');
    expect(world.entityStore.size).toBe(0);
    expect(world.tileMap.size).toBe(0);
  });

  describe('UPDATE', () => {
    it('adds objects, tiles, and removes drops', () => {
      const { world, feed } = harness();
      feed(
        packetOf('UPDATE', {
          position: { x: 0, y: 0 },
          levelType: 0,
          tiles: [
            { x: 10, y: 20, type: 3 },
            { x: 11, y: 20, type: 4 },
          ],
          newObjs: [
            {
              objectType: 1000,
              status: status(5, 1.5, 2.5, [stat(StatType.Hp, 90), stat(StatType.MaxHp, 100)]),
            },
            { objectType: 1001, status: status(6, 3, 4) },
          ],
          drops: [],
        }),
      );

      expect(world.entityStore.size).toBe(2);
      const entity = world.entityStore.get(5);
      expect(entity?.objectType).toBe(1000);
      expect(entity?.x).toBeCloseTo(1.5);
      expect(entity?.hp).toBe(90);
      expect(entity?.maxHp).toBe(100);
      expect(world.tileMap.typeAt(10, 20)).toBe(3);
      expect(world.tileAt(11, 20)?.type).toBe(4);

      feed(
        packetOf('UPDATE', {
          position: { x: 0, y: 0 },
          levelType: 0,
          tiles: [],
          newObjs: [],
          drops: [5, 999],
        }),
      );

      // 999 was never in view; dropping an id we do not hold is not an error.
      expect(world.entityStore.get(5)).toBeUndefined();
      expect(world.entityStore.size).toBe(1);
    });

    it('refreshes an object that comes back into view instead of losing its stats', () => {
      const { world, feed } = harness();
      const first = packetOf('UPDATE', {
        position: { x: 0, y: 0 },
        levelType: 0,
        tiles: [],
        newObjs: [{ objectType: 7, status: status(5, 0, 0, [stat(StatType.MaxHp, 5000)]) }],
        drops: [],
      });
      feed(first);
      feed(
        packetOf('UPDATE', {
          position: { x: 0, y: 0 },
          levelType: 0,
          tiles: [],
          newObjs: [{ objectType: 7, status: status(5, 9, 9) }],
          drops: [],
        }),
      );

      const entity = world.entityStore.get(5);
      expect(entity?.maxHp).toBe(5000);
      expect(entity?.x).toBe(9);
    });

    it('applies the local player from an UPDATE that carries it', () => {
      const { world, feed } = harness();
      feed(packetOf('CREATESUCCESS', { objectId: 42, charId: 1, stats: '' }));
      feed(
        packetOf('UPDATE', {
          position: { x: 0, y: 0 },
          levelType: 0,
          tiles: [],
          newObjs: [
            {
              objectType: 782,
              status: status(42, 100, 200, [
                stat(StatType.Hp, 640),
                stat(StatType.MaxHp, 770),
                stat(StatType.Name, 'Someone'),
              ]),
            },
          ],
          drops: [],
        }),
      );

      expect(world.self.hp).toBe(640);
      expect(world.self.maxHp).toBe(770);
      expect(world.self.name).toBe('Someone');
      expect(world.self.x).toBe(100);
      expect(world.self.alive).toBe(true);
    });
  });

  describe('NEWTICK', () => {
    it('updates positions and stats of known entities', () => {
      const { world, feed } = harness();
      feed(
        packetOf('UPDATE', {
          position: { x: 0, y: 0 },
          levelType: 0,
          tiles: [],
          newObjs: [{ objectType: 1, status: status(5, 0, 0, [stat(StatType.Hp, 100)]) }],
          drops: [],
        }),
      );

      feed(
        packetOf('NEWTICK', {
          tickId: 1,
          tickTime: 200,
          serverRealTimeMs: 0,
          serverLastRttMs: 0,
          statuses: [status(5, 12, 13, [stat(StatType.Hp, 40)])],
        }),
      );

      const entity = world.entityStore.get(5);
      expect(entity?.x).toBe(12);
      expect(entity?.hp).toBe(40);
    });

    it('ignores a status for an object it has never seen typed', () => {
      const { world, feed } = harness();
      feed(
        packetOf('NEWTICK', {
          tickId: 1,
          tickTime: 200,
          serverRealTimeMs: 0,
          serverLastRttMs: 0,
          statuses: [status(4242, 1, 1)],
        }),
      );
      expect(world.entityStore.size).toBe(0);
    });

    it('keeps the local player current even before an UPDATE names it', () => {
      const { world, feed } = harness();
      feed(packetOf('CREATESUCCESS', { objectId: 8, charId: 1, stats: '' }));
      feed(
        packetOf('NEWTICK', {
          tickId: 1,
          tickTime: 200,
          serverRealTimeMs: 0,
          serverLastRttMs: 0,
          statuses: [status(8, 5, 6, [stat(StatType.Hp, 10), stat(StatType.Defense, 25)])],
        }),
      );

      expect(world.self.x).toBe(5);
      expect(world.self.hp).toBe(10);
      expect(world.self.defense).toBe(25);
    });

    it('carries stats it does not name, so a plugin can still read them', () => {
      const { world, feed } = harness();
      feed(
        packetOf('UPDATE', {
          position: { x: 0, y: 0 },
          levelType: 0,
          tiles: [],
          newObjs: [{ objectType: 1, status: status(5, 0, 0, [stat(123, 456)]) }],
          drops: [],
        }),
      );
      expect(world.entityStore.get(5)?.stat(123)).toBe(456);
    });
  });

  describe('movement', () => {
    it('follows a GOTO for the player and for an entity', () => {
      const { world, feed } = harness();
      feed(packetOf('CREATESUCCESS', { objectId: 3, charId: 1, stats: '' }));
      feed(
        packetOf('UPDATE', {
          position: { x: 0, y: 0 },
          levelType: 0,
          tiles: [],
          newObjs: [{ objectType: 1, status: status(9, 0, 0) }],
          drops: [],
        }),
      );

      feed(packetOf('GOTO', { objectId: 3, position: { x: 50, y: 60 }, unknown: 0 }));
      feed(packetOf('GOTO', { objectId: 9, position: { x: 70, y: 80 }, unknown: 0 }));

      expect(world.self.x).toBe(50);
      expect(world.entityStore.get(9)?.y).toBe(80);
    });

    it('takes the player position from the last record of a client MOVE', () => {
      const { world, feed } = harness();
      feed(packetOf('CREATESUCCESS', { objectId: 3, charId: 1, stats: '' }));

      feed(
        packetOf('MOVE', {
          tickId: 1,
          serverRealTimeMSofLastNewTick: 0,
          records: [
            { time: 1, x: 1, y: 1 },
            { time: 2, x: 2.5, y: 3.5 },
          ],
        }),
        FROM_CLIENT,
      );

      expect(world.self.x).toBeCloseTo(2.5);
      expect(world.self.y).toBeCloseTo(3.5);
    });

    it('ignores a MOVE that arrived from the wrong direction', () => {
      const { world, feed } = harness();
      feed(
        packetOf('MOVE', {
          tickId: 1,
          serverRealTimeMSofLastNewTick: 0,
          records: [{ time: 1, x: 9, y: 9 }],
        }),
        FROM_SERVER,
      );
      expect(world.self.x).toBe(0);
    });

    it('ignores a server packet that arrived from the client', () => {
      const { world, feed } = harness();
      feed(packetOf('CREATESUCCESS', { objectId: 5, charId: 1, stats: '' }), FROM_CLIENT);
      expect(world.self.objectId).toBe(-1);
    });
  });

  it('learns nothing from a packet it cannot decode, and does not throw', () => {
    const { world, feed } = harness();
    const truncated = Buffer.alloc(6);
    truncated.writeInt32BE(6, 0);
    truncated.writeUInt8(registry.idOf('CREATESUCCESS')!, 4);
    const packet = new MutablePacket(decodeFrame(registry, truncated));

    expect(packet.opaque).toBe(true);
    expect(() => feed(packet)).not.toThrow();
    expect(world.self.objectId).toBe(-1);
  });

  it('reacts only to the packets it declares', () => {
    const { world } = harness();
    void world;
    expect(new StateStage(new WorldState()).trackedPackets).toEqual([
      'AOE',
      'CREATESUCCESS',
      'ENEMYSHOOT',
      'GOTO',
      'MAPINFO',
      'MOVE',
      'NEWTICK',
      'OTHERHIT',
      'PLAYERHIT',
      // Not state: the two other packets the client stamps with its own clock.
      'PLAYERSHOOT',
      'PONG',
      'SHOWEFFECT',
      'SQUAREHIT',
      'UPDATE',
    ]);
  });

  // A lifetime says when a shot runs out, not when it stops existing — and most
  // shots stop early, by landing. The client is what decides a bullet has hit,
  // so the acknowledgement it sends is the only word the runtime ever gets that
  // one is gone. Without this the model carries spent bullets for the rest of
  // their declared life and the dodge avoids things nobody can see.
  describe('shots that have already landed', () => {
    /** An enemy that fires one straight, ordinary shot. */
    function shooter(overrides: Partial<ProjectileDefinition> = {}): ObjectCatalog {
      const definition: ProjectileDefinition = {
        bulletType: 0,
        speed: 1000,
        lifetimeMs: 4000,
        damage: 10,
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
      return {
        isPlayer: () => false,
        isEnemy: () => true,
        isPet: () => false,
        isInvincible: () => false,
        isQuest: () => false,
        occupies: () => false,
        isScenery: () => false,
        isDungeonPortal: () => false,
        dungeonPortals: () => [],
        bodyTiles: () => undefined,
        displayName: () => undefined,
        projectile: () => definition,
        hasShots: () => true,
        item: () => undefined,
        container: () => undefined,
        statMaxima: () => undefined,
      };
    }

    function fired(catalog: ObjectCatalog): { world: WorldState; feed: typeof feedInto } {
      const world = new WorldState({ objects: catalog });
      const stage = new StateStage(world);
      function feedInto(packet: MutablePacket, context: PacketContext = FROM_SERVER): void {
        stage.handle(packet, context);
      }
      feedInto(
        packetOf('UPDATE', {
          position: { x: 0, y: 0 },
          levelType: 0,
          tiles: [],
          newObjs: [{ objectType: 1000, status: status(42, 0, 0) }],
          drops: [],
        }),
      );
      feedInto(
        packetOf('ENEMYSHOOT', {
          bulletId: 7,
          ownerId: 42,
          bulletType: 0,
          position: { x: 0, y: 0 },
          angle: 0,
          damage: 10,
          numShots: 1,
          angleInc: 0,
        }),
      );
      expect(world.projectileStore.size).toBe(1);
      return { world, feed: feedInto };
    }

    it('forgets one that hit us', () => {
      const { world, feed } = fired(shooter());
      feed(packetOf('PLAYERHIT', { bulletId: 7, objectId: 42 }), FROM_CLIENT);
      expect(world.projectileStore.size).toBe(0);
    });

    it('forgets one that hit somebody else', () => {
      const { world, feed } = fired(shooter());
      feed(packetOf('OTHERHIT', { time: 1, bulletId: 7, objectId: 42, targetId: 9 }), FROM_CLIENT);
      expect(world.projectileStore.size).toBe(0);
    });

    it('forgets one that hit the map', () => {
      const { world, feed } = fired(shooter());
      feed(packetOf('SQUAREHIT', { time: 1, bulletId: 7, objectId: 42 }), FROM_CLIENT);
      expect(world.projectileStore.size).toBe(0);
    });

    it('keeps one that goes through whatever it hit', () => {
      const { world, feed } = fired(shooter({ multiHit: true }));
      feed(packetOf('PLAYERHIT', { bulletId: 7, objectId: 42 }), FROM_CLIENT);
      expect(world.projectileStore.size).toBe(1);
    });

    // **The acknowledgement only ever covers the shots the client resolved, and
    // it arrives a round trip late.** Where the walls are is already known, and
    // so is the curve, so the flight is worked out when the shot is announced
    // rather than waited for.
    it('ends a shot at the wall it flies into without being told', () => {
      const WALL = 2;
      const tiles: TileCatalog = {
        isDamaging: () => false,
        isBlocking: (type) => type === WALL,
        isPushing: () => false,
      };
      const world = new WorldState({ objects: shooter({ speed: 100 }), tiles });
      const stage = new StateStage(world);
      const feed = (packet: MutablePacket): void => {
        stage.handle(packet, FROM_SERVER);
      };

      feed(
        packetOf('UPDATE', {
          position: { x: 0, y: 0 },
          levelType: 0,
          // Five tiles east of the shooter, straight across its line of fire.
          tiles: [{ x: 5, y: 0, type: WALL }],
          newObjs: [{ objectType: 1000, status: status(42, 0.5, 0.5) }],
          drops: [],
        }),
      );
      feed(
        packetOf('ENEMYSHOOT', {
          bulletId: 7,
          ownerId: 42,
          bulletType: 0,
          position: { x: 0.5, y: 0.5 },
          angle: 0,
          damage: 10,
          numShots: 1,
          angleInc: 0,
        }),
      );

      // Four and a half tiles at a hundredth of a tile a millisecond, out of a
      // four-second life it will never see the end of.
      const [shot] = [...world.projectileStore.values(0)];
      expect(shot?.expiresAtMs).toBeGreaterThan(400);
      expect(shot?.expiresAtMs).toBeLessThan(460);
      expect(shot?.positionAt(1000)).toBeUndefined();
    });

    // The server sends the tiles around the player and no further, so the edge
    // of what is known is not a wall. Reading it as one would delete every shot
    // fired from off screen — which is the dangerous direction.
    it('flies a shot straight through ground nobody has described', () => {
      const { world } = fired(shooter({ speed: 100 }));
      const [shot] = [...world.projectileStore.values(0)];
      expect(shot?.expiresAtMs).toBe(4000);
    });

    // The acknowledgement is the *client* speaking. One arriving the other way
    // is not the client's word about anything.
    it('ignores an acknowledgement that came from the server', () => {
      const { world, feed } = fired(shooter());
      feed(packetOf('PLAYERHIT', { bulletId: 7, objectId: 42 }), FROM_SERVER);
      expect(world.projectileStore.size).toBe(1);
    });
  });
});

describe('SelfState defence', () => {
  it("prefers the native module's reading over the server stat", () => {
    const { world, feed } = harness();
    feed(packetOf('CREATESUCCESS', { objectId: 1, charId: 1, stats: '' }));
    feed(
      packetOf('NEWTICK', {
        tickId: 1,
        tickTime: 200,
        serverRealTimeMs: 0,
        serverLastRttMs: 0,
        statuses: [status(1, 0, 0, [stat(StatType.Defense, 20)])],
      }),
    );
    expect(world.self.defense).toBe(20);
    expect(world.self.defenseIsNative).toBe(false);

    world.self.setNativeDefense(31);
    expect(world.self.defense).toBe(31);
    expect(world.self.defenseIsNative).toBe(true);

    // Cleared when the reading goes away, so it cannot outlive the character.
    world.self.setNativeDefense(undefined);
    expect(world.self.defense).toBe(20);
  });
});

describe('classification', () => {
  it('says nothing without a catalog, rather than guessing from id ranges', () => {
    const { world, feed } = harness();
    feed(
      packetOf('UPDATE', {
        position: { x: 0, y: 0 },
        levelType: 0,
        tiles: [],
        newObjs: [{ objectType: 782, status: status(1, 0, 0) }],
        drops: [],
      }),
    );
    const entity = world.entityStore.get(1);
    expect(entity?.isPlayer).toBe(false);
    expect(entity?.isEnemy).toBe(false);
    expect([...world.players()]).toHaveLength(0);
  });

  it('uses the catalog when there is one', () => {
    const catalog: ObjectCatalog = {
      isPlayer: (type) => type === 782,
      isEnemy: (type) => type === 1000,
      isPet: (type) => type === 1500,
      isInvincible: () => false,
      isQuest: () => false,
      occupies: () => false,
      isScenery: () => false,
      isDungeonPortal: () => false,
      dungeonPortals: () => [],
      bodyTiles: () => undefined,
      displayName: () => undefined,
      projectile: () => undefined,
      hasShots: () => false,
      item: () => undefined,
      container: () => undefined,
      statMaxima: () => undefined,
    };
    const { world, feed } = harness(catalog);
    feed(
      packetOf('UPDATE', {
        position: { x: 0, y: 0 },
        levelType: 0,
        tiles: [],
        newObjs: [
          { objectType: 782, status: status(1, 0, 0) },
          { objectType: 1000, status: status(2, 0, 0) },
        ],
        drops: [],
      }),
    );

    expect([...world.players()].map((e) => e.objectId)).toEqual([1]);
    expect([...world.enemies()].map((e) => e.objectId)).toEqual([2]);
  });
});

describe('standing room', () => {
  const FLOOR = 1;
  const WALL = 2;
  const tiles: TileCatalog = {
    isDamaging: () => false,
    isBlocking: (tileType) => tileType === WALL,
    isPushing: () => false,
  };

  /** Five tiles of floor with one column of wall through it. */
  function withWallColumnAt(wallX: number): WorldState {
    const world = new WorldState({ tiles });
    for (let x = 0; x <= 4; x += 1) {
      for (let y = 0; y <= 4; y += 1) world.tileMap.set(x, y, x === wallX ? WALL : FLOOR);
    }
    return world;
  }

  it('fits the body flush against a wall', () => {
    expect(withWallColumnAt(3).canStandAt(2.5, 2)).toBe(true);
  });

  // The game's own collision half is 0.2285 and the one a *shot* is tested
  // against is 0.2139. Sizing the body by the smaller of the two admits places
  // the client refuses to stand in, and the server puts the character back.
  it('measures the body by the half the game walks with, not the one it shoots with', () => {
    expect(withWallColumnAt(3).canStandAt(2.78, 2)).toBe(false);
  });

  it('refuses the same place once room to spare is asked for', () => {
    expect(withWallColumnAt(3).canStandAt(2.5, 2, 0.3)).toBe(false);
  });

  it('allows a place that has the room', () => {
    expect(withWallColumnAt(3).canStandAt(2, 2, 0.3)).toBe(true);
  });

  it('never shrinks the body below its own size', () => {
    // A negative margin unclamped would reach *past* the wall and refuse a
    // place the player fits in.
    expect(withWallColumnAt(3).canStandAt(2.5, 2, -1)).toBe(true);
  });
});

describe('WorldState timing', () => {
  it('reports zero until the session connects, then counts from there', () => {
    let now = 1000;
    const world = new WorldState({ now: () => now });
    expect(world.gameTimeMs).toBe(0);

    world.markConnected();
    now = 1750;
    expect(world.gameTimeMs).toBe(750);

    // Marking again must not restart the clock — a reconnect is a new session.
    world.markConnected();
    expect(world.gameTimeMs).toBe(750);
  });
});

/**
 * The clock the server checks a packet's `time` against.
 *
 * Not the connection's — the client has usually been running long before the
 * connection this session carries, and a packet stamped with the wrong one is
 * dropped in silence. Auto-loot and auto-drink both spent a session sending
 * perfectly formed packets nothing answered.
 */
describe("the game client's own clock", () => {
  const CONNECTED_AT = 1_000_000;

  /** A world on a clock the test drives, so the readings are exact. */
  function clockHarness(): {
    world: WorldState;
    feed: (packet: MutablePacket, context?: PacketContext) => void;
    tick: (ms: number) => void;
  } {
    let now = CONNECTED_AT;
    const world = new WorldState({ now: () => now });
    const stage = new StateStage(world);
    world.markConnected();
    return {
      world,
      feed: (packet, context = FROM_CLIENT) => {
        stage.handle(packet, context);
      },
      tick: (ms) => {
        now += ms;
      },
    };
  }

  const move = (time: number): MutablePacket =>
    packetOf('MOVE', {
      tickId: 1,
      serverRealTimeMSofLastNewTick: 0,
      records: [{ time, x: 5, y: 6 }],
    });

  it('falls back to the connection until the client has stamped something', () => {
    const { world, tick } = clockHarness();
    tick(5_000);
    expect(world.clientTimeMs).toBe(5_000);
  });

  it("reads it off the client's own movement, and keeps running from there", () => {
    const { world, feed, tick } = clockHarness();
    feed(move(1_234_567));
    expect(world.clientTimeMs).toBe(1_234_567);

    // The client's clock and ours tick together, so it stays current between
    // the packets it is read from.
    tick(400);
    expect(world.clientTimeMs).toBe(1_234_967);
    // And it is nothing like the connection's, which is the whole point.
    expect(world.gameTimeMs).toBe(400);
  });

  it('reads it off a pong, which the client sends before anything else', () => {
    const { world, feed } = clockHarness();
    feed(packetOf('PONG', { serial: 1, time: 900_000 }));
    expect(world.clientTimeMs).toBe(900_000);
  });

  it("reads it off the client's own shots", () => {
    const { world, feed } = clockHarness();
    feed(
      packetOf('PLAYERSHOOT', {
        time: 500_000,
        shotId: 1,
        containerType: 1,
        attackIndex: 0,
        projectilePosition: { x: 1, y: 1 },
        angle: 0,
        bulletId: 1,
        unknownShort: 0,
        playerPosition: { x: 1, y: 1 },
      }),
    );
    expect(world.clientTimeMs).toBe(500_000);
  });

  it('follows the latest reading rather than freezing the first', () => {
    // A movement record describes where the player *was*, so every calibration
    // is a little stale; taking the newest keeps that from being frozen in.
    const { world, feed, tick } = clockHarness();
    feed(move(1_000_000));
    tick(1_000);
    feed(move(2_000_000));
    expect(world.clientTimeMs).toBe(2_000_000);
  });

  it('ignores a stamp that is not a time', () => {
    const { world, feed } = clockHarness();
    feed(move(1_000_000));
    feed(move(0));
    expect(world.clientTimeMs).toBe(1_000_000);
  });

  // What the client puts on the wire is a rising sequence, and a packet slipped
  // into the middle of it carrying an earlier time is that sequence going
  // backwards. Every calibration is taken from a reading already a moment old,
  // so the estimate alone can be behind.
  it('never reads behind the last stamp the client sent', () => {
    const { world, feed } = clockHarness();
    feed(move(1_000_000));
    // A later packet stamped further ahead than wall time accounts for.
    feed(move(1_009_000));
    expect(world.clientTimeMs).toBe(1_009_000);
  });

  it('is not read from what the server sends', () => {
    const { world, feed, tick } = clockHarness();
    tick(5_000);
    // The appliers are origin-gated, so a server-side copy changes nothing.
    feed(move(1_234_567), FROM_SERVER);
    expect(world.clientTimeMs).toBe(5_000);
  });
});

// **The dodgeable half of an area effect.** By the time `AOE` arrives the blast
// has landed and the client is already answering with where the player was; what
// can be walked out of is the telegraph the game sends first.
describe('blasts on their way down', () => {
  /** The object type of the thing that throws them, and of the ally that does not. */
  const BOMBER = 1000;
  const ALLY = 782;
  const BOMBER_ID = 42;
  const ALLY_ID = 43;

  /** A catalog that can tell the two apart, which the wire cannot. */
  const CATALOG: ObjectCatalog = {
    isPlayer: (type) => type === ALLY,
    isEnemy: (type) => type === BOMBER,
    isPet: () => false,
    isInvincible: () => false,
    isQuest: () => false,
    occupies: () => false,
    isScenery: () => false,
    isDungeonPortal: () => false,
    dungeonPortals: () => [],
    bodyTiles: () => undefined,
    displayName: () => undefined,
    projectile: () => undefined,
    hasShots: () => false,
    item: () => undefined,
    container: () => undefined,
    statMaxima: () => undefined,
  };

  /** A world with one monster and one teammate standing in it. */
  function thrown(): ReturnType<typeof harness> {
    const built = harness(CATALOG);
    built.world.markConnected();
    built.feed(
      packetOf('UPDATE', {
        position: { x: 0, y: 0 },
        levelType: 0,
        tiles: [],
        newObjs: [
          { objectType: BOMBER, status: status(BOMBER_ID, 3, 3) },
          { objectType: ALLY, status: status(ALLY_ID, 4, 4) },
        ],
        drops: [],
      }),
    );
    return built;
  }

  // **The mask that says which of the nine fields follow.** This packet omits
  // everything it does not need, and a schema that read it positionally failed
  // on three quarters of a live capture — see `packet-definitions.json`.
  const HAS_COLOR = 1;
  const HAS_POSITION_X = 2;
  const HAS_POSITION_Y = 4;
  const HAS_TARGET_X = 8;
  const HAS_TARGET_Y = 16;
  const HAS_DURATION = 32;
  const HAS_TARGET_ID = 64;

  /**
   * One telegraph, thrown `from` somewhere `to` somewhere.
   *
   * **The first position is where it goes off and the second is where it came
   * from**, which is the opposite way round to how this read at first — see the
   * note in `StateStage`. A nova and a ground circle use the first alone.
   */
  function showEffect(
    effectType: number,
    from: { x: number; y: number },
    to: { x: number; y: number },
    duration: number,
    thrower = BOMBER_ID,
    color = 0,
  ): MutablePacket {
    return packetOf('SHOWEFFECT', {
      effectType,
      presentFields:
        HAS_TARGET_ID |
        HAS_POSITION_X |
        HAS_POSITION_Y |
        HAS_TARGET_X |
        HAS_TARGET_Y |
        HAS_COLOR |
        HAS_DURATION,
      targetObjectId: thrower,
      positionX: to.x,
      positionY: to.y,
      targetPositionX: from.x,
      targetPositionY: from.y,
      color,
      duration,
    });
  }

  /** A detonation. Harmful by default, because almost all of them are. */
  function aoe(
    at: { x: number; y: number },
    radius: number,
    overrides: { damage?: number; effect?: number } = {},
  ): MutablePacket {
    return packetOf('AOE', {
      position: at,
      radius,
      damage: overrides.damage ?? 200,
      effect: overrides.effect ?? 0,
      effectDuration: 0,
      originType: BOMBER,
      color: 0,
      armorPierce: false,
    });
  }

  /**
   * The shape the wire actually carries most of the time.
   *
   * A live session recorded 19 016 of these and 17 878 of them carried no
   * second position, colour or duration at all — which is what the mask is for,
   * and what the old positional schema could not describe: 206 of 273 captured
   * SHOWEFFECT bodies failed to decode outright, and nothing downstream can
   * tell a packet that failed to decode from a packet that never came.
   */
  function shortEffect(effectType: number, at: { x: number; y: number }): MutablePacket {
    return packetOf('SHOWEFFECT', {
      effectType,
      presentFields: HAS_TARGET_ID | HAS_POSITION_X | HAS_POSITION_Y,
      targetObjectId: BOMBER_ID,
      positionX: at.x,
      positionY: at.y,
    });
  }

  it('reads a telegraph that carries only its own position', () => {
    const { world, feed } = thrown();
    feed(shortEffect(NOVA_EFFECT, { x: 7, y: 7 }));

    const blasts = [...world.blasts()];
    expect(blasts).toHaveLength(1);
    expect(blasts[0]?.x).toBeCloseTo(7, 5);
    // No duration on the wire, so the flat default stands rather than nothing.
    // Compared loosely for the same reason as the throw above: the world's
    // clock is wall time, and it moves between the feed and the assertion.
    expect((blasts[0]?.armsAtMs ?? 0) - world.gameTimeMs).toBeGreaterThan(
      DEFAULT_TELEGRAPH_MS - 100,
    );
  });

  // **Each axis is gated on its own bit, so half a position is a shape the
  // packet can genuinely carry** — and half a position is not a place. One with
  // no position at all is a telegraph this cannot put anywhere; inventing a spot
  // for it would have the planner refusing ground nothing is landing on.
  it('refuses to place a telegraph that never said where', () => {
    const { world, feed } = thrown();
    feed(
      packetOf('SHOWEFFECT', {
        effectType: THROW_EFFECT,
        presentFields: HAS_TARGET_ID | HAS_POSITION_X,
        targetObjectId: BOMBER_ID,
        positionX: 3,
      }),
    );

    expect(world.blastStore.size).toBe(0);
  });

  it('records a thrown bomb where it will land, not where it was thrown', () => {
    const { world, feed } = thrown();
    feed(showEffect(THROW_EFFECT, { x: 3, y: 3 }, { x: 12, y: 9 }, 0.6));

    const blasts = [...world.blasts()];
    expect(blasts).toHaveLength(1);
    expect(blasts[0]?.x).toBeCloseTo(12, 5);
    expect(blasts[0]?.y).toBeCloseTo(9, 5);
    expect(blasts[0]?.confirmed).toBe(false);
    // Seconds on the wire, milliseconds here.
    expect((blasts[0]?.armsAtMs ?? 0) - world.gameTimeMs).toBeGreaterThan(400);
  });

  // A nova or a ground circle goes off where it is announced; only a throw has
  // somewhere else to be.
  // **The shape nearly every throw actually has**, and the one that went
  // missing: the second position is usually not sent at all, so reading the
  // landing spot out of it dropped every throw but the occasional one — and that
  // one was drawn under the monster that threw it. Live report: "enemy ones
  // appear only once, and the first did not show where it was thrown to."
  it('places a throw that carries only where it lands', () => {
    const { world, feed } = thrown();
    feed(shortEffect(THROW_EFFECT, { x: 12, y: 9 }));

    const blasts = [...world.blasts()];
    expect(blasts).toHaveLength(1);
    expect(blasts[0]?.x).toBeCloseTo(12, 5);
    expect(blasts[0]?.y).toBeCloseTo(9, 5);
  });

  it('records a nova where it was announced', () => {
    const { world, feed } = thrown();
    // A nova has nowhere else to be: it goes off where the packet places it,
    // which is the same first position a throw lands at.
    feed(showEffect(NOVA_EFFECT, { x: 0, y: 0 }, { x: 7, y: 7 }, 0.5));

    expect([...world.blasts()][0]?.x).toBeCloseTo(7, 5);
  });

  it('ignores the effects that are only decoration', () => {
    const { world, feed } = thrown();
    // A flash, a beam, a trail: reacting to these would have the dodge running
    // from light.
    for (const type of [1, 2, 3, 6, 7, 15]) {
      feed(showEffect(type, { x: 10, y: 10 }, { x: 10, y: 10 }, 0.5));
    }
    expect(world.blastStore.size).toBe(0);
  });

  // The detonation is what proves the telegraph was read correctly, which is
  // the only check available on a packet body recovered from game metadata.
  // **A teammate's thrown ability is the same packet with the same effect
  // type.** Nothing on the wire tells it from a monster's bomb; what does is the
  // object it hangs on, and a dodge that walks out of its own party's abilities
  // is a dodge that cannot stand in one.
  it('ignores a throw an ally made', () => {
    const { world, feed } = thrown();
    feed(showEffect(THROW_EFFECT, { x: 4, y: 4 }, { x: 12, y: 9 }, 0.6, ALLY_ID));

    expect(world.blastStore.size).toBe(0);
  });

  // **The live complaint: "we are still dodging an allied blast."** The id was
  // being read out of the wrong bytes, so it never named anybody — and an
  // unidentified thrower was treated as hostile, which meant every ability the
  // party threw was walked out of. It is refused now: a player's own ability is
  // by far the commonest thing on the screen carrying one of these effect types,
  // so a blast nobody can be blamed for is more often a friend's than a boss's.
  it('refuses a throw it cannot say who made', () => {
    const { world, feed } = thrown();
    feed(showEffect(THROW_EFFECT, { x: 3, y: 3 }, { x: 12, y: 9 }, 0.6, 999));

    expect(world.blastStore.size).toBe(0);
  });

  // And the same for one that names nobody at all, which the mask allows.
  it('refuses a throw anchored to nothing', () => {
    const { world, feed } = thrown();
    feed(
      packetOf('SHOWEFFECT', {
        effectType: THROW_EFFECT,
        presentFields: HAS_POSITION_X | HAS_POSITION_Y | HAS_TARGET_X | HAS_TARGET_Y,
        positionX: 3,
        positionY: 3,
        targetPositionX: 12,
        targetPositionY: 9,
      }),
    );

    expect(world.blastStore.size).toBe(0);
  });

  it('still avoids one from a monster standing next to them', () => {
    const { world, feed } = thrown();
    feed(showEffect(THROW_EFFECT, { x: 3, y: 3 }, { x: 12, y: 9 }, 0.6, BOMBER_ID));

    expect(world.blastStore.size).toBe(1);
  });

  it('confirms a prediction the detonation lands on', () => {
    const { world, feed } = thrown();
    feed(showEffect(THROW_EFFECT, { x: 3, y: 3 }, { x: 12, y: 9 }, 0.6));
    feed(aoe({ x: 12.2, y: 9.1 }, 3));

    expect(world.blastStore.confirmed).toBe(1);
    expect(world.blastStore.unmatched).toBe(0);
    // And it stops being something to walk out of: it has already gone off.
    expect([...world.blasts()][0]?.confirmed).toBe(true);
  });

  it('counts a detonation nothing predicted', () => {
    const { world, feed } = thrown();
    feed(aoe({ x: 40, y: 40 }, 3));

    expect(world.blastStore.confirmed).toBe(0);
    expect(world.blastStore.unmatched).toBe(1);
  });

  // A teammate's heal is an area effect in every respect the wire cares about,
  // and it lands where teammates are. Counted as a detonation it would confirm
  // — and so cancel — whatever real bomb happened to be coming down nearby.
  it('is not fooled by an area effect that cannot hurt anybody', () => {
    const { world, feed } = thrown();
    feed(showEffect(THROW_EFFECT, { x: 3, y: 3 }, { x: 12, y: 9 }, 0.6));
    feed(aoe({ x: 12.1, y: 9 }, 3, { damage: 0, effect: 0 }));

    expect(world.blastStore.confirmed).toBe(0);
    expect(world.blastStore.unmatched).toBe(0);
    expect([...world.blasts()][0]?.confirmed).toBe(false);
  });

  // **The measurement that makes the second bomb dodgeable at its real size.**
  // The telegraph never says how wide; the detonation does, and the ability is
  // the same one the next time this enemy uses it.
  it('plans the next blast from the same enemy at its measured size', () => {
    const { world, feed } = thrown();
    feed(showEffect(THROW_EFFECT, { x: 3, y: 3 }, { x: 12, y: 9 }, 0.6));
    expect([...world.blasts()][0]?.radiusTiles).toBe(DEFAULT_BLAST_RADIUS_TILES);
    feed(aoe({ x: 12, y: 9 }, 1.25));

    feed(showEffect(THROW_EFFECT, { x: 3, y: 3 }, { x: 20, y: 20 }, 0.6));
    const next = [...world.blasts()].find((blast) => blast.x === 20);
    expect(next?.radiusTiles).toBe(1.25);
  });

  it('keeps the measurement apart per ability, by colour', () => {
    const { world, feed } = thrown();
    feed(showEffect(THROW_EFFECT, { x: 3, y: 3 }, { x: 12, y: 9 }, 0.6, BOMBER_ID, 0xff0000));
    feed(aoe({ x: 12, y: 9 }, 1.25));

    // The same enemy, a different ability: nothing has been measured for it.
    feed(showEffect(THROW_EFFECT, { x: 3, y: 3 }, { x: 20, y: 20 }, 0.6, BOMBER_ID, 0x00ff00));
    const next = [...world.blasts()].find((blast) => blast.x === 20);
    expect(next?.radiusTiles).toBe(DEFAULT_BLAST_RADIUS_TILES);
  });

  it('falls back to a sensible delay when the duration is nonsense', () => {
    const store = new BlastStore();
    store.announce(0, telegraph(5, 5, Number.NaN));
    store.announce(0, telegraph(6, 6, 999_999));
    const blasts = [...store.values(0)];
    expect(blasts).toHaveLength(2);
    for (const blast of blasts) expect(blast.armsAtMs).toBe(DEFAULT_TELEGRAPH_MS);
  });

  // The flight time is the gap between the two packets, and it is worth keeping
  // for exactly the case above: a duration field this build could not read.
  it('uses the flight time it measured when the duration is nonsense', () => {
    const store = new BlastStore();
    store.announce(0, telegraph(5, 5, 900));
    store.landed(1400, { x: 5, y: 5, radiusTiles: 2, harmful: true });

    store.announce(2000, telegraph(5, 5, Number.NaN));
    expect([...store.values(2000)].at(-1)?.armsAtMs).toBeCloseTo(3400, 5);
  });

  it('refuses a landing spot that is not a place', () => {
    const store = new BlastStore();
    expect(store.announce(0, telegraph(Number.NaN, 5, 500))).toBe(false);
    expect(store.size).toBe(0);
  });

  // Every effect hanging on an object we do not hold would otherwise share one
  // key, and whichever of them landed first would be measuring for the rest.
  it('does not lend one unknown thrower another one’s measurement', () => {
    const store = new BlastStore();
    const anonymous = { armsInMs: 500, originType: UNKNOWN_ORIGIN_TYPE, color: 0 };
    store.announce(0, { x: 5, y: 5, ...anonymous });
    store.landed(400, { x: 5, y: 5, radiusTiles: 1.25, harmful: true });

    store.announce(1000, { x: 9, y: 9, ...anonymous });
    expect([...store.values(1000)].at(-1)?.radiusTiles).toBe(DEFAULT_BLAST_RADIUS_TILES);
  });

  it('forgets one long after it has gone off', () => {
    const store = new BlastStore();
    store.announce(0, telegraph(5, 5, 500));
    expect([...store.values(600)]).toHaveLength(1);
    expect([...store.values(9000)]).toHaveLength(0);
  });
});

/** One telegraph from one anonymous thrower, for the store's own tests. */
function telegraph(x: number, y: number, armsInMs: number): BlastTelegraph {
  return { x, y, armsInMs, originType: 7, color: 0 };
}

/**
 * What a blast turned out to be, kept between runs.
 *
 * A cache and nothing else: every way of failing to read it has to end in the
 * planner using its default, because the alternative is a runtime that will not
 * start over a file it wrote itself.
 */
describe('what blasts have been measured at', () => {
  it('remembers the widest it saw, and the mean time it took', () => {
    const table = new BlastRadiusTable();
    table.learn(1000, 0, 2, 800);
    table.learn(1000, 0, 3, 1200);

    expect(table.lookUp(1000, 0)?.radiusTiles).toBe(3);
    expect(table.lookUp(1000, 0)?.flightMs).toBeCloseTo(1000, 5);
    expect(table.lookUp(1000, 0)?.seen).toBe(2);
  });

  it('keeps abilities apart by colour, and knows nothing about the rest', () => {
    const table = new BlastRadiusTable();
    table.learn(1000, 1, 2, 800);

    expect(table.lookUp(1000, 2)).toBeUndefined();
    expect(table.lookUp(1001, 1)).toBeUndefined();
  });

  it('refuses a radius that is not one', () => {
    const table = new BlastRadiusTable();
    table.learn(1000, 0, Number.NaN, 800);
    table.learn(1000, 0, MAX_BLAST_RADIUS_TILES + 1, 800);
    table.learn(1000, 0, -1, 800);

    expect(table.size).toBe(0);
  });

  // The two are separate measurements, and the one the planner reads is the
  // radius. A detonation nothing predicted has no flight time to give, and
  // throwing the sighting away over that would cost the number that matters.
  it('keeps the radius when there is no flight time to go with it', () => {
    const table = new BlastRadiusTable();
    table.learn(1000, 0, 2, 0);
    table.learn(1000, 0, 2, MAX_BLAST_FLIGHT_MS + 1);

    expect(table.lookUp(1000, 0)?.radiusTiles).toBe(2);
    expect(table.lookUp(1000, 0)?.flightMs).toBe(0);
    expect(table.lookUp(1000, 0)?.seen).toBe(2);
    expect(table.lookUp(1000, 0)?.timed).toBe(0);
  });

  it('survives a round trip through a file', () => {
    const written = new BlastRadiusTable();
    written.learn(1000, 5, 2.5, 900);
    const read = new BlastRadiusTable();

    expect(read.restore(JSON.parse(JSON.stringify(written.serialise())))).toBe(1);
    expect(read.lookUp(1000, 5)?.radiusTiles).toBe(2.5);
    expect(read.lookUp(1000, 5)?.flightMs).toBe(900);
  });

  it('degrades to knowing nothing when the file is not one', () => {
    const table = new BlastRadiusTable();

    expect(table.restore(undefined)).toBe(0);
    expect(table.restore({ version: 99, blasts: [] })).toBe(0);
    expect(table.restore({ version: 1, blasts: 'not a list' })).toBe(0);
    expect(table.restore({ version: 1, blasts: [{ originType: 1 }] })).toBe(0);
    expect(table.size).toBe(0);
  });
});

/**
 * The player's bars and slots.
 *
 * The stat ids below are written out rather than imported, deliberately: they
 * are the claim being tested. `state/ItemSlots.ts` records that the two tables
 * in this repository disagree about the backpack and the belt, so a build that
 * moves them is a change to that file *and* to these numbers, which is what
 * makes the change visible instead of silent.
 */
describe("the player's own bars and slots", () => {
  const WIZARD = 0x30e;
  const HP_BOOST_STAT = 46;
  const MP_BOOST_STAT = 47;
  const CARRIED_SLOT_4_STAT = 12;
  const BACKPACK_SLOT_0_STAT = 131;
  const BACKPACK_SLOT_8_STAT = 139;
  const BELT_SLOT_0_STAT = 116;

  const HEALTH_POTION = 2594;
  const A_BOW = 3010;

  function stacked(id: number, value: number, stackCount: number): PacketFields {
    return { id, value, stackCount };
  }

  /** Announces the local player carrying `stats`. */
  function announceSelf(stats: PacketFields[]): { world: WorldState } {
    const { world, feed } = harness();
    feed(packetOf('CREATESUCCESS', { objectId: 42, charId: 1, stats: '' }));
    feed(
      packetOf('UPDATE', {
        position: { x: 0, y: 0 },
        levelType: 0,
        tiles: [],
        newObjs: [{ objectType: WIZARD, status: status(42, 1, 2, stats) }],
        drops: [],
      }),
    );
    return { world };
  }

  it('draws the bar against the base plus what the gear adds', () => {
    const { world } = announceSelf([
      stat(StatType.Hp, 900),
      stat(StatType.MaxHp, 770),
      stat(HP_BOOST_STAT, 250),
      stat(StatType.Mp, 100),
      stat(StatType.MaxMp, 400),
      stat(MP_BOOST_STAT, 60),
    ]);

    // Health above the base is the ordinary case on a geared character, and is
    // why the base alone is not a maximum.
    expect(world.self.maxHp).toBe(1020);
    expect(world.self.maxMp).toBe(460);
  });

  it('is the base alone until the gear stat arrives', () => {
    const { world } = announceSelf([stat(StatType.MaxHp, 770)]);
    expect(world.self.maxHp).toBe(770);
  });

  it('names the class the character is', () => {
    const { world } = announceSelf([stat(StatType.Hp, 1)]);
    expect(world.self.objectType).toBe(WIZARD);
  });

  it('records the six stats a potion raises', () => {
    const { world } = announceSelf([
      stat(StatType.Attack, 60),
      stat(StatType.Defense, 25),
      stat(StatType.Speed, 50),
      stat(StatType.Dexterity, 75),
      stat(StatType.Vitality, 40),
      stat(StatType.Wisdom, 60),
    ]);
    expect(world.self.permanentStats).toEqual({
      attack: 60,
      defense: 25,
      speed: 50,
      dexterity: 75,
      vitality: 40,
      wisdom: 60,
    });
  });

  it('keeps the same record while none of the six move', () => {
    const { world, feed } = harness();
    feed(packetOf('CREATESUCCESS', { objectId: 42, charId: 1, stats: '' }));
    feed(
      packetOf('UPDATE', {
        position: { x: 0, y: 0 },
        levelType: 0,
        tiles: [],
        newObjs: [{ objectType: WIZARD, status: status(42, 1, 2, [stat(StatType.Attack, 60)]) }],
        drops: [],
      }),
    );
    const before = world.self.permanentStats;

    feed(
      packetOf('NEWTICK', {
        tickId: 1,
        tickTime: 200,
        serverRealTimeMs: 0,
        serverLastRttMs: 0,
        statuses: [status(42, 1, 2, [stat(StatType.Hp, 5)])],
      }),
    );
    expect(world.self.permanentStats).toBe(before);
  });

  it('reads the carried slots, the backpack and the belt', () => {
    const { world } = announceSelf([
      stat(CARRIED_SLOT_4_STAT, A_BOW),
      stat(CARRIED_SLOT_4_STAT + 1, -1),
      stat(BACKPACK_SLOT_0_STAT, A_BOW),
      stat(BACKPACK_SLOT_8_STAT, -1),
      stacked(BELT_SLOT_0_STAT, HEALTH_POTION, 4),
    ]);
    const inventory = world.self.inventory;

    expect(inventory.carried()).toEqual([
      { slotId: 4, objectType: A_BOW, quantity: 0 },
      { slotId: 5, objectType: -1, quantity: 0 },
    ]);
    expect(inventory.backpack().map((slot) => slot.slotId)).toEqual([12, 20]);
    expect(inventory.belt()).toEqual([
      { slotId: 1_000_000, objectType: HEALTH_POTION, quantity: 4 },
    ]);
    expect(inventory.at(4)?.objectType).toBe(A_BOW);
  });

  it('has nothing to say about a slot the server has not stated', () => {
    const { world } = announceSelf([stat(CARRIED_SLOT_4_STAT, A_BOW)]);
    // Absent, not empty: a swap aimed at a slot nobody described is a swap
    // aimed at a slot that may well be full.
    expect(world.self.inventory.at(5)).toBeUndefined();
    expect(world.self.inventory.carried()).toHaveLength(1);
    expect(world.self.inventory.backpack()).toHaveLength(0);
    expect(world.self.inventory.belt()).toHaveLength(0);
  });

  it('follows a slot as its contents change', () => {
    const { world, feed } = harness();
    feed(packetOf('CREATESUCCESS', { objectId: 42, charId: 1, stats: '' }));
    feed(
      packetOf('UPDATE', {
        position: { x: 0, y: 0 },
        levelType: 0,
        tiles: [],
        newObjs: [
          { objectType: WIZARD, status: status(42, 1, 2, [stat(CARRIED_SLOT_4_STAT, -1)]) },
        ],
        drops: [],
      }),
    );
    expect(world.self.inventory.at(4)?.objectType).toBe(-1);

    feed(
      packetOf('NEWTICK', {
        tickId: 1,
        tickTime: 200,
        serverRealTimeMs: 0,
        serverLastRttMs: 0,
        statuses: [status(42, 1, 2, [stat(CARRIED_SLOT_4_STAT, A_BOW)])],
      }),
    );
    expect(world.self.inventory.at(4)?.objectType).toBe(A_BOW);
    // The same list, not a longer one: a slot restated is not a new slot.
    expect(world.self.inventory.carried()).toHaveLength(1);
  });
});

function mapInfo(name: string, displayName: string): MutablePacket {
  return packetOf('MAPINFO', {
    width: 100,
    height: 100,
    name,
    displayName,
    realmName: '',
    fp: 0,
    background: 0,
    difficulty: 0,
    allowPlayerTeleport: true,
    noSave: false,
    showDisplays: true,
    maxPlayers: 85,
    gameOpenedTime: 0,
    serverVersion: '',
    viewDistance: 15,
  });
}
