/**
 * What each enemy shot in flight would do, keyed by the id the hit will name.
 *
 * A `PLAYERHIT` names the bullet that struck by `ownerId` and `bulletId`, and
 * nothing else — not its damage. To turn that into a health decision the damage
 * has to have been remembered from the `ENEMYSHOOT` that announced the shot.
 * That is this log's whole job.
 *
 * It records the damage straight off the wire rather than from the game's
 * projectile data, on purpose: the wire value is present in every session,
 * while the data files may not be, and a safety feature that goes quiet without
 * an optional asset is not a safety feature. The cost is that armour-piercing,
 * which only the data files describe, is not known here — the plugin treats an
 * unknown shot as piercing, which is the safe direction.
 */

import { BULLET_MAX_AGE_MS } from './constants.js';

/** A shot the log is tracking. */
interface LoggedBullet {
  readonly damage: number;
  /** Game time it was fired, for expiry. */
  readonly firedAtMs: number;
}

export class BulletLog {
  readonly #bullets = new Map<string, LoggedBullet>();

  get size(): number {
    return this.#bullets.size;
  }

  /**
   * Records a volley: consecutive bullet ids from one owner, each with the
   * same damage. `count` is the shot count already sanitised by the caller.
   */
  add(
    ownerId: number,
    firstBulletId: number,
    damage: number,
    count: number,
    firedAtMs: number,
  ): void {
    for (let i = 0; i < count; i += 1) {
      this.#bullets.set(key(ownerId, firstBulletId + i), { damage, firedAtMs });
    }
  }

  /** The damage of a tracked shot, or `undefined` if it was never seen. */
  damageOf(ownerId: number, bulletId: number): number | undefined {
    return this.#bullets.get(key(ownerId, bulletId))?.damage;
  }

  /** Drops a shot once its hit has been accounted for. */
  consume(ownerId: number, bulletId: number): void {
    this.#bullets.delete(key(ownerId, bulletId));
  }

  /** Drops shots older than {@link BULLET_MAX_AGE_MS}. Cheap, bounds the map. */
  prune(gameTimeMs: number): void {
    for (const [k, bullet] of this.#bullets) {
      if (gameTimeMs - bullet.firedAtMs > BULLET_MAX_AGE_MS) this.#bullets.delete(k);
    }
  }

  clear(): void {
    this.#bullets.clear();
  }
}

/** Bullet ids are unique only per owner, so both identify a shot. */
function key(ownerId: number, bulletId: number): string {
  return `${String(ownerId)}:${String(bulletId)}`;
}
