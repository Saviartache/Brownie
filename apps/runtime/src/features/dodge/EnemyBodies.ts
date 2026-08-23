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
 * **Culled twice, and the second cull is the one that makes the band mean
 * anything.** A realm holds hundreds of enemies and a plan can reach five tiles,
 * so distance drops most of them — but distance alone left the list full of
 * things that are enemies only on paper. A wall in this game is an object with
 * hit points and the enemy flag, and better than a quarter of what
 * `objects.xml` marks as an enemy is a spawner, an emitter or a room controller
 * that can neither be hurt nor hurt anybody. With those in, "how near is the
 * nearest monster" was answered by the room: the near edge kept the player off
 * the scenery, and the far edge was satisfied by a pillar while the boss stood
 * out of range. The caller says which is which; see {@link EnemyBodies.collect}.
 *
 * **And they move.** The packet stream says where a monster is and never where
 * it is going, so with the list frozen at the last sighting every course that
 * walks away scored as making room — which is true of a boss standing still and
 * false of the melee minion matching the player's speed, and the second is the
 * whole reason the near edge exists. Each body carries the velocity the caller
 * derived, and a place is judged at the moment the player would be standing in
 * it.
 */

import type { EntityView } from '@brownie/plugin-api';
import type { Motion } from '../../state/MotionTracker.js';
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

/**
 * How far ahead a body's own movement is believed, in milliseconds.
 *
 * **Believing it at all is what makes the near edge of the band mean
 * anything.** With the monsters frozen where they were last seen, every course
 * that walks away scores as making room — so a melee minion matching the
 * player's speed was answered with "you are already dealing with it", every
 * plan, until it was in contact. Predicting it says the plain thing instead:
 * walking away from something that is following you does not open a gap, and
 * walking across its path does.
 *
 * Bounded because a monster is free to turn, stop or die, and a velocity
 * carried a whole second is a claim about a decision it has not made yet. Long
 * enough to cover the half of the horizon the standoff is actually sampled at.
 */
export const MAX_BODY_LOOKAHEAD_MS = 600;

/**
 * How fast a body has to be coming at you before it counts as coming at you.
 *
 * **The line between "it is chasing me" and "I walked over there".** Both close
 * the gap and only the first is the planner's business — a player heading for a
 * portal, a bag or the next room walks past monsters the whole way, and a dodge
 * that reads their own approach as danger is one that will not let them
 * navigate. What separates the two is which body is doing the closing, and that
 * is a question about the *monster's* velocity alone.
 *
 * Above the noise a smoothed per-tick velocity carries and below anything that
 * is actually walking at somebody: a server tick moves an entity in one jump,
 * so a monster standing still still reports a twitch.
 */
export const MIN_CLOSING_TILES_PER_SECOND = 1;

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
  /** Tiles per millisecond, or nought for a body nothing is known about. */
  #vx = new Float64Array(0);
  #vy = new Float64Array(0);
  #count = 0;

  get count(): number {
    return this.#count;
  }

  /**
   * Takes everything within `withinTiles` of a point, and forgets the rest.
   *
   * @param read What this one is doing, or `undefined` for something that is
   *   not a body worth keeping away from at all.
   *
   *   **Not every `<Enemy/>` is a monster, and in a dungeon most of them are
   *   not.** A wall in this game is an object with hit points and the enemy
   *   flag, and better than a quarter of what `objects.xml` marks as an enemy is
   *   a spawner, an emitter or a room controller that can never be hurt and
   *   never hurts anybody. Counting those had the band measuring the scenery:
   *   the setting that keeps a boss at arm's length was answered by a pillar,
   *   and the one that keeps the player in weapon range was satisfied by a spawn
   *   anchor across the room. Auto-aim already refuses the same two, for the
   *   same reason and out of the same catalog.
   *
   *   The velocity is what the caller has managed to derive; nought in both
   *   axes is the honest answer for something seen only once, and it degrades
   *   this to what it did before — a snapshot.
   */
  collect(
    enemies: Iterable<EntityView>,
    x: number,
    y: number,
    withinTiles: number,
    read: (enemy: EntityView) => Motion | undefined,
  ): void {
    this.#count = 0;
    for (const enemy of enemies) {
      if (Math.abs(enemy.x - x) > withinTiles || Math.abs(enemy.y - y) > withinTiles) continue;
      const motion = read(enemy);
      if (motion === undefined) continue;
      if (this.#count >= this.#x.length) this.#grow();
      this.#x[this.#count] = enemy.x;
      this.#y[this.#count] = enemy.y;
      this.#vx[this.#count] = motion.velocityX;
      this.#vy[this.#count] = motion.velocityY;
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
   *
   * @param aheadMs How far into the future the place being asked about is. The
   *   bodies are carried forward by their own movement over it, capped at
   *   {@link MAX_BODY_LOOKAHEAD_MS} — so "how good a place is this" is answered
   *   about the moment the player would arrive rather than about now, which is
   *   the whole of what makes it true of something that is following them.
   */
  standoffAt(x: number, y: number, band: StandoffBand, aheadMs = 0): number {
    if (this.#count === 0) return 0;

    const ahead = Math.min(Math.max(aheadMs, 0), MAX_BODY_LOOKAHEAD_MS);
    let nearestSquared = Infinity;
    for (let i = 0; i < this.#count; i += 1) {
      const dx = (this.#x[i] ?? 0) + (this.#vx[i] ?? 0) * ahead - x;
      const dy = (this.#y[i] ?? 0) + (this.#vy[i] ?? 0) * ahead - y;
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

  /**
   * Whether anything already inside the near edge is walking towards a place.
   *
   * **Not "is the gap closing" — "is something closing it".** The gap between a
   * player and a monster shrinks just as fast when the player walks at it, and
   * that is a route, not a threat. Only the body's own velocity is read here,
   * so a boss standing where the player chose to stand next to it says no and a
   * minion running them down says yes.
   *
   * Any body inside the near edge will do rather than the nearest one: being
   * run down by the second-closest of two is being run down.
   */
  closingOn(x: number, y: number, band: StandoffBand): boolean {
    const keepAway = Math.max(band.keepAwayTiles, CONTACT_TILES);
    const closing = MIN_CLOSING_TILES_PER_SECOND / 1000;

    for (let i = 0; i < this.#count; i += 1) {
      const dx = x - (this.#x[i] ?? 0);
      const dy = y - (this.#y[i] ?? 0);
      const distance = Math.hypot(dx, dy);
      if (distance >= keepAway) continue;
      // On top of us already, so there is no direction to be closing along and
      // nothing left to wait for.
      if (distance === 0) return true;
      // How fast it is eating the gap, which is its velocity along the line
      // between the two.
      if (((this.#vx[i] ?? 0) * dx + (this.#vy[i] ?? 0) * dy) / distance > closing) return true;
    }
    return false;
  }

  #grow(): void {
    const length = Math.max(16, this.#x.length * 2);
    const x = new Float64Array(length);
    const y = new Float64Array(length);
    const vx = new Float64Array(length);
    const vy = new Float64Array(length);
    x.set(this.#x);
    y.set(this.#y);
    vx.set(this.#vx);
    vy.set(this.#vy);
    this.#x = x;
    this.#y = y;
    this.#vx = vx;
    this.#vy = vy;
  }
}
