/**
 * The name, guild and star count one client believes its own character has.
 *
 * This is not `StatOverrides`, and the reason is the name: that one holds
 * *numeric* stats and refuses a text value outright, because a number written
 * into a stat the encoder writes as text reaches the client as an empty string.
 * Two of the three stats here are text.
 *
 * What it does share with an override is the one thing that makes either more
 * than a field write: **the client keeps a stat it has been told**, so a value
 * is written once rather than into every tick — repeating it would re-encode a
 * packet several times a second to say what the client already believes.
 *
 * **A stat is also stated rather than only rewritten**, and that is what makes
 * the disguise work at all. Identity stats arrive with the object and then
 * never again, so a mode switched on in the middle of a map has no packet to
 * edit: the stat has to be injected into the next tick or nothing changes on
 * screen until the next map.
 *
 * **What is written while the object is being created is not counted as told.**
 * The client seeds its own character from more than the object it is handed —
 * `CREATESUCCESS` carries a stat blob of its own — and a name written into the
 * creating packet did not survive that on the live client: entering a world put
 * the real name back, while the same alias injected into a tick held. So the
 * creating packet is still rewritten, which is what stops the real name being
 * drawn even for a frame, and then the whole identity is stated once more on
 * the first tick that follows.
 *
 * Nothing here restores the real values. Switching the mode off stops the
 * claim, and the server's own values are back the next time the character is
 * created — which is the safe direction for the failure to run in: an identity
 * still hidden after the mode is off costs nothing, and a real name shown while
 * it is on is the whole thing this exists to prevent.
 *
 * One instance belongs to one session and one character; nothing here is shared.
 */

import type { FieldValue } from '@brownie/protocol';
import type { MutableStatus } from '../../state/StatOverrides.js';

/** What a disguised stat can be set to: the two shapes a stat value has. */
export type StatValue = string | number;

interface MutableStat {
  id?: FieldValue;
  value?: FieldValue;
  stackCount?: FieldValue;
}

export class IdentityDisguise {
  /** statId → the value the client was last told, for the object it holds now. */
  readonly #shown = new Map<number, StatValue>();

  /**
   * Brings one status in line with `wanted`, editing it in place.
   *
   * @param announced true for a status out of `UPDATE.newObjs`, where the
   *   client is *creating* the character: it forgets everything it was told
   *   about the old object, and what is written here is not yet a claim it
   *   keeps — see the note above.
   * @returns whether the status was edited — a packet that would re-encode to
   *   the bytes it arrived as should forward as those bytes instead.
   */
  applyTo(
    status: MutableStatus,
    wanted: ReadonlyMap<number, StatValue>,
    announced: boolean,
  ): boolean {
    if (announced) this.#shown.clear();
    if (wanted.size === 0) return false;

    const data = status.data;
    // A status with no stat array is not one to invent fields for.
    if (!Array.isArray(data)) return false;
    const stats = data as unknown as MutableStat[];

    let changed = false;
    for (const [id, value] of wanted) {
      if (this.#write(stats, id, value, announced)) changed = true;
    }
    return changed;
  }

  #write(stats: MutableStat[], id: number, value: StatValue, announced: boolean): boolean {
    const existing = findStat(stats, id);
    if (existing !== undefined) {
      if (!announced) this.#shown.set(id, value);
      if (existing.value === value) return false;
      existing.value = value;
      return true;
    }

    if (this.#shown.get(id) === value) return false;
    stats.push({ id, value, stackCount: 0 });
    if (!announced) this.#shown.set(id, value);
    return true;
  }
}

function findStat(stats: readonly MutableStat[], id: number): MutableStat | undefined {
  for (const stat of stats) {
    if (stat.id === id) return stat;
  }
  return undefined;
}
