import type { InventoryView, ItemSlotView } from '@brownie/plugin-api';
import { isBackpackSlot, isBeltSlot, isCarriedSlot, slotIdOfStat } from './ItemSlots.js';
import type { StatEntry } from './stats.js';

/** One slot, as the store keeps it. Handed out through the read-only view. */
class SlotRecord implements ItemSlotView {
  objectType = -1;
  quantity = 0;

  constructor(readonly slotId: number) {}
}

/**
 * What the player is wearing, carrying and drinking from.
 *
 * **A slot exists here only once the server has stated it.** That is the whole
 * design, and it is what makes the unresolved stat-id question in
 * `ItemSlots.ts` survivable: an id pointed at nothing reports nothing, and a
 * feature reading this does less rather than something wrong. The alternative —
 * a fixed array with -1 in the gaps — cannot tell "empty" from "never told",
 * and the difference between those is a swap aimed at a slot that is full.
 *
 * The server states every slot in the first `UPDATE` that carries the character
 * and thereafter only the ones that changed, so this accumulates rather than
 * being rebuilt per tick. {@link reset} is what forgets a character, and it is
 * called on the same events that forget the rest of {@link SelfState}.
 */
export class PlayerInventory implements InventoryView {
  readonly #bySlot = new Map<number, SlotRecord>();

  /**
   * The three groups, rebuilt only when a slot is stated for the first time.
   *
   * Membership changes a handful of times per character; these are read on
   * every tick by anything looking for a free slot or a potion. Contents change
   * constantly and do not invalidate anything — a record edited in place is the
   * same record in the same group.
   */
  #carried: SlotRecord[] | undefined;
  #backpack: SlotRecord[] | undefined;
  #belt: SlotRecord[] | undefined;

  carried(): readonly ItemSlotView[] {
    this.#carried ??= this.#collect(isCarriedSlot);
    return this.#carried;
  }

  backpack(): readonly ItemSlotView[] {
    this.#backpack ??= this.#collect(isBackpackSlot);
    return this.#backpack;
  }

  belt(): readonly ItemSlotView[] {
    this.#belt ??= this.#collect(isBeltSlot);
    return this.#belt;
  }

  at(slotId: number): ItemSlotView | undefined {
    return this.#bySlot.get(slotId);
  }

  /**
   * Records what the server said about any slot in this batch.
   *
   * A stat whose value is a string is skipped rather than coerced: a slot holds
   * an object type, and a string one would be a stat that is not a slot at all.
   */
  applyStats(stats: readonly StatEntry[]): void {
    for (const stat of stats) {
      const slotId = slotIdOfStat(stat.id);
      if (slotId === undefined || typeof stat.value !== 'number') continue;

      let record = this.#bySlot.get(slotId);
      if (record === undefined) {
        record = new SlotRecord(slotId);
        this.#bySlot.set(slotId, record);
        this.#invalidate(slotId);
      }
      record.objectType = Math.trunc(stat.value);
      // Only the belt stacks, and only the belt sends a count. Everywhere else
      // this is the zero the wire carried, which is what "does not stack" reads
      // as — see `ItemSlotView.quantity`.
      record.quantity = stat.stackCount > 0 ? Math.trunc(stat.stackCount) : 0;
    }
  }

  /** Forgets the character, keeping nothing that could describe the next one. */
  reset(): void {
    this.#bySlot.clear();
    this.#carried = undefined;
    this.#backpack = undefined;
    this.#belt = undefined;
  }

  #invalidate(slotId: number): void {
    if (isCarriedSlot(slotId)) this.#carried = undefined;
    else if (isBackpackSlot(slotId)) this.#backpack = undefined;
    else if (isBeltSlot(slotId)) this.#belt = undefined;
  }

  /** The stated slots of one group, in slot order — which is the order a
   *  caller looking for "the first free one" means. */
  #collect(matches: (slotId: number) => boolean): SlotRecord[] {
    const found: SlotRecord[] = [];
    for (const record of this.#bySlot.values()) {
      if (matches(record.slotId)) found.push(record);
    }
    found.sort((a, b) => a.slotId - b.slotId);
    return found;
  }
}
