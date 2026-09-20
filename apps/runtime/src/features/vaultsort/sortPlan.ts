/**
 * Sorting a chest's contents, and the moves that realise the sorted order.
 *
 * Pure, and the whole of the policy: nothing here knows about packets,
 * sessions or pacing, so the orderings and the move sequences can be tested
 * against a bare array with no session and no game.
 *
 * A sort is expressed as a *target* — the chest's own slot indices, in the
 * order their current contents should end up in — and then as the moves that
 * turn the current arrangement into it. Two steps rather than one because they
 * answer different questions: the target is what the player asked for, the
 * moves are what the wire can carry, and only the second has to worry about
 * what the server will actually do with what it is asked.
 */

import { gearFamilyOf, type GearFamily } from '../../gamedata/items.js';

/** The orders a chest can be asked into. */
export const VaultSortOrder = {
  /** Gear families together — weapons, abilities, armour, rings, then the rest. */
  Type: 'type',
  /** Display name, A to Z. */
  Name: 'name',
  /** What feeding each item to a pet is worth, best first. */
  Feed: 'feed',
} as const;

export type VaultSortOrder = (typeof VaultSortOrder)[keyof typeof VaultSortOrder];

/** What the sorter needs to know about one item type. */
export interface SortableItem {
  readonly name: string;
  readonly slotType: number;
  /** Numeric tier, or nothing for an item that has none. */
  readonly tier: number | undefined;
  readonly feedPower: number;
}

/** The catalog as the sorter needs it: what an object type is, or nothing. */
export type SortableLookup = (objectType: number) => SortableItem | undefined;

/** Where a gear family sits in a type sort. Everything unrecognised follows. */
const FAMILY_RANK: Readonly<Record<GearFamily, number>> = {
  weapon: 0,
  ability: 1,
  armor: 2,
  ring: 3,
};

/** The rank a slot type sorts at; potions, eggs and the unknown come last. */
function familyRank(slotType: number): number {
  const family = gearFamilyOf(slotType);
  return family === undefined ? FAMILY_RANK.ring + 1 : FAMILY_RANK[family];
}

/**
 * The chest's slots, ordered so that their current contents read as sorted.
 *
 * `target[position]` is the slot whose content belongs at `position`, so the
 * arrangement reads straight off it: `contents[target[0]]` is the first item.
 * Empty slots — anything below zero — go last in every order, because a sorted
 * chest is one that is packed from the front. Ties break on the slot index, so
 * the same chest always sorts to the same target whatever it was arranged as
 * before.
 */
export function sortedSlots(
  contents: readonly number[],
  order: VaultSortOrder,
  item: SortableLookup,
): number[] {
  const slots = contents.map((_, slot) => slot);

  // Read once per slot rather than once per comparison: a chest holds dozens of
  // slots and every fact below is asked about both sides of every comparison.
  const facts = new Map<number, SortableItem | undefined>();
  const factsOf = (objectType: number): SortableItem | undefined => {
    if (!facts.has(objectType)) facts.set(objectType, item(objectType));
    return facts.get(objectType);
  };

  const byName = (x: number, y: number): number => {
    const factsX = factsOf(contents[x] ?? -1);
    const factsY = factsOf(contents[y] ?? -1);
    return (factsX?.name ?? '').localeCompare(factsY?.name ?? '') || x - y;
  };

  slots.sort((x, y) => {
    const typeX = contents[x] ?? -1;
    const typeY = contents[y] ?? -1;
    // Occupied before empty, in every order, whatever the catalog knows.
    if (typeX < 0 || typeY < 0) return (typeX < 0 ? 1 : 0) - (typeY < 0 ? 1 : 0);

    const factsX = factsOf(typeX);
    const factsY = factsOf(typeY);

    switch (order) {
      case VaultSortOrder.Type: {
        const rank = familyRank(factsX?.slotType ?? -1) - familyRank(factsY?.slotType ?? -1);
        if (rank !== 0) return rank;
        // Better gear first within a family: a higher tier, and — with no tier
        // to rank by, which is the untiered and set items — the name decides.
        const tier = (factsY?.tier ?? -1) - (factsX?.tier ?? -1);
        return tier !== 0 ? tier : byName(x, y);
      }
      case VaultSortOrder.Feed: {
        const feed = (factsY?.feedPower ?? 0) - (factsX?.feedPower ?? 0);
        return feed !== 0 ? feed : byName(x, y);
      }
      case VaultSortOrder.Name:
        return byName(x, y);
    }
  });
  return slots;
}

