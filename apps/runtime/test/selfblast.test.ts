/**
 * Enemy keep-outs learned from the game's own data, not by name.
 *
 * The reference implementation shipped a hard-coded radius for one enemy and
 * then replaced the list with the idea: a detonation centred on a living enemy
 * of its own origin type, with no telegraph near it, is a self blast — and any
 * enemy that attacks that way teaches its radius the first time it is seen
 * doing so. These tests hold both halves of that idea to the fire: what gets
 * learned, what must never be, and what the dodge does with a radius once it
 * has one.
 */

import { describe, expect, it } from 'vitest';
import { createBundledRegistry } from '@brownie/protocol/bundled';
import {
  createPacket,
  decodeFrame,
  encodePacket,
  type FieldValue,
  type PacketFields,
  type PacketRegistry,
} from '@brownie/protocol';
import { MutablePacket, type EntityView } from '@brownie/plugin-api';
import { PacketOrigin, type PacketContext } from '../src/pipeline/PacketPipeline.js';
import { StateStage } from '../src/pipeline/stages/StateStage.js';
import type { ProjectileDefinition } from '../src/gamedata/projectiles.js';
import type { ObjectCatalog } from '../src/state/ObjectCatalog.js';
import { StatType } from '../src/constants/StatType.js';
import { BlastStore, THROW_EFFECT, type BlastTelegraph } from '../src/state/blasts/BlastStore.js';
import {
  isSelfBlast,
  MAX_SELF_BLAST_TILES,
  SELF_BLAST_MARGIN_TILES,
  SelfBlastTable,
} from '../src/state/blasts/SelfBlastTable.js';
import { SelfBlastKeepouts } from '../src/features/dodge/SelfBlastKeepouts.js';
import { PLAYER_HALF_TILES } from '../src/features/dodge/hitbox.js';
import { WorldState } from '../src/state/WorldState.js';

const registry: PacketRegistry = createBundledRegistry();
const FROM_SERVER: PacketContext = { origin: PacketOrigin.Server, sessionId: 's1' };

/** Builds a real packet, encoded and decoded, as the game could have sent it. */
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

const SELF_BLASTER = 1000;
const OTHER_ENEMY = 1001;
const BLASTER_ID = 42;

function alive(hp = 500, maxHp = 500): PacketFields[] {
  return [
    { id: StatType.Hp, value: hp, stackCount: 0 },
    { id: StatType.MaxHp, value: maxHp, stackCount: 0 },
  ];
}

/** One detonation, attributed, as the wire carries it. */
function aoe(
  at: { x: number; y: number },
  radius: number,
  originType = SELF_BLASTER,
  damage = 200,
): MutablePacket {
  return packetOf('AOE', {
    position: at,
    radius,
    damage,
    effect: 0,
    effectDuration: 0,
    originType,
    color: 0,
    armorPierce: false,
  });
}

const HAS_TARGET_ID = 64;
const HAS_POSITION_X = 2;
const HAS_POSITION_Y = 4;

/** One telegraph, thrown at a place, so a warned blast can be told from one that was not. */
function telegraph(at: { x: number; y: number }, thrower = BLASTER_ID): MutablePacket {
  return packetOf('SHOWEFFECT', {
    effectType: THROW_EFFECT,
    presentFields: HAS_TARGET_ID | HAS_POSITION_X | HAS_POSITION_Y,
    targetObjectId: thrower,
    positionX: at.x,
    positionY: at.y,
  });
}

/** A catalog that can describe one shot, for the stationary-field path. */
function shooter(overrides: Partial<ProjectileDefinition> = {}): ObjectCatalog {
  const definition: ProjectileDefinition = {
    bulletType: 0,
    speed: 0,
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
    debuffSeverity: 0,
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
    isPortal: () => false,
    isDungeonPortal: () => false,
    dungeonPortals: () => [],
    items: () => [],
    bodyTiles: () => undefined,
    displayName: () => undefined,
    projectile: () => definition,
    hasShots: () => true,
    item: () => undefined,
    container: () => undefined,
    statMaxima: () => undefined,
  };
}

/**
 * A world with the self-blaster on it, standing somewhere, alive or not.
 */
function worldWithBlaster(
  catalog: ObjectCatalog = shooter(),
  stats: PacketFields[] = alive(),
): { world: WorldState; feed: (packet: MutablePacket) => void } {
  const world = new WorldState({ objects: catalog });
  const stage = new StateStage(world);
  world.markConnected();
  const feed = (packet: MutablePacket): void => stage.handle(packet, FROM_SERVER);
  feed(
    packetOf('UPDATE', {
      position: { x: 0, y: 0 },
      levelType: 0,
      tiles: [],
      newObjs: [{ objectType: SELF_BLASTER, status: status(BLASTER_ID, 10, 10, stats) }],
      drops: [],
    }),
  );
  return { world, feed };
}

