import {
  MutablePacket,
  Verdict,
  type EntityView,
  type InventoryView,
  type ItemSlotView,
  type NativeApi,
  type SessionApi,
  type SessionView,
} from '@brownie/plugin-api';
import { createPacket, decodeFrame, encodePacket } from '@brownie/protocol';
import { createBundledRegistry } from '@brownie/protocol/bundled';
import { describe, expect, it, vi } from 'vitest';

import { StatType } from '../src/constants/StatType.js';
import { createAutoLootPlugin } from '../src/features/autoloot/autoLootPlugin.js';
import { enlargeBags } from '../src/features/autoloot/bigBags.js';
import { BIG_BAG_SIZE, PENDING_TIMEOUT_MS } from '../src/features/autoloot/constants.js';
import { findBeltDestination, findFreeSlot } from '../src/features/autoloot/destination.js';
import { enchantCount, UNIQUE_DATA_STAT } from '../src/features/autoloot/enchants.js';
import { Claims, LootSession } from '../src/features/autoloot/LootSession.js';
import {
  gearCategoryOf,
  parseItemList,
  shouldLoot,
  GearCategory,
  type LootPreferences,
} from '../src/features/autoloot/lootRules.js';
import { shouldWithhold, touchesPotions } from '../src/features/autoloot/manualGuard.js';
import { PotionKind, type ContainerFacts, type ItemFacts } from '../src/gamedata/items.js';
import { isBeltSlot, SlotRange } from '../src/state/ItemSlots.js';
import { PluginHost } from '../src/plugins/PluginHost.js';
import { testLogger } from './fakes.js';

const registry = createBundledRegistry();

const T13_BOW = 3010;
const T6_BOW = 3003;
const UT_BOW = 8961;
const ST_ROBE = 9001;
const HEALTH_POTION = 2594;
const ATTACK_POTION = 2593;
const LIFE_POTION = 2793;
const PET_EGG = 3205;
const MARK = 7718;
const DYE = 4000;

const LOOT_BAG = 1280;
const SOULBOUND_BAG = 1283;

function facts(over: Partial<ItemFacts> = {}): ItemFacts {
  return {
    slotType: 3,
    tier: undefined,
    untiered: false,
    setItem: false,
    beltStack: 0,
    potion: undefined,
    ability: undefined,
    ...over,
  };
}

const ITEMS: ReadonlyMap<number, ItemFacts> = new Map([
  [T13_BOW, facts({ slotType: 3, tier: 13 })],
  [T6_BOW, facts({ slotType: 3, tier: 6 })],
  [UT_BOW, facts({ slotType: 3, untiered: true })],
  [ST_ROBE, facts({ slotType: 14, setItem: true })],
  [
    HEALTH_POTION,
    facts({ slotType: 10, beltStack: 6, potion: { kind: PotionKind.Heal, raises: undefined } }),
  ],
  [
    ATTACK_POTION,
    facts({ slotType: 10, potion: { kind: PotionKind.Permanent, raises: 'attack' } }),
  ],
  [
    LIFE_POTION,
    facts({ slotType: 10, potion: { kind: PotionKind.LifeOrMana, raises: undefined } }),
  ],
  [PET_EGG, facts({ slotType: 26 })],
  [MARK, facts({ slotType: 10 })],
  // A dye: untiered by the labels' account, and in the consumable slot.
  [DYE, facts({ slotType: 10, untiered: true })],
]);

const NAMES: ReadonlyMap<number, string> = new Map([
  [T13_BOW, 'Bow of Covert Havens'],
  [MARK, 'Mark of Septavius'],
  [LOOT_BAG, 'Loot Bag 0'],
]);

const CONTAINERS: ReadonlyMap<number, ContainerFacts> = new Map([
  [LOOT_BAG, { slots: 8, shared: true }],
  [SOULBOUND_BAG, { slots: 8, shared: false }],
]);

const INPUTS = {
  item: (objectType: number): ItemFacts | undefined => ITEMS.get(objectType),
  container: (objectType: number): ContainerFacts | undefined => CONTAINERS.get(objectType),
  statMaxima: (): undefined => undefined,
  displayName: (objectType: number): string | undefined => NAMES.get(objectType),
};

