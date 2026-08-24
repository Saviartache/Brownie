/**
 * Everything auto-loot remembers about one connection.
 *
 * All of it is timing. The protocol has no acknowledgement for "the item you
 * asked for is now in slot seven" — what confirms a move is the destination
 * filling on a later tick — so every rule here exists to stop a second move
 * being sent before the first has been answered, and to stop a move that was
 * silently refused from wedging everything behind it.
 */

import type { InventoryView } from '@brownie/plugin-api';
import { MOVEMENT_EPSILON, PENDING_TIMEOUT_MS } from './constants.js';

/**
 * A set of keys held until a deadline.
 *
 * The reference implementation kept three near-identical maps of these — bag
 * slots taken from, destination slots aimed at, and items tried too recently to
 * try again. Two of the three were only ever needed because a potion moved onto
 * the potion belt could not be *seen* to arrive; nothing writes to the belt any
 * more (see `destination.ts`), and a move to an ordinary slot is confirmed by
 * the slot filling, so what is left is the retry cooldown.
 */
export class Claims<K> {
  readonly #until = new Map<K, number>();

  get size(): number {
    return this.#until.size;
  }

  hold(key: K, untilMs: number): void {
    const existing = this.#until.get(key);
    if (existing === undefined || existing < untilMs) this.#until.set(key, untilMs);
  }

  held(key: K, nowMs: number): boolean {
    const until = this.#until.get(key);
    return until !== undefined && until > nowMs;
  }

  /** Drops what has lapsed. Bounds the map; nothing else depends on it. */
  expire(nowMs: number): void {
    for (const [key, until] of this.#until) {
      if (until <= nowMs) this.#until.delete(key);
    }
  }

  clear(): void {
    this.#until.clear();
  }
}

/** Where a move took an item from — one slot of one container. */
export interface MoveSource {
  readonly objectId: number;
  readonly slot: number;
  readonly objectType: number;
}

/** A move that has gone out and not yet been seen to land. */
export interface PendingMove {
  readonly slotId: number;
  /** What the slot's count should read once it lands, for a slot that counts. */
  readonly expectedQuantity: number | undefined;
  /** The bag slot it came out of, which has to be seen to empty. */
  readonly source: MoveSource;
  readonly sinceMs: number;
  /** Whether it was a quaff potion, which is what the manual guard cares about. */
  readonly potion: boolean;
}

export class LootSession {
  /** Items tried recently, so a refusal is retried rather than spun on. */
  readonly attempts = new Claims<string>();

  /** Bags already announced, so the notifier says each one once. */
  readonly announced = new Set<number>();

  /**
   * Object types the player has dropped or dumped back, so auto-loot does not
   * put them straight back. Kept for the map — an item type is the same across
   * maps, but the intent to leave one behind belongs to this run.
   */
  readonly droppedTypes = new Set<number>();

  /**
   * When the last item packet went out.
   *
   * The spacing every move is held to, and it is never reset — see
   * `PICKUP_INTERVAL_MS` for the sessions that cost.
   */
  lastActionAtMs = Number.NEGATIVE_INFINITY;
  /** Until when the player's own potion packets are held back. */
  blockUntilMs = 0;
  /** Until when auto-loot stands down after the player acted by hand. */
  pauseUntilMs = 0;

  #pending: PendingMove | undefined;
  #lastX = Number.NaN;
  #lastY = Number.NaN;
  #stationaryTicks = 0;

  get pending(): PendingMove | undefined {
    return this.#pending;
  }

  get stationaryTicks(): number {
    return this.#stationaryTicks;
  }

  startPending(move: PendingMove): void {
    this.#pending = move;
  }

  /**
   * Clears the pending move once it has been seen to happen at **both ends**,
   * or has waited long enough to be assumed lost.
   *
   * Both ends, because one is not enough. The destination filling says the item
   * arrived; the bag slot emptying says the server has told us about the bag it
   * came out of. Acting on the first alone means the next swap is aimed using a
   * picture of the bag from before the last one — and a swap naming a bag slot
   * that no longer holds what we say it holds is how the second pickup out of
   * one bag ended a session.
   *
   * @param sourceCleared Whether the bag slot this came out of has been seen to
   *   change. A bag that is gone entirely counts: there is nothing left to be
   *   stale about.
   * @returns the move that was **abandoned** — sent, waited on, and never seen
   *   to arrive. Silence is the only answer a move the server will not carry
   *   out ever gets, so this is it. It is not held against the item: once the
   *   pending move is cleared the item is free to be tried again, paced by its
   *   own retry cooldown and the never-reset spacing floor, which is what keeps
   *   a refusal from turning into a packet a second while still letting a bag
   *   that is simply slow to answer be looted in the end.
   */
  resolvePending(
    inventory: InventoryView,
    sourceCleared: (move: PendingMove) => boolean,
    nowMs: number,
  ): PendingMove | undefined {
    const move = this.#pending;
    if (move === undefined) return undefined;
    if (landed(inventory, move) && sourceCleared(move)) {
      this.#pending = undefined;
      return undefined;
    }
    if (nowMs - move.sinceMs < PENDING_TIMEOUT_MS) return undefined;
    this.#pending = undefined;
    return move;
  }

  /** Records where the player is, and how long they have been there. */
  trackMovement(x: number, y: number): void {
    const moved =
      Number.isNaN(this.#lastX) ||
      Math.abs(x - this.#lastX) > MOVEMENT_EPSILON ||
      Math.abs(y - this.#lastY) > MOVEMENT_EPSILON;
    this.#lastX = x;
    this.#lastY = y;
    this.#stationaryTicks = moved ? 0 : this.#stationaryTicks + 1;
  }

  /** Drops what has lapsed from every claim. */
  expire(nowMs: number): void {
    this.attempts.expire(nowMs);
  }

  /**
   * Forgets everything about where things were.
   *
   * Called on a map change, and an object id is only unique within a map — so a
   * bag remembered across one is not stale data, it is a different object
   * wearing the same number.
   */
  reset(): void {
    this.attempts.clear();
    this.announced.clear();
    this.droppedTypes.clear();
    this.#pending = undefined;
    this.lastActionAtMs = Number.NEGATIVE_INFINITY;
    this.#lastX = Number.NaN;
    this.#lastY = Number.NaN;
    this.#stationaryTicks = 0;
  }
}

/** Names one item in one slot of one bag. */
export function bagSlotKey(objectId: number, slot: number, objectType: number): string {
  return `${String(objectId)}:${String(slot)}:${String(objectType)}`;
}

function landed(inventory: InventoryView, move: PendingMove): boolean {
  const slot = inventory.at(move.slotId);
  if (slot === undefined) return false;
  // A slot being occupied answers it, except for one that was already occupied
  // before the move — a stack being added to, where the count is the evidence.
  return move.expectedQuantity === undefined
    ? slot.objectType !== -1
    : slot.quantity >= move.expectedQuantity;
}
