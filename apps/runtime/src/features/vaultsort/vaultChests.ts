/**
 * What the vault's chests hold, as the server last stated it.
 *
 * Two packets say, and neither says it alone. `VAULTCONTENT` arrives with the
 * whole of every chest — on entering the vault, on opening a chest's panel, and
 * after the contents change — and `INVRESULT` arrives after each swap the
 * server carried out, naming the two slots and what each held *before*. A
 * snapshot and a result can describe the same swap in either order, so patching
 * here has to survive hearing about one move twice.
 *
 * So the snapshot is kept and patched, and every patch is **idempotent and
 * trusting**: applying a result that says a slot now holds what it already
 * holds changes nothing, and a result our picture cannot explain is applied
 * anyway — the server performed the swap, so where it says the slots now stand
 * is where they stand. Nothing here ever *rejects* what the server said; a
 * sorter that disagreed with the server was a bug that stopped a live sort the
 * first time it ran.
 *
 * Everything is dropped on `MAPINFO` — an object id is only unique within a
 * map, so a chest remembered across one is a chest that no longer exists.
 *
 * Which chests: the ordinary vault chest and the seasonal spoils chest — the
 * two a player keeps their gear in. The gift, material and potion chests the
 * packet also describes have their own rules and their own interfaces, and are
 * left to the game.
 */

/** One chest as the server last described it. */
export interface VaultChest {
  /** The chest entity in the current map, or -1 when it is not on this map. */
  readonly objectId: number;
  /** Item type per slot; below zero is empty. The length is the capacity. */
  readonly contents: number[];
  /** What the player calls it, for the lines this feature says in chat. */
  readonly label: string;
}

/** One side of a swap, as the swap and its result both spell it. */
export interface SlotRef {
  readonly objectId: number;
  readonly slotId: number;
  readonly objectType: number;
}

/**
 * Beyond this a slot id cannot name a chest slot: the largest chest the game
 * sells is a few hundred slots, and a result that reads further than this is a
 * decode gone wrong rather than a fact about the chest.
 */
const MAX_CHEST_SLOTS = 1024;

/** Reads a slot reference out of a decoded packet field, or says it is not one. */
export function slotRefOf(value: unknown): SlotRef | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { objectId, slotId, objectType } = value as Record<string, unknown>;
  if (
    typeof objectId !== 'number' ||
    typeof slotId !== 'number' ||
    typeof objectType !== 'number'
  ) {
    return undefined;
  }
  return { objectId, slotId, objectType };
}

/**
 * The vault's chests for one session.
 *
 * Held per session and replaced wholesale by each `VAULTCONTENT`, so a run that
 * misses a patch — a chest upgraded, a season rolled over — is corrected by the
 * next snapshot rather than drifting forever.
 */
export class VaultChests {
  #vault: VaultChest | undefined;
  #seasonal: VaultChest | undefined;

  /** Takes a full snapshot, as `VAULTCONTENT` carries it. */
  replace(vault: VaultChest | undefined, seasonal: VaultChest | undefined): void {
    this.#vault = vault !== undefined && vault.objectId > 0 ? vault : undefined;
    this.#seasonal = seasonal !== undefined && seasonal.objectId > 0 ? seasonal : undefined;
  }

  /** The chests that are on this map, vault chest first. */
  chests(): readonly VaultChest[] {
    return [this.#vault, this.#seasonal].filter(
      (chest): chest is VaultChest => chest !== undefined,
    );
  }

  /** The chest with this entity id, if the snapshot describes one. */
  chest(objectId: number): VaultChest | undefined {
    return this.chests().find((chest) => chest.objectId === objectId);
  }

  /** The chest the snapshot files under this label, whatever its entity id. */
  chestByLabel(label: string): VaultChest | undefined {
    return this.chests().find((chest) => chest.label === label);
  }

  /**
   * Applies a swap the server has confirmed, and says whether anything moved.
   *
   * Each side of the result ends holding what the other side held — a plain
   * exchange, whichever chest each side belongs to. A slot beyond the
   * snapshot's capacity grows it, because a confirmed result about a slot is a
   * fact about the chest even when the snapshot predates it. A result that
   * names a slot no chest could have is ignored whole rather than half-applied:
   * one impossible slot means the decode is wrong, and the other side of a
   * mis-decoded swap is not a fact about anything.
   */
  applyResult(from: SlotRef, to: SlotRef): boolean {
    if (
      impossibleSlot(from, this.chest(from.objectId)) ||
      impossibleSlot(to, this.chest(to.objectId))
    ) {
      return false;
    }
    // Each patch re-resolves its chest: when both sides of the swap are on one
    // chest, the first patch replaces the chest object and a reference taken
    // before it would write the second half into a chest nobody holds.
    let changed = false;
    changed = this.#patch(from.objectId, from.slotId, to.objectType) || changed;
    changed = this.#patch(to.objectId, to.slotId, from.objectType) || changed;
    return changed;
  }

  #patch(objectId: number, slotId: number, nowHolds: number): boolean {
    const chest = this.chest(objectId);
    if (chest === undefined) return false;
    const contents = [...chest.contents];
    while (contents.length <= slotId) contents.push(-1);
    // The slot already holding this is the same swap heard twice — a result
    // that raced the snapshot which included it — and re-applying it would put
    // the exchange back.
    if (contents[slotId] === nowHolds) return false;
    contents[slotId] = nowHolds;
    if (chest === this.#vault) this.#vault = { ...chest, contents };
    else this.#seasonal = { ...chest, contents };
    return true;
  }

  /**
   * Applies one of this feature's own moves — what sat at `from` now sits at
   * `to`, and `from` is empty — and says whether anything visibly moved.
   *
   * Written from the picture's own values rather than from anything the result
   * reported: the server checks the types a move carries before executing it,
   * so a result naming our two slots is our move as we asked it, and the types
   * a result *reports* are the one part of this protocol a live session has
   * already disagreed with us about.
   *
   * Always visible: an item appears where a gap was, and the gap moves to
   * where the item was.
   */
  move(objectId: number, from: number, to: number): boolean {
    const chest = this.chest(objectId);
    if (chest === undefined) return false;
    if (from < 0 || from >= MAX_CHEST_SLOTS || to < 0 || to >= MAX_CHEST_SLOTS) return false;
    const held = chest.contents[from] ?? -1;
    let changed = this.#patch(objectId, to, held);
    changed = this.#patch(objectId, from, -1) || changed;
    return changed;
  }

  /** Forgets every chest — called on a map change, when their ids expire. */
  clear(): void {
    this.#vault = undefined;
    this.#seasonal = undefined;
  }
}

/** Whether two pictures of a chest disagree — either one may be no picture. */
export function contentsDiffer(
  a: readonly number[] | undefined,
  b: readonly number[] | undefined,
): boolean {
  if (a === undefined || b === undefined) return a !== b;
  return a.length !== b.length || a.some((type, slot) => type !== b[slot]);
}

/** Whether a side of a result names a slot its chest could not possibly have. */
function impossibleSlot(ref: SlotRef, chest: VaultChest | undefined): boolean {
  return chest !== undefined && (ref.slotId < 0 || ref.slotId >= MAX_CHEST_SLOTS);
}
