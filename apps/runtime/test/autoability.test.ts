import {
  MutablePacket,
  type EntityView,
  type InventoryView,
  type ItemSlotView,
  type NativeApi,
  type PermanentStats,
  type SessionApi,
  type SessionView,
} from '@brownie/plugin-api';
import { createPacket, decodeFrame, encodePacket } from '@brownie/protocol';
import { createBundledRegistry } from '@brownie/protocol/bundled';
import { describe, expect, it } from 'vitest';

import { createAutoAbilityPlugin } from '../src/features/autoability/autoAbilityPlugin.js';
import { AbilityUse, readAbilityFacts, type AbilityFacts } from '../src/gamedata/abilities.js';
import { PluginHost } from '../src/plugins/PluginHost.js';
import type { SettingsRegistry } from '../src/plugins/SettingsRegistry.js';
import { testLogger } from './fakes.js';

const registry = createBundledRegistry();

// Trimmed from `game-data/objects.xml` — the elements that decide the answer,
// verbatim, and nothing else. Real text rather than invented text: what is
// being tested is a reading of a file somebody else maintains.

/** Archer. One aimed effect, a projectile, a cost, no cooldown. */
const QUIVER = `<Object type="0xb28" id="Quiver of Elvish Mastery">
    <Item />
    <SlotType>15</SlotType>
    <Usable />
    <MpCost>75</MpCost>
    <Activate scalingStat="WIS" statModScalingMin="34" statModDamage="3.88">Shoot</Activate>
  </Object>`;

/** Priest. Three self effects and an instant heal; only the aura is timed. */
const TOME = `<Object type="0xc09" id="Tome of Purification">
    <Item />
    <SlotType>4</SlotType>
    <Activate amount="150" scalingStat="VIT">Heal</Activate>
    <Activate amount="075" range="8.0" effect="Healing" duration="4.4" color="0xFFFFCC">ConditionEffectAura</Activate>
    <Activate effect="Speedy" checkExistingEffect="Hexed">ClearConditionEffectSelf</Activate>
    <Activate>RemoveNegativeConditionsSelf</Activate>
    <MpCost>140</MpCost>
    <Usable />
  </Object>`;

/** Trickster. Throws a decoy and then moves the character. */
const PRISM = `<Object type="0xb23" id="Prism of Apparitions">
    <Item />
    <SlotType>22</SlotType>
    <Usable />
    <MpCost>90</MpCost>
    <Activate duration="9" speed="1.25">Decoy</Activate>
    <Activate maxDistance="13">Teleport</Activate>
  </Object>`;

/** Ninja. Aimed, but held down: a second press is what ends it. */
const STAR = `<Object type="0xc59" id="Doom Circle">
    <Item />
    <SlotType>25</SlotType>
    <MpCost>0</MpCost>
    <MpEndCost>90</MpEndCost>
    <MultiPhase />
    <Activate stat="DEX" amount="6" statModDamage="18.00">ShurikenAbility</Activate>
    <Usable />
  </Object>`;

/** Warrior. Two timed self effects and a cooldown the file states itself. */
const HELM = `<Object type="0x9ff" id="Helm of the Juggernaut">
    <Item />
    <SlotType>6</SlotType>
    <Activate effect="Damaging" duration="5" range="5">ConditionEffectAura</Activate>
    <Activate effect="Invulnerable" duration="2.2">ConditionEffectSelf</Activate>
    <Cooldown>5</Cooldown>
    <Usable />
  </Object>`;

const HEALTH_POTION = `<Object type="0xa22" id="Health Potion">
    <Item />
    <SlotType>10</SlotType>
    <Potion />
    <Activate>Heal</Activate>
  </Object>`;

const SWORD = `<Object type="0x3000" id="Sword of Acclaim">
    <Item />
    <SlotType>1</SlotType>
  </Object>`;

/** An effect the game has and this build has never heard of. */
const UNKNOWN = `<Object type="0x3001" id="Something New">
    <Item />
    <SlotType>4</SlotType>
    <MpCost>50</MpCost>
    <Activate duration="3">SomethingNobodyHasSeen</Activate>
  </Object>`;

function abilityOf(element: string): AbilityFacts {
  const facts = readAbilityFacts(element);
  if (facts === undefined) throw new Error('expected an ability');
  return facts;
}

