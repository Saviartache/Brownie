import {
  MutablePacket,
  type EntityView,
  type InventoryView,
  type ItemSlotView,
  type NativeApi,
  type PermanentStats,
  type Position,
  type SessionApi,
  type SessionView,
} from '@brownie/plugin-api';
import { createPacket, decodeFrame, encodePacket } from '@brownie/protocol';
import { createBundledRegistry } from '@brownie/protocol/bundled';
import { describe, expect, it } from 'vitest';

import { ConditionEffect, conditionBitLow } from '../src/constants/ConditionEffect.js';
import { createAutoAbilityPlugin } from '../src/features/autoability/autoAbilityPlugin.js';
import {
  castReason,
  percentOf,
  type CastMoment,
  type CastPreferences,
} from '../src/features/autoability/worthCasting.js';
import { AbilityUse, readAbilityFacts, type AbilityFacts } from '../src/gamedata/abilities.js';
import { BenefitKind, type AbilityBenefit } from '../src/gamedata/abilityEffects.js';
import { PluginHost } from '../src/plugins/PluginHost.js';
import type { SettingsRegistry } from '../src/plugins/SettingsRegistry.js';
import { testLogger } from './fakes.js';

const registry = createBundledRegistry();

// Trimmed from `game-data/objects.xml` — the elements that decide the answer,
// verbatim, and nothing else. Real text rather than invented text: what is
// being tested is a reading of a file somebody else maintains.

/** Archer. One aimed effect, a cost, no cooldown, nothing granted. */
const QUIVER = `<Object type="0xb28" id="Quiver of Elvish Mastery">
    <Item />
    <SlotType>15</SlotType>
    <Usable />
    <MpCost>75</MpCost>
    <Activate scalingStat="WIS" statModScalingMin="34" statModDamage="3.88">Shoot</Activate>
  </Object>`;

/** Priest. A heal, a healing aura and a cleanse — and nothing else. */
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

/**
 * Priest again, and the one that reported this: a heal with a shot bolted on.
 *
 * `Tome of Holy Guidance` is the same shape with a damage nova in place of the
 * shot. Both fired every 700 ms for as long as anything was on screen, because
 * the rider was read as the reason.
 */
const HYBRID_TOME = `<Object type="0x7b8" id="pD Tome">
    <Item />
    <SlotType>4</SlotType>
    <Activate amount="120" statModAmount="0.8800" scalingStat="ATT">Heal</Activate>
    <Activate amount="060" range="8.0" effect="Healing" duration="4.4" color="0xFFFFEE">ConditionEffectAura</Activate>
    <Activate scalingStat="ATT" statModScalingMin="65" statModDamage="6.65">Shoot</Activate>
    <MpCost>140</MpCost>
  </Object>`;

/** Paladin. A stat boost the runtime cannot see, and two auras it can. */
const SEAL = `<Object type="0xc61" id="Seal of the Blessed Champion">
    <Item />
    <SlotType>12</SlotType>
    <MpCost>90</MpCost>
    <Activate stat="MAXHP" amount="70" duration="4" range="4.5" channel="maxStack">StatBoostAura</Activate>
    <Activate effect="Healing" duration="4" range="4.5" scalingStat="WIS">ConditionEffectAura</Activate>
    <Activate effect="Damaging" duration="4" range="4.5" scalingStat="WIS">ConditionEffectAura</Activate>
  </Object>`;

