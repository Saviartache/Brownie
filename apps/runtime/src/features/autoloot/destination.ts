/**
 * Where a looted item is put.
 *
 * Two questions, and they are different ones: a quaff potion goes on the potion
 * belt if the belt will take it — one slot holds six — and everything else goes
 * in the first free slot the player has asked to fill.
 *
 * Pure. What is *claimed* is passed in rather than read, so the rules here have
 * no idea a claim exists and stay testable as a table.
 */

import type { InventoryView, ItemSlotView } from '@brownie/plugin-api';

/** A slot an item can be moved into, named the way `INVENTORYSWAP` names it. */
export interface Destination {
  readonly slotId: number;
  /**
   * What is in the slot now.
   *
   * The packet carries it and the server checks it against its own view, so a
   * slot we believe is empty and is not gets the swap refused rather than the
   * item that was there thrown into the bag. That check is what makes a wrong
   * guess about the slot stats cost nothing — see `state/ItemSlots.ts`.
   */
  readonly objectType: number;
  /** What the slot's count should read once the move lands, when it counts. */
  readonly expectedQuantity: number | undefined;
}

/** Whether a slot is already spoken for by a move still settling. */
export type SlotClaimed = (slotId: number) => boolean;

/**
 * A potion-belt slot for this potion, or `undefined` if the belt will not take
 * it.
 *
 * Stacks onto a slot already holding the same potion while there is room. When
 * there is such a slot and it is *full*, the answer is nothing rather than an
 * empty slot: a second stack of the same potion on the belt is not what anyone
 * wants, and the reference implementation learned that by producing them.
 */
export function findBeltDestination(
  inventory: InventoryView,
  objectType: number,
  beltStack: number,
  claimed: SlotClaimed,
): Destination | undefined {
  if (beltStack <= 0) return undefined;

  let firstEmpty: ItemSlotView | undefined;
  for (const slot of inventory.belt()) {
    if (claimed(slot.slotId)) continue;
    if (slot.objectType === objectType) {
      return slot.quantity > 0 && slot.quantity < beltStack
        ? { slotId: slot.slotId, objectType, expectedQuantity: slot.quantity + 1 }
        : undefined;
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
 * Only slots the server has actually stated are candidates, which is what the
 * inventory view guarantees — so a character whose backpack is not being
 * reported has no free backpack slots rather than sixteen imaginary ones.
 */
export function findFreeSlot(
  inventory: InventoryView,
  useBackpack: boolean,
  backpackFirst: boolean,
  claimed: SlotClaimed,
): Destination | undefined {
  const carried = (): Destination | undefined => firstEmpty(inventory.carried(), claimed);
  const backpack = (): Destination | undefined =>
    useBackpack ? firstEmpty(inventory.backpack(), claimed) : undefined;

  return backpackFirst ? (backpack() ?? carried()) : (carried() ?? backpack());
}

function firstEmpty(slots: readonly ItemSlotView[], claimed: SlotClaimed): Destination | undefined {
  for (const slot of slots) {
    if (slot.objectType !== -1 || claimed(slot.slotId)) continue;
    return { slotId: slot.slotId, objectType: -1, expectedQuantity: undefined };
  }
  return undefined;
}
