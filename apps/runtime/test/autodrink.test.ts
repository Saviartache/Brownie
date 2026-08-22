import {
  MutablePacket,
  type InventoryView,
  type ItemSlotView,
  type NativeApi,
  type SessionApi,
  type SessionView,
} from '@brownie/plugin-api';
import { createPacket, decodeFrame, encodePacket } from '@brownie/protocol';
import { createBundledRegistry } from '@brownie/protocol/bundled';
import { describe, expect, it, vi } from 'vitest';

import { ConditionEffect, conditionBitLow } from '../src/constants/ConditionEffect.js';
import { createAutoDrinkPlugin } from '../src/features/autodrink/autoDrinkPlugin.js';
import { findPotion } from '../src/features/autodrink/findPotion.js';
import { Quaff, quaffKindOf } from '../src/features/autodrink/potions.js';
import { PotionKind, type ItemFacts } from '../src/gamedata/items.js';
import { SlotRange } from '../src/state/ItemSlots.js';
import { PluginHost } from '../src/plugins/PluginHost.js';
import { testLogger } from './fakes.js';

const registry = createBundledRegistry();

const HEALTH_POTION = 2594;
const MAGIC_POTION = 2595;
const GREATER_HEALTH = 2795;
/** Something in a slot that is not a potion at all. */
const A_BOW = 3010;

function facts(over: Partial<ItemFacts> = {}): ItemFacts {
  return {
    slotType: 10,
    tier: undefined,
    untiered: false,
    setItem: false,
    beltStack: 6,
    potion: undefined,
    ability: undefined,
    ...over,
  };
}

/** A catalog that knows the two potions and the bow, and nothing else. */
const CATALOG: ReadonlyMap<number, ItemFacts> = new Map([
  [HEALTH_POTION, facts({ potion: { kind: PotionKind.Heal, raises: undefined } })],
  [MAGIC_POTION, facts({ potion: { kind: PotionKind.Magic, raises: undefined } })],
  [A_BOW, facts({ slotType: 3, tier: 13, beltStack: 0 })],
]);

const item = (objectType: number): ItemFacts | undefined => CATALOG.get(objectType);
const kindOf = (objectType: number): Quaff | undefined => quaffKindOf(objectType, item);

function slot(slotId: number, objectType: number, quantity = 0): ItemSlotView {
  return { slotId, objectType, quantity };
}

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

describe('recognising a potion', () => {
  it('reads what drinking it does out of the catalog', () => {
    expect(kindOf(HEALTH_POTION)).toBe(Quaff.Health);
    expect(kindOf(MAGIC_POTION)).toBe(Quaff.Magic);
  });

  it('is not fooled by an item that is not a potion', () => {
    expect(kindOf(A_BOW)).toBeUndefined();
    expect(kindOf(-1)).toBeUndefined();
  });

  it('falls back to the well-known ids only when nothing is catalogued', () => {
    const nothing = (): undefined => undefined;
    expect(quaffKindOf(GREATER_HEALTH, nothing)).toBe(Quaff.Health);
    expect(quaffKindOf(A_BOW, nothing)).toBeUndefined();
  });

  it('believes the catalog over the fallback list', () => {
    // A build that reassigned the id is described by the file, so the file wins
    // — the list exists for the case where there is no file at all.
    const reassigned = (): ItemFacts => facts({ slotType: 3, tier: 13 });
    expect(quaffKindOf(HEALTH_POTION, reassigned)).toBeUndefined();
  });
});

describe('finding a potion to drink', () => {
  const belt = [slot(SlotRange.BeltFirst, HEALTH_POTION, 3)];
  const carried = [slot(4, A_BOW), slot(5, HEALTH_POTION)];

  it('drains the belt first when asked to', () => {
    const found = findPotion(inventoryOf({ carried, belt }), Quaff.Health, kindOf, true);
    expect(found).toEqual({ slotId: SlotRange.BeltFirst, objectType: HEALTH_POTION });
  });

  it('saves the belt for last otherwise', () => {
    const found = findPotion(inventoryOf({ carried, belt }), Quaff.Health, kindOf, false);
    expect(found).toEqual({ slotId: 5, objectType: HEALTH_POTION });
  });

  it('ignores an emptied belt slot that still names its potion', () => {
    const drained = [slot(SlotRange.BeltFirst, HEALTH_POTION, 0)];
    expect(findPotion(inventoryOf({ belt: drained }), Quaff.Health, kindOf, true)).toBeUndefined();
    // The same slot in the carried group has no count and is still a potion.
    expect(
      findPotion(inventoryOf({ carried: [slot(4, HEALTH_POTION)] }), Quaff.Health, kindOf, true),
    ).toEqual({ slotId: 4, objectType: HEALTH_POTION });
  });

  it('falls through to the backpack', () => {
    const inventory = inventoryOf({
      carried: [slot(4, A_BOW)],
      backpack: [slot(12, MAGIC_POTION)],
    });
    expect(findPotion(inventory, Quaff.Magic, kindOf, false)).toEqual({
      slotId: 12,
      objectType: MAGIC_POTION,
    });
  });

  it('finds nothing in an inventory the server has not stated', () => {
    expect(findPotion(inventoryOf({}), Quaff.Health, kindOf, true)).toBeUndefined();
  });

  it('does not drink the wrong kind', () => {
    const inventory = inventoryOf({ carried: [slot(4, MAGIC_POTION)] });
    expect(findPotion(inventory, Quaff.Health, kindOf, true)).toBeUndefined();
  });
});