/** Rogue. One utility effect, and the game states its own cooldown. */
const CLOAK = `<Object type="0xb27" id="Cloak of Ghostly Concealment">
    <Item />
    <SlotType>13</SlotType>
    <Usable />
    <MpCost>100</MpCost>
    <Activate conditionEffect="Invisible" duration="5.0" cancelTime="1">Sneak</Activate>
    <Cooldown>5.5</Cooldown>
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

const HEALING = conditionBitLow(ConditionEffect.Healing);
const DAMAGING = conditionBitLow(ConditionEffect.Damaging);
const INVISIBLE = conditionBitLow(ConditionEffect.Invisible);
const BLEEDING = conditionBitLow(ConditionEffect.Bleeding);

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
      benefits: [],
    });
  });

  it('reads a priest tome as health and a cleanse, which is what it is', () => {
    expect(abilityOf(TOME)).toEqual({
      use: AbilityUse.SelfCast,
      mpCost: 140,
      cooldownMs: undefined,
      // Nothing it grants is invisible to the runtime, so there is no duration
      // to fall back on and none is kept.
      refreshMs: undefined,
      benefits: [
        { kind: BenefitKind.Health, conditionBit: 0 },
        { kind: BenefitKind.Health, conditionBit: HEALING },
        { kind: BenefitKind.Cleanse, conditionBit: 0 },
      ],
    });
  });

  it('reads a tome with a shot on it as a tome that also shoots', () => {
    // Aimed, so the shot lands on something — and still a heal, which is what
    // decides whether to cast at all.
    const hybrid = abilityOf(HYBRID_TOME);
    expect(hybrid.use).toBe(AbilityUse.Aimed);
    expect(hybrid.benefits).toEqual([
      { kind: BenefitKind.Health, conditionBit: 0 },
      { kind: BenefitKind.Health, conditionBit: HEALING },
    ]);
  });

  it('keeps a duration only for what it cannot see on the character', () => {
    // The two auras set bits the server states; the stat boost sets one it
    // states in a stat this runtime does not carry, and that is the 4 s.
    expect(abilityOf(SEAL)).toEqual({
      use: AbilityUse.SelfCast,
      mpCost: 90,
      cooldownMs: undefined,
      refreshMs: 4000,
      benefits: [
        { kind: BenefitKind.Defence, conditionBit: 0 },
        { kind: BenefitKind.Health, conditionBit: HEALING },
        { kind: BenefitKind.Offence, conditionBit: DAMAGING },
      ],
    });
  });

  it('reads the cooldown the game states, and what a cloak grants', () => {
    expect(abilityOf(CLOAK)).toEqual({
      use: AbilityUse.SelfCast,
      mpCost: 100,
      cooldownMs: 5500,
      refreshMs: undefined,
      benefits: [{ kind: BenefitKind.Utility, conditionBit: INVISIBLE }],
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

describe('whether casting it now would accomplish anything', () => {
  const LIMITS: CastPreferences = { hpPercent: 80, mpPercent: 50, utilityOutOfCombat: false };

  /** Full bars, nothing on the character, nothing to fight. */
  const alone = (over: Partial<Omit<CastMoment, 'enemyNear'>> = {}): CastMoment => ({
    hpPercent: 100,
    mpPercent: 100,
    conditions: 0,
    ...over,
    enemyNear: () => false,
  });

  const fighting = (over: Partial<Omit<CastMoment, 'enemyNear'>> = {}): CastMoment => ({
    ...alone(over),
    enemyNear: () => true,
  });

  const health: AbilityBenefit = { kind: BenefitKind.Health, conditionBit: 0 };
  const healingAura: AbilityBenefit = { kind: BenefitKind.Health, conditionBit: HEALING };
  const offence: AbilityBenefit = { kind: BenefitKind.Offence, conditionBit: DAMAGING };
  const utility: AbilityBenefit = { kind: BenefitKind.Utility, conditionBit: INVISIBLE };
  const cleanse: AbilityBenefit = { kind: BenefitKind.Cleanse, conditionBit: 0 };

  it('holds a heal at full health, and lets it go once health is missing', () => {
    // The whole reason this file exists: a priest's tome fired on a timer is a
    // heal thrown away every 2.5 seconds for the walk to the dungeon.
    expect(castReason([health, healingAura], alone(), LIMITS)).toBeUndefined();
    expect(castReason([health, healingAura], fighting(), LIMITS)).toBeUndefined();
    expect(castReason([health, healingAura], alone({ hpPercent: 60 }), LIMITS)).toBe(
      BenefitKind.Health,
    );
  });

  it('waits for something to fight before an offensive aura', () => {
    expect(castReason([offence], alone(), LIMITS)).toBeUndefined();
    expect(castReason([offence], fighting(), LIMITS)).toBe(BenefitKind.Offence);
  });

  it('will not renew what the character is already carrying', () => {
    expect(castReason([offence], fighting({ conditions: DAMAGING }), LIMITS)).toBeUndefined();
    expect(castReason([utility], fighting({ conditions: INVISIBLE }), LIMITS)).toBeUndefined();
    expect(castReason([utility], fighting(), LIMITS)).toBe(BenefitKind.Utility);
  });

  it('spends mana on speed outside a fight only when asked to', () => {
    // A warrior's helm grants a berserk aura and a speed boost, so without this
    // it renews for the whole walk across the realm.
    const keepUp = { ...LIMITS, utilityOutOfCombat: true };
    expect(castReason([utility], alone(), LIMITS)).toBeUndefined();
    expect(castReason([utility], alone(), keepUp)).toBe(BenefitKind.Utility);
    // And still not while it is already up.
    expect(castReason([utility], alone({ conditions: INVISIBLE }), keepUp)).toBeUndefined();
  });

  it('cleanses only once something has gone wrong', () => {
    expect(castReason([cleanse], alone(), LIMITS)).toBeUndefined();
    expect(castReason([cleanse], alone({ conditions: BLEEDING }), LIMITS)).toBe(
      BenefitKind.Cleanse,
    );
  });

  it('casts for any one of the things an ability gives', () => {
    // A tome that heals and cleanses is worth casting for either, and the
    // implementation this came from returned on the first that did not apply.
    expect(castReason([health, cleanse], alone({ conditions: BLEEDING }), LIMITS)).toBe(
      BenefitKind.Cleanse,
    );
    expect(castReason([health, cleanse], alone({ hpPercent: 60 }), LIMITS)).toBe(
      BenefitKind.Health,
    );
  });

  it('gives no reason at all for an ability it cannot name — enemies or not', () => {
    // Every attack ability in the game lands here, and "something is nearby" is
    // not a reason to spend the player's mana on one. The plugin points those
    // when the player fires them instead; see the redirect tests below.
    expect(castReason([], alone(), LIMITS)).toBeUndefined();
    expect(castReason([], fighting(), LIMITS)).toBeUndefined();
  });

  it('reads an unstated bar as full rather than as empty', () => {
    // A character whose maximum the server has not sent is not a character at
    // nought health, and treating it as one would fire on the first tick of
    // every session.
    expect(castReason([health], alone({ hpPercent: percentOf(0, 0) }), LIMITS)).toBeUndefined();
  });

  it('never asks about the room when nothing it gives depends on one', () => {
    // The search behind that answer is a pass over every visible entity, and a
    // priest walking with a full bar has no use for it.
    let asked = 0;
    const moment: CastMoment = {
      hpPercent: 100,
      mpPercent: 100,
      conditions: 0,
      enemyNear: () => {
        asked += 1;
        return true;
      },
    };
    expect(castReason([health, healingAura, cleanse], moment, LIMITS)).toBeUndefined();
    expect(asked).toBe(0);
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
  const HYBRID_TOME_TYPE = 0x7b8;
  const SEAL_TYPE = 0xc61;
  const CLOAK_TYPE = 0xb27;
  const PRISM_TYPE = 0xb23;
  const UNCATALOGUED_TYPE = 0x7777;

  const ENEMY_TYPE = 100;
  const WALL_TYPE = 200;
  /** What `objects.xml` marks `<Quest />`, which is the arrow over a boss. */
  const BOSS_TYPE = 300;

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

  /** The whole packet, for the one test that is about the packet. */
  interface SentPacket {
    readonly time: number;
    readonly useType: number;
    readonly slotId: number;
    readonly objectId: number;
  }

  interface Harness {
    host: PluginHost;
    settings: SettingsRegistry;
    self: {
      x: number;
      y: number;
      hp: number;
      maxHp: number;
      mp: number;
      maxMp: number;
      alive: boolean;
      conditions: number;
    };
    world: { mapName: string; gameTimeMs: number; clientTimeMs: number; clientTickId: number };
    enemies: EntityView[];
    slot: { objectType: number };
    casts: Cast[];
    packets: SentPacket[];
    session: SessionView;
    /** Where the module says the player is pointing, or nothing when nobody knows. */
    cursor: { point: Position | undefined };
    /** Advances the clock and offers one server tick. */
    tick: (atMs: number) => void;
    /** How many times the enemy list has been walked. */
    scans: () => number;
    /** How many times the cursor has been asked for, which is the claim on it. */
    cursorAsks: () => number;
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
      [HYBRID_TOME_TYPE, abilityOf(HYBRID_TOME)],
      [SEAL_TYPE, abilityOf(SEAL)],
      [CLOAK_TYPE, abilityOf(CLOAK)],
      [PRISM_TYPE, abilityOf(PRISM)],
    ]);

    // A support ability, because that is the half this plugin casts on its own.
    // The attack half is only ever pointed, and the tests that cover it name
    // the quiver they are pointing.
    const slot = { objectType: SEAL_TYPE };
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
    /** How many times anything has walked the enemy list. */
    let scans = 0;
    const world = {
      mapName: 'Undead Lair',
      gameTimeMs: 0,
      // Deliberately nothing like the schedule clock: the two are different
      // quantities and only one of them belongs on the wire.
      clientTimeMs: 1_234_000,
      clientTickId: 41,
      entities: () => enemies,
      entity: () => undefined,
      players: () => [],
      enemies: () => {
        scans += 1;
        return enemies;
      },
      tileAt: () => undefined,
      canStandAt: () => true,
      projectiles: () => [],
      blasts: () => [],
    };

    const casts: Cast[] = [];
    const packets: SentPacket[] = [];
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
        packets.push({
          time: numberAt(fields, 'time'),
          useType: numberAt(fields, 'useType'),
          slotId: numberAt(slotObject, 'slotId'),
          objectId: numberAt(slotObject, 'objectId'),
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
    // Nothing until a test points somewhere, which is the module saying nothing
    // — the state a session spends most of its life in.
    const cursor: { point: Position | undefined } = { point: undefined };
    let cursorAsks = 0;
    host.load(
      createAutoAbilityPlugin({
        ability: (objectType) => abilities.get(objectType),
        isObstacle: (objectType) => objectType === WALL_TYPE,
        isInvincible: () => false,
        isBoss: (objectType) => objectType === BOSS_TYPE,
        cursorPoint: () => {
          cursorAsks += 1;
          return cursor.point;
        },
      }),
    );
    host.setEnabled('auto-ability', true);
    const settings = host.settingsOf('auto-ability');
    if (settings === undefined) throw new Error('the plugin declared no settings');

    const tick = (atMs: number): void => {
      world.gameTimeMs = atMs;
      host.dispatchPacket(new MutablePacket(createPacket(registry, 'NEWTICK')), session);
    };

    return {
      host,
      settings,
      self,
      world,
      enemies,
      slot,
      casts,
      packets,
      session,
      cursor,
      tick,
      scans: () => scans,
      cursorAsks: () => cursorAsks,
    };
  }

  /** Where the player pointed — nowhere near anything the tests below spawn. */
  const MOUSE = { x: -7, y: 11 };

  /** A real `USEITEM`, encoded and decoded, so the nested slot is read as one. */
  function useItem(slotId: number, objectType = SEAL_TYPE): MutablePacket {
    const packet = createPacket(registry, 'USEITEM');
    Object.assign(packet.fields, {
      time: 0,
      slotObject: { objectId: 7, slotId, objectType },
      itemUsePos: MOUSE,
      useType: 1,
      unknownInt: 0,
    });
    return new MutablePacket(decodeFrame(registry, encodePacket(registry, packet)));
  }

  /** Where a `USEITEM` says the effect should land. */
  function usePosOf(packet: MutablePacket): { x: number; y: number } {
    const position = recordAt(packet.fields, 'itemUsePos');
    return { x: numberAt(position, 'x'), y: numberAt(position, 'y') };
  }

  it('walks the enemy list once a tick at most, and not at all when it need not', () => {
    // The one expensive thing on this path, in a realm with several hundred
    // entities in view. A tome at full health is turned down by the health rule
    // before anything wants to know whether the room is empty.
    const h = harness();
    h.slot.objectType = TOME_TYPE;
    for (let at = 0; at <= 3000; at += 500) h.tick(at);
    expect(h.scans()).toBe(0);

    // And a combat aura, which does need the answer, asks for it once.
    const seal = harness();
    seal.enemies.push(enemyOf(1, 2));
    seal.tick(0);
    expect(seal.casts).toHaveLength(1);
    expect(seal.scans()).toBe(1);
  });

  it('stops before the ability slot while the cooldown is still running', () => {
    const h = harness();
    h.enemies.push(enemyOf(1, 2));
    h.tick(0);
    expect(h.scans()).toBe(1);

    // Inside the interval: nothing is read, nothing is searched.
    h.tick(300);
    expect(h.scans()).toBe(1);
  });

  it('stamps the packet with the client clock, not the schedule clock', () => {
    // A `time` the server does not recognise is a packet it throws away without
    // saying so: the ability sound plays, the mana never moves, and the plugin
    // fires again a moment later because from where it sits nothing happened.
    // A whole session of a priest's tome went that way.
    const h = harness();
    h.enemies.push(enemyOf(1, 2));
    h.world.clientTimeMs = 1_800_500;
    h.tick(9000);

    expect(h.packets).toEqual([{ time: 1_800_500, useType: 1, slotId: ABILITY_SLOT, objectId: 7 }]);
  });

  it('never fires an attack ability, however long something stands in range', () => {
    // The whole point of the split: a quiver is the player's key to press. It
    // is not even worth a look at the room until they press it.
    const h = harness();
    h.slot.objectType = QUIVER_TYPE;
    h.enemies.push(enemyOf(1, 2));

    for (let at = 0; at <= 5000; at += 500) h.tick(at);
    expect(h.casts).toHaveLength(0);
    expect(h.scans()).toBe(0);
  });

  it('leaves a priest tome alone at full health, enemies or not', () => {
    // The report this behaviour comes from: playing a priest, the tome went off
    // continuously for no reason at all.
    const h = harness();
    h.slot.objectType = TOME_TYPE;

    h.tick(0);
    h.enemies.push(enemyOf(1, 2));
    h.tick(1000);
    expect(h.casts).toHaveLength(0);
  });

  it('casts the tome once health is missing, where the character stands', () => {
    const h = harness();
    h.slot.objectType = TOME_TYPE;
    h.self.x = 12.5;
    h.self.y = -4;
    h.self.hp = 300;

    h.tick(0);
    expect(h.casts).toEqual([{ x: 12.5, y: -4, slotId: ABILITY_SLOT, objectType: TOME_TYPE }]);
  });

  it('casts the tome at full health when something needs cleansing', () => {
    const h = harness();
    h.slot.objectType = TOME_TYPE;
    h.self.conditions = BLEEDING;

    h.tick(0);
    expect(h.casts).toHaveLength(1);
  });

  it('does not spam a healing tome that happens to shoot', () => {
    // The report: `cast aimed 0x7b8 … for 140 mp, again in 700 ms`, over and
    // over, on a priest at full health. One `Shoot` at the end of the item's
    // effects was outranking the two heals in front of it.
    const h = harness();
    h.slot.objectType = HYBRID_TOME_TYPE;
    h.enemies.push(enemyOf(1, 2));

    for (let at = 0; at <= 5000; at += 500) h.tick(at);
    expect(h.casts).toHaveLength(0);
  });

  it('points that tome at the enemy once health is worth spending it on', () => {
    const h = harness();
    h.slot.objectType = HYBRID_TOME_TYPE;
    h.self.hp = 300;
    h.enemies.push(enemyOf(1, 4));

    h.tick(0);
    // At the enemy, not at the character: the heal lands either way and the
    // shot only lands one of those ways.
    expect(h.casts).toEqual([{ x: 4, y: 0, slotId: ABILITY_SLOT, objectType: HYBRID_TOME_TYPE }]);
  });

  it('still heals with that tome when there is nobody to point it at', () => {
    const h = harness();
    h.slot.objectType = HYBRID_TOME_TYPE;
    h.self.hp = 300;
    h.self.x = 9;
    h.self.y = 3;

    h.tick(0);
    expect(h.casts).toEqual([{ x: 9, y: 3, slotId: ABILITY_SLOT, objectType: HYBRID_TOME_TYPE }]);
  });

  it('counts a tome as support rather than as an attack, switches included', () => {
    const h = harness();
    h.slot.objectType = HYBRID_TOME_TYPE;
    h.self.hp = 300;

    h.settings.apply('aimAttacks', false);
    h.tick(0);
    expect(h.casts).toHaveLength(1);

    h.settings.apply('castSelf', false);
    h.tick(1000);
    expect(h.casts).toHaveLength(1);
  });

  it('casts a combat seal only while there is something to fight', () => {
    const h = harness();
    h.slot.objectType = SEAL_TYPE;

    h.tick(0);
    expect(h.casts).toHaveLength(0);

    h.enemies.push(enemyOf(1, 2));
    h.tick(1000);
    expect(h.casts).toHaveLength(1);
  });

  it('waits for the aura it just put up to run out', () => {
    const h = harness();
    h.slot.objectType = SEAL_TYPE;
    h.enemies.push(enemyOf(1, 2));
    h.tick(0);
    expect(h.casts).toHaveLength(1);

    // The stat boost it also grants is invisible to the runtime, so the file's
    // own four seconds is what paces it.
    h.tick(2000);
    expect(h.casts).toHaveLength(1);
    h.tick(4000);
    expect(h.casts).toHaveLength(2);
  });

  it('does not renew a cloak the character is already wearing', () => {
    const h = harness();
    h.slot.objectType = CLOAK_TYPE;
    h.enemies.push(enemyOf(1, 2));

    h.tick(0);
    expect(h.casts).toHaveLength(1);

    // Invisible now, so there is nothing to gain — and no duration was needed
    // to work that out.
    h.self.conditions = INVISIBLE;
    h.tick(10_000);
    expect(h.casts).toHaveLength(1);

    h.self.conditions = 0;
    h.tick(20_000);
    expect(h.casts).toHaveLength(2);
  });

  it('waits the minimum interval for an ability that grants nothing timed', () => {
    // A plain heal states no cooldown and grants nothing with a duration on it,
    // so the floor is the only thing pacing it.
    const h = harness();
    h.slot.objectType = TOME_TYPE;
    h.self.hp = 300;

    h.tick(0);
    h.tick(600);
    expect(h.casts).toHaveLength(1);
    h.tick(700);
    expect(h.casts).toHaveLength(2);
  });

  it('will not cast what it cannot pay for', () => {
    const h = harness();
    h.enemies.push(enemyOf(1, 2));
    h.self.mp = 89;
    h.tick(0);
    expect(h.casts).toHaveLength(0);

    h.self.mp = 90;
    h.tick(1000);
    expect(h.casts).toHaveLength(1);
  });

  it('leaves the reserve the player asked to keep', () => {
    const h = harness();
    h.enemies.push(enemyOf(1, 2));
    h.settings.apply('mpReservePercent', 50);
    h.self.maxMp = 200;

    // The 90 it costs, and then the 100 the player asked to still be holding.
    h.self.mp = 150;
    h.tick(0);
    expect(h.casts).toHaveLength(0);

    h.self.mp = 190;
    h.tick(1000);
    expect(h.casts).toHaveLength(1);
  });

  it('obeys the two thresholds the player sets', () => {
    const h = harness();
    h.slot.objectType = TOME_TYPE;
    h.self.hp = 450;

    // 90% — above the 80% default, below what the player just asked for.
    h.tick(0);
    expect(h.casts).toHaveLength(0);

    h.settings.apply('healthPercent', 95);
    h.tick(1000);
    expect(h.casts).toHaveLength(1);
  });

  it('keeps a stealth buff up outside combat only when asked to', () => {
    const h = harness();
    h.slot.objectType = CLOAK_TYPE;

    h.tick(0);
    expect(h.casts).toHaveLength(0);

    h.settings.apply('utilityOutOfCombat', true);
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

  it('casts nothing at all with the support switch off', () => {
    const h = harness();
    h.enemies.push(enemyOf(1, 2));
    h.settings.apply('castSelf', false);
    h.tick(0);
    expect(h.casts).toHaveLength(0);

    h.slot.objectType = CLOAK_TYPE;
    h.tick(1000);
    expect(h.casts).toHaveLength(0);

    h.settings.apply('castSelf', true);
    h.tick(2000);
    expect(h.casts).toHaveLength(1);
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
    const packet = useItem(5);
    h.host.dispatchPacket(packet, h.session);
    expect(packet.modified).toBe(false);
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

  it('points the attack the player fired at the nearest enemy worth hitting', () => {
    const h = harness();
    h.enemies.push(enemyOf(1, 6), enemyOf(2, 3));

    const packet = useItem(ABILITY_SLOT, QUIVER_TYPE);
    h.host.dispatchPacket(packet, h.session);

    expect(usePosOf(packet)).toEqual({ x: 3, y: 0 });
    expect(packet.modified).toBe(true);
  });

  it('points a tome that also shoots, since the shot is what the point is for', () => {
    const h = harness();
    h.enemies.push(enemyOf(1, 4));

    const packet = useItem(ABILITY_SLOT, HYBRID_TOME_TYPE);
    h.host.dispatchPacket(packet, h.session);

    expect(usePosOf(packet)).toEqual({ x: 4, y: 0 });
  });

  it('leaves the cast where the player pointed it when nothing is worth hitting', () => {
    const h = harness();
    // Past the eight-tile default, and then a wall, which is an object with hit
    // points and would otherwise be the closest enemy there is.
    h.enemies.push(enemyOf(1, 12), enemyOf(2, 2, WALL_TYPE));

    const packet = useItem(ABILITY_SLOT, QUIVER_TYPE);
    h.host.dispatchPacket(packet, h.session);

    expect(usePosOf(packet)).toEqual(MOUSE);
    expect(packet.modified).toBe(false);
  });

  it('never points an ability that would move the character', () => {
    // A prism reads that field as the place to teleport to, so pointing one at
    // a monster is a teleport into the monster.
    const h = harness();
    h.enemies.push(enemyOf(1, 2));

    const packet = useItem(ABILITY_SLOT, PRISM_TYPE);
    h.host.dispatchPacket(packet, h.session);

    expect(usePosOf(packet)).toEqual(MOUSE);
  });

  it('leaves a buff alone, which the game centres on the character anyway', () => {
    const h = harness();
    h.enemies.push(enemyOf(1, 2));

    const packet = useItem(ABILITY_SLOT, CLOAK_TYPE);
    h.host.dispatchPacket(packet, h.session);

    expect(packet.modified).toBe(false);
  });

  it('leaves the aim on the mouse when the player asked it to', () => {
    const h = harness();
    h.enemies.push(enemyOf(1, 3));
    h.settings.apply('aimAttacks', false);

    const packet = useItem(ABILITY_SLOT, QUIVER_TYPE);
    h.host.dispatchPacket(packet, h.session);

    expect(usePosOf(packet)).toEqual(MOUSE);
  });

  it('says nothing about an item the catalog cannot describe, here either', () => {
    const h = harness();
    h.enemies.push(enemyOf(1, 3));

    const packet = useItem(ABILITY_SLOT, UNCATALOGUED_TYPE);
    h.host.dispatchPacket(packet, h.session);

    expect(packet.modified).toBe(false);
  });

  describe('choosing which enemy', () => {
    /** A boss at the far end of the room, with a minion on top of the player. */
    function room(h: Harness): void {
      h.enemies.push(enemyOf(1, 2), enemyOf(2, 7, BOSS_TYPE));
    }

    /** Where a quiver the player fired ended up. */
    function fired(h: Harness): { x: number; y: number } {
      const packet = useItem(ABILITY_SLOT, QUIVER_TYPE);
      h.host.dispatchPacket(packet, h.session);
      return usePosOf(packet);
    }

    it('takes the closest enemy until it is told otherwise', () => {
      const h = harness();
      room(h);
      expect(fired(h)).toEqual({ x: 2, y: 0 });
    });

    it('takes the boss over whatever is standing closer, when asked to', () => {
      const h = harness();
      room(h);
      // Same health on both, so nothing but the marker separates them: this is
      // the tier doing the work rather than `The toughest enemy` happening to
      // agree with it, which is how bosses were picked before there was one.
      h.settings.apply('bosses', 'prefer');
      expect(fired(h)).toEqual({ x: 7, y: 0 });

      h.settings.apply('bosses', 'any');
      expect(fired(h)).toEqual({ x: 2, y: 0 });
    });

    it('points nothing at all at a minion when the player asked for bosses only', () => {
      const h = harness();
      h.enemies.push(enemyOf(1, 2));
      h.settings.apply('bosses', 'only');

      // Left where they pointed it, which is the honest answer to "there is
      // nothing here you said you wanted this spent on".
      expect(fired(h)).toEqual(MOUSE);

      h.enemies.push(enemyOf(2, 7, BOSS_TYPE));
      expect(fired(h)).toEqual({ x: 7, y: 0 });
    });

    it('holds a combat aura for a boss under that rule, not for the minions', () => {
      // The other half of "only bosses", and the half somebody would be annoyed
      // to find missing: a seal is 90 mana, and spending it on two bats is what
      // the setting says not to do.
      const h = harness();
      h.settings.apply('bosses', 'only');
      h.enemies.push(enemyOf(1, 2));

      h.tick(0);
      expect(h.casts).toHaveLength(0);

      h.enemies.push(enemyOf(2, 7, BOSS_TYPE));
      h.tick(1000);
      expect(h.casts).toEqual([{ x: 0, y: 0, slotId: ABILITY_SLOT, objectType: SEAL_TYPE }]);
    });

    it('still puts a combat aura up while the cursor points at nothing', () => {
      // Which enemy to *point at* is a preference about aiming; whether a
      // 90-mana aura is worth putting up is a question about the room, and a
      // paladin surrounded by monsters with the mouse resting on empty floor
      // is in a fight. Only the boss rule crosses between the two.
      const h = harness();
      h.settings.apply('priority', 'closestToCursor');
      h.enemies.push(enemyOf(1, 2));

      h.tick(0);
      expect(h.casts).toHaveLength(1);
    });

    it('takes the enemy under the cursor, which is where auto-aim is pointing', () => {
      // The complaint that produced this: aiming at the enemy under the cursor
      // and watching the ability go to whatever had wandered closest.
      const h = harness();
      room(h);
      h.settings.apply('priority', 'closestToCursor');
      h.cursor.point = { x: 7, y: 1 };

      expect(fired(h)).toEqual({ x: 7, y: 0 });
    });

    it('points nowhere new while nobody knows where the cursor is', () => {
      // A module that was killed, unloaded or has not started measuring yet
      // says nothing, and the player's own aim is the right answer to that.
      const h = harness();
      room(h);
      h.settings.apply('priority', 'closestToCursor');

      expect(fired(h)).toEqual(MOUSE);
    });

    it('keeps the cursor asked for even while it has no reason to cast', () => {
      // Asking is the claim, and the module measures nothing without one — so
      // an archer holding a quiver, whose ability is never cast from here, has
      // to keep the reading alive for the moment they press the key.
      const h = harness();
      h.slot.objectType = QUIVER_TYPE;
      h.settings.apply('priority', 'closestToCursor');

      h.tick(0);
      h.tick(500);
      expect(h.cursorAsks()).toBe(2);
    });

    it('leaves the cursor alone under every other priority', () => {
      // Three calls a frame into the game's camera, for an answer nothing on
      // this path reads.
      const h = harness();
      room(h);
      for (let at = 0; at <= 3000; at += 500) h.tick(at);
      fired(h);
      expect(h.cursorAsks()).toBe(0);
    });
  });
});