const DEFAULTS: LootPreferences = {
  minWeaponTier: 11,
  minAbilityTier: 6,
  minArmorTier: 11,
  minRingTier: 6,
  untiered: true,
  setItems: false,
  healthPotions: false,
  magicPotions: false,
  statPotions: true,
  lifeManaPotions: true,
  eggs: false,
  marks: false,
  minEnchants: 0,
  always: new Set<number>(),
  never: new Set<number>(),
};

function wants(objectType: number, over: Partial<LootPreferences> = {}, enchants = 0): boolean {
  return shouldLoot(
    {
      objectType,
      facts: ITEMS.get(objectType),
      name: NAMES.get(objectType) ?? '',
      enchants,
    },
    { ...DEFAULTS, ...over },
  );
}

describe('what auto-loot decides to take', () => {
  it('files each gear slot under the bucket its threshold applies to', () => {
    expect(gearCategoryOf(3)).toBe(GearCategory.Weapon);
    expect(gearCategoryOf(11)).toBe(GearCategory.Ability);
    expect(gearCategoryOf(14)).toBe(GearCategory.Armor);
    expect(gearCategoryOf(9)).toBe(GearCategory.Ring);
    // Potions and eggs are not gear and have their own rules.
    expect(gearCategoryOf(10)).toBeUndefined();
    expect(gearCategoryOf(26)).toBeUndefined();
  });

  it('takes gear at or above its bucket threshold and nothing below it', () => {
    expect(wants(T13_BOW)).toBe(true);
    expect(wants(T6_BOW)).toBe(false);
    expect(wants(T6_BOW, { minWeaponTier: 6 })).toBe(true);
  });

  it('obeys the untiered and set toggles separately', () => {
    expect(wants(UT_BOW)).toBe(true);
    expect(wants(UT_BOW, { untiered: false })).toBe(false);
    expect(wants(ST_ROBE)).toBe(false);
    expect(wants(ST_ROBE, { setItems: true })).toBe(true);
  });

  it('does not let "untiered" mean every dye in the game', () => {
    // The reference implementation treated anything without a tier as untiered
    // and filled backpacks with clothing dye.
    expect(wants(DYE)).toBe(false);
  });

  it('reads each potion against its own toggle', () => {
    expect(wants(HEALTH_POTION)).toBe(false);
    expect(wants(HEALTH_POTION, { healthPotions: true })).toBe(true);
    expect(wants(ATTACK_POTION)).toBe(true);
    expect(wants(ATTACK_POTION, { statPotions: false })).toBe(false);
    expect(wants(LIFE_POTION)).toBe(true);
    expect(wants(LIFE_POTION, { lifeManaPotions: false })).toBe(false);
  });

  it('keeps eggs and marks behind their own switches', () => {
    expect(wants(PET_EGG)).toBe(false);
    expect(wants(PET_EGG, { eggs: true })).toBe(true);
    expect(wants(MARK)).toBe(false);
    expect(wants(MARK, { marks: true })).toBe(true);
  });

  it('lets the never list beat everything and the always list beat the rules', () => {
    expect(wants(T13_BOW, { never: new Set([T13_BOW]) })).toBe(false);
    expect(wants(T6_BOW, { always: new Set([T6_BOW]) })).toBe(true);
    // Never wins over always, so one list can always take something back.
    expect(wants(T6_BOW, { always: new Set([T6_BOW]), never: new Set([T6_BOW]) })).toBe(false);
  });

  it('holds gear to the enchant threshold and potions to none', () => {
    expect(wants(T13_BOW, { minEnchants: 2 }, 1)).toBe(false);
    expect(wants(T13_BOW, { minEnchants: 2 }, 2)).toBe(true);
    // A potion cannot carry an enchant, so a threshold must not hide it.
    expect(wants(ATTACK_POTION, { minEnchants: 4 }, 0)).toBe(true);
    // And the always list is not held to it either.
    expect(wants(T6_BOW, { minEnchants: 4, always: new Set([T6_BOW]) }, 0)).toBe(true);
  });

  it('leaves an item the catalog does not describe alone', () => {
    expect(shouldLoot({ objectType: 999, facts: undefined, name: '', enchants: 0 }, DEFAULTS)).toBe(
      false,
    );
    expect(shouldLoot({ objectType: 0, facts: undefined, name: '', enchants: 0 }, DEFAULTS)).toBe(
      false,
    );
  });
});

describe('reading an always/never list', () => {
  it('accepts decimal and hex, separated by anything', () => {
    expect([...parseItemList('2594, 0xa23\n3010')]).toEqual([2594, 2595, 3010]);
  });

  it('ignores what is not an id', () => {
    expect([...parseItemList('  ,, -1, 0, ')]).toEqual([1]);
    expect([...parseItemList('')]).toEqual([]);
  });
});

