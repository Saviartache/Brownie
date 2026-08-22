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
  DEFAULT_TELEGRAPH_MS,
  NOVA_EFFECT,
  THROW_EFFECT,
} from '../src/state/blasts/BlastStore.js';
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
        occupies: () => false,
        displayName: () => undefined,
        projectile: () => definition,
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

// **The dodgeable half of an area effect.** By the time `AOE` arrives the blast
// has landed and the client is already answering with where the player was; what
// can be walked out of is the telegraph the game sends first.
describe('blasts on their way down', () => {
  function showEffect(
    effectType: number,
    from: { x: number; y: number },
    to: { x: number; y: number },
    duration: number,
  ): MutablePacket {
    return packetOf('SHOWEFFECT', {
      effectType,
      targetObjectId: 42,
      position: from,
      targetPosition: to,
      color: 0,
      duration,
    });
  }

  it('records a thrown bomb where it will land, not where it was thrown', () => {
    const { world, feed } = harness();
    world.markConnected();
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
  it('records a nova where it was announced', () => {
    const { world, feed } = harness();
    world.markConnected();
    feed(showEffect(NOVA_EFFECT, { x: 7, y: 7 }, { x: 0, y: 0 }, 0.5));

    expect([...world.blasts()][0]?.x).toBeCloseTo(7, 5);
  });

  it('ignores the effects that are only decoration', () => {
    const { world, feed } = harness();
    world.markConnected();
    // A flash, a beam, a trail: reacting to these would have the dodge running
    // from light.
    for (const type of [1, 2, 3, 6, 7, 15]) {
      feed(showEffect(type, { x: 10, y: 10 }, { x: 10, y: 10 }, 0.5));
    }
    expect(world.blastStore.size).toBe(0);
  });

  // The detonation is what proves the telegraph was read correctly, which is
  // the only check available on a packet body recovered from game metadata.
  it('confirms a prediction the detonation lands on', () => {
    const { world, feed } = harness();
    world.markConnected();
    feed(showEffect(THROW_EFFECT, { x: 3, y: 3 }, { x: 12, y: 9 }, 0.6));
    feed(
      packetOf('AOE', {
        position: { x: 12.2, y: 9.1 },
        radius: 3,
        damage: 200,
        effect: 0,
        effectDuration: 0,
        originType: 0,
        color: 0,
        armorPierce: false,
      }),
    );

    expect(world.blastStore.confirmed).toBe(1);
    expect(world.blastStore.unmatched).toBe(0);
    // And it stops being something to walk out of: it has already gone off.
    expect([...world.blasts()][0]?.confirmed).toBe(true);
  });

  it('counts a detonation nothing predicted', () => {
    const { world, feed } = harness();
    world.markConnected();
    feed(
      packetOf('AOE', {
        position: { x: 40, y: 40 },
        radius: 3,
        damage: 200,
        effect: 0,
        effectDuration: 0,
        originType: 0,
        color: 0,
        armorPierce: false,
      }),
    );

    expect(world.blastStore.confirmed).toBe(0);
    expect(world.blastStore.unmatched).toBe(1);
  });

  it('falls back to a sensible delay when the duration is nonsense', () => {
    const store = new BlastStore();
    store.announce(0, 5, 5, Number.NaN);
    store.announce(0, 6, 6, 999_999);
    const blasts = [...store.values(0)];
    expect(blasts).toHaveLength(2);
    for (const blast of blasts) expect(blast.armsAtMs).toBe(DEFAULT_TELEGRAPH_MS);
  });

  it('refuses a landing spot that is not a place', () => {
    const store = new BlastStore();
    expect(store.announce(0, Number.NaN, 5, 500)).toBe(false);
    expect(store.size).toBe(0);
  });

  it('forgets one long after it has gone off', () => {
    const store = new BlastStore();
    store.announce(0, 5, 5, 500);
    expect([...store.values(600)]).toHaveLength(1);
    expect([...store.values(9000)]).toHaveLength(0);
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
  const BACKPACK_SLOT_0_STAT = 135;
  const BACKPACK_SLOT_8_STAT = 148;
  const BELT_SLOT_0_STAT = 143;

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
