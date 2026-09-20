import {
  MutablePacket,
  type EntityView,
  type NativeApi,
  type SessionApi,
  type SessionView,
} from '@brownie/plugin-api';
import { createPacket, decodeFrame, encodePacket } from '@brownie/protocol';
import { createBundledRegistry } from '@brownie/protocol/bundled';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ItemFacts } from '../src/gamedata/items.js';
import { VaultSortOrder, planMoves, sortedSlots } from '../src/features/vaultsort/sortPlan.js';
import { createVaultSortPlugin } from '../src/features/vaultsort/vaultSortPlugin.js';
import { VaultChests, contentsDiffer, slotRefOf } from '../src/features/vaultsort/vaultChests.js';
import { PluginHost } from '../src/plugins/PluginHost.js';
import { immediateSend, testLogger } from './fakes.js';

const registry = createBundledRegistry();

/** A sword — slot type 2, one of the weapon family. */
const WEAPON = 101;
/** A lesser sword, same family, lower tier. */
const WEAPON_LOW = 102;
const ARMOR = 201;
const RING = 301;
const POTION = 401;
/** A bow with no tier — untiered, still a weapon. */
const UT_WEAPON = 501;
const EGG = 601;

function facts(over: Partial<ItemFacts> = {}): ItemFacts {
  return {
    slotType: 2,
    tier: 12,
    untiered: false,
    setItem: false,
    beltStack: 0,
    feedPower: 900,
    potion: undefined,
    key: false,
    ability: undefined,
    ...over,
  };
}

const ITEMS: ReadonlyMap<number, ItemFacts> = new Map([
  [WEAPON, facts({ feedPower: 900 })],
  [WEAPON_LOW, facts({ tier: 6, feedPower: 300 })],
  [ARMOR, facts({ slotType: 14, tier: 13, feedPower: 1300 })],
  [RING, facts({ slotType: 9, tier: 6, feedPower: 700 })],
  [POTION, facts({ slotType: 10, tier: 1, feedPower: 5 })],
  [UT_WEAPON, facts({ slotType: 3, tier: undefined, untiered: true, feedPower: 1400 })],
  [EGG, facts({ slotType: 26, tier: undefined, feedPower: 0 })],
]);

const NAMES: ReadonlyMap<number, string> = new Map([
  [WEAPON, 'Zephyr Sword'],
  [WEAPON_LOW, 'Zephyr Sword of Lesser Might'],
  [ARMOR, 'Robe of the Void'],
  [RING, 'Amethyst Ring'],
  [POTION, 'Health Potion'],
  [UT_WEAPON, 'Morning Star'],
  [EGG, 'Pet Egg'],
]);

const INPUTS = {
  item: (objectType: number): ItemFacts | undefined => ITEMS.get(objectType),
  displayName: (objectType: number): string | undefined => NAMES.get(objectType),
};

/** The sortable view the plugin composes, built the same way it builds it. */
const sortable = (objectType: number) => {
  const item = ITEMS.get(objectType);
  if (item === undefined) return undefined;
  return { name: NAMES.get(objectType) ?? '', ...item };
};

/**
 * Applies a plan to a copy of the chest, as the server would move by move —
 * and refuses a move whose destination is not empty, which is the one rule the
 * whole plan exists to keep.
 */
function applied(
  contents: readonly number[],
  moves: readonly { from: number; to: number }[],
): number[] {
  const result = [...contents];
  for (const { from, to } of moves) {
    if ((result[to] ?? -1) >= 0) throw new Error(`a move aimed into occupied slot ${String(to)}`);
    result[to] = result[from] ?? -1;
    result[from] = -1;
  }
  return result;
}

// ── The orderings ────────────────────────────────────────────────────────────