describe('counting a bag slot"s enchants', () => {
  /** One slot's blob: three header bytes, ids, terminator. */
  function blob(...ids: number[]): string {
    const bytes = Buffer.alloc(3 + ids.length * 2 + 2);
    ids.forEach((id, index) => {
      bytes.writeUInt16LE(id, 3 + index * 2);
    });
    bytes.writeUInt16LE(0xfffd, 3 + ids.length * 2);
    return bytes.toString('base64');
  }

  it('counts the ids in the slot it was asked about', () => {
    const stat = [blob(11, 22), blob(), blob(7)].join(',');
    expect(enchantCount(stat, 0)).toBe(2);
    expect(enchantCount(stat, 1)).toBe(0);
    expect(enchantCount(stat, 2)).toBe(1);
  });

  it('does not count the empty-position marker', () => {
    expect(enchantCount(blob(11, 0xfffe, 22), 0)).toBe(2);
  });

  it('reads a stat that is missing or unparseable as no enchants', () => {
    expect(enchantCount(undefined, 0)).toBe(0);
    expect(enchantCount('', 0)).toBe(0);
    expect(enchantCount('not base64 at all!!', 0)).toBe(0);
    expect(enchantCount(blob(1), 5)).toBe(0);
    expect(enchantCount(blob(1), -1)).toBe(0);
  });
});

describe('choosing where a looted item goes', () => {
  const nothingClaimed = (): boolean => false;

  function inventoryOf(options: {
    carried?: ItemSlotView[];
    backpack?: ItemSlotView[];
    belt?: ItemSlotView[];
  }): InventoryView {
    const carried = options.carried ?? [];
    const backpack = options.backpack ?? [];
    const belt = options.belt ?? [];
    const all = [...carried, ...backpack, ...belt];
    return {
      carried: () => carried,
      backpack: () => backpack,
      belt: () => belt,
      at: (slotId) => all.find((entry) => entry.slotId === slotId),
    };
  }

  const beltSlot = (index: number, objectType: number, quantity: number): ItemSlotView => ({
    slotId: SlotRange.BeltFirst + index,
    objectType,
    quantity,
  });

  it('stacks a potion onto a belt slot that has room', () => {
    const inventory = inventoryOf({ belt: [beltSlot(0, HEALTH_POTION, 3)] });
    expect(findBeltDestination(inventory, HEALTH_POTION, 6, nothingClaimed)).toEqual({
      slotId: SlotRange.BeltFirst,
      objectType: HEALTH_POTION,
      expectedQuantity: 4,
    });
  });

  it('refuses to start a second stack when the first is full', () => {
    const inventory = inventoryOf({
      belt: [beltSlot(0, HEALTH_POTION, 6), beltSlot(1, -1, 0)],
    });
    expect(findBeltDestination(inventory, HEALTH_POTION, 6, nothingClaimed)).toBeUndefined();
  });

  it('takes an empty belt slot when there is no stack yet', () => {
    const inventory = inventoryOf({ belt: [beltSlot(0, -1, 0)] });
    expect(findBeltDestination(inventory, HEALTH_POTION, 6, nothingClaimed)).toEqual({
      slotId: SlotRange.BeltFirst,
      objectType: -1,
      expectedQuantity: 1,
    });
  });

  it('does not use the belt for an item the belt refuses', () => {
    const inventory = inventoryOf({ belt: [beltSlot(0, -1, 0)] });
    expect(findBeltDestination(inventory, T13_BOW, 0, nothingClaimed)).toBeUndefined();
  });

  it('takes the first free carried slot, in slot order', () => {
    const inventory = inventoryOf({
      carried: [
        { slotId: 4, objectType: T13_BOW, quantity: 0 },
        { slotId: 5, objectType: -1, quantity: 0 },
        { slotId: 6, objectType: -1, quantity: 0 },
      ],
    });
    expect(findFreeSlot(inventory, true, false, nothingClaimed)).toEqual({
      slotId: 5,
      objectType: -1,
      expectedQuantity: undefined,
    });
  });

  it('skips a slot already claimed by a move still settling', () => {
    const inventory = inventoryOf({
      carried: [
        { slotId: 4, objectType: -1, quantity: 0 },
        { slotId: 5, objectType: -1, quantity: 0 },
      ],
    });
    expect(findFreeSlot(inventory, true, false, (slotId) => slotId === 4)?.slotId).toBe(5);
  });

  it('uses the backpack only when allowed, and first when asked', () => {
    const inventory = inventoryOf({
      carried: [{ slotId: 4, objectType: -1, quantity: 0 }],
      backpack: [{ slotId: 12, objectType: -1, quantity: 0 }],
    });
    expect(findFreeSlot(inventory, false, false, nothingClaimed)?.slotId).toBe(4);
    expect(findFreeSlot(inventory, true, true, nothingClaimed)?.slotId).toBe(12);
  });

  it('has nowhere to put anything when the server has stated no slots', () => {
    expect(findFreeSlot(inventoryOf({}), true, false, nothingClaimed)).toBeUndefined();
  });
});