describe('the learned keep-out table', () => {
  it('learns a radius from one self blast and reports it', () => {
    const table = new SelfBlastTable();
    expect(table.learn(SELF_BLASTER, 3)).toBe(true);
    expect(table.lookUp(SELF_BLASTER)?.radiusTiles).toBeCloseTo(3, 5);
  });

  it('widens and never narrows', () => {
    const table = new SelfBlastTable();
    table.learn(SELF_BLASTER, 3);
    expect(table.learn(SELF_BLASTER, 2)).toBe(false);
    expect(table.learn(SELF_BLASTER, 4)).toBe(true);
    expect(table.lookUp(SELF_BLASTER)?.radiusTiles).toBeCloseTo(4, 5);
  });

  it('refuses a radius the wire cannot really have said', () => {
    const table = new SelfBlastTable();
    expect(table.learn(SELF_BLASTER, 0)).toBe(false);
    expect(table.learn(SELF_BLASTER, -1)).toBe(false);
    expect(table.learn(SELF_BLASTER, MAX_SELF_BLAST_TILES + 1)).toBe(false);
    expect(table.learn(-1, 3)).toBe(false);
    expect(table.size).toBe(0);
  });

  it('survives a round trip through the file', () => {
    const written = new SelfBlastTable();
    written.learn(SELF_BLASTER, 3);
    written.learn(OTHER_ENEMY, 1.5);

    const read = new SelfBlastTable();
    expect(read.restore(written.serialise())).toBe(2);
    expect(read.lookUp(SELF_BLASTER)?.radiusTiles).toBeCloseTo(3, 5);
    expect(read.lookUp(OTHER_ENEMY)?.radiusTiles).toBeCloseTo(1.5, 5);
  });

  it('skips the entries a hand edit broke rather than refusing the file', () => {
    const table = new SelfBlastTable();
    expect(
      table.restore({
        version: 1,
        types: [
          { objectType: SELF_BLASTER, radiusTiles: 2, seen: 1 },
          { objectType: -5, radiusTiles: 2 },
          { objectType: OTHER_ENEMY, radiusTiles: 'wide' },
        ],
      }),
    ).toBe(1);
    expect(table.lookUp(SELF_BLASTER)?.radiusTiles).toBeCloseTo(2, 5);
  });
});

describe('the self-blast classifier', () => {
  const enemiesOf = (list: [number, number, number, number][]): EntityView[] =>
    list.map(([objectType, x, y, hp]) => ({ objectType, x, y, hp }) as EntityView);

  it('accepts a detonation centred on a living enemy of its own origin type', () => {
    expect(isSelfBlast(10, 10, SELF_BLASTER, enemiesOf([[SELF_BLASTER, 10.5, 10, 500]]))).toBe(
      true,
    );
  });

  it('rejects a blast centred on another type', () => {
    expect(isSelfBlast(10, 10, SELF_BLASTER, enemiesOf([[OTHER_ENEMY, 10, 10, 500]]))).toBe(false);
  });

  it('rejects a blast centred on a corpse', () => {
    expect(isSelfBlast(10, 10, SELF_BLASTER, enemiesOf([[SELF_BLASTER, 10, 10, 0]]))).toBe(false);
  });

  it('rejects a blast centred on nobody', () => {
    expect(isSelfBlast(40, 40, SELF_BLASTER, enemiesOf([[SELF_BLASTER, 10, 10, 500]]))).toBe(false);
  });
});

describe('the blast store as the telegraph’s own witness', () => {
  const thrown: BlastTelegraph = { x: 5, y: 5, armsInMs: 500, originType: 1, color: 0 };

  it('says whether a detonation matched a prediction', () => {
    const store = new BlastStore();
    store.announce(0, thrown);
    expect(store.landed(400, { x: 5, y: 5, radiusTiles: 2, harmful: true })).toBe(true);
    expect(store.landed(500, { x: 40, y: 40, radiusTiles: 2, harmful: true })).toBe(false);
  });

  it('knows when a telegraph is still live near a place', () => {
    const store = new BlastStore();
    store.announce(0, thrown);
    expect(store.announcedNear(7, 7, 3)).toBe(true);
    expect(store.announcedNear(20, 20, 3)).toBe(false);
    // Gone off, so no longer a warning about anything.
    store.landed(600, { x: 5, y: 5, radiusTiles: 2, harmful: true });
    expect(store.announcedNear(7, 7, 3)).toBe(false);
  });
});