describe('how a chest is ordered', () => {
  it('files gear by family, best tier first, and leaves the empties to the back', () => {
    // A potion, a gap, a weapon, an armour, an untiered weapon, an egg.
    const contents = [POTION, -1, WEAPON, ARMOR, UT_WEAPON, EGG];
    const target = sortedSlots(contents, VaultSortOrder.Type, sortable);
    expect(target).toEqual([2, 4, 3, 0, 5, 1]);
    // The arrangement the target describes, read off it:
    expect(target.map((slot) => contents[slot])).toEqual([
      WEAPON,
      UT_WEAPON,
      ARMOR,
      POTION,
      EGG,
      -1,
    ]);
  });

  it('ranks a higher tier above a lower one within a family', () => {
    const target = sortedSlots([WEAPON_LOW, WEAPON], VaultSortOrder.Type, sortable);
    expect(target).toEqual([1, 0]);
  });

  it('orders alphabetically by the name the player sees', () => {
    const contents = [WEAPON, ARMOR, RING, POTION, UT_WEAPON];
    const target = sortedSlots(contents, VaultSortOrder.Name, sortable);
    expect(target.map((slot) => NAMES.get(contents[slot] ?? -1))).toEqual([
      'Amethyst Ring',
      'Health Potion',
      'Morning Star',
      'Robe of the Void',
      'Zephyr Sword',
    ]);
  });

  it('orders by feed power, best first', () => {
    const contents = [POTION, WEAPON, ARMOR, RING, UT_WEAPON, -1];
    const target = sortedSlots(contents, VaultSortOrder.Feed, sortable);
    expect(target.map((slot) => contents[slot])).toEqual([
      UT_WEAPON,
      ARMOR,
      WEAPON,
      RING,
      POTION,
      -1,
    ]);
  });

  it('keeps duplicates in the order they already stand', () => {
    const target = sortedSlots([WEAPON, ARMOR, WEAPON, ARMOR], VaultSortOrder.Type, sortable);
    expect(target).toEqual([0, 2, 1, 3]);
  });

  it('sorts items the catalog does not describe rather than dropping them', () => {
    // An undescribed item has no family and no tier, so it follows what it
    // would rank beside — and stays in the chest rather than vanishing from it.
    const target = sortedSlots([9999, POTION], VaultSortOrder.Type, sortable);
    expect(target).toEqual([1, 0]);
  });
});

// ── The plan ─────────────────────────────────────────────────────────────────

describe('the moves a sort costs', () => {
  it('costs nothing for a chest already in order', () => {
    expect(planMoves([WEAPON, -1], [0, 1])).toEqual([]);
  });

  it('never touches an occupied slot with another item', () => {
    // The shape a live server carried out as anything but an exchange: two
    // occupied slots named in one packet. Every plan this produces reaches an
    // occupied slot only by emptying it first.
    const contents = [POTION, -1, WEAPON, ARMOR, RING, UT_WEAPON, EGG, WEAPON_LOW];
    const target = sortedSlots(contents, VaultSortOrder.Type, sortable);
    const moves = planMoves(contents, target);
    expect(applied(contents, moves)).toEqual(target.map((slot) => contents[slot]));
  });

  it('reverses three occupied slots through the one empty one', () => {
    const contents = [ARMOR, RING, WEAPON, -1];
    const target = sortedSlots(contents, VaultSortOrder.Type, sortable);
    expect(target).toEqual([2, 0, 1, 3]);
    const moves = planMoves(contents, target);
    expect(applied(contents, moves)).toEqual([WEAPON, ARMOR, RING, -1]);
  });

  it('rotates a cycle that owns an empty slot without borrowing another', () => {
    // The empty at slot 0 belongs at the far end, so it travels the cycle
    // itself: two moves for three slots, and no slot outside the cycle touched.
    const moves = planMoves([-1, ARMOR, RING], [1, 2, 0]);
    expect(moves).toEqual([
      { from: 1, to: 0 },
      { from: 2, to: 1 },
    ]);
    expect(applied([-1, ARMOR, RING], moves)).toEqual([ARMOR, RING, -1]);
  });

  it('sorts a chest of duplicates without a single occupied-for-occupied move', () => {
    // Duplicates are what once made a re-deriving sort re-ask one invisible
    // swap forever; through empty slots every move is visible, duplicates or
    // no duplicates.
    const contents = [EGG, EGG, POTION, -1];
    const target = sortedSlots(contents, VaultSortOrder.Type, sortable);
    const moves = planMoves(contents, target);
    expect(applied(contents, moves)).toEqual([POTION, EGG, EGG, -1]);
  });

  it('refuses a target that is not a permutation of the chest', () => {
    expect(() => planMoves([0, -1], [0, 0])).toThrow(TypeError);
    expect(() => planMoves([0, -1], [1, 2])).toThrow(TypeError);
  });

  it('refuses a chest with no empty slot to move through', () => {
    expect(() => planMoves([WEAPON, ARMOR, RING], [1, 2, 0])).toThrow(TypeError);
  });
});

// ── The chest as the server states it ────────────────────────────────────────

