/**
 * Getting out of the player's way when they touch a potion themselves.
 *
 * Two hands on one inventory is the one thing that actually breaks: auto-loot
 * moves a potion into a belt slot while the player drags another out of it, and
 * the client's picture of its own slots stops matching the server's until the
 * next full stat update.
 *
 * **The half that matters is standing down**, and it is unconditional: any
 * manual potion or belt action pauses auto-loot for a few seconds. Nothing is
 * lost by waiting.
 *
 * **The half that withholds a packet is deliberately narrower than the
 * reference implementation's.** That one dropped the player's `USEITEM` as well
 * — so a manual quaff in a panic could be swallowed while one of its own swaps
 * settled, which is a way to die for a tidy inventory. Only *moves* collide
 * with a move, so only moves are withheld, and only in the short window where
 * one of ours is already in flight.
 */

import type { MutablePacket } from '@brownie/plugin-api';

/** The three packets that move or consume an item. */
export const GUARDED_PACKETS: readonly string[] = ['USEITEM', 'INVENTORYSWAP', 'INVDROP'];

/** Moving one is what can collide with a move of ours. Quaffing one cannot. */
const MOVE_PACKETS: ReadonlySet<string> = new Set(['INVENTORYSWAP', 'INVDROP']);

/** The fields that carry a slot, across the three packets. */
const SLOT_FIELDS: readonly string[] = ['slotObject', 'slotObject1', 'slotObject2'];

/**
 * Whether a packet touches a potion or a belt slot.
 *
 * @param isPotion Whether an object type is a potion, from the catalog.
 * @param isBeltSlot Whether a slot id names a potion-belt slot.
 */
export function touchesPotions(
  packet: MutablePacket,
  isPotion: (objectType: number) => boolean,
  isBeltSlot: (slotId: number) => boolean,
): boolean {
  for (const field of SLOT_FIELDS) {
    const slot = packet.get(field);
    if (typeof slot !== 'object' || Array.isArray(slot)) continue;
    const record = slot as Record<string, unknown>;
    const slotId = record['slotId'];
    const objectType = record['objectType'];
    if (typeof slotId === 'number' && isBeltSlot(slotId)) return true;
    if (typeof objectType === 'number' && objectType > 0 && isPotion(objectType)) return true;
  }
  return false;
}

/**
 * Whether to withhold a packet already known to touch potions.
 *
 * False does not mean "do nothing": every such packet stands auto-loot down.
 * This only decides the narrower question of whether the packet itself would
 * collide with one of ours.
 *
 * @param movePending Whether a potion move of ours has gone out and not landed.
 * @param withinBlockWindow Whether the short window after one of ours is open.
 */
export function shouldWithhold(
  packetName: string,
  movePending: boolean,
  withinBlockWindow: boolean,
): boolean {
  if (!MOVE_PACKETS.has(packetName)) return false;
  return movePending || withinBlockWindow;
}
