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

/**
 * Archer. One aimed effect, a cost, no cooldown, nothing granted — and arrows
 * of its own, which the client fires behind its use from the same point.
 */
const QUIVER = `<Object type="0xb28" id="Quiver of Elvish Mastery">
    <Item />
    <SlotType>15</SlotType>
    <Usable />
    <Projectile>
      <ObjectId>Blue Arrow</ObjectId>
    </Projectile>
    <NumProjectiles>4</NumProjectiles>
    <MpCost>75</MpCost>
    <Activate scalingStat="WIS" statModScalingMin="34" statModDamage="3.88">Shoot</Activate>
  </Object>`;

/** Huntress. Aimed at a place, and nothing flies: the server lays the trap there. */
const TRAP = `<Object type="0xb40" id="Trap of the Vile Spirit" collectionIcon="100">
    <Item />
    <SlotType>20</SlotType>
    <Usable />
    <MpCost>90</MpCost>
    <Activate radius="3.0" sensitivity="1.0" totalDamage="0" color="5c6bb8" condEffect="Curse" condDuration="2" throwTime="0.6">Trap</Activate>
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
 * It fired every 700 ms for as long as anything was on screen, because the
 * rider was read as the reason. The shot is a projectile of the item's own,
 * which the client fires behind its use.
 */
const HYBRID_TOME = `<Object type="0x7b8" id="pD Tome">
    <Item />
    <SlotType>4</SlotType>
    <Projectile>
      <ObjectId>pD Blob Shot</ObjectId>
    </Projectile>
    <Activate amount="120" statModAmount="0.8800" scalingStat="ATT">Heal</Activate>
    <Activate amount="060" range="8.0" effect="Healing" duration="4.4" color="0xFFFFEE">ConditionEffectAura</Activate>
    <Activate scalingStat="ATT" statModScalingMin="65" statModDamage="6.65">Shoot</Activate>
    <NumProjectiles>0</NumProjectiles>
    <MpCost>140</MpCost>
  </Object>`;

/** Priest, the same shape with a damage nova in place of the shot. */
const NOVA_TOME = `<Object type="0x0ad7" id="Remedy Tome">
    <Item />
    <SlotType>4</SlotType>
    <Activate amount="090" statModAmount="0.7150" scalingStat="WIS" statModScalingMin="70">Heal</Activate>
    <Activate amount="045" statModAmount="0.3575" range="6.2" effect="Healing" duration="4.4" color="0xFFFFCC">ConditionEffectAura</Activate>
    <Activate minDamage="240" maxDamage="240" statModDamage="5.20" activationCount="2" time="0.4" radius="2.5" color="0xFFFF00">DamageNova</Activate>
    <MpCost>130</MpCost>
    <Usable />
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
const INVULNERABLE = conditionBitLow(ConditionEffect.Invulnerable);

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
    // when the player fires them instead; see the pointing tests below.
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
  const TRAP_TYPE = 0xb40;
  const TOME_TYPE = 0xc09;
  const HYBRID_TOME_TYPE = 0x7b8;
  const NOVA_TOME_TYPE = 0x0ad7;
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

  /** A press the module was asked to make, where. */
  interface Cast {
    readonly x: number;
    readonly y: number;
  }

  /** A pointing of the player's own presses, and how long it stands. */
  interface Aim {
    readonly x: number;
    readonly y: number;
    readonly holdMs: number;
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
    world: { mapName: string; gameTimeMs: number };
    enemies: EntityView[];
    slot: { objectType: number };
    /** Every press asked of the module, in order. */
    casts: Cast[];
    /** How long each of those was allowed to wait for a frame. */
    castHolds: number[];
    /** Every pointing published, in order. */
    aims: Aim[];
    /** Anything the plugin tried to send to the server itself. */
    sent: string[];
    /**
     * Whether the client makes the presses it is asked to. When it does, its
     * `USEITEM` follows within the same tick, the way the real one follows
     * within a frame.
     */
    client: { makesPresses: boolean };
    session: SessionView;
    /** Where the module says the player is pointing, or nothing when nobody knows. */
    cursor: { point: Position | undefined };
    /** Advances the clock and offers one server tick. */
    tick: (atMs: number) => void;
    /** The client's own use of the ability slot, at the clock as it stands. */
    press: () => void;
    /** How many times the enemy list has been walked. */
    scans: () => number;
    /** How many times the cursor has been asked for, which is the claim on it. */
    cursorAsks: () => number;
  }

  function enemyOf(
    objectId: number,
    x: number,
    objectType = ENEMY_TYPE,
    conditions = 0,
  ): EntityView {
    return {
      objectId,
      objectType,
      name: '',
      hp: 100,
      maxHp: 100,
      isEnemy: true,
      isPlayer: false,
      conditions,
      guildName: '',
      stat: () => undefined,
      text: () => undefined,
      x,
      y: 0,
    };
  }

  /** A real `USEITEM`, encoded and decoded, so the nested slot is read as one. */
  function useItem(slotId: number, objectType = SEAL_TYPE): MutablePacket {
    const packet = createPacket(registry, 'USEITEM');
    Object.assign(packet.fields, {
      time: 0,
      slotObject: { objectId: 7, slotId, objectType },
      itemUsePos: { x: -7, y: 11 },
      useType: 1,
      unknownInt: 0,
    });
    return new MutablePacket(decodeFrame(registry, encodePacket(registry, packet)));
  }

  function harness(): Harness {
    const abilities = new Map<number, AbilityFacts>([
      [QUIVER_TYPE, abilityOf(QUIVER)],
      [TRAP_TYPE, abilityOf(TRAP)],
      [TOME_TYPE, abilityOf(TOME)],
      [HYBRID_TOME_TYPE, abilityOf(HYBRID_TOME)],
      [NOVA_TOME_TYPE, abilityOf(NOVA_TOME)],
      [SEAL_TYPE, abilityOf(SEAL)],
      [CLOAK_TYPE, abilityOf(CLOAK)],
      [PRISM_TYPE, abilityOf(PRISM)],
    ]);

    // A support ability, because that is the half this plugin casts on its own.
    // The attack half is only ever pointed, and the tests that cover it name
    // the item they are pointing.
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
      questObjectId: -1,
      gameTimeMs: 0,
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
      selfBlastKeepoutTiles: (): undefined => undefined,
    };

    const casts: Cast[] = [];
    const castHolds: number[] = [];
    const aims: Aim[] = [];
    const sent: string[] = [];
    const client = { makesPresses: true };
    /** Presses asked for during the tick being offered, not yet made. */
    let asked = 0;

    const session: SessionView = {
      id: 's1',
      self,
      world,
      server: { host: '', port: 0 },
      sendToServer: (name) => {
        sent.push(name);
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
        output: {
          cast: (at, holdMs) => {
            casts.push({ x: at.x, y: at.y });
            castHolds.push(holdMs);
            asked += 1;
          },
          aimAt: (at, holdMs) => {
            aims.push({ x: at.x, y: at.y, holdMs });
          },
        },
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

    const press = (): void => {
      host.dispatchPacket(useItem(ABILITY_SLOT, slot.objectType), session);
    };

    const tick = (atMs: number): void => {
      world.gameTimeMs = atMs;
      host.dispatchPacket(new MutablePacket(createPacket(registry, 'NEWTICK')), session);
      // The client making what it was asked to, as its own `USEITEM` — which
      // is the only way the plugin ever hears that a cast happened.
      const made = client.makesPresses ? asked : 0;
      asked = 0;
      for (let i = 0; i < made; i++) press();
    };

    return {
      host,
      settings,
      self,
      world,
      enemies,
      slot,
      casts,
      castHolds,
      aims,
      sent,
      client,
      session,
      cursor,
      tick,
      press,
      scans: () => scans,
      cursorAsks: () => cursorAsks,
    };
  }

  /** The pointings published by one tick at `atMs`, as places. */
  function pointedOn(h: Harness, atMs: number): Position[] {
    const before = h.aims.length;
    h.tick(atMs);
    return h.aims.slice(before).map(({ x, y }) => ({ x, y }));
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

  it('does not search the room while the cooldown is still running', () => {
    const h = harness();
    h.enemies.push(enemyOf(1, 2));
    h.tick(0);
    expect(h.scans()).toBe(1);

    // Inside the interval: nothing is read, nothing is searched.
    h.tick(300);
    expect(h.scans()).toBe(1);
  });

  it('sends nothing to the server itself: the client makes every use', () => {
    // The kicks this replaced: a `USEITEM` the client never made — no shots
    // behind a quiver's, no cooldown on the client's side, sent while the
    // client would have refused it. The module presses the key instead, and
    // the client builds its own.
    const h = harness();
    h.enemies.push(enemyOf(1, 2));
    h.tick(0);
    h.slot.objectType = TRAP_TYPE;
    h.tick(5000);
    h.press();

    expect(h.casts).toHaveLength(1);
    expect(h.aims).toHaveLength(1);
    expect(h.sent).toEqual([]);
    // And the press may wait a quarter of a second for a frame to be made in,
    // not longer: what it was aimed at moves.
    expect(h.castHolds).toEqual([250]);
  });

  it('leaves the player’s own use exactly as the client built it', () => {
    const h = harness();
    h.slot.objectType = TRAP_TYPE;
    h.enemies.push(enemyOf(1, 3));
    h.tick(0);

    const packet = useItem(ABILITY_SLOT, TRAP_TYPE);
    h.host.dispatchPacket(packet, h.session);
    expect(packet.modified).toBe(false);
  });

  it('never fires an attack ability, however long something stands in range', () => {
    // The whole point of the split: a trap is the player's key to press. It
    // looks at the room once a tick, to point that press, and no more.
    const h = harness();
    h.slot.objectType = TRAP_TYPE;
    h.enemies.push(enemyOf(1, 2));

    for (let at = 0; at <= 5000; at += 500) h.tick(at);
    expect(h.casts).toHaveLength(0);
    expect(h.scans()).toBe(11);

    // With the pointing off there is nothing to look at the room for at all.
    const quiet = harness();
    quiet.slot.objectType = TRAP_TYPE;
    quiet.enemies.push(enemyOf(1, 2));
    quiet.settings.apply('aimAttacks', false);
    for (let at = 0; at <= 5000; at += 500) quiet.tick(at);
    expect(quiet.scans()).toBe(0);
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
    expect(h.casts).toEqual([{ x: 12.5, y: -4 }]);
  });

  it('casts the tome at full health when something needs cleansing', () => {
    const h = harness();
    h.slot.objectType = TOME_TYPE;
    h.self.conditions = BLEEDING;

    h.tick(0);
    expect(h.casts).toHaveLength(1);
  });

  it('does not spam a healing tome that happens to hit things', () => {
    // The report: `cast aimed 0x7b8 … for 140 mp, again in 700 ms`, over and
    // over, on a priest at full health. One attack at the end of the item's
    // effects was outranking the two heals in front of it — a shot on one tome,
    // a nova on the other.
    for (const tome of [HYBRID_TOME_TYPE, NOVA_TOME_TYPE]) {
      const h = harness();
      h.slot.objectType = tome;
      h.enemies.push(enemyOf(1, 2));

      for (let at = 0; at <= 5000; at += 500) h.tick(at);
      expect(h.casts).toHaveLength(0);
    }
  });

  it('points that tome at the enemy once health is worth spending it on', () => {
    // At the enemy, not at the character: the heal lands either way and the
    // attack only lands one of those ways. The shot on the first is fired by
    // the client itself, behind its own use, from the same point.
    for (const tome of [HYBRID_TOME_TYPE, NOVA_TOME_TYPE]) {
      const h = harness();
      h.slot.objectType = tome;
      h.self.hp = 300;
      h.enemies.push(enemyOf(1, 4));

      h.tick(0);
      expect(h.casts).toEqual([{ x: 4, y: 0 }]);
    }
  });

  it('still heals with that tome when there is nobody to point it at', () => {
    const h = harness();
    h.slot.objectType = NOVA_TOME_TYPE;
    h.self.hp = 300;
    h.self.x = 9;
    h.self.y = 3;

    h.tick(0);
    expect(h.casts).toEqual([{ x: 9, y: 3 }]);
  });

  it('looks for that tome’s enemy once, whichever of its switches asks', () => {
    // The pointing of the player's own presses and the cast both want the same
    // enemy by the same rule, and the room is the expensive thing to ask about.
    const h = harness();
    h.slot.objectType = NOVA_TOME_TYPE;
    h.self.hp = 300;
    h.enemies.push(enemyOf(1, 4));

    h.tick(0);
    expect(h.casts).toEqual([{ x: 4, y: 0 }]);
    expect(h.aims.map(({ x, y }) => ({ x, y }))).toEqual([{ x: 4, y: 0 }]);
    expect(h.scans()).toBe(1);

    // With the pointing off, the cast looks for itself.
    const unpointed = harness();
    unpointed.slot.objectType = NOVA_TOME_TYPE;
    unpointed.self.hp = 300;
    unpointed.enemies.push(enemyOf(1, 4));
    unpointed.settings.apply('aimAttacks', false);
    unpointed.tick(0);
    expect(unpointed.casts).toEqual([{ x: 4, y: 0 }]);
    expect(unpointed.aims).toHaveLength(0);
  });

  it('counts a tome as support rather than as an attack, switches included', () => {
    const h = harness();
    h.slot.objectType = NOVA_TOME_TYPE;
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
    expect(h.aims).toHaveLength(0);
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
    h.slot.objectType = NOVA_TOME_TYPE;
    h.self.hp = 300;
    h.enemies.push(enemyOf(1, 2));

    h.world.mapName = 'Vault 3';
    h.tick(0);
    expect(h.casts).toHaveLength(0);
    expect(h.aims).toHaveLength(0);

    h.world.mapName = 'Undead Lair';
    h.self.alive = false;
    h.tick(1000);
    expect(h.casts).toHaveLength(0);
    expect(h.aims).toHaveLength(0);

    h.self.alive = true;
    h.tick(2000);
    expect(h.casts).toHaveLength(1);
    expect(h.aims).toHaveLength(1);
  });

  it('backs off after the player uses the ability by hand', () => {
    const h = harness();
    h.enemies.push(enemyOf(1, 2));

    h.world.gameTimeMs = 0;
    h.press();
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

  describe('hearing whether the client made the press', () => {
    it('starts the interval when the client makes the press, not when it was asked', () => {
      // A seal's four seconds are four seconds of an aura the server put up,
      // and the server put it up when the client's use reached it.
      const h = harness();
      h.enemies.push(enemyOf(1, 2));
      h.client.makesPresses = false;

      h.tick(0);
      expect(h.casts).toHaveLength(1);
      h.world.gameTimeMs = 300;
      h.press();

      h.tick(4200);
      expect(h.casts).toHaveLength(1);
      h.tick(4300);
      expect(h.casts).toHaveLength(2);
    });

    it('asks again later, and later still, while the client makes nothing', () => {
      // Silenced, a cooldown this side cannot see, a map that forbids it, or no
      // module at all: the client refuses on screen each time it is asked, and
      // five notices a second is not an answer to anything.
      const h = harness();
      h.slot.objectType = TOME_TYPE;
      h.self.hp = 300;
      h.client.makesPresses = false;

      const askedAt: number[] = [];
      for (let at = 0; at <= 23_000; at += 100) {
        const before = h.casts.length;
        h.tick(at);
        if (h.casts.length > before) askedAt.push(at);
      }
      expect(askedAt).toEqual([0, 1000, 3000, 7000, 15_000, 23_000]);

      // And the moment the client makes one, the ordinary pace is back.
      h.client.makesPresses = true;
      h.tick(23_100);
      expect(h.casts).toHaveLength(6);
      h.world.gameTimeMs = 23_100;
      h.press();
      h.tick(23_800);
      expect(h.casts).toHaveLength(7);
      h.tick(24_500);
      expect(h.casts).toHaveLength(8);
    });

    it('reads a use long after the asking as the player’s own key', () => {
      const h = harness();
      h.slot.objectType = TOME_TYPE;
      h.self.hp = 300;
      h.client.makesPresses = false;

      h.tick(0);
      h.world.gameTimeMs = 900;
      h.press();

      // The pause a press by hand earns, not the heal's own interval.
      h.tick(2800);
      expect(h.casts).toHaveLength(1);
      h.tick(2900);
      expect(h.casts).toHaveLength(2);
    });

    it('forgets a press asked for on the last map', () => {
      const h = harness();
      h.slot.objectType = TOME_TYPE;
      h.self.hp = 300;
      h.client.makesPresses = false;

      h.tick(0);
      h.world.gameTimeMs = 100;
      h.host.dispatchPacket(new MutablePacket(createPacket(registry, 'MAPINFO')), h.session);
      // A use this soon after asking would have been the answer, but a map has
      // changed in between: it is the player's.
      h.world.gameTimeMs = 200;
      h.press();

      h.tick(2100);
      expect(h.casts).toHaveLength(1);
      h.tick(2200);
      expect(h.casts).toHaveLength(2);
    });
  });

  describe('pointing the presses the player makes', () => {
    it('points them at the nearest enemy worth hitting, a tick at a time', () => {
      const h = harness();
      h.slot.objectType = TRAP_TYPE;
      h.enemies.push(enemyOf(1, 6), enemyOf(2, 3));

      h.tick(0);
      // Two ticks' worth, renewed on every one: silence is how the cursor
      // becomes theirs again.
      expect(h.aims).toEqual([{ x: 3, y: 0, holdMs: 400 }]);
      h.tick(200);
      expect(h.aims).toHaveLength(2);
    });

    it('points a quiver too: the client fires the arrows from the point it is handed', () => {
      const h = harness();
      h.slot.objectType = QUIVER_TYPE;
      h.enemies.push(enemyOf(1, 3));
      expect(pointedOn(h, 0)).toEqual([{ x: 3, y: 0 }]);
    });

    it('points a tome that also hits, since the hit is what the point is for', () => {
      for (const tome of [HYBRID_TOME_TYPE, NOVA_TOME_TYPE]) {
        const h = harness();
        h.slot.objectType = tome;
        h.enemies.push(enemyOf(1, 4));
        expect(pointedOn(h, 0)).toEqual([{ x: 4, y: 0 }]);
      }
    });

    it('points nothing when nothing is worth hitting', () => {
      const h = harness();
      h.slot.objectType = TRAP_TYPE;
      // Past the eight-tile default, and then a wall, which is an object with
      // hit points and would otherwise be the closest enemy there is.
      h.enemies.push(enemyOf(1, 12), enemyOf(2, 2, WALL_TYPE));
      expect(pointedOn(h, 0)).toEqual([]);
    });

    it('never points an ability that would move the character', () => {
      // A prism reads the point as the place to teleport to, so pointing one at
      // a monster is a teleport into the monster.
      const h = harness();
      h.slot.objectType = PRISM_TYPE;
      h.enemies.push(enemyOf(1, 2));
      expect(pointedOn(h, 0)).toEqual([]);
    });

    it('leaves a buff alone, which the game centres on the character anyway', () => {
      const h = harness();
      h.slot.objectType = CLOAK_TYPE;
      h.enemies.push(enemyOf(1, 2));
      expect(pointedOn(h, 0)).toEqual([]);
    });

    it('leaves the presses on the mouse when the player asked it to', () => {
      const h = harness();
      h.slot.objectType = TRAP_TYPE;
      h.enemies.push(enemyOf(1, 3));
      h.settings.apply('aimAttacks', false);
      expect(pointedOn(h, 0)).toEqual([]);
    });

    it('keeps pointing while a cast is not due', () => {
      // Whether this plugin spends mana has nothing to do with where the
      // player's spending lands: a press made inside the interval is pointed
      // all the same.
      const h = harness();
      h.slot.objectType = NOVA_TOME_TYPE;
      h.self.hp = 300;
      h.enemies.push(enemyOf(1, 4));
      h.tick(0);
      expect(h.casts).toHaveLength(1);
      expect(pointedOn(h, 300)).toEqual([{ x: 4, y: 0 }]);
      expect(h.casts).toHaveLength(1);
    });
  });

  describe('choosing which enemy', () => {
    /** A boss at the far end of the room, with a minion on top of the player. */
    function room(h: Harness): void {
      h.slot.objectType = TRAP_TYPE;
      h.enemies.push(enemyOf(1, 2), enemyOf(2, 7, BOSS_TYPE));
    }

    /** Where the player's presses were pointed on one more tick, if anywhere. */
    function pointed(h: Harness): Position | undefined {
      const published = pointedOn(h, h.world.gameTimeMs + 200);
      return published[published.length - 1];
    }

    it('takes the closest enemy until it is told otherwise', () => {
      const h = harness();
      room(h);
      expect(pointed(h)).toEqual({ x: 2, y: 0 });
    });

    it('takes the boss over whatever is standing closer, when asked to', () => {
      const h = harness();
      room(h);
      // Same health on both, so nothing but the marker separates them: this is
      // the tier doing the work rather than `The toughest enemy` happening to
      // agree with it, which is how bosses were picked before there was one.
      h.settings.apply('bosses', 'prefer');
      expect(pointed(h)).toEqual({ x: 7, y: 0 });

      h.settings.apply('bosses', 'any');
      expect(pointed(h)).toEqual({ x: 2, y: 0 });
    });

    it('points nothing at all at a minion when the player asked for bosses only', () => {
      const h = harness();
      h.slot.objectType = TRAP_TYPE;
      h.enemies.push(enemyOf(1, 2));
      h.settings.apply('bosses', 'only');

      // Left on the mouse, which is the honest answer to "there is nothing
      // here you said you wanted this spent on".
      expect(pointed(h)).toBeUndefined();

      h.enemies.push(enemyOf(2, 7, BOSS_TYPE));
      expect(pointed(h)).toEqual({ x: 7, y: 0 });
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
      expect(h.casts).toEqual([{ x: 0, y: 0 }]);
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

      expect(pointed(h)).toEqual({ x: 7, y: 0 });
    });

    it('points nowhere new while nobody knows where the cursor is', () => {
      // A module that was killed, unloaded or has not started measuring yet
      // says nothing, and the player's own aim is the right answer to that.
      const h = harness();
      room(h);
      h.settings.apply('priority', 'closestToCursor');

      expect(pointed(h)).toBeUndefined();
    });

    it('keeps the cursor asked for on every tick, whether or not it has a reason to cast', () => {
      // Asking is the claim, and the module measures nothing without one — so
      // a huntress holding a trap, whose ability is never cast from here, keeps
      // the reading alive tick by tick for the moment they press the key.
      const h = harness();
      h.slot.objectType = TRAP_TYPE;
      h.settings.apply('priority', 'closestToCursor');

      h.tick(0);
      const first = h.cursorAsks();
      expect(first).toBeGreaterThan(0);
      h.tick(500);
      expect(h.cursorAsks()).toBeGreaterThan(first);
    });

    it('leaves the cursor alone under every other priority', () => {
      // Three calls a frame into the game's camera, for an answer nothing on
      // this path reads.
      const h = harness();
      room(h);
      for (let at = 0; at <= 3000; at += 500) h.tick(at);
      h.press();
      expect(h.cursorAsks()).toBe(0);
    });
  });

  describe('auto-casting attack abilities at bosses', () => {
    /** A boss wherever the test wants it, by the marker that makes it one. */
    const bossOf = (objectId: number, x: number, conditions = 0): EntityView =>
      enemyOf(objectId, x, BOSS_TYPE, conditions);

    /** A harness holding a trap and the boss switch on, unless said otherwise. */
    function armed(enemies: readonly EntityView[], switchOn = true): Harness {
      const h = harness();
      h.slot.objectType = TRAP_TYPE;
      if (switchOn) h.settings.apply('autoCastAttacks', true);
      h.enemies.push(...enemies);
      return h;
    }

    it('leaves the attack to the key press until the switch is on', () => {
      const h = armed([bossOf(1, 7)], false);
      for (let at = 0; at <= 5000; at += 500) h.tick(at);
      expect(h.casts).toHaveLength(0);
    });

    it('fires the attack ability at the boss, and paces itself', () => {
      const h = armed([bossOf(1, 7)]);

      h.tick(0);
      expect(h.casts).toEqual([{ x: 7, y: 0 }]);

      // Inside the interval floor: one boss, one cast.
      h.tick(300);
      expect(h.casts).toHaveLength(1);
      h.tick(700);
      expect(h.casts).toHaveLength(2);
    });

    it('fires at nothing but a boss, however long the minions stand there', () => {
      const h = armed([enemyOf(1, 2)]);
      for (let at = 0; at <= 5000; at += 500) h.tick(at);
      expect(h.casts).toHaveLength(0);
    });

    it('takes the boss over the minion standing closer', () => {
      const h = armed([enemyOf(1, 2), bossOf(2, 7)]);
      h.tick(0);
      expect(h.casts).toEqual([{ x: 7, y: 0 }]);
    });

    it('fires at the boss while the player’s own presses go to the minion in front of it', () => {
      // Two questions with two answers in the same tick. The module keeps them
      // apart: its own press goes where it was sent, whatever the player's are
      // pointed at.
      const h = armed([enemyOf(1, 2), bossOf(2, 7)]);
      h.tick(0);
      expect(h.casts).toEqual([{ x: 7, y: 0 }]);
      expect(h.aims).toEqual([{ x: 2, y: 0, holdMs: 400 }]);
    });

    it('holds its fire while the boss cannot be hurt', () => {
      const h = armed([bossOf(1, 5, INVULNERABLE)]);
      h.tick(0);
      expect(h.casts).toHaveLength(0);

      h.enemies.length = 0;
      h.enemies.push(bossOf(2, 6));
      h.tick(1000);
      expect(h.casts).toHaveLength(1);
    });

    it('picks between two bosses by the same aim setting', () => {
      const h = armed([bossOf(1, 7), bossOf(2, 3)]);
      h.tick(0);
      expect(h.casts).toEqual([{ x: 3, y: 0 }]);
    });

    it('ignores the boss rule the aiming half reads', () => {
      // "Treat bosses like any other enemy" is about what to point at; the
      // switch says attack abilities fire at bosses, and that is not loosened
      // by a preference over minions.
      const h = armed([bossOf(1, 7)]);
      h.settings.apply('bosses', 'any');
      h.tick(0);
      expect(h.casts).toHaveLength(1);
    });

    it('will not fire into the mana reserve', () => {
      const h = armed([bossOf(1, 7)]);
      h.settings.apply('mpReservePercent', 50);
      h.self.maxMp = 200;

      // The 90 a trap costs, and then the 100 the player asked to hold.
      h.self.mp = 150;
      h.tick(0);
      expect(h.casts).toHaveLength(0);

      h.self.mp = 190;
      h.tick(1000);
      expect(h.casts).toHaveLength(1);
    });

    it('backs off after the player fires it by hand', () => {
      const h = armed([bossOf(1, 5)]);

      h.world.gameTimeMs = 0;
      h.press();
      h.tick(1500);
      expect(h.casts).toHaveLength(0);
      h.tick(2000);
      expect(h.casts).toHaveLength(1);
    });

    it('fires a quiver at a boss as well: the client sends the arrows behind its own use', () => {
      const h = armed([bossOf(1, 7)]);
      h.slot.objectType = QUIVER_TYPE;
      h.tick(0);
      expect(h.casts).toEqual([{ x: 7, y: 0 }]);
    });

    it('never fires a hybrid tome for the hit riding on it', () => {
      // The tome heals, so it belongs to the support half, and a boss walking
      // past a priest at full health is not a reason to spend its mana.
      for (const tome of [HYBRID_TOME_TYPE, NOVA_TOME_TYPE]) {
        const h = armed([bossOf(1, 4)]);
        h.slot.objectType = tome;
        for (let at = 0; at <= 5000; at += 500) h.tick(at);
        expect(h.casts).toHaveLength(0);
      }
    });

    it('points nothing when the aim switch is off, and still fires at the boss', () => {
      // Two switches, two questions: where the player's own press lands, and
      // whether the plugin ever presses the key itself.
      const h = armed([bossOf(1, 5)]);
      h.settings.apply('aimAttacks', false);

      h.tick(0);
      expect(h.aims).toHaveLength(0);
      expect(h.casts).toEqual([{ x: 5, y: 0 }]);
    });
  });
});