describe('what one connection remembers', () => {
  function inventoryWith(slot: ItemSlotView | undefined): InventoryView {
    return {
      carried: () => (slot === undefined ? [] : [slot]),
      backpack: () => [],
      belt: () => [],
      at: (slotId) => (slot?.slotId === slotId ? slot : undefined),
    };
  }

  it('holds a claim until its deadline and not past it', () => {
    const claims = new Claims<string>();
    claims.hold('a', 100);
    expect(claims.held('a', 99)).toBe(true);
    expect(claims.held('a', 100)).toBe(false);
    claims.expire(100);
    expect(claims.size).toBe(0);
  });

  it('keeps the later of two deadlines for the same key', () => {
    const claims = new Claims<string>();
    claims.hold('a', 100);
    claims.hold('a', 50);
    expect(claims.held('a', 80)).toBe(true);
  });

  it('clears a pending move once its destination fills', () => {
    const state = new LootSession();
    state.startPending({ slotId: 4, expectedQuantity: undefined, sinceMs: 0, potion: false });

    state.resolvePending(inventoryWith({ slotId: 4, objectType: -1, quantity: 0 }), 10);
    expect(state.pending).toBeDefined();

    state.resolvePending(inventoryWith({ slotId: 4, objectType: T13_BOW, quantity: 0 }), 20);
    expect(state.pending).toBeUndefined();
  });

  it('waits for a belt slot to reach the count it should', () => {
    const state = new LootSession();
    const beltId = SlotRange.BeltFirst;
    state.startPending({ slotId: beltId, expectedQuantity: 4, sinceMs: 0, potion: true });

    const belt = (quantity: number): InventoryView => ({
      carried: () => [],
      backpack: () => [],
      belt: () => [{ slotId: beltId, objectType: HEALTH_POTION, quantity }],
      at: (slotId) =>
        slotId === beltId ? { slotId: beltId, objectType: HEALTH_POTION, quantity } : undefined,
    });

    state.resolvePending(belt(3), 10);
    expect(state.pending).toBeDefined();
    state.resolvePending(belt(4), 20);
    expect(state.pending).toBeUndefined();
  });

  it('gives up on a move to a slot nothing ever reports', () => {
    const state = new LootSession();
    state.startPending({ slotId: 12, expectedQuantity: undefined, sinceMs: 0, potion: false });
    state.resolvePending(inventoryWith(undefined), PENDING_TIMEOUT_MS - 1);
    expect(state.pending).toBeDefined();
    state.resolvePending(inventoryWith(undefined), PENDING_TIMEOUT_MS);
    expect(state.pending).toBeUndefined();
  });

  it('counts ticks spent standing still, and forgets them on any real movement', () => {
    const state = new LootSession();
    state.trackMovement(10, 10);
    state.trackMovement(10, 10);
    state.trackMovement(10.01, 10); // inside the epsilon: still standing still
    expect(state.stationaryTicks).toBe(2);
    state.trackMovement(11, 10);
    expect(state.stationaryTicks).toBe(0);
  });
});

describe('getting out of the player"s way', () => {
  const isPotion = (objectType: number): boolean => ITEMS.get(objectType)?.potion !== undefined;

  it('notices a packet naming a potion or a belt slot, and no others', () => {
    expect(touchesPotions(useItem(4, HEALTH_POTION), isPotion, isBeltSlot)).toBe(true);
    expect(touchesPotions(useItem(SlotRange.BeltFirst, T13_BOW), isPotion, isBeltSlot)).toBe(true);
    expect(touchesPotions(useItem(4, T13_BOW), isPotion, isBeltSlot)).toBe(false);
  });

  it('withholds a move that would collide with one of ours, and never a quaff', () => {
    expect(shouldWithhold('INVENTORYSWAP', true, false)).toBe(true);
    expect(shouldWithhold('INVDROP', false, true)).toBe(true);
    expect(shouldWithhold('INVENTORYSWAP', false, false)).toBe(false);
    // A manual quaff is never swallowed — that is a way to die for a tidy
    // inventory, and the reference implementation swallowed it.
    expect(shouldWithhold('USEITEM', true, true)).toBe(false);
  });
});

