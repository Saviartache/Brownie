/**
 * Holding a few stats of one object at values of our own, and putting back
 * exactly what the server sent once an override goes away.
 *
 * Two things make this more than a field write. The client **keeps a stat it
 * has been told**, so a value only has to be written when what the client
 * believes differs from what we want — writing it every tick would re-encode
 * every packet to repeat what the client already holds. And a stat the server
 * never sends at all still has to reach the client, so an override has to be
 * able to *inject* one rather than only rewrite what arrived.
 *
 * The originals are remembered per stat id, so switching an override off — or
 * moving it to a different stat id — restores what the server last said instead
 * of guessing zero.
 *
 * One instance belongs to one session and one object; nothing here is shared.
 */

import type { FieldValue } from '@brownie/protocol';

/**
 * A decoded `Status` and its stats, as things this feature has decided it may
 * edit.
 *
 * Decoded field values are described as deeply readonly because *reading* a
 * packet should not imply the right to rewrite it. Rewriting in place is what
 * this does, so that a tick which changed one number is not rebuilt.
 */
export interface MutableStatus {
  objectId?: FieldValue;
  data?: FieldValue;
}

interface MutableStat {
  id?: FieldValue;
  value?: FieldValue;
  stackCount?: FieldValue;
}

/** What a stat reads as client-side when no status ever carried it. */
const ABSENT_VALUE = 0;

export class StatOverrides {
  /** statId → the last value the server actually sent for it. */
  readonly #originals = new Map<number, number>();
  /** statId → the value the client was last made to see, for ids we drive. */
  readonly #applied = new Map<number, number>();

  /** Whether anything is currently being held away from the server's value. */
  get active(): boolean {
    return this.#applied.size > 0;
  }

  /**
   * Brings one status in line with `targets`, editing it in place.
   *
   * @param announced true for a status out of `UPDATE.newObjs`, where the
   *   client is *creating* the object: everything it was previously told is
   *   gone with the old object, so an injected stat has to be injected again.
   *   Without this, re-entering a map would leave the glow behind.
   * @returns whether the status was edited — a packet that would re-encode to
   *   the bytes it arrived as should forward as those bytes instead.
   */
  applyTo(
    status: MutableStatus,
    targets: ReadonlyMap<number, number>,
    announced: boolean,
  ): boolean {
    if (announced) this.#applied.clear();
    if (targets.size === 0 && this.#applied.size === 0) return false;

    const data = status.data;
    // A status with no stat array is not one to invent fields for.
    if (!Array.isArray(data)) return false;
    const stats = data as unknown as MutableStat[];

    let changed = false;
    for (const [id, value] of targets) {
      if (this.#write(stats, id, value)) changed = true;
    }
    // Ids we used to drive and no longer do — a mode change, or an override
    // moved to a different stat id. Deleting the entry being visited is well
    // defined for a `Map`, and copying the key set every tick is not worth it
    // for the two or so ids this ever holds.
    for (const id of this.#applied.keys()) {
      if (targets.has(id)) continue;
      if (this.#restore(stats, id)) changed = true;
    }
    return changed;
  }

  /** Forgets both the originals and what the client was told. */
  reset(): void {
    this.#originals.clear();
    this.#applied.clear();
  }

  #write(stats: MutableStat[], id: number, wanted: number): boolean {
    const existing = findStat(stats, id);
    if (existing === undefined) {
      if (this.#applied.get(id) === wanted) return false;
      stats.push({ id, value: wanted, stackCount: 0 });
      this.#applied.set(id, wanted);
      return true;
    }

    const sent = existing.value;
    // A stat the server sends as text is one the encoder writes as text, so a
    // number put there would reach the client as an empty string. Only
    // reachable by retargeting an id by hand, and then leaving it alone is the
    // only safe answer.
    if (typeof sent !== 'number') return false;

    this.#originals.set(id, sent);
    this.#applied.set(id, wanted);
    if (sent === wanted) return false;
    existing.value = wanted;
    return true;
  }

  #restore(stats: MutableStat[], id: number): boolean {
    this.#applied.delete(id);

    const existing = findStat(stats, id);
    if (existing !== undefined) {
      // The server's own value is on its way to the client already: this
      // packet *is* the restore, and the original is worth recording from it.
      if (typeof existing.value === 'number') this.#originals.set(id, existing.value);
      return false;
    }

    stats.push({ id, value: this.#originals.get(id) ?? ABSENT_VALUE, stackCount: 0 });
    return true;
  }
}

/** The `Status` in a `NEWTICK.statuses` element, if that is what it is. */
export function asStatus(value: FieldValue | undefined): MutableStatus | undefined {
  if (typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as unknown as MutableStatus;
}

/** The `Status` nested in an `Entity` element of `UPDATE.newObjs`. */
export function statusOfEntity(value: FieldValue | undefined): MutableStatus | undefined {
  if (typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entity = value as unknown as Record<string, FieldValue | undefined>;
  return asStatus(entity['status']);
}

function findStat(stats: readonly MutableStat[], id: number): MutableStat | undefined {
  for (const stat of stats) {
    if (stat.id === id) return stat;
  }
  return undefined;
}