describe('the vault chests the server describes', () => {
  it('keeps the chests a snapshot names and drops the ones it does not', () => {
    const chests = new VaultChests();
    chests.replace({ objectId: 100, contents: [WEAPON], label: 'vault chest' }, undefined);
    expect(chests.chests().map((chest) => chest.objectId)).toEqual([100]);
    expect(chests.chest(100)?.contents).toEqual([WEAPON]);
    expect(chests.chestByLabel('vault chest')?.objectId).toBe(100);
    expect(chests.chest(200)).toBeUndefined();
    chests.clear();
    expect(chests.chests()).toEqual([]);
  });

  it('ignores a chest the snapshot names with no object', () => {
    const chests = new VaultChests();
    chests.replace(
      { objectId: -1, contents: [], label: 'vault chest' },
      { objectId: -1, contents: [], label: 'seasonal spoils chest' },
    );
    expect(chests.chests()).toEqual([]);
  });

  it('exchanges the two slots a confirmed result names', () => {
    const chests = new VaultChests();
    chests.replace(
      { objectId: 100, contents: [WEAPON, ARMOR, POTION], label: 'vault chest' },
      undefined,
    );
    const changed = chests.applyResult(
      { objectId: 100, slotId: 0, objectType: WEAPON },
      { objectId: 100, slotId: 2, objectType: POTION },
    );
    expect(chests.chest(100)?.contents).toEqual([POTION, ARMOR, WEAPON]);
    expect(changed).toBe(true);
  });

  it('hears the same move twice without putting it back', () => {
    // The race the first live sort died on: a snapshot carrying the move can
    // arrive before the result for it, so the result lands on a picture that
    // already includes it.
    const chests = new VaultChests();
    chests.replace(
      { objectId: 100, contents: [POTION, ARMOR, WEAPON], label: 'vault chest' },
      undefined,
    );
    const changed = chests.applyResult(
      { objectId: 100, slotId: 0, objectType: WEAPON },
      { objectId: 100, slotId: 2, objectType: POTION },
    );
    expect(chests.chest(100)?.contents).toEqual([POTION, ARMOR, WEAPON]);
    expect(changed).toBe(false);
  });

  it('trusts a result the picture cannot explain', () => {
    // The server performed the move it is reporting; a disagreement is our
    // picture being behind, not the result being wrong.
    const chests = new VaultChests();
    chests.replace({ objectId: 100, contents: [WEAPON, ARMOR], label: 'vault chest' }, undefined);
    chests.applyResult(
      { objectId: 100, slotId: 0, objectType: 9999 },
      { objectId: 100, slotId: 1, objectType: RING },
    );
    expect(chests.chest(100)?.contents).toEqual([RING, 9999]);
  });

  it('patches the one chest of a move that touched it', () => {
    const chests = new VaultChests();
    chests.replace({ objectId: 100, contents: [WEAPON], label: 'vault chest' }, undefined);
    // A withdrawal: the player's slot takes what the chest held.
    chests.applyResult(
      { objectId: 100, slotId: 0, objectType: WEAPON },
      { objectId: 7, slotId: 4, objectType: -1 },
    );
    expect(chests.chest(100)?.contents).toEqual([-1]);
  });

  it('grows to a slot a result names beyond the snapshot', () => {
    const chests = new VaultChests();
    chests.replace({ objectId: 100, contents: [WEAPON], label: 'vault chest' }, undefined);
    chests.applyResult(
      { objectId: 100, slotId: 0, objectType: WEAPON },
      { objectId: 100, slotId: 2, objectType: -1 },
    );
    expect(chests.chest(100)?.contents).toEqual([-1, -1, WEAPON]);
  });

  it('ignores a slot no chest could have', () => {
    // A decode that reads a slot id in the thousands is wrong, not a fact about
    // the chest; growing to meet it would invent a thousand-slot chest.
    const chests = new VaultChests();
    chests.replace({ objectId: 100, contents: [WEAPON], label: 'vault chest' }, undefined);
    const changed = chests.applyResult(
      { objectId: 100, slotId: 0, objectType: WEAPON },
      { objectId: 100, slotId: 5000, objectType: -1 },
    );
    expect(chests.chest(100)?.contents).toEqual([WEAPON]);
    expect(changed).toBe(false);
  });

  it('applies one of our moves by what the run meant', () => {
    const chests = new VaultChests();
    chests.replace(
      { objectId: 100, contents: [WEAPON, ARMOR, -1], label: 'vault chest' },
      undefined,
    );
    // A move into an empty slot is always visible: an item appears where the
    // gap was, and the gap moves to where the item was.
    expect(chests.move(100, 0, 2)).toBe(true);
    expect(chests.chest(100)?.contents).toEqual([-1, ARMOR, WEAPON]);
    expect(chests.move(100, 0, 5000)).toBe(false);
  });

  it('reads a slot reference out of a packet field, or says it is not one', () => {
    expect(slotRefOf({ objectId: 1, slotId: 2, objectType: 3 })).toEqual({
      objectId: 1,
      slotId: 2,
      objectType: 3,
    });
    expect(slotRefOf(undefined)).toBeUndefined();
    expect(slotRefOf({ objectId: 'one' })).toBeUndefined();
  });

  it('says whether two pictures of a chest disagree', () => {
    expect(contentsDiffer([WEAPON, -1], [WEAPON, -1])).toBe(false);
    expect(contentsDiffer([WEAPON], [WEAPON, -1])).toBe(true);
    expect(contentsDiffer([WEAPON, -1], undefined)).toBe(true);
    expect(contentsDiffer(undefined, undefined)).toBe(false);
  });
});

