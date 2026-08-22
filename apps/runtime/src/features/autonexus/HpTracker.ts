/**
 * A running estimate of the player's health that is *ahead* of the server.
 *
 * This is the idea that makes auto-nexus work at all, and the one the first
 * version of this feature got wrong. The server's health, as `NEWTICK` reports
 * it, is always about a round trip stale: a hit the client has already taken
 * and acknowledged is not reflected until the server has processed that
 * acknowledgement and the next tick has travelled back. Escaping on the server's
 * number means escaping a round trip too late.
 *
 * So health is *simulated*: decremented the instant a hit is seen on the wire —
 * before the acknowledging packet is even forwarded — and only reconciled with
 * the server's authoritative value when the two drift far apart. Between hits
 * the simulation is the most current thing there is; the reconciliation keeps
 * accumulated error and out-of-band changes (healing, effects this does not
 * model) from letting it wander.
 *
 * Kept apart from the plugin so this reconciliation logic is testable without a
 * packet, a session or a clock — it is the part most likely to be wrong.
 */

import { HP_DRIFT_SNAP, HP_SYNC_WARMUP_TICKS } from './constants.js';

export class HpTracker {
  #hp = 0;
  #maxHp = 0;
  #ticks = 0;
  #initialized = false;

  /** The simulated health — the number decisions are made against. */
  get hp(): number {
    return this.#hp;
  }

  get maxHp(): number {
    return this.#maxHp;
  }

  /** Forgets everything, so a new character or map starts from the server. */
  reset(): void {
    this.#hp = 0;
    this.#maxHp = 0;
    this.#ticks = 0;
    this.#initialized = false;
  }

  /**
   * Reconciles with the server's authoritative health on a tick.
   *
   * The first reading, or one taken while the simulation has bottomed out,
   * adopts the server value outright. After that the simulation is trusted —
   * it is more current — unless it has drifted past {@link HP_DRIFT_SNAP},
   * which is how healing and un-modelled effects are picked back up without
   * erasing the in-flight damage the simulation is ahead by.
   */
  syncFromServer(serverHp: number, maxHp: number): void {
    this.#maxHp = maxHp;

    if (!this.#initialized || this.#hp <= 0) {
      this.#hp = serverHp;
      this.#initialized = true;
      this.#ticks = 0;
      return;
    }

    if (Math.abs(this.#hp - serverHp) > HP_DRIFT_SNAP && this.#ticks > HP_SYNC_WARMUP_TICKS) {
      this.#hp = serverHp;
    }
    this.#ticks += 1;
  }

  /** Records a hit the server has not applied yet. */
  applyHit(damage: number): void {
    if (damage <= 0) return;
    this.#hp -= damage;
  }

  /** Whether simulated health is at or below a share of the maximum. */
  atOrBelowPercent(percent: number): boolean {
    if (this.#maxHp <= 0) return false;
    return this.#hp <= (this.#maxHp * percent) / 100;
  }
}
