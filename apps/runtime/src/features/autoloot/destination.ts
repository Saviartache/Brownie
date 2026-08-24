/**
 * Where a looted item is put.
 *
 * A quaff potion goes to the potion belt first — one belt slot holds six, so it
 * is six carried slots the player keeps, and it is where they are reached for
 * from. Everything else, and every potion the belt has no room for, goes in the
 * first free slot the player has allowed.
 *
 * **Only slots the server has actually stated are candidates**, which is what
 * the inventory view guarantees: a slot nobody has described is absent rather
 * than empty, so a character whose backpack is not being reported has no free
 * backpack slots rather than sixteen imaginary ones. The third belt slot is an
 * unlock and the server reports it exactly when the character has it, so being
 * reported is itself the answer.
 *
 * **And a group whose contents are not items is not an inventory group at all.**
 * Which stats carry the backpack and the belt is a fact about a game build, and
 * the two tables in this repository disagree about it — see `state/ItemSlots.ts`
 * for the sessions that cost. Under the wrong one those ids report exalt totals
 * and quest counts, so a group is read against the game's own item data before
 * anything is aimed into it: every stated slot must hold either nothing or
 * something `objects.xml` describes as an item, and a group holding anything
 * else is left alone entirely.
 *
 * That check is the whole point of this file. The alternative is asking the
 * server one swap at a time which of its slots are real, which costs a packet
 * per guess — and the server answers a swap it will not carry out with silence,
 * so the guessing never ends.
 *
 * Pure, and testable as a table.
 */

import type { InventoryView, ItemSlotView } from '@brownie/plugin-api';

/** What an empty slot reads as. */
const EMPTY = -1;

/** Whether the game's own data describes an object type as an item. */
export type IsItem = (objectType: number) => boolean;

/** Which slots a looted item is allowed into, and how to tell one. */
export interface AllowedSlots {
  readonly useBackpack: boolean;
  readonly isItem: IsItem;
}

/** A slot an item can be moved into, named the way `INVENTORYSWAP` names it. */
export interface Destination {
  readonly slotId: number;
  /**
   * What is in the slot now.
   *
   * The packet carries it and the server checks it against its own view, so a
   * slot we believe is empty and is not gets the swap refused rather than the
   * item that was there thrown into the bag.
   */
  readonly objectType: number;
  /**
   * What the slot's count should read once the move lands, for a slot that
   * counts.
   *
   * The only evidence a stacking move arrived: the slot already held the item
   * before it, so "is it occupied?" cannot answer. `undefined` everywhere else,
   * where being occupied at all is the answer.
   */
  readonly expectedQuantity: number | undefined;
}

/**
 * A potion-belt slot for this potion, or `undefined` when the belt has no room.
 *
 * A stack of the same potion is joined before an empty slot is taken, so the
 * belt fills rather than spreading one potion across it. A stack that is *full*
 * ends the search rather than starting a second one somewhere else — two stacks
 * of one potion on a three-slot belt is not what anybody wants.
 *
 * @param beltStack How many the belt holds in one slot, from the item's own
 *   `QuickslotAllowed`. Zero for everything the belt refuses, which is most of
 *   the game.
 */
export function findBeltDestination(
  inventory: InventoryView,
  objectType: number,
  beltStack: number,
  isItem: IsItem,
): Destination | undefined {
  if (beltStack <= 0) return undefined;

  const belt = inventory.belt();
  if (!holdsItems(belt, isItem)) return undefined;

  let firstEmpty: ItemSlotView | undefined;
  for (const slot of belt) {
    if (slot.objectType === objectType) {
      // A count is what says the game stacks this slot at all.
      if (slot.quantity <= 0 || slot.quantity >= beltStack) return undefined;
      return { slotId: slot.slotId, objectType, expectedQuantity: slot.quantity + 1 };
    }
    if (slot.objectType === EMPTY && firstEmpty === undefined) firstEmpty = slot;
  }

  return firstEmpty === undefined
    ? undefined
    : { slotId: firstEmpty.slotId, objectType: EMPTY, expectedQuantity: 1 };
}

/**
 * Every ordinary slot that is free, in the order they should be filled.
 *
 * The whole answer rather than the first of it, because it is asked before a
 * pickup is decided on and not after one has failed: an empty list is "there is
 * nowhere to put anything", which is a reason to send nothing at all.
 *
 * The main inventory comes first and the backpack is the overflow behind it, so
 * "use the backpack" means both, filled in that order — never the backpack on
 * its own. With it off the backpack is left out entirely.
 */
export function freeSlots(inventory: InventoryView, allowed: AllowedSlots): Destination[] {
  const carried = freeIn(inventory.carried(), allowed.isItem);
  if (!allowed.useBackpack) return carried;

  return carried.concat(freeIn(inventory.backpack(), allowed.isItem));
}

/** The empty slots of one group, and none at all for a group that is not one. */
function freeIn(slots: readonly ItemSlotView[], isItem: IsItem): Destination[] {
  if (!holdsItems(slots, isItem)) return [];

  const free: Destination[] = [];
  for (const slot of slots) {
    if (slot.objectType !== EMPTY) continue;
    free.push({ slotId: slot.slotId, objectType: EMPTY, expectedQuantity: undefined });
  }
  return free;
}

/**
 * Whether every stated slot of a group holds nothing or an item.
 *
 * Anything else — an exalt total, a quest count — says these stats are not the
 * group's slots, and the ones beside them that do read as empty are not empty
 * slots either.
 */
function holdsItems(slots: readonly ItemSlotView[], isItem: IsItem): boolean {
  for (const slot of slots) {
    if (slot.objectType !== EMPTY && !isItem(slot.objectType)) return false;
  }
  return true;
}