// ── The plugin ───────────────────────────────────────────────────────────────

describe('the vault sort plugin', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const NATIVE: NativeApi = {
    connected: false,
    setFeature: () => undefined,
    onConnected: () => () => undefined,
  };

  interface Harness {
    host: PluginHost;
    session: SessionView;
    world: { gameTimeMs: number; clientTimeMs: number; mapName: string };
    entities: Map<number, EntityView>;
    sent: ReturnType<typeof vi.fn>;
    notified: string[];
    settings: NonNullable<ReturnType<PluginHost['settingsOf']>>;
  }

  let harness_: Harness | undefined;

  function harness(options: { at?: { x: number; y: number } } = {}): Harness {
    const at = options.at ?? { x: 10, y: 10 };
    const entities = new Map<number, EntityView>();
    const world = {
      mapName: 'Vault',
      gameTimeMs: 50_000,
      // Deliberately different: the packet must carry the client's clock, not
      // the connection's, and only a test that can tell them apart says so.
      clientTimeMs: 1_234_000,
      entities: () => entities.values(),
      entity: (objectId: number) => entities.get(objectId),
    };
    const self = {
      objectId: 7,
      objectType: 0x30e,
      x: at.x,
      y: at.y,
      alive: true,
      hp: 100,
      maxHp: 100,
      mp: 0,
      maxMp: 0,
      conditions: 0,
    };
    const notified: string[] = [];
    const sent = vi.fn();
    const session = {
      id: 's1',
      self,
      world,
      server: { host: 'h', port: 1 },
      // The real session's contract: a move's clock starts when it leaves, and
      // with an empty lane it leaves during the call.
      sendToServer: immediateSend(sent),
      sendToClient: vi.fn(),
      notify: (text: string) => notified.push(text),
    } as unknown as SessionView;

    const sessions: SessionApi = {
      current: () => harness_?.session,
      all: () => (harness_ === undefined ? [] : [harness_.session]),
      onConnected: () => () => undefined,
      onDisconnected: () => () => undefined,
    };

    const host = new PluginHost({
      log: testLogger(),
      native: NATIVE,
      sessions,
      onChanged: () => undefined,
    });
    host.load(createVaultSortPlugin(INPUTS));
    host.setEnabled('vault-sort', true);
    const settings = host.settingsOf('vault-sort');
    if (settings === undefined) throw new Error('the plugin declared no settings');

    harness_ = { host, session, world, entities, sent, notified, settings };
    return harness_;
  }

  /** What a hundred milliseconds of real time does to the driver and the clock. */
  const step = (h: Harness, ms = 100): void => {
    // The clock moves first, so every driver tick inside the window reads the
    // time it is stepping to — the wall order would be the ticks reading a
    // clock the advance has not reached yet.
    h.world.gameTimeMs += ms;
    vi.advanceTimersByTime(ms);
  };

  function chest(objectId: number, at: { x: number; y: number }): EntityView {
    return {
      objectId,
      objectType: 0x0504,
      name: 'Vault Chest',
      hp: 0,
      maxHp: 0,
      isEnemy: false,
      isPlayer: false,
      conditions: 0,
      guildName: '',
      stat: () => undefined,
      text: () => undefined,
      x: at.x,
      y: at.y,
    };
  }

  /** A key press, as the hotkey router delivers one to the bind's setting. */
  const press = (h: Harness): void => {
    h.settings.apply('sortNow', true);
  };

  /** Everything sent so far, as (from, to, fromType, toType) tuples. */
  const sentMoves = (h: Harness): Array<[number, number, number, number]> =>
    h.sent.mock.calls.map(([, fields]) => {
      const one = (fields as Record<string, unknown>).slotObject1 as Record<string, number>;
      const two = (fields as Record<string, unknown>).slotObject2 as Record<string, number>;
      return [one.slotId ?? -1, two.slotId ?? -1, one.objectType ?? -1, two.objectType ?? -1];
    });

  it('sorts a shuffled chest through confirmed moves into empty slots', () => {
    const h = harness();
    h.entities.set(100, chest(100, { x: 10, y: 10 }));
    h.host.dispatchPacket(vaultContent(100, [POTION, -1, WEAPON, ARMOR]), h.session);

    press(h);
    expect(h.notified[0]).toBe('Sorting the vault chest — 3 items, 4 moves.');

    // The first move may leave at once: the press is the asking.
    step(h);
    expect(h.sent).toHaveBeenCalledTimes(1);
    expect(h.sent).toHaveBeenCalledWith('INVENTORYSWAP', {
      // The client's own clock, never the connection's.
      time: 1_234_000,
      position: { x: 10, y: 10 },
      slotObject1: { objectId: 100, slotId: 0, objectType: POTION },
      slotObject2: { objectId: 100, slotId: 1, objectType: -1 },
    });

    // The server confirms, naming what each slot held — as the result does.
    h.host.dispatchPacket(
      invResult(
        { objectId: 100, slotId: 0, objectType: POTION },
        { objectId: 100, slotId: 1, objectType: -1 },
      ),
      h.session,
    );

    // The next move waits out the floor, and the floor spans the whole sort.
    step(h, 900);
    expect(h.sent).toHaveBeenCalledTimes(1);
    step(h, 100);
    expect(h.sent).toHaveBeenCalledTimes(2);

    h.host.dispatchPacket(
      invResult(
        { objectId: 100, slotId: 2, objectType: WEAPON },
        { objectId: 100, slotId: 0, objectType: -1 },
      ),
      h.session,
    );
    step(h, 1000);
    expect(h.sent).toHaveBeenCalledTimes(3);
    h.host.dispatchPacket(
      invResult(
        { objectId: 100, slotId: 1, objectType: POTION },
        { objectId: 100, slotId: 2, objectType: -1 },
      ),
      h.session,
    );
    step(h, 1000);
    expect(h.sent).toHaveBeenCalledTimes(4);
    h.host.dispatchPacket(
      invResult(
        { objectId: 100, slotId: 3, objectType: ARMOR },
        { objectId: 100, slotId: 1, objectType: -1 },
      ),
      h.session,
    );
    step(h);
    expect(h.sent).toHaveBeenCalledTimes(4);
    expect(h.notified[h.notified.length - 1]).toBe('Sorted the vault chest in 4 moves.');

    // Every move on the wire went into a slot the picture called empty.
    expect(sentMoves(h).every(([, , , toType]) => toType === -1)).toBe(true);

    // A finished sort leaves nothing armed and nothing running.
    expect(h.settings.value('sortNow')).toBe(false);
  });

  it('adopts a snapshot that includes its own move, and the late result too', () => {
    // The race that stopped the first live sort: the server refreshes the
    // vault list when a chest's contents change, so the snapshot carrying this
    // feature's own move can arrive before the result for it.
    const h = harness();
    h.entities.set(100, chest(100, { x: 10, y: 10 }));
    h.host.dispatchPacket(vaultContent(100, [POTION, -1, WEAPON, ARMOR]), h.session);

    press(h);
    step(h);
    expect(h.sent).toHaveBeenCalledTimes(1);

    h.host.dispatchPacket(vaultContent(100, [-1, POTION, WEAPON, ARMOR]), h.session);
    expect(h.notified[h.notified.length - 1]).not.toContain('stopped');

    step(h, 1000);
    // Re-derived from the adopted picture: the weapon moves into the gap.
    expect(h.sent).toHaveBeenCalledTimes(2);
    expect(h.sent).toHaveBeenLastCalledWith('INVENTORYSWAP', {
      time: 1_234_000,
      position: { x: 10, y: 10 },
      slotObject1: { objectId: 100, slotId: 2, objectType: WEAPON },
      slotObject2: { objectId: 100, slotId: 0, objectType: -1 },
    });

    // The result for the first move arrives late; hearing a move twice, the
    // picture does not put it back, and the move in flight is not disturbed.
    h.host.dispatchPacket(
      invResult(
        { objectId: 100, slotId: 0, objectType: POTION },
        { objectId: 100, slotId: 1, objectType: -1 },
      ),
      h.session,
    );
    step(h, 100);
    expect(h.sent).toHaveBeenCalledTimes(2);
  });

  it('re-plans around a withdrawal the player made mid-sort', () => {
    const h = harness();
    h.entities.set(100, chest(100, { x: 10, y: 10 }));
    h.host.dispatchPacket(vaultContent(100, [POTION, WEAPON, ARMOR, RING, -1]), h.session);

    press(h);
    step(h);
    expect(h.sent).toHaveBeenCalledTimes(1);
    expect(h.sent).toHaveBeenNthCalledWith(1, 'INVENTORYSWAP', {
      time: 1_234_000,
      position: { x: 10, y: 10 },
      slotObject1: { objectId: 100, slotId: 0, objectType: POTION },
      slotObject2: { objectId: 100, slotId: 4, objectType: -1 },
    });

    // The player takes the weapon out of slot 1 while our first move is out:
    // not ours, not a dispute — a fact about the chest the next plan is
    // derived from.
    h.host.dispatchPacket(
      invResult(
        { objectId: 100, slotId: 1, objectType: WEAPON },
        { objectId: 7, slotId: 4, objectType: -1 },
      ),
      h.session,
    );
    expect(h.notified[h.notified.length - 1]).not.toContain('stopped');

    // Our own move lands, by intent, through the slots it named: the potion
    // parks outside the chest's arrangement and the gap it left behind joins
    // the one the withdrawal opened.
    h.host.dispatchPacket(
      invResult(
        { objectId: 100, slotId: 0, objectType: POTION },
        { objectId: 100, slotId: 4, objectType: -1 },
      ),
      h.session,
    );

    // Re-planned around the two gaps: the armour moves into the first one.
    step(h, 1000);
    expect(h.sent).toHaveBeenCalledTimes(2);
    expect(h.sent).toHaveBeenLastCalledWith('INVENTORYSWAP', {
      time: 1_234_000,
      position: { x: 10, y: 10 },
      slotObject1: { objectId: 100, slotId: 2, objectType: ARMOR },
      slotObject2: { objectId: 100, slotId: 0, objectType: -1 },
    });
  });

  it('rearms the key once the press has been consumed', () => {
    const h = harness();
    h.entities.set(100, chest(100, { x: 10, y: 10 }));
    h.host.dispatchPacket(vaultContent(100, [ARMOR, WEAPON, -1]), h.session);

    press(h);
    step(h, 1);
    expect(h.settings.value('sortNow')).toBe(false);

    // The next press is a new press, not a no-change.
    press(h);
    expect(h.notified[0]).toBe('Sorting the vault chest — 2 items, 3 moves.');
  });

  it('says there is nothing to move when the chest already reads as sorted', () => {
    const h = harness();
    h.entities.set(100, chest(100, { x: 10, y: 10 }));
    h.host.dispatchPacket(vaultContent(100, [WEAPON, ARMOR, POTION, -1]), h.session);

    press(h);
    expect(h.notified).toEqual(['Already in order — nothing to move.']);
    step(h);
    expect(h.sent).not.toHaveBeenCalled();
  });

  it('says there is nothing to move in an empty chest', () => {
    const h = harness();
    h.entities.set(100, chest(100, { x: 10, y: 10 }));
    h.host.dispatchPacket(vaultContent(100, [-1, -1]), h.session);

    press(h);
    expect(h.notified).toEqual(['The chest is empty.']);
  });

  it('refuses a chest with no empty slot to move through', () => {
    const h = harness();
    h.entities.set(100, chest(100, { x: 10, y: 10 }));
    h.host.dispatchPacket(vaultContent(100, [WEAPON, ARMOR]), h.session);

    press(h);
    // The one rearrangement a full chest allows is the occupied-for-occupied
    // exchange, and that is the one shape a live server did not carry out as
    // one — so a full chest is the player's problem, not the sort's.
    expect(h.notified).toEqual([
      'The chest is full — leave a slot empty for the sort to move through.',
    ]);
    step(h);
    expect(h.sent).not.toHaveBeenCalled();
  });

  it('refuses a press with no chest in the snapshot', () => {
    const h = harness();
    press(h);
    expect(h.notified).toEqual(['No vault chest seen yet — enter the vault first.']);
  });

  it('refuses a press with no chest within a tile', () => {
    const h = harness({ at: { x: 10, y: 10 } });
    h.entities.set(100, chest(100, { x: 20, y: 20 }));
    h.host.dispatchPacket(vaultContent(100, [WEAPON, ARMOR, -1]), h.session);

    press(h);
    expect(h.notified).toEqual(['No vault chest within 1 tile of you.']);
  });

  it('picks the nearer of the two chests', () => {
    const h = harness();
    h.entities.set(100, chest(100, { x: 10.4, y: 10 }));
    h.entities.set(200, chest(200, { x: 10.2, y: 10 }));
    h.host.dispatchPacket(vaultContent(100, [WEAPON, -1], 200, [POTION, WEAPON, -1]), h.session);

    press(h);
    expect(h.notified[0]).toBe('Sorting the seasonal spoils chest — 2 items, 3 moves.');
  });

  it('follows the chest onto a fresh entity id in a later snapshot', () => {
    const h = harness();
    h.entities.set(200, chest(200, { x: 10, y: 10 }));
    h.host.dispatchPacket(vaultContent(-1, [], 200, [ARMOR, POTION, WEAPON, -1]), h.session);

    press(h);
    step(h);
    expect(h.sent).toHaveBeenCalledTimes(1);
    h.host.dispatchPacket(
      invResult(
        { objectId: 200, slotId: 0, objectType: ARMOR },
        { objectId: 200, slotId: 3, objectType: -1 },
      ),
      h.session,
    );

    // The chest re-issued under a new id, contents and all: the sort follows
    // the label rather than insisting on the entity it started with.
    h.entities.set(210, chest(210, { x: 10, y: 10 }));
    h.host.dispatchPacket(vaultContent(-1, [], 210, [-1, POTION, WEAPON, ARMOR]), h.session);
    step(h, 1000);
    expect(h.sent).toHaveBeenCalledTimes(2);
    expect(h.sent).toHaveBeenLastCalledWith(
      'INVENTORYSWAP',
      expect.objectContaining({
        slotObject1: { objectId: 210, slotId: 2, objectType: WEAPON },
        slotObject2: { objectId: 210, slotId: 0, objectType: -1 },
      }),
    );
  });

  it('refuses a second press while a sort is running', () => {
    const h = harness();
    h.entities.set(100, chest(100, { x: 10, y: 10 }));
    h.host.dispatchPacket(vaultContent(100, [POTION, WEAPON, -1]), h.session);

    press(h);
    step(h);
    press(h);
    expect(h.notified).toContain('Already sorting — press again once it finishes.');
    expect(h.sent).toHaveBeenCalledTimes(1);
  });

  it('stops after three moves in a row that nothing confirms', () => {
    const h = harness();
    h.entities.set(100, chest(100, { x: 10, y: 10 }));
    h.host.dispatchPacket(vaultContent(100, [POTION, WEAPON, -1]), h.session);

    press(h);
    step(h);
    expect(h.sent).toHaveBeenCalledTimes(1);

    // A refusal is silence: the same move is retried from the same picture,
    // and three silent ones in a row end the sort rather than pestering.
    step(h, 4100);
    expect(h.sent).toHaveBeenCalledTimes(2);
    step(h, 4100);
    expect(h.sent).toHaveBeenCalledTimes(3);
    step(h, 4100);
    expect(h.notified[h.notified.length - 1]).toBe('Sort stopped — a move went unconfirmed.');
    step(h, 2000);
    expect(h.sent).toHaveBeenCalledTimes(3);
  });

  it('stops the sort when the player moves something themselves', () => {
    const h = harness();
    h.entities.set(100, chest(100, { x: 10, y: 10 }));
    h.host.dispatchPacket(vaultContent(100, [POTION, WEAPON, -1]), h.session);

    press(h);
    step(h);
    h.host.dispatchPacket(
      packetOf('INVENTORYSWAP', {
        time: 1_234_100,
        position: { x: 10, y: 10 },
        slotObject1: { objectId: 100, slotId: 0, objectType: POTION },
        slotObject2: { objectId: 7, slotId: 4, objectType: -1 },
      }),
      h.session,
    );

    expect(h.notified[h.notified.length - 1]).toBe('Sort stopped — you moved something yourself.');
    step(h, 2000);
    expect(h.sent).toHaveBeenCalledTimes(1);
  });

  it('stops when a fresh snapshot no longer names the chest', () => {
    const h = harness();
    h.entities.set(100, chest(100, { x: 10, y: 10 }));
    h.host.dispatchPacket(vaultContent(100, [POTION, WEAPON, -1]), h.session);

    press(h);
    step(h);
    h.host.dispatchPacket(vaultContent(-1, []), h.session);

    expect(h.notified[h.notified.length - 1]).toBe('Sort stopped — the chest left the vault list.');
    step(h, 2000);
    expect(h.sent).toHaveBeenCalledTimes(1);
  });

  it('rides through a snapshot that says what it already believes', () => {
    const h = harness();
    h.entities.set(100, chest(100, { x: 10, y: 10 }));
    h.host.dispatchPacket(vaultContent(100, [POTION, -1, WEAPON, ARMOR]), h.session);

    press(h);
    step(h);
    h.host.dispatchPacket(vaultContent(100, [POTION, -1, WEAPON, ARMOR]), h.session);
    expect(h.notified[h.notified.length - 1]).not.toContain('stopped');

    h.host.dispatchPacket(
      invResult(
        { objectId: 100, slotId: 0, objectType: POTION },
        { objectId: 100, slotId: 1, objectType: -1 },
      ),
      h.session,
    );
    step(h, 1000);
    expect(h.sent).toHaveBeenCalledTimes(2);
  });

  it('forgets the chests on a map change', () => {
    const h = harness();
    h.entities.set(100, chest(100, { x: 10, y: 10 }));
    h.host.dispatchPacket(vaultContent(100, [ARMOR, WEAPON, -1]), h.session);

    press(h);
    step(h);
    expect(h.sent).toHaveBeenCalledTimes(1);
    h.host.dispatchPacket(mapinfo(), h.session);

    press(h);
    expect(h.notified[h.notified.length - 1]).toBe(
      'No vault chest seen yet — enter the vault first.',
    );
    step(h, 2000);
    // The sort that was running went with the map, not just the snapshot.
    expect(h.sent).toHaveBeenCalledTimes(1);
  });

  it('sorts the seasonal chest the same way', () => {
    const h = harness();
    h.entities.set(200, chest(200, { x: 10, y: 10 }));
    h.host.dispatchPacket(vaultContent(-1, [], 200, [POTION, WEAPON, -1]), h.session);

    press(h);
    expect(h.notified[0]).toBe('Sorting the seasonal spoils chest — 2 items, 3 moves.');
    step(h);
    expect(h.sent).toHaveBeenNthCalledWith(1, 'INVENTORYSWAP', {
      time: 1_234_000,
      position: { x: 10, y: 10 },
      slotObject1: { objectId: 200, slotId: 0, objectType: POTION },
      slotObject2: { objectId: 200, slotId: 2, objectType: -1 },
    });
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

function vaultContent(
  vaultObjectId: number,
  vaultContents: readonly number[],
  seasonalObjectId = -1,
  seasonalContents: readonly number[] = [],
): MutablePacket {
  return packetOf('VAULTCONTENT', {
    lastVaultUpdate: false,
    vaultChestObjectId: vaultObjectId,
    materialChestObjectId: -1,
    giftChestObjectId: -1,
    potionStorageObjectId: -1,
    seasonalSpoilChestObjectId: seasonalObjectId,
    vaultContents: [...vaultContents],
    materialContents: [],
    giftContents: [],
    potionContents: [],
    seasonalSpoilContent: [...seasonalContents],
    vaultUpgradeCost: 0,
    materialUpgradeCost: 0,
    seasonalSpoilUpgradeCost: 0,
    potionUpgradeCost: 0,
    currentPotionMax: 0,
    nextPotionMax: 0,
    vaultChestEnchants: '',
    giftChestEnchants: '',
    spoilsChestEnchants: '',
  });
}

function invResult(
  from: { objectId: number; slotId: number; objectType: number },
  to: { objectId: number; slotId: number; objectType: number },
): MutablePacket {
  return packetOf('INVRESULT', {
    unknownBool: false,
    unknownByte: 0,
    fromSlot: from,
    toSlot: to,
    unknownInt1: 0,
    unknownInt2: 0,
  });
}

function mapinfo(): MutablePacket {
  return packetOf('MAPINFO', {
    width: 10,
    height: 10,
    name: 'Vault',
    displayName: 'Vault',
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
