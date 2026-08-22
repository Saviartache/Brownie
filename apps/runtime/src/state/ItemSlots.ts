/**
 * Where the player's own item slots live: the id the item packets name a slot
 * by, and the stat the server states its contents in.
 *
 * Two numbering schemes meet here and they are not the same scheme.
 * `SlotObject.slotId` — what `USEITEM` and `INVENTORYSWAP` carry — is one flat
 * space: 0–11 the character itself, 12–27 the backpack, and the potion belt a
 * million above. The *stats* that report what is in those slots are scattered,
 * and where they are scattered to is a fact about a game build.
 *
 * **The two stat tables in this repository disagree about the backpack and the
 * belt.** `packages/protocol/data/stat-types.json` puts the backpack at 135–142
 * and 148–155 with the belt at 143–145, which is what this file uses because
 * that table is the repository's stated source for stat ids. The reference
 * implementation, from a live capture, put the backpack at 131–146 and the belt
 * at 116–118. Both cannot be right and neither can be settled from a file on
 * disk — the game's own metadata is name-obfuscated, so the enum is not in it.
 *
 * What makes leaving that unresolved safe is that a slot is only ever known
 * when the server actually stated it (see {@link PlayerInventory}). Point these
 * at the wrong ids and nothing is *reported* for the backpack or the belt: a
 * pickup declines to use the backpack, a drink declines to use the belt, and
 * both fall back to the eight carried slots, whose ids the two tables agree on.
 * Nothing acts on a slot it invented. Correcting a build is an edit to the four
 * numbers below and to nothing else.
 */

/**
 * The slot-id space the item packets use.
 *
 * Slots 0 to 3 are what the character is wearing — weapon, ability, armour,
 * ring — and are deliberately not a range here: nothing may treat one as
 * somewhere to put a looted item, and the way to guarantee that is for no
 * predicate below to answer for them.
 */
export const SlotRange = {
  /** The eight the character carries. */
  CarriedFirst: 4,
  CarriedLast: 11,
  BackpackFirst: 12,
  BackpackLast: 27,
  /** A potion-belt slot is named as this plus its index. */
  BeltFirst: 1_000_000,
  BeltLast: 1_000_002,
} as const;

/** The stat carrying slot 0; the eleven that follow are consecutive. */
const WORN_AND_CARRIED_STAT = 8;
/** The stat carrying backpack slot 0; seven more follow it. */
const BACKPACK_STAT = 135;
/** The stat carrying backpack slot 8 — the extender's half, elsewhere. */
const BACKPACK_EXTENDER_STAT = 148;
/** The stat carrying belt slot 0; two more follow it. */
const BELT_STAT = 143;

/** Slots 0–11: the four worn and the eight carried, numbered together. */
const OWN_SLOTS = 12;
const BACKPACK_FIRST_HALF = 8;
const BACKPACK_SLOTS = 16;
const BELT_SLOTS = 3;

/** Stat id → the packet slot id it carries, for every slot this knows about. */
const SLOT_BY_STAT = buildSlotByStat();

function buildSlotByStat(): ReadonlyMap<number, number> {
  const bySlot = new Map<number, number>();
  for (let slot = 0; slot < OWN_SLOTS; slot += 1) {
    bySlot.set(WORN_AND_CARRIED_STAT + slot, slot);
  }
  for (let index = 0; index < BACKPACK_SLOTS; index += 1) {
    const stat =
      index < BACKPACK_FIRST_HALF
        ? BACKPACK_STAT + index
        : BACKPACK_EXTENDER_STAT + (index - BACKPACK_FIRST_HALF);
    bySlot.set(stat, SlotRange.BackpackFirst + index);
  }
  for (let index = 0; index < BELT_SLOTS; index += 1) {
    bySlot.set(BELT_STAT + index, SlotRange.BeltFirst + index);
  }
  return bySlot;
}

/** The slot a stat carries, or `undefined` for a stat that carries no slot. */
export function slotIdOfStat(statId: number): number | undefined {
  return SLOT_BY_STAT.get(statId);
}

/** Whether a slot id names one of the eight the character carries. */
export function isCarriedSlot(slotId: number): boolean {
  return slotId >= SlotRange.CarriedFirst && slotId <= SlotRange.CarriedLast;
}

/** Whether a slot id names one in the backpack. */
export function isBackpackSlot(slotId: number): boolean {
  return slotId >= SlotRange.BackpackFirst && slotId <= SlotRange.BackpackLast;
}

/** Whether a slot id names one on the potion belt. */
export function isBeltSlot(slotId: number): boolean {
  return slotId >= SlotRange.BeltFirst && slotId <= SlotRange.BeltLast;
}