describe('drawing loot bags larger', () => {
  const isContainer = (objectType: number): boolean => CONTAINERS.has(objectType);

  function update(objectType: number, stats: { id: number; value: number; stackCount: number }[]) {
    return packetOf('UPDATE', {
      position: { x: 0, y: 0 },
      levelType: 0,
      tiles: [],
      newObjs: [
        {
          objectType,
          status: { objectId: 50, position: { x: 1, y: 1 }, data: stats },
        },
      ],
      drops: [],
    });
  }

  it('injects a size for a bag the server did not send one for', () => {
    const packet = update(LOOT_BAG, []);
    expect(enlargeBags(packet, isContainer)).toBe(true);
    expect(packet.modified).toBe(true);
    const stats = statsOfFirstObject(packet);
    expect(stats).toContainEqual({ id: StatType.Size, value: BIG_BAG_SIZE, stackCount: 0 });
  });

  it('rewrites a size the server did send', () => {
    const packet = update(LOOT_BAG, [{ id: StatType.Size, value: 80, stackCount: 0 }]);
    expect(enlargeBags(packet, isContainer)).toBe(true);
    expect(statsOfFirstObject(packet)?.[0]).toMatchObject({ value: BIG_BAG_SIZE });
  });

  it('leaves anything that is not a bag alone', () => {
    const packet = update(999, []);
    expect(enlargeBags(packet, isContainer)).toBe(false);
    expect(packet.modified).toBe(false);
  });
});

