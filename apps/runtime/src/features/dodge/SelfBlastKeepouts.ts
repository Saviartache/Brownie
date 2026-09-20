/**
 * Ground around enemies that blast themselves, which the dodge treats as
 * ground that hurts.
 *
 * **The one attack with no dodgeable half.** A bomb is telegraphed, a bullet is
 * visible the whole way, and a blast centred on the enemy that set it off is
 * neither: it damages the same instant it becomes visible, so there is nothing
 * to react to and the only defence is the radius never entered in the first
 * place. Which enemies those are and how far they reach is learned from the
 * detonations themselves — see `SelfBlastTable` — and this holds the discs that
 * knowledge turns into, one per living enemy of a learned type, rebuilt from
 * live positions every plan.
 *
 * **Answered as a distance and fed to the hazard question, not stamped as a
 * wall.** The planner's rule for ground that costs health is a ratchet — a step
 * may never end deeper in it than the place it left (see `entersHazard`) — so a
 * keep-out disc pushes the player out of the radius without ever being able to
 * pin them inside one, which is exactly the trade a monster they are already
 * standing next to needs. The alternative, refusing the ground outright, is
 * what the reference implementation did to its danger grid and what this
 * codebase spent a whole file un-learning (see `EnemyBodies`).
 */

import type { EntityView } from '@brownie/plugin-api';
import { SELF_BLAST_MARGIN_TILES } from '../../state/blasts/SelfBlastTable.js';
import { MAX_BODY_LOOKAHEAD_MS } from './EnemyBodies.js';
import { PLAYER_HALF_TILES } from './hitbox.js';

/** What one collected disc is, supplied by the caller. See {@link collect}. */
export interface KeepOutSighting {
  readonly x: number;
  readonly y: number;
  /** Tiles per millisecond, or nought for one nothing is known about. */
  readonly velocityX: number;
  readonly velocityY: number;
  /** How far from the enemy the damage reaches, in tiles. */
  readonly radiusTiles: number;
}

export class SelfBlastKeepouts {
  #x = new Float64Array(0);
  #y = new Float64Array(0);
  #vx = new Float64Array(0);
  #vy = new Float64Array(0);
  #required = new Float64Array(0);
  #count = 0;

  get count(): number {
    return this.#count;
  }

  /**
   * Takes every learned self-blaster in reach of a point, and forgets the rest.
   *
   * The caller reads each enemy — position carried to now, velocity, and the
   * type's learned radius — because the same reading is already being made for
   * the body list and a second opinion could disagree with the first.
   */
  collect(
    enemies: Iterable<EntityView>,
    x: number,
    y: number,
    withinTiles: number,
    read: (enemy: EntityView) => KeepOutSighting | undefined,
  ): void {
    this.#count = 0;
    for (const enemy of enemies) {
      if (Math.abs(enemy.x - x) > withinTiles || Math.abs(enemy.y - y) > withinTiles) continue;
      const sighting = read(enemy);
      if (sighting === undefined) continue;
      if (this.#count >= this.#x.length) this.#grow();
      this.#x[this.#count] = sighting.x;
      this.#y[this.#count] = sighting.y;
      this.#vx[this.#count] = sighting.velocityX;
      this.#vy[this.#count] = sighting.velocityY;
      // The margin and the player's own half, for the same reasons every blast
      // gets them: where the player will be is only as good as the latency the
      // whole dodge prices, and a blast edge that grazes costs the whole hit.
      this.#required[this.#count] =
        sighting.radiusTiles + PLAYER_HALF_TILES + SELF_BLAST_MARGIN_TILES;
      this.#count += 1;
    }
  }

  /** Drops everything. Used when the feature is off, so a stale list cannot score. */
  clear(): void {
    this.#count = 0;
  }

  /**
   * How far a body standing here is from the nearest learned radius, in tiles.
   *
   * Negative once inside one, and `Infinity` when none was collected — the same
   * answers `hazardGapTiles` gives about pools, because the question is the
   * same one about a different kind of ground.
   *
   * @param aheadMs When the player would be standing there. The enemy is
   *   carried forward by its own movement over it, bounded the same way a
   *   body's is — a velocity claimed a whole second ahead is a claim about a
   *   decision the enemy has not made yet.
   */
  gapAt(x: number, y: number, aheadMs = 0): number {
    if (this.#count === 0) return Infinity;

    const ahead = Math.min(Math.max(aheadMs, 0), MAX_BODY_LOOKAHEAD_MS);
    let worst = Infinity;
    for (let i = 0; i < this.#count; i += 1) {
      const dx = (this.#x[i] ?? 0) + (this.#vx[i] ?? 0) * ahead - x;
      const dy = (this.#y[i] ?? 0) + (this.#vy[i] ?? 0) * ahead - y;
      const here = Math.sqrt(dx * dx + dy * dy) - (this.#required[i] ?? 0);
      if (here < worst) worst = here;
    }
    return worst;
  }

  #grow(): void {
    const length = Math.max(8, this.#x.length * 2);
    const x = new Float64Array(length);
    const y = new Float64Array(length);
    const vx = new Float64Array(length);
    const vy = new Float64Array(length);
    const required = new Float64Array(length);
    x.set(this.#x);
    y.set(this.#y);
    vx.set(this.#vx);
    vy.set(this.#vy);
    required.set(this.#required);
    this.#x = x;
    this.#y = y;
    this.#vx = vx;
    this.#vy = vy;
    this.#required = required;
  }
}
