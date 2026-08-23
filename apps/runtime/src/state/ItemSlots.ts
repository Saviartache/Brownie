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
 * belt, and the live game settled it against the newer one.**
 * `packages/protocol/data/stat-types.json` puts the backpack at 135–142 and
 * 148–155 with the belt at 143–145. The reference implementation, from a live
 * capture, puts the backpack at 131–146 — contiguous — and the belt at 116–118.
 * It cannot be settled from a file on disk: the game's own metadata is
 * name-obfuscated, so the enum is not in it.
 *
 * Two sessions decided it, both against the JSON table and both explained by
 * the same four-slot shift:
 *
 *  - A swap aimed at potion-belt slot 0 — chosen because stat 143 read as empty
 *    — killed the session outright. Under the capture, 143 is backpack slot 12,
 *    not the belt.
 *  - A swap aimed at backpack slot 4 was refused over and over, chosen because
 *    stat 139 read as empty. Under the capture, 139 is backpack slot **8**, so
 *    the packet named a slot four places earlier than the one that was free —
 *    which is exactly a swap into an occupied slot, and exactly what the server
 *    refuses.
 *
 * So the capture's numbers are the ones below. Being wrong here no longer costs
 * a session either way: a slot is only known when the server actually stated it
 * (see {@link PlayerInventory}), nothing is ever moved *into* the belt (see
 * `features/autoloot/destination.ts`), and a destination that will not take an
 * item is dropped after one refusal rather than retried forever. Under the JSON
 * table these ids report exalt totals and quest counts, which are numbers rather
 * than the -1 an empty slot sends — so a wrong guess reads as "occupied" and is
 * never aimed at. Correcting a future build is an edit to the three numbers
 * below and to the test in `state.test.ts` that pins them.
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
/** The stat carrying backpack slot 0; the fifteen that follow are consecutive. */
const BACKPACK_STAT = 131;
/** The stat carrying belt slot 0; two more follow it. */
const BELT_STAT = 116;

/** Slots 0–11: the four worn and the eight carried, numbered together. */
const OWN_SLOTS = 12;
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
    bySlot.set(BACKPACK_STAT + index, SlotRange.BackpackFirst + index);
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