describe('the auto-loot plugin', () => {
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

  /** A container in the world, holding one item per slot given. */
  function bag(
    objectId: number,
    objectType: number,
    contents: readonly number[],
    at: { x: number; y: number },
    uniqueData?: string,
  ): EntityView {
    const stats = new Map<number, number>();
    contents.forEach((objectTypeInSlot, slot) => {
      stats.set(StatType.Inventory0 + slot, objectTypeInSlot);
    });
    return {
      objectId,
      objectType,
      name: '',
      hp: 0,
      maxHp: 0,
      isEnemy: false,
      isPlayer: false,
      conditions: 0,
      guildName: '',
      stat: (id) => stats.get(id),
      text: (id) => (id === UNIQUE_DATA_STAT ? uniqueData : undefined),
      x: at.x,
      y: at.y,
    };
  }

  interface Harness {
    host: PluginHost;
    session: SessionView;
    world: { gameTimeMs: number; mapName: string };
    self: { x: number; y: number; inventory: InventoryView };
    bags: Map<number, EntityView>;
    sent: ReturnType<typeof vi.fn>;
    notified: string[];
    settings: NonNullable<ReturnType<PluginHost['settingsOf']>>;
  }

  function harness(options: { carried?: ItemSlotView[]; map?: string } = {}): Harness {
    const carried = options.carried ?? [
      { slotId: 4, objectType: -1, quantity: 0 },
      { slotId: 5, objectType: -1, quantity: 0 },
    ];
    const inventory: InventoryView = {
      carried: () => carried,
      backpack: () => [],
      belt: () => [],
      at: (slotId) => carried.find((entry) => entry.slotId === slotId),
    };

    const bags = new Map<number, EntityView>();
    const world = {
      gameTimeMs: 50_000,
      mapName: options.map ?? 'Dungeon',
      entities: () => bags.values(),
      entity: (objectId: number) => bags.get(objectId),
    };
    const self = {
      objectId: 7,
      objectType: 0x30e,
      hp: 100,
      maxHp: 100,
      mp: 0,
      maxMp: 0,
      conditions: 0,
      alive: true,
      x: 10,
      y: 10,
      permanentStats: {
        attack: 0,
        defense: 0,
        speed: 0,
        dexterity: 0,
        vitality: 0,
        wisdom: 0,
      },
      inventory,
    };
    const notified: string[] = [];
    const sent = vi.fn();
    const session = {
      id: 's1',
      self,
      world,
      sendToServer: sent,
      notify: (text: string) => notified.push(text),
    } as unknown as SessionView;

    const host = new PluginHost({
      log: testLogger(),
      native: NATIVE,
      sessions: SESSIONS,
      onChanged: () => undefined,
    });
    host.load(createAutoLootPlugin(INPUTS));
    host.setEnabled('auto-loot', true);
    const settings = host.settingsOf('auto-loot');
    if (settings === undefined) throw new Error('the plugin declared no settings');

    return { host, session, world, self, bags, sent, notified, settings };
  }

  const newtick = (): MutablePacket =>
    packetOf('NEWTICK', {
      tickId: 0,
      tickTime: 200,
      serverRealTimeMs: 0,
      serverLastRttMs: 0,
      statuses: [],
    });

  const tick = (h: Harness): void => {
    h.host.dispatchPacket(newtick(), h.session);
  };

  /** Steps the clock past every wait so the next tick is free to act. */
  const advance = (h: Harness, ms = 2000): void => {
    h.world.gameTimeMs += ms;
  };

  it('takes a wanted item out of the bag it is standing on', () => {
    const h = harness();
    h.bags.set(1, bag(1, SOULBOUND_BAG, [T13_BOW], { x: 10, y: 10 }));
    tick(h);

    expect(h.sent).toHaveBeenCalledWith('INVENTORYSWAP', {
      time: 50_000,
      position: { x: 10, y: 10 },
      slotObject1: { objectId: 1, slotId: 0, objectType: T13_BOW },
      slotObject2: { objectId: 7, slotId: 4, objectType: -1 },
      tickId: 0,
    });
  });

  it('leaves an item below the threshold where it is', () => {
    const h = harness();
    h.bags.set(1, bag(1, SOULBOUND_BAG, [T6_BOW], { x: 10, y: 10 }));
    tick(h);
    expect(h.sent).not.toHaveBeenCalled();
  });

  it('does not reach for a bag it is not standing on', () => {
    const h = harness();
    h.bags.set(1, bag(1, SOULBOUND_BAG, [T13_BOW], { x: 14, y: 10 }));
    tick(h);
    expect(h.sent).not.toHaveBeenCalled();
  });

  it('sends one move at a time and waits for it to land', () => {
    const h = harness();
    h.bags.set(1, bag(1, SOULBOUND_BAG, [T13_BOW, T13_BOW], { x: 10, y: 10 }));

    tick(h);
    expect(h.sent).toHaveBeenCalledTimes(1);

    // Still pending, and the destination has not filled.
    advance(h, 500);
    tick(h);
    expect(h.sent).toHaveBeenCalledTimes(1);

    // Past the timeout, the move is assumed lost and the next one goes.
    advance(h, PENDING_TIMEOUT_MS);
    tick(h);
    expect(h.sent).toHaveBeenCalledTimes(2);
  });

  it('gives everybody else a moment on a shared bag', () => {
    const h = harness();
    h.bags.set(1, bag(1, LOOT_BAG, [T13_BOW], { x: 10, y: 10 }));

    tick(h);
    expect(h.sent).not.toHaveBeenCalled();

    advance(h, 2000);
    tick(h);
    expect(h.sent).toHaveBeenCalledTimes(1);
  });

  it('never loots in a safe zone', () => {
    const h = harness({ map: 'Vault' });
    h.bags.set(1, bag(1, SOULBOUND_BAG, [T13_BOW], { x: 10, y: 10 }));
    tick(h);
    expect(h.sent).not.toHaveBeenCalled();
  });

  it('stops when the inventory has nowhere left to put anything', () => {
    const h = harness({ carried: [{ slotId: 4, objectType: T6_BOW, quantity: 0 }] });
    h.bags.set(1, bag(1, SOULBOUND_BAG, [T13_BOW], { x: 10, y: 10 }));
    tick(h);
    expect(h.sent).not.toHaveBeenCalled();
  });

  it('holds the enchant threshold against what the bag says', () => {
    const bytes = Buffer.alloc(5);
    bytes.writeUInt16LE(0xfffd, 3);
    const noEnchants = bytes.toString('base64');

    const h = harness();
    h.settings.apply('minEnchants', 'rare');
    h.bags.set(1, bag(1, SOULBOUND_BAG, [T13_BOW], { x: 10, y: 10 }, noEnchants));
    tick(h);
    expect(h.sent).not.toHaveBeenCalled();
  });

  it('announces a bag once when asked to', () => {
    const h = harness();
    h.settings.apply('announceBags', true);
    h.bags.set(1, bag(1, LOOT_BAG, [T13_BOW], { x: 12, y: 10 }));

    tick(h);
    tick(h);
    expect(h.notified).toHaveLength(1);
    expect(h.notified[0]).toContain('Bow of Covert Havens');
  });

  it('stands down and withholds a move while one of its own potions settles', () => {
    const h = harness();
    h.settings.apply('healthPotions', true);
    h.bags.set(1, bag(1, SOULBOUND_BAG, [HEALTH_POTION], { x: 10, y: 10 }));
    tick(h);
    expect(h.sent).toHaveBeenCalledTimes(1);

    const manual = inventorySwap(SlotRange.BeltFirst, HEALTH_POTION);
    h.host.dispatchPacket(manual, h.session);
    expect(manual.verdict).toBe(Verdict.Drop);

    // And it stops looting for a while afterwards.
    advance(h, PENDING_TIMEOUT_MS);
    tick(h);
    expect(h.sent).toHaveBeenCalledTimes(1);
  });

  it('lets a manual quaff through and only stands down', () => {
    const h = harness();
    h.bags.set(1, bag(1, SOULBOUND_BAG, [T13_BOW], { x: 10, y: 10 }));

    const quaff = useItem(SlotRange.BeltFirst, HEALTH_POTION);
    h.host.dispatchPacket(quaff, h.session);
    expect(quaff.verdict).toBe(Verdict.Forward);

    tick(h);
    expect(h.sent).not.toHaveBeenCalled();
  });

  it('forgets everything it knew about a map when it leaves one', () => {
    const h = harness();
    h.settings.apply('announceBags', true);
    h.bags.set(1, bag(1, LOOT_BAG, [T13_BOW], { x: 12, y: 10 }));
    tick(h);
    expect(h.notified).toHaveLength(1);

    h.host.dispatchPacket(mapinfo(), h.session);
    tick(h);
    // The same object id in a new map is a different object.
    expect(h.notified).toHaveLength(2);
  });

  it('does nothing at all while switched off', () => {
    const h = harness();
    h.host.setEnabled('auto-loot', false);
    h.bags.set(1, bag(1, SOULBOUND_BAG, [T13_BOW], { x: 10, y: 10 }));
    tick(h);
    expect(h.sent).not.toHaveBeenCalled();
  });
});

