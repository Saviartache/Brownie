/**
 * What the player has just pushed out of their own inventory.
 *
 * Auto-loot takes items out of bags and into the inventory; the player moving
 * one the other way — dropping it on the ground, or dumping it back into the bag
 * it came from — is a plain statement that they do not want it. Reading that off
 * the packet is what lets auto-loot leave it where they put it instead of
 * grabbing it straight back, one against the other, for as long as they stand
 * on the bag.
 *
 * A withdrawal *out* of a bag is not a drop: the item is moving into the
 * inventory, which is exactly where auto-loot would have put it. Nor is a swap
 * between two of the player's own slots — that is a rearrangement, and nothing
 * has left the inventory at all.
 *
 * Pure, and testable without a session or a live packet stream.
 */

import type { MutablePacket } from '@brownie/plugin-api';

/** The only two fields of a slot object this needs. */
interface Slot {
  readonly objectId: number;
  readonly objectType: number;
}

/** Reads one `SlotObject` field, or `undefined` if it is absent or malformed. */
function slotOf(packet: MutablePacket, field: string): Slot | undefined {
  const raw = packet.get(field);
  if (typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const objectId = record['objectId'];
  const objectType = record['objectType'];
  if (typeof objectId !== 'number' || typeof objectType !== 'number') return undefined;
  return { objectId, objectType };
}

/**
 * The object type the player took out of their own inventory, or `undefined`.
 *
 * @param selfObjectId The player's own object id, which is what tells their
 *   inventory apart from a bag's.
 */
export function droppedObjectType(packet: MutablePacket, selfObjectId: number): number | undefined {
  if (packet.name === 'INVDROP') {
    const slot = slotOf(packet, 'slotObject');
    return slot !== undefined && slot.objectId === selfObjectId && slot.objectType > 0
      ? slot.objectType
      : undefined;
  }

  if (packet.name === 'INVENTORYSWAP') {
    const first = slotOf(packet, 'slotObject1');
    const second = slotOf(packet, 'slotObject2');
    if (first === undefined || second === undefined) return undefined;

    // The item leaving the inventory sits on the player's side; the other side
    // is the bag it is going into. Which of the two the client names first is
    // not fixed, so it is found by object id rather than by position.
    const mine = first.objectId === selfObjectId ? first : second;
    const other = mine === first ? second : first;
    // Both sides the player's own is a rearrangement; the player's side empty is
    // a pickup coming the other way. Neither is a drop.
    if (mine.objectId !== selfObjectId || other.objectId === selfObjectId) return undefined;
    return mine.objectType > 0 ? mine.objectType : undefined;
  }

  return undefined;
}