describe('what objects.xml says an ability does', () => {
  it('reads an aimed ability from its effect, not from a class id', () => {
    expect(abilityOf(QUIVER)).toEqual({
      use: AbilityUse.Aimed,
      mpCost: 75,
      cooldownMs: undefined,
      refreshMs: undefined,
    });
  });

  it('reads a self-cast, and takes the shortest of what it grants', () => {
    // 2.2 s, not the aura's 5 s: the ability is only fully applied while both
    // stand, so the shorter one is when it is worth casting again.
    expect(abilityOf(HELM)).toEqual({
      use: AbilityUse.SelfCast,
      mpCost: 0,
      cooldownMs: 5000,
      refreshMs: 2200,
    });
  });

  it('ignores an instant effect when deciding how long a buff lasts', () => {
    expect(abilityOf(TOME)).toEqual({
      use: AbilityUse.SelfCast,
      mpCost: 140,
      cooldownMs: undefined,
      refreshMs: 4400,
    });
  });

  it('refuses an ability that moves the character, whatever else it does', () => {
    // The decoy alone would be aimed. The teleport is what decides.
    expect(abilityOf(PRISM).use).toBe(AbilityUse.Never);
  });

  it('refuses an ability that is held down', () => {
    expect(abilityOf(STAR).use).toBe(AbilityUse.Never);
  });

  it('refuses an ability whose effects it does not recognise', () => {
    // Not the same claim as "it is safe": the game adds effects faster than
    // this table learns them, and a timer on an unknown one is a timer on
    // whatever it turns out to do.
    expect(abilityOf(UNKNOWN).use).toBe(AbilityUse.Never);
  });

  it('is not an ability at all without something to activate', () => {
    expect(readAbilityFacts(SWORD)).toBeUndefined();
  });

  it('is not an ability when it is a potion', () => {
    // It activates `Heal` exactly as a tome does, and it cannot be worn.
    expect(readAbilityFacts(HEALTH_POTION)).toBeUndefined();
  });
});

