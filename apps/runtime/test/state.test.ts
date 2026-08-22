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
      'CREATESUCCESS',
      'ENEMYSHOOT',
      'GOTO',
      'MAPINFO',
      'MOVE',
      'NEWTICK',
      'OTHERHIT',
      'PLAYERHIT',
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
        occupies: () => false,
        displayName: () => undefined,
        projectile: () => definition,
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
      occupies: () => false,
      displayName: () => undefined,
      projectile: () => undefined,
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
