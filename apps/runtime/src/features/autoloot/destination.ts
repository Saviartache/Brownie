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
 * Pure, and testable as a table.
 */

import type { InventoryView, ItemSlotView } from '@brownie/plugin-api';

/** Whether a slot has already refused an item and should be left alone. */
export type SlotRefused = (slotId: number) => boolean;

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
  refused: SlotRefused,
): Destination | undefined {
  if (beltStack <= 0) return undefined;

  let firstEmpty: ItemSlotView | undefined;
  for (const slot of inventory.belt()) {
    if (refused(slot.slotId)) continue;
    if (slot.objectType === objectType) {
      // A count is what says the game stacks this slot at all.
      if (slot.quantity <= 0 || slot.quantity >= beltStack) return undefined;
      return { slotId: slot.slotId, objectType, expectedQuantity: slot.quantity + 1 };
    }
    if (slot.objectType === -1 && firstEmpty === undefined) firstEmpty = slot;
  }

  return firstEmpty === undefined
    ? undefined
    : { slotId: firstEmpty.slotId, objectType: -1, expectedQuantity: 1 };
}

/**
 * The first free slot the player has allowed, or `undefined` when full.
 *
 * `refused` is what makes a mistake here self-limiting rather than endless: a
 * slot the server would not take an item into is skipped from then on, so the
 * search moves along the inventory instead of retrying the same refusal.
 */
export function findFreeSlot(
  inventory: InventoryView,
  useBackpack: boolean,
  backpackFirst: boolean,
  refused: SlotRefused,
): Destination | undefined {
  const carried = (): Destination | undefined => firstEmpty(inventory.carried(), refused);
  const backpack = (): Destination | undefined =>
    useBackpack ? firstEmpty(inventory.backpack(), refused) : undefined;

  return backpackFirst ? (backpack() ?? carried()) : (carried() ?? backpack());
}

function firstEmpty(slots: readonly ItemSlotView[], refused: SlotRefused): Destination | undefined {
  for (const slot of slots) {
    if (slot.objectType !== -1 || refused(slot.slotId)) continue;
    return { slotId: slot.slotId, objectType: -1, expectedQuantity: undefined };
  }
  return undefined;
}
