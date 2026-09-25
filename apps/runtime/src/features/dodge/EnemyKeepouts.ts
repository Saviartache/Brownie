/**
 * Ground round enemies that the dodge treats as ground that hurts.
 *
 * **Two kinds of enemy leave nothing to dodge, and both are answered here.** A
 * blast centred on the enemy that set it off damages the same instant it becomes
 * visible; a shot fired by a turret the character is standing beside lands
 * before any command could reach the character. Neither can be reacted to after
 * the fact, so the only defence is the radius never entered in the first place:
 * one disc per enemy, rebuilt from live positions every plan. How wide each one
 * is, is the caller's to say — `DodgeScene` asks the learned `SelfBlastTable`
 * about the first kind and `PointBlankReach` about the second, and hands over
 * the wider of the two with every margin already in it.
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
import { MAX_BODY_LOOKAHEAD_MS } from './EnemyBodies.js';

/** What one collected disc is, supplied by the caller. See {@link collect}. */
export interface KeepOutSighting {
  readonly x: number;
  readonly y: number;
  /** Tiles per millisecond, or nought for one nothing is known about. */
  readonly velocityX: number;
  readonly velocityY: number;
  /**
   * How far from the enemy's centre a body has to stay, in tiles — the whole of
   * it, margins included. Nothing is added here.
   */
  readonly radiusTiles: number;
}

export class EnemyKeepouts {
  #x = new Float64Array(0);
  #y = new Float64Array(0);
  #vx = new Float64Array(0);
  #vy = new Float64Array(0);
  #radius = new Float64Array(0);
  #count = 0;

  get count(): number {
    return this.#count;
  }

  /**
   * Where one of the collected discs is, how wide, and how it is moving.
   *
   * **For drawing them, and for nothing else**, for the reason `EnemyBodies`
   * gives about its own: a picture rebuilt from the world a second time could
   * disagree with the plan it claims to show. Out of range answers nought.
   */
  xOf(index: number): number {
    return index >= 0 && index < this.#count ? (this.#x[index] ?? 0) : 0;
  }

  yOf(index: number): number {
    return index >= 0 && index < this.#count ? (this.#y[index] ?? 0) : 0;
  }

  radiusOf(index: number): number {
    return index >= 0 && index < this.#count ? (this.#radius[index] ?? 0) : 0;
  }

  /** Tiles per millisecond, as the discs are carried by. */
  velocityXOf(index: number): number {
    return index >= 0 && index < this.#count ? (this.#vx[index] ?? 0) : 0;
  }

  velocityYOf(index: number): number {
    return index >= 0 && index < this.#count ? (this.#vy[index] ?? 0) : 0;
  }

  /**
   * Takes every enemy in reach of a point that keeps a disc, and forgets the rest.
   *
   * The caller reads each enemy — position carried to now, velocity, and how
   * far to stay off it — because the same reading is already being made for the
   * body list and a second opinion could disagree with the first.
   *
   * @param read What this one keeps the player off, or `undefined` for an enemy
   *   that keeps nobody off anything.
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
      if (sighting === undefined || !(sighting.radiusTiles > 0)) continue;
      if (this.#count >= this.#x.length) this.#grow();
      this.#x[this.#count] = sighting.x;
      this.#y[this.#count] = sighting.y;
      this.#vx[this.#count] = sighting.velocityX;
      this.#vy[this.#count] = sighting.velocityY;
      this.#radius[this.#count] = sighting.radiusTiles;
      this.#count += 1;
    }
  }

  /** Drops everything. Used when the feature is off, so a stale list cannot score. */
  clear(): void {
    this.#count = 0;
  }

  /**
   * How far a body standing here is from the nearest disc's edge, in tiles.
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
      const here = Math.sqrt(dx * dx + dy * dy) - (this.#radius[i] ?? 0);
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
    const radius = new Float64Array(length);
    x.set(this.#x);
    y.set(this.#y);
    vx.set(this.#vx);
    vy.set(this.#vy);
    radius.set(this.#radius);
    this.#x = x;
    this.#y = y;
    this.#vx = vx;
    this.#vy = vy;
    this.#radius = radius;
  }
}
