/**
 * Where the next potion to drink is.
 *
 * Pure, and separated from the plugin because the order it searches in is the
 * only interesting decision it makes: the belt is a stack of six that costs one
 * slot, and everything taken out of it has to be replaced by hand, so a player
 * who has filled it usually wants it drained first.
 *
 * **Reading the belt is safe in a way that writing to it is not**, and the
 * difference is what this file relies on. A drink names a slot the server has
 * just described and repeats its contents straight back — so being wrong about
 * which stat carries the belt cannot produce a claim the server did not make.
 * A *swap* had to assert that a belt slot was empty, which is a claim the
 * server never made, and doing that killed a live session; nothing writes to
 * the belt any more (see `autoloot/destination.ts`).
 *
 * The guard that makes reading safe is the stack count: a belt slot reports one
 * and nothing else on the wire does, so a slot with no count is not treated as
 * a belt slot at all.
 */

import type { InventoryView, ItemSlotView } from '@brownie/plugin-api';
import type { Quaff } from './potions.js';

/** A potion that can be drunk, named the way `USEITEM` names it. */
export interface FoundPotion {
  readonly slotId: number;
  readonly objectType: number;
}

/**
 * The first potion of the wanted kind.
 *
 * @param beltFirst Search the potion belt before the carried slots. Off, the
 *   belt is searched last — which is what a player hoarding it for an emergency
 *   means by keeping it full.
 */
export function findPotion(
  inventory: InventoryView,
  wanted: Quaff,
  kindOf: (objectType: number) => Quaff | undefined,
  beltFirst: boolean,
): FoundPotion | undefined {
  const belt = (): FoundPotion | undefined => search(inventory.belt(), wanted, kindOf, true);
  const carried = (): FoundPotion | undefined =>
    search(inventory.carried(), wanted, kindOf, false) ??
    search(inventory.backpack(), wanted, kindOf, false);

  return beltFirst ? (belt() ?? carried()) : (carried() ?? belt());
}

/**
 * @param stacked Whether the group counts what is in a slot. The belt reports a
 *   quantity and an emptied belt slot keeps naming the potion that was in it,
 *   so a slot with none left is not a potion — while everywhere else the count
 *   is zero because nothing there stacks at all.
 */
function search(
  slots: readonly ItemSlotView[],
  wanted: Quaff,
  kindOf: (objectType: number) => Quaff | undefined,
  stacked: boolean,
): FoundPotion | undefined {
  for (const slot of slots) {
    if (slot.objectType <= 0) continue;
    if (stacked && slot.quantity <= 0) continue;
    if (kindOf(slot.objectType) !== wanted) continue;
    return { slotId: slot.slotId, objectType: slot.objectType };
  }
  return undefined;
}
