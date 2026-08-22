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
 * Three things want exactly this and they wanted three near-identical maps in
 * the reference implementation: bag slots already taken from, destination slots
 * already aimed at, and items tried too recently to try again.
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

/** A move that has gone out and not yet been seen to land. */
export interface PendingMove {
  readonly slotId: number;
  /** What the slot's count should read once it lands, for a slot that counts. */
  readonly expectedQuantity: number | undefined;
  readonly sinceMs: number;
  /** Whether it was a quaff potion, which is what the manual guard cares about. */
  readonly potion: boolean;
}

export class LootSession {
  /** Bag slots taken from, so an emptied slot is not tried again immediately. */
  readonly bagSlots = new Claims<string>();
  /** Destination slots aimed at, so two potions never chase one slot. */
  readonly slots = new Claims<number>();
  /** Items tried recently, so a refusal is retried rather than spun on. */
  readonly attempts = new Claims<string>();

  /** When a bag was first seen, for the shared-bag delay. */
  readonly bagSeenAtMs = new Map<number, number>();
  /** Bags already announced, so the notifier says each one once. */
  readonly announced = new Set<number>();

  /** When the last move went out, for the spacing between consecutive ones. */
  lastActionAtMs = Number.NEGATIVE_INFINITY;
  /** Until when the player's own potion packets are held back. */
  blockUntilMs = 0;
  /** Until when auto-loot stands down after the player acted by hand. */
  pauseUntilMs = 0;
  /** When the guard last said something, so it cannot flood the log. */
  lastGuardLogAtMs = Number.NEGATIVE_INFINITY;

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
   * Clears the pending move once its destination has filled or it has waited
   * long enough to be assumed lost.
   *
   * A destination the server has never stated cannot be seen to fill, so such a
   * move is only ever cleared by the timeout — which is the behaviour that lets
   * a build with unknown backpack stats keep working, one slow move at a time,
   * rather than stopping after the first.
   */
  resolvePending(inventory: InventoryView, nowMs: number): void {
    const move = this.#pending;
    if (move === undefined) return;
    if (nowMs - move.sinceMs >= PENDING_TIMEOUT_MS || landed(inventory, move)) {
      this.#pending = undefined;
    }
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
    this.bagSlots.expire(nowMs);
    this.slots.expire(nowMs);
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
    this.bagSlots.clear();
    this.slots.clear();
    this.attempts.clear();
    this.bagSeenAtMs.clear();
    this.announced.clear();
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
  return move.expectedQuantity === undefined
    ? slot.objectType !== -1
    : slot.quantity >= move.expectedQuantity;
}
