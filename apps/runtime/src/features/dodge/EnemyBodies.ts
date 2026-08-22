/**
 * How close a course comes to standing on a monster.
 *
 * **Contact damage is why this exists.** Touching a body in this game hurts, so
 * an escape that threads a perfect gap between two shots and finishes inside a
 * boss has not escaped anything. The reference implementation stamped enemy
 * bodies into its danger grid as lethal, which made them a wall — and a wall is
 * the wrong answer, because the only lane out of a volley sometimes runs past a
 * monster and a planner that refuses it stands in the volley instead. Here it is
 * a number to prefer more of, never a veto.
 *
 * **Culled, because a realm holds hundreds and a plan can reach five tiles.**
 * The list is rebuilt per plan from the store's own cached array and holds only
 * what could matter, so the scoring loop never sees the room.
 *
 * Measured with Chebyshev distance, like everything else that decides where the
 * player may be — see `hitbox.ts` for why the game's shapes are squares.
 */

import type { EntityView } from '@brownie/plugin-api';
import { PLAYER_HALF_TILES } from './hitbox.js';

/**
 * How big a body is assumed to be, in tiles.
 *
 * The reference implementation's figure, and its reasoning: bosses are larger,
 * so this under-covers them — but it is a preference rather than a barrier, and
 * a number large enough to cover a boss would push the planner off every
 * ordinary monster in the game.
 */
export const ENEMY_CONTACT_HALF_TILES = 0.5;

export class EnemyBodies {
  #x = new Float64Array(0);
  #y = new Float64Array(0);
  #count = 0;

  get count(): number {
    return this.#count;
  }

  /** Takes everything within `withinTiles` of a point, and forgets the rest. */
  collect(enemies: Iterable<EntityView>, x: number, y: number, withinTiles: number): void {
    this.#count = 0;
    for (const enemy of enemies) {
      if (Math.abs(enemy.x - x) > withinTiles || Math.abs(enemy.y - y) > withinTiles) continue;
      if (this.#count >= this.#x.length) this.#grow();
      this.#x[this.#count] = enemy.x;
      this.#y[this.#count] = enemy.y;
      this.#count += 1;
    }
  }

  /** Drops everything. Used when the feature is off, so a stale list cannot score. */
  clear(): void {
    this.#count = 0;
  }

  /** Room to the nearest body, in tiles. Negative means overlapping it. */
  roomAt(x: number, y: number): number {
    let room = Infinity;
    for (let i = 0; i < this.#count; i += 1) {
      const here =
        Math.max(Math.abs((this.#x[i] ?? 0) - x), Math.abs((this.#y[i] ?? 0) - y)) -
        (ENEMY_CONTACT_HALF_TILES + PLAYER_HALF_TILES);
      if (here < room) room = here;
    }
    return room;
  }

  #grow(): void {
    const length = Math.max(16, this.#x.length * 2);
    const x = new Float64Array(length);
    const y = new Float64Array(length);
    x.set(this.#x);
    y.set(this.#y);
    this.#x = x;
    this.#y = y;
  }
}
