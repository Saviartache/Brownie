/**
 * Pointing the game's own quest arrow at a bag worth walking to.
 *
 * **The arrow is the client's, and so is everything it does.** The server names
 * the quest with `QUESTOBJECTID`; the client keeps the id, looks it up among the
 * objects it holds every frame, and points its arrow at whatever answers —
 * with that object's own picture on it and its name in the tooltip, hidden
 * while the object is on screen. A loot bag is filed among those objects like
 * any monster, so a bag's id in that packet points the same arrow at the bag.
 * The packet only ever travels towards the client: the server never hears it.
 *
 * **One arrow, so one bag, and the real quest waits.** While a bag is named, the
 * server's own quest packets are held back; the world model has already
 * recorded them, and the quest it holds is named again the moment no bag is
 * left. See `WorldView.questObjectId`.
 */

import type { NearbyBag } from './bags.js';

/**
 * The loot tiers worth the arrow, best first.
 *
 * 6 is the white bag — every untiered item drops in it — and 8 the orange one,
 * which carries the set pieces. See `ContainerFacts.lootTier`. White comes
 * first because it is the rarer, and because the arrow only shows while its bag
 * is off screen: pointed at an orange bag the player can already see, it would
 * be hidden from the white one further off.
 */
export const QUEST_BAG_TIERS: readonly number[] = [6, 8];

/**
 * The bag the arrow should point at, or nothing.
 *
 * @param bags Every bag in the world, nearest first — so the first of a tier is
 *   the nearest one of it.
 */
export function pickQuestBag(bags: readonly NearbyBag[]): NearbyBag | undefined {
  for (const tier of QUEST_BAG_TIERS) {
    const bag = bags.find((candidate) => candidate.facts.lootTier === tier);
    if (bag !== undefined) return bag;
  }
  return undefined;
}

/**
 * How long a bag the arrow stays on goes without being named again.
 *
 * **Restated rather than trusted.** The client keeps whatever it heard last,
 * and a plugin that stopped for a while — switched off for failing, then back
 * on — let the server's own quest packets through to it, so after that the
 * arrow is on the quest while this side still believes it is on the bag.
 * Merely switching it off does not: none of this is behind the switch. Naming
 * the object the client already holds costs the client nothing: it looks up
 * the same id and finds the same bag.
 */
export const RESTATE_MS = 2000;

/**
 * What one client has been told its quest is.
 *
 * A change goes out at once; a bag that stays is named again every
 * {@link RESTATE_MS}; the server's own quest is named once, when the arrow
 * leaves a bag, and after that the server's packets are the ones naming it.
 */
export class QuestArrow {
  /** The bag the client is pointing at, or `undefined` while it holds the server's quest. */
  #bagId: number | undefined;
  #saidAtMs = Number.NEGATIVE_INFINITY;

  /** Whether the client is pointing at a bag rather than at the server's quest. */
  get pointingAtBag(): boolean {
    return this.#bagId !== undefined;
  }

  /**
   * The id to name to the client now, or `undefined` when there is nothing to
   * say.
   *
   * @param bagId The bag to point at, or `undefined` for none.
   * @param questId The server's own quest, which is what the arrow goes back
   *   to once no bag is wanted.
   * @param nowMs The session's clock, for pacing the restatement.
   */
  next(bagId: number | undefined, questId: number, nowMs: number): number | undefined {
    if (bagId === this.#bagId && (bagId === undefined || nowMs - this.#saidAtMs < RESTATE_MS)) {
      return undefined;
    }
    this.#bagId = bagId;
    this.#saidAtMs = nowMs;
    return bagId ?? questId;
  }
}