// ── Packet builders ──────────────────────────────────────────────────────────

function packetOf(name: string, fields: Record<string, unknown>): MutablePacket {
  const packet = createPacket(registry, name);
  for (const [key, value] of Object.entries(fields)) {
    packet.fields[key] = value as never;
  }
  return new MutablePacket(decodeFrame(registry, encodePacket(registry, packet)));
}

function useItem(slotId: number, objectType: number): MutablePacket {
  return packetOf('USEITEM', {
    time: 0,
    slotObject: { objectId: 7, slotId, objectType },
    itemUsePos: { x: 0, y: 0 },
    useType: 1,
    unknownInt: 0,
  });
}

function inventorySwap(slotId: number, objectType: number): MutablePacket {
  return packetOf('INVENTORYSWAP', {
    time: 0,
    position: { x: 0, y: 0 },
    slotObject1: { objectId: 7, slotId, objectType },
    slotObject2: { objectId: 7, slotId: 4, objectType: -1 },
    tickId: 0,
  });
}

function mapinfo(): MutablePacket {
  return packetOf('MAPINFO', {
    width: 10,
    height: 10,
    name: 'Dungeon',
    displayName: 'Dungeon',
    realmName: '',
    fp: 0,
    background: 0,
    difficulty: 0,
    allowPlayerTeleport: false,
    noSave: false,
    showDisplays: false,
    maxPlayers: 10,
    gameOpenedTime: 0,
    serverVersion: '',
    viewDistance: 15,
  });
}

function statsOfFirstObject(
  packet: MutablePacket,
): { id: number; value: number; stackCount: number }[] | undefined {
  const newObjs = packet.get('newObjs');
  if (!Array.isArray(newObjs)) return undefined;
  const entity = newObjs[0] as { status?: { data?: unknown } } | undefined;
  const data = entity?.status?.data;
  return Array.isArray(data)
    ? (data as { id: number; value: number; stackCount: number }[])
    : undefined;
}