describe('the auto-drink plugin', () => {
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

  interface Harness {
    host: PluginHost;
    session: SessionView;
    self: { hp: number; mp: number; conditions: number };
    world: { gameTimeMs: number; mapName: string };
    sent: ReturnType<typeof vi.fn>;
  }

  function harness(
    over: Partial<{ hp: number; maxHp: number; mp: number; maxMp: number; map: string }> = {},
  ): Harness {
    const world = { gameTimeMs: 10_000, mapName: over.map ?? 'Dungeon' };
    const self = {
      objectId: 7,
      objectType: 0x30e,
      hp: over.hp ?? 100,
      maxHp: over.maxHp ?? 1000,
      mp: over.mp ?? 1000,
      maxMp: over.maxMp ?? 1000,
      conditions: 0,
      alive: true,
      x: 4.5,
      y: 6.5,
      inventory: inventoryOf({
        carried: [slot(4, HEALTH_POTION), slot(5, MAGIC_POTION)],
      }),
    };
    const sent = vi.fn();
    const session = {
      id: 's1',
      self,
      world,
      sendToServer: sent,
      notify: () => undefined,
    } as unknown as SessionView;

    const host = new PluginHost({
      log: testLogger(),
      native: NATIVE,
      sessions: SESSIONS,
      onChanged: () => undefined,
    });
    host.load(createAutoDrinkPlugin({ item }));
    host.setEnabled('auto-drink', true);
    return { host, session, self, world, sent };
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

  it('drinks when health is at or below the threshold, naming the slot it drank from', () => {
    const h = harness({ hp: 700, maxHp: 1000 }); // exactly 70%
    tick(h);
    expect(h.sent).toHaveBeenCalledWith('USEITEM', {
      time: 10_000,
      slotObject: { objectId: 7, slotId: 4, objectType: HEALTH_POTION },
      itemUsePos: { x: 4.5, y: 6.5 },
      useType: 1,
      unknownInt: 0,
    });
  });

  it('leaves a full bar alone', () => {
    const h = harness({ hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 });
    tick(h);
    expect(h.sent).not.toHaveBeenCalled();
  });

  it('waits out the cooldown before drinking again', () => {
    const h = harness({ hp: 100, maxHp: 1000 });
    tick(h);
    expect(h.sent).toHaveBeenCalledTimes(1);

    h.world.gameTimeMs += 100;
    tick(h);
    expect(h.sent).toHaveBeenCalledTimes(1);

    h.world.gameTimeMs += 300;
    tick(h);
    expect(h.sent).toHaveBeenCalledTimes(2);
  });

  it('drinks health and mana on the same tick when both are low', () => {
    const h = harness({ hp: 100, maxHp: 1000, mp: 100, maxMp: 1000 });
    tick(h);
    expect(h.sent).toHaveBeenCalledTimes(2);
    const kinds = h.sent.mock.calls.map(
      (call) => (call[1] as { slotObject: { objectType: number } }).slotObject.objectType,
    );
    expect(kinds).toEqual([HEALTH_POTION, MAGIC_POTION]);
  });

  it('does not waste a health potion while sick', () => {
    const h = harness({ hp: 100, maxHp: 1000, mp: 100, maxMp: 1000 });
    h.self.conditions = conditionBitLow(ConditionEffect.Sick);
    tick(h);
    // Mana still goes down, because being sick blocks healing and nothing else.
    expect(h.sent).toHaveBeenCalledTimes(1);
    expect(h.sent.mock.calls[0]?.[1]).toMatchObject({
      slotObject: { objectType: MAGIC_POTION },
    });
  });

  it('never drinks in a safe zone, whatever the bar says', () => {
    for (const map of ['Vault', 'Nexus', 'Pet Yard 3', 'Guild Hall 2']) {
      const h = harness({ hp: 1, maxHp: 1000, map });
      tick(h);
      expect(h.sent, map).not.toHaveBeenCalled();
    }
  });

  it('does nothing at all while switched off', () => {
    const h = harness({ hp: 1, maxHp: 1000 });
    h.host.setEnabled('auto-drink', false);
    tick(h);
    expect(h.sent).not.toHaveBeenCalled();
  });
});

/** A decoded packet, round-tripped so a handler sees what a live one carries. */
function packetOf(name: string, fields: Record<string, unknown>): MutablePacket {
  const packet = createPacket(registry, name);
  for (const [key, value] of Object.entries(fields)) {
    packet.fields[key] = value as never;
  }
  return new MutablePacket(decodeFrame(registry, encodePacket(registry, packet)));
}