/**
 * What one step of a sort asks the server for.
 *
 * **Always a move into an empty slot — never an exchange of two occupied
 * ones.** The third live run of this feature proved the hard way that a swap
 * naming two occupied chest slots is not carried out as an exchange: the
 * server confirmed every one, the picture here updated, and the chest's items
 * piled into a single slot instead of trading places. A move into an empty
 * slot is the one rearrangement the game's own client performs on a chest and
 * the one the reference mule ran a whole live session on, so it is the only
 * shape this will put on the wire.
 */
export interface PlannedMove {
  readonly from: number;
  readonly to: number;
}

/**
 * The moves that turn a chest arranged as it is into one arranged as `target`
 * says, every one of them into a slot that is empty at the moment it is made.
 *
 * The arrangement is a permutation, and a permutation is cycles; each cycle is
 * rotated by walking its contents backward into a travelling empty slot — the
 * empty already inside the cycle if it has one, else one borrowed from outside
 * the cycle and given back when the rotation closes. A cycle with its own
 * empty costs its length minus one move, a cycle that borrows costs one more,
 * which is the price of never touching an occupied slot with another item.
 *
 * @throws {TypeError} if `target` is not a permutation of the chest's slots —
 *   a plan aimed at a slot that does not exist is a bug in the caller, and a
 *   move sent against it would be aimed who knows where. Also if no slot is
 *   empty and some cycle has none of its own: with nowhere to move through, an
 *   occupied-for-occupied exchange would be the only way on, and that is the
 *   one shape this will not send.
 */
export function planMoves(contents: readonly number[], target: readonly number[]): PlannedMove[] {
  const dest = new Array<number>(target.length).fill(-1);
  target.forEach((slot, position) => {
    if (!Number.isInteger(slot) || slot < 0 || slot >= target.length || dest[slot] !== -1) {
      throw new TypeError('the sorted order is not a permutation of the chest\u2019s slots');
    }
    dest[slot] = position;
  });

  // Followed as the moves are made, so every move's target is known empty and
  // a cycle that needs to borrow can be pointed at a slot that is empty *now*.
  const arrangement = [...contents];
  const moves: PlannedMove[] = [];

  /** Moves what sits at `from` into the empty slot `to`, and records it. */
  const move = (from: number, to: number): void => {
    moves.push({ from, to });
    arrangement[to] = arrangement[from] ?? -1;
    arrangement[from] = -1;
  };

  const settled = new Array<boolean>(target.length).fill(false);
  for (let start = 0; start < target.length; start += 1) {
    if (settled[start] === true) continue;

    // Gather the cycle `start` belongs to. `previous` walks it backward: the
    // content that belongs in a slot is the one its cycle-predecessor holds.
    const cycle: number[] = [];
    for (let slot = start; settled[slot] !== true; slot = dest[slot] ?? start) {
      cycle.push(slot);
      settled[slot] = true;
    }
    if (cycle.length === 1) continue;

    const first = cycle[0];
    if (first === undefined) continue;
    const previous = new Map<number, number>();
    for (let index = 0; index < cycle.length; index += 1) {
      const ahead = cycle[(index + 1) % cycle.length];
      if (ahead !== undefined) previous.set(ahead, cycle[index] ?? first);
    }

    const ownEmpty = cycle.find((slot) => (arrangement[slot] ?? 0) < 0);
    if (ownEmpty !== undefined) {
      // The cycle has an empty of its own: walk the contents backward into it
      // until it has travelled the whole cycle and everything has arrived. A
      // predecessor that is itself empty costs nothing to cross — the gap
      // simply jumps — which is what keeps a cycle holding several empties
      // from asking the server to move nothing anywhere.
      let emptySlot = ownEmpty;
      for (let step = 0; step < cycle.length - 1; step += 1) {
        const from = previous.get(emptySlot);
        if (from === undefined) break;
        if ((arrangement[from] ?? 0) >= 0) move(from, emptySlot);
        emptySlot = from;
      }
      continue;
    }

    // No empty of its own: park the first slot's content outside the cycle,
    // walk the rest backward into the vacancy, and give the borrowed slot
    // back. The buffer is empty now and outside this cycle by construction.
    const buffer = arrangement.findIndex((type) => type < 0);
    if (buffer === -1) {
      throw new TypeError('no empty slot to move through');
    }
    move(first, buffer);
    let emptySlot = first;
    for (let step = 0; step < cycle.length - 1; step += 1) {
      const from = previous.get(emptySlot);
      if (from === undefined) break;
      move(from, emptySlot);
      emptySlot = from;
    }
    move(buffer, emptySlot);
  }
  return moves;
}
