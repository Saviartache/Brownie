/**
 * Where the monsters are, and whether a place is a good one to fight from.
 *
 * **A dodge that only avoids bullets walks itself out of the fight.** Every
 * course that gives ground survives a little longer than every course that does
 * not, so a planner ranking on survival alone drifts backwards until it is out
 * of weapon range — and then it is a movement feature with the damage switched
 * off. The band below is the whole answer: a nearest distance to stay outside
 * of, so nothing can walk up and take the room needed to dodge at all, and one
 * to stay inside of, so the shots we are dodging between are also shots we are
 * shooting back through.
 *
 * The reference implementation arrived at the same two numbers from the other
 * end — `DangerPlanner` parked at `weaponRange × 0.9` and `ZDodge` at `× 0.85` —
 * having built goal-seeking to get there. Nothing here seeks a goal: this is a
 * preference between courses the planner was choosing between anyway, which is
 * why it costs one comparison and cannot fight the player for the wheel.
 *
 * **Contact damage is the floor under it.** Touching a body in this game hurts,
 * so an escape that threads a perfect gap between two shots and finishes inside
 * a boss has not escaped anything. The reference stamped enemy bodies into its
 * danger grid as lethal, which made them a wall — and a wall is the wrong
 * answer, because the only lane out of a volley sometimes runs past a monster
 * and a planner that refuses it stands in the volley instead. Here it only ever
 * raises the near edge of the band, which is a preference and never a veto.
 *
 * **Culled, because a realm holds hundreds and a plan can reach five tiles.**
 * The list is rebuilt per plan from the store's own cached array and holds only
 * what could matter, so the scoring loop never sees the room.
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

/** Nearer than this and the bodies are touching. The floor under the band. */
const CONTACT_TILES = ENEMY_CONTACT_HALF_TILES + PLAYER_HALF_TILES;

/**
 * How far out of weapon range is still worth being pulled back from, in tiles.
 *
 * **Without a cap this stops being a preference and becomes a chase.** Just
 * outside range, "closer is better" is the player's own intent — they are here
 * to do damage. Ten tiles outside it, the same rule is a planner walking towards
 * a monster nobody asked it to approach. Past the cap every course is equally
 * far and the difference decides nothing, which is the behaviour wanted: hold
 * position, do not seek.
 */
export const OUT_OF_RANGE_CAP_TILES = 2;

/** The distances a place is judged against. See the file's note. */
export interface StandoffBand {
  /** Never nearer to a monster than this. Raised to the contact distance. */
  readonly keepAwayTiles: number;
  /** And preferably no further. `Infinity` when range is not being kept. */
  readonly stayWithinTiles: number;
}

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

  /**
   * How far out of the band a place sits, in tiles.
   *
   * Negative when it is too near a monster, positive when it is further from the
   * nearest one than the weapon reaches, nought when it is somewhere worth
   * standing. One signed number rather than two questions, because the caller
   * asks both of them about every candidate course and they cannot both be true.
   *
   * Nought as well when nothing has been collected — no monsters is not a
   * position to hold or leave, and answering anything else would have the
   * planner ranking courses by a distance to nobody.
   *
   * Distance is measured centre to centre and round, unlike the square the
   * game's collision uses (see `hitbox.ts`): weapon range is a radius, and the
   * near edge is a bubble rather than a hitbox. Squared until the end, because
   * this is asked twice per candidate per plan.
   */
  standoffAt(x: number, y: number, band: StandoffBand): number {
    if (this.#count === 0) return 0;

    let nearestSquared = Infinity;
    for (let i = 0; i < this.#count; i += 1) {
      const dx = (this.#x[i] ?? 0) - x;
      const dy = (this.#y[i] ?? 0) - y;
      const squared = dx * dx + dy * dy;
      if (squared < nearestSquared) nearestSquared = squared;
    }

    const nearest = Math.sqrt(nearestSquared);
    const keepAway = Math.max(band.keepAwayTiles, CONTACT_TILES);
    if (nearest < keepAway) return nearest - keepAway;
    if (nearest > band.stayWithinTiles) {
      return Math.min(nearest - band.stayWithinTiles, OUT_OF_RANGE_CAP_TILES);
    }
    return 0;
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