describe('the auto-ability plugin', () => {
  const NATIVE: NativeApi = {
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

  const ABILITY_SLOT = 1;
  const QUIVER_TYPE = 0xb28;
  const TOME_TYPE = 0xc09;
  const PRISM_TYPE = 0xb23;
  const UNCATALOGUED_TYPE = 0x7777;

  const ENEMY_TYPE = 100;
  const WALL_TYPE = 200;

  const NO_STATS: PermanentStats = {
    attack: 0,
    defense: 0,
    speed: 0,
    dexterity: 0,
    vitality: 0,
    wisdom: 0,
  };

  /** Reads a nested field, failing the test rather than asserting its shape. */
  function recordAt(
    fields: Readonly<Record<string, unknown>>,
    key: string,
  ): Readonly<Record<string, unknown>> {
    const value = fields[key];
    if (typeof value !== 'object' || value === null) {
      throw new Error(`${key} is not an object`);
    }
    return value as Readonly<Record<string, unknown>>;
  }

  function numberAt(record: Readonly<Record<string, unknown>>, key: string): number {
    const value = record[key];
    if (typeof value !== 'number') throw new Error(`${key} is not a number`);
    return value;
  }

  interface Cast {
    readonly x: number;
    readonly y: number;
    readonly slotId: number;
    readonly objectType: number;
  }

  interface Harness {
    host: PluginHost;
    settings: SettingsRegistry;
    self: { x: number; y: number; mp: number; maxMp: number; alive: boolean };
    world: { mapName: string; gameTimeMs: number };
    enemies: EntityView[];
    slot: { objectType: number };
    casts: Cast[];
    session: SessionView;
    /** Advances the clock and offers one server tick. */
    tick: (atMs: number) => void;
  }

  function enemyOf(objectId: number, x: number, objectType = ENEMY_TYPE): EntityView {
    return {
      objectId,
      objectType,
      name: '',
      hp: 100,
      maxHp: 100,
      isEnemy: true,
      isPlayer: false,
      conditions: 0,
      guildName: '',
      stat: () => undefined,
      text: () => undefined,
      x,
      y: 0,
    };
  }

  function harness(): Harness {
    const abilities = new Map<number, AbilityFacts>([
      [QUIVER_TYPE, abilityOf(QUIVER)],
      [TOME_TYPE, abilityOf(TOME)],
      [PRISM_TYPE, abilityOf(PRISM)],
    ]);

    const slot = { objectType: QUIVER_TYPE };
    const inventory: InventoryView = {
      carried: () => [],
      backpack: () => [],
      belt: () => [],
      at: (slotId): ItemSlotView | undefined =>
        slotId === ABILITY_SLOT ? { slotId, objectType: slot.objectType, quantity: 0 } : undefined,
    };

    const self = {
      objectId: 7,
      objectType: 0x30e,
      name: 'Tester',
      hp: 500,
      maxHp: 500,
      mp: 1000,
      maxMp: 1000,
      defense: 0,
      walkSpeedTilesPerSecond: 5,
      weaponType: -1,
      alive: true,
      conditions: 0,
      inventory,
      permanentStats: NO_STATS,
      x: 0,
      y: 0,
    };

    const enemies: EntityView[] = [];
    const world = {
      mapName: 'Undead Lair',
      gameTimeMs: 0,
      entities: () => enemies,
      entity: () => undefined,
      players: () => [],
      enemies: () => enemies,
      tileAt: () => undefined,
      canStandAt: () => true,
      projectiles: () => [],
    };

    const casts: Cast[] = [];
    const session: SessionView = {
      id: 's1',
      self,
      world,
      server: { host: '', port: 0 },
      sendToServer: (name, fields) => {
        expect(name).toBe('USEITEM');
        const position = recordAt(fields, 'itemUsePos');
        const slotObject = recordAt(fields, 'slotObject');
        casts.push({
          x: numberAt(position, 'x'),
          y: numberAt(position, 'y'),
          slotId: numberAt(slotObject, 'slotId'),
          objectType: numberAt(slotObject, 'objectType'),
        });
      },
      sendToClient: () => undefined,
      notify: () => undefined,
    };

    const host = new PluginHost({
      log: testLogger(),
      native: NATIVE,
      sessions: SESSIONS,
      onChanged: () => undefined,
    });
    host.load(
      createAutoAbilityPlugin({
        ability: (objectType) => abilities.get(objectType),
        isObstacle: (objectType) => objectType === WALL_TYPE,
        isInvincible: () => false,
      }),
    );
    host.setEnabled('auto-ability', true);
    const settings = host.settingsOf('auto-ability');
    if (settings === undefined) throw new Error('the plugin declared no settings');

    const tick = (atMs: number): void => {
      world.gameTimeMs = atMs;
      host.dispatchPacket(new MutablePacket(createPacket(registry, 'NEWTICK')), session);
    };

    return { host, settings, self, world, enemies, slot, casts, session, tick };
  }

  /** A real `USEITEM`, encoded and decoded, so the nested slot is read as one. */
  function useItem(slotId: number): MutablePacket {
    const packet = createPacket(registry, 'USEITEM');
    Object.assign(packet.fields, {
      time: 0,
      slotObject: { objectId: 7, slotId, objectType: QUIVER_TYPE },
      itemUsePos: { x: 0, y: 0 },
      useType: 1,
      unknownInt: 0,
    });
    return new MutablePacket(decodeFrame(registry, encodePacket(registry, packet)));
  }

  it('casts an aimed ability at the nearest enemy that is worth hitting', () => {
    const h = harness();
    h.enemies.push(enemyOf(1, 6), enemyOf(2, 3));
    h.tick(0);

    expect(h.casts).toEqual([{ x: 3, y: 0, slotId: ABILITY_SLOT, objectType: QUIVER_TYPE }]);
  });

  it('holds an aimed ability while there is nothing in range', () => {
    const h = harness();
    // Past the eight-tile default, and then a wall, which is an object with hit
    // points and would otherwise be the closest enemy there is.
    h.enemies.push(enemyOf(1, 12));
    h.tick(0);
    expect(h.casts).toHaveLength(0);

    h.enemies.push(enemyOf(2, 2, WALL_TYPE));
    h.tick(1000);
    expect(h.casts).toHaveLength(0);
  });

  it('casts a self-buff where the character stands', () => {
    const h = harness();
    h.slot.objectType = TOME_TYPE;
    h.self.x = 12.5;
    h.self.y = -4;
    h.enemies.push(enemyOf(1, 14));
    h.tick(0);

    expect(h.casts).toEqual([{ x: 12.5, y: -4, slotId: ABILITY_SLOT, objectType: TOME_TYPE }]);
  });

  it('holds a self-buff until an enemy is near, unless told not to', () => {
    const h = harness();
    h.slot.objectType = TOME_TYPE;
    h.tick(0);
    expect(h.casts).toHaveLength(0);

    h.settings.apply('onlyNearEnemies', false);
    h.tick(1000);
    expect(h.casts).toHaveLength(1);
  });

  it('waits as long as the buff it just cast lasts', () => {
    const h = harness();
    h.slot.objectType = TOME_TYPE;
    h.settings.apply('onlyNearEnemies', false);
    h.tick(0);
    expect(h.casts).toHaveLength(1);

    // The reference implementation recast every 2500 ms, which for this tome
    // was two casts in five thrown away.
    h.tick(2500);
    expect(h.casts).toHaveLength(1);
    h.tick(4400);
    expect(h.casts).toHaveLength(2);
  });

  it('waits the minimum interval for an ability that grants nothing timed', () => {
    const h = harness();
    h.enemies.push(enemyOf(1, 2));
    h.tick(0);
    h.tick(600);
    expect(h.casts).toHaveLength(1);
    h.tick(700);
    expect(h.casts).toHaveLength(2);
  });

  it('will not cast what it cannot pay for', () => {
    const h = harness();
    h.enemies.push(enemyOf(1, 2));
    h.self.mp = 74;
    h.tick(0);
    expect(h.casts).toHaveLength(0);

    h.self.mp = 75;
    h.tick(1000);
    expect(h.casts).toHaveLength(1);
  });

  it('leaves the reserve the player asked to keep', () => {
    const h = harness();
    h.enemies.push(enemyOf(1, 2));
    h.settings.apply('mpReservePercent', 50);
    h.self.maxMp = 200;

    h.self.mp = 150;
    h.tick(0);
    expect(h.casts).toHaveLength(0);

    h.self.mp = 180;
    h.tick(1000);
    expect(h.casts).toHaveLength(1);
  });

  it('never casts an ability that would move the character', () => {
    const h = harness();
    h.slot.objectType = PRISM_TYPE;
    h.enemies.push(enemyOf(1, 2));
    h.tick(0);
    h.tick(5000);
    expect(h.casts).toHaveLength(0);
  });

  it('says nothing about an item the catalog cannot describe', () => {
    const h = harness();
    h.slot.objectType = UNCATALOGUED_TYPE;
    h.enemies.push(enemyOf(1, 2));
    h.tick(0);
    expect(h.casts).toHaveLength(0);
  });

  it('stays quiet in a safe zone and while dead', () => {
    const h = harness();
    h.enemies.push(enemyOf(1, 2));

    h.world.mapName = 'Vault 3';
    h.tick(0);
    expect(h.casts).toHaveLength(0);

    h.world.mapName = 'Undead Lair';
    h.self.alive = false;
    h.tick(1000);
    expect(h.casts).toHaveLength(0);

    h.self.alive = true;
    h.tick(2000);
    expect(h.casts).toHaveLength(1);
  });

  it('backs off after the player uses the ability by hand', () => {
    const h = harness();
    h.enemies.push(enemyOf(1, 2));

    h.world.gameTimeMs = 0;
    h.host.dispatchPacket(useItem(ABILITY_SLOT), h.session);
    h.tick(1900);
    expect(h.casts).toHaveLength(0);
    h.tick(2000);
    expect(h.casts).toHaveLength(1);
  });

  it('ignores the player using anything else', () => {
    const h = harness();
    h.enemies.push(enemyOf(1, 2));

    h.world.gameTimeMs = 0;
    // A potion out of a carried slot, which auto-drink and the player both send.
    h.host.dispatchPacket(useItem(5), h.session);
    h.tick(0);
    expect(h.casts).toHaveLength(1);
  });

  it('does not cast into a map the client has not finished loading', () => {
    const h = harness();
    h.enemies.push(enemyOf(1, 2));
    h.tick(0);
    expect(h.casts).toHaveLength(1);

    h.world.gameTimeMs = 5000;
    h.host.dispatchPacket(new MutablePacket(createPacket(registry, 'MAPINFO')), h.session);
    h.tick(5500);
    expect(h.casts).toHaveLength(1);
    h.tick(6000);
    expect(h.casts).toHaveLength(2);
  });
});