describe('learning from the wire', () => {
  it('learns a self blast that nothing warned about', () => {
    const { world, feed } = worldWithBlaster();
    feed(aoe({ x: 10, y: 10 }, 3));

    expect(world.selfBlastKeepoutTiles(SELF_BLASTER)).toBeCloseTo(3, 5);
  });

  it('does not learn a blast its own telegraph predicted', () => {
    const { world, feed } = worldWithBlaster();
    feed(telegraph({ x: 10, y: 10 }));
    feed(aoe({ x: 10.1, y: 10 }, 3));

    expect(world.selfBlastKeepoutTiles(SELF_BLASTER)).toBeUndefined();
  });

  it('does not learn a blast a nearby telegraph warned about, matched or not', () => {
    const { world, feed } = worldWithBlaster();
    // A telegraph that drifted past the confirm radius: warned fire all the
    // same, and learning it would keep the player out of radius around an
    // enemy whose blasts are perfectly dodgeable.
    feed(telegraph({ x: 13, y: 10 }));
    feed(aoe({ x: 10, y: 10 }, 3));

    expect(world.selfBlastKeepoutTiles(SELF_BLASTER)).toBeUndefined();
  });

  it('does not learn a blast centred on nobody', () => {
    const { world, feed } = worldWithBlaster();
    feed(aoe({ x: 40, y: 40 }, 3));

    expect(world.selfBlastKeepoutTiles(SELF_BLASTER)).toBeUndefined();
  });

  it('does not learn a blast centred on a corpse', () => {
    const { world, feed } = worldWithBlaster(shooter(), alive(0, 500));
    feed(aoe({ x: 10, y: 10 }, 3));

    expect(world.selfBlastKeepoutTiles(SELF_BLASTER)).toBeUndefined();
  });

  it('does not learn a detonation that cannot hurt anybody', () => {
    const { world, feed } = worldWithBlaster();
    feed(aoe({ x: 10, y: 10 }, 3, SELF_BLASTER, 0));

    expect(world.selfBlastKeepoutTiles(SELF_BLASTER)).toBeUndefined();
  });

  it('learns a stationary shot as the enemy’s own ground, circumscribed', () => {
    const { world, feed } = worldWithBlaster();
    feed(
      packetOf('ENEMYSHOOT', {
        ownerId: BLASTER_ID,
        bulletId: 1,
        bulletType: 0,
        angle: 0,
        position: { x: 10, y: 10 },
        numShots: 1,
        angleInc: 0,
      }),
    );

    // The shot's collision square (half a tile) circumscribed into a disc.
    expect(world.selfBlastKeepoutTiles(SELF_BLASTER)).toBeCloseTo(0.5 * Math.SQRT2, 5);
  });

  it('does not learn a shot that moves as if it owned the ground', () => {
    const { world, feed } = worldWithBlaster(shooter({ speed: 1000 }));
    feed(
      packetOf('ENEMYSHOOT', {
        ownerId: BLASTER_ID,
        bulletId: 1,
        bulletType: 0,
        angle: 0,
        position: { x: 10, y: 10 },
        numShots: 1,
        angleInc: 0,
      }),
    );

    expect(world.selfBlastKeepoutTiles(SELF_BLASTER)).toBeUndefined();
  });
});

describe('the keep-out discs the dodge holds', () => {
  function disc(x: number, y: number, radiusTiles: number, vx = 0, vy = 0) {
    return { x, y, radiusTiles, velocityX: vx, velocityY: vy };
  }

  function enemyAt(objectType: number, x: number, y: number, hp: number, maxHp: number) {
    return {
      objectId: objectType,
      objectType,
      x,
      y,
      hp,
      maxHp,
      name: '',
      isEnemy: true,
      isPlayer: false,
      conditions: 0,
      guildName: '',
      stat: () => undefined,
      text: () => undefined,
    } as EntityView;
  }

  it('answers a distance outside the radius and a depth inside it', () => {
    const keepOuts = new SelfBlastKeepouts();
    keepOuts.collect([enemyAt(SELF_BLASTER, 10, 10, 500, 500)], 10, 10, 30, () => disc(10, 10, 3));

    // Beyond the learned radius by the player's own half and the margin, which
    // are part of the answer for the same reason every blast carries them.
    expect(keepOuts.gapAt(14.5, 10)).toBeCloseTo(
      4.5 - 3 - PLAYER_HALF_TILES - SELF_BLAST_MARGIN_TILES,
      3,
    );
    expect(keepOuts.gapAt(12, 10)).toBeLessThan(0);
  });

  it('answers nothing at all when nothing was learned', () => {
    const keepOuts = new SelfBlastKeepouts();
    keepOuts.collect([enemyAt(OTHER_ENEMY, 10, 10, 500, 500)], 10, 10, 30, () => undefined);
    expect(keepOuts.gapAt(10, 10)).toBe(Infinity);
  });

  it('carries the enemy’s own movement into the answer', () => {
    const keepOuts = new SelfBlastKeepouts();
    keepOuts.collect([enemyAt(SELF_BLASTER, 10, 10, 500, 500)], 10, 10, 30, () =>
      disc(10, 10, 1, 0.001, 0),
    );

    // Half a second ahead the enemy has walked half a tile towards the place
    // asked about, and the answer is that much deeper in.
    const stoodStill = keepOuts.gapAt(12.5, 10);
    expect(keepOuts.gapAt(12.5, 10, 500)).toBeCloseTo(stoodStill - 0.5, 3);
  });
});
