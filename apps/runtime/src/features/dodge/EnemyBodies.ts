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
 *
 * **And they are not all one tile wide.** The near edge used to be measured
 * from a monster's centre with every monster assumed the same size, so the
 * distance that keeps a scattering minion at arm's length put the player well
 * inside a boss four times the width — which is the live report, and it is the
 * one case where being crowded is most expensive. `<Size>` says how big each
 * one is; the setting names a *gap* from the body rather than a distance from
 * its middle, so one number holds for both.
 */

import type { EntityView } from '@brownie/plugin-api';
import type { Motion } from '../../state/MotionTracker.js';
import { PLAYER_HALF_TILES } from './hitbox.js';

/**
 * How big a body is when the catalog has nothing to say about it, in tiles.
 *
 * The reference implementation's figure, and the size the game draws anything
 * whose data omits `<Size>` at. It is also the yardstick {@link StandoffBand}
 * is calibrated against — see {@link EnemyBodies.standoffAt} — so that the same
 * setting means the same *gap* whatever is standing there.
 */
export const ENEMY_CONTACT_HALF_TILES = 0.5;

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

/** No body is the one being shot at. */
const NOBODY = -1;

/** The distances a place is judged against. See the file's note. */
export interface StandoffBand {
  /**
   * Never nearer to a monster than this.
   *
   * Stated as the distance from the centre of an ordinary, one-tile monster,
   * because that is what it has always meant and what the presets are tuned
   * against — but *applied* as the gap it works out to, so a body twice the
   * width is kept twice as far off its middle and exactly as far off its edge.
   * Raised to the contact distance, so nought here still means "not inside it".
   */
  readonly keepAwayTiles: number;
  /** And preferably no further. `Infinity` when range is not being kept. */
  readonly stayWithinTiles: number;
}

/** What the caller knows about one body. See {@link EnemyBodies.collect}. */
export interface BodySighting extends Motion {
  /**
   * Where it is *now*, which is not where the last packet put it.
   *
   * Sightings arrive five times a second and a plan is made fifty, so the raw
   * sample is a body frozen up to a whole server tick behind whatever is
   * actually walking at the player. The caller carries it forward with the
   * velocity below; see `MotionTracker.motionAt`.
   */
  readonly x: number;
  readonly y: number;
  /**
   * Half the width of this one, in tiles.
   *
   * {@link ENEMY_CONTACT_HALF_TILES} for anything the catalog cannot describe,
   * which is what this did for every monster alike before it could tell.
   */
  readonly halfTiles: number;
}

export class EnemyBodies {
  #x = new Float64Array(0);
  #y = new Float64Array(0);
  /** Tiles per millisecond, or nought for a body nothing is known about. */
  #vx = new Float64Array(0);
  #vy = new Float64Array(0);
  /** Half the width of each, in tiles. */
  #half = new Float64Array(0);
  #count = 0;
  /**
   * Which of them the shots are being pointed at, or {@link NOBODY}.
   *
   * **What the far edge of the band is measured to.** "Stay within your
   * weapon's range" is a distance to something, and the nearest body is the
   * wrong something: it kept the player in reach of whatever wandered closest
   * while the monster they were shooting walked away. The near edge is
   * unchanged and still asks about every body — being crowded is about whoever
   * is crowding you, not about who you are shooting.
   */
  #target = NOBODY;

  get count(): number {
    return this.#count;
  }

  /**
   * Where one of the collected bodies is, and how wide.
   *
   * **For drawing them, and for nothing else.** The planner asks this class
   * questions about places; a picture of what it is thinking has to name the
   * things themselves, and rebuilding the list a second time from the world
   * would be a second cull that could disagree with this one — which is the one
   * failure a debug view must not have. Out of range answers nought, so a caller
   * that has miscounted draws a body at the origin rather than reading rubbish.
   */
  xOf(index: number): number {
    return index >= 0 && index < this.#count ? (this.#x[index] ?? 0) : 0;
  }

  yOf(index: number): number {
    return index >= 0 && index < this.#count ? (this.#y[index] ?? 0) : 0;
  }

  halfOf(index: number): number {
    return index >= 0 && index < this.#count
      ? (this.#half[index] ?? ENEMY_CONTACT_HALF_TILES)
      : ENEMY_CONTACT_HALF_TILES;
  }

  /**
   * What one of them is doing, in tiles per millisecond.
   *
   * For drawing, as {@link xOf} is. A circle published twenty times a second and
   * drawn at the frame rate steps visibly across the monster it belongs to
   * unless whoever draws it can carry it between publishes, and this is what
   * lets them — the same velocity the planner scored the place with, so the
   * picture cannot claim a motion the decision did not use.
   */
  velocityXOf(index: number): number {
    return index >= 0 && index < this.#count ? (this.#vx[index] ?? 0) : 0;
  }

  velocityYOf(index: number): number {
    return index >= 0 && index < this.#count ? (this.#vy[index] ?? 0) : 0;
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
    read: (enemy: EntityView) => BodySighting | undefined,
    targetObjectId?: number,
  ): void {
    this.#count = 0;
    this.#target = NOBODY;
    for (const enemy of enemies) {
      if (Math.abs(enemy.x - x) > withinTiles || Math.abs(enemy.y - y) > withinTiles) continue;
      const sighting = read(enemy);
      if (sighting === undefined) continue;
      if (this.#count >= this.#x.length) this.#grow();
      // The caller's reading rather than the packet's: the cull above is about
      // which monsters are near enough to matter, and a prediction cannot move
      // one far enough to change that answer, but where it *is* decides both the
      // near edge of the band and where its circle gets drawn.
      this.#x[this.#count] = sighting.x;
      this.#y[this.#count] = sighting.y;
      this.#vx[this.#count] = sighting.velocityX;
      this.#vy[this.#count] = sighting.velocityY;
      this.#half[this.#count] = sighting.halfTiles;
      if (enemy.objectId === targetObjectId) this.#target = this.#count;
      this.#count += 1;
    }
  }

  /** Drops everything. Used when the feature is off, so a stale list cannot score. */
  clear(): void {
    this.#count = 0;
    this.#target = NOBODY;
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
   * near edge is a bubble rather than a hitbox.
   *
   * **The near edge is per body and the far edge is not.** How near is too near
   * depends on how big the thing is — see {@link nearEdgeOf} — while how far is
   * too far is a property of the weapon, which reaches the same distance
   * whatever it is pointed at. Where the two cross, on a melee weapon against
   * something enormous, the near edge wins: being able to dodge outranks being
   * able to shoot, and a band with nothing inside it would otherwise have the
   * planner stepping in and out of contact forever.
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
    // How far inside a near edge this place is, taking the worst offender —
    // being crowded by the second-nearest of two is being crowded.
    let intrusion = 0;
    // And how far it is from the one worth staying in range of, which is the
    // target when there is one and the nearest body when there is not.
    let reach = Infinity;
    let reachEdge = 0;
    for (let i = 0; i < this.#count; i += 1) {
      const dx = (this.#x[i] ?? 0) + (this.#vx[i] ?? 0) * ahead - x;
      const dy = (this.#y[i] ?? 0) + (this.#vy[i] ?? 0) * ahead - y;
      const distance = Math.hypot(dx, dy);
      const edge = nearEdgeOf(this.#half[i] ?? ENEMY_CONTACT_HALF_TILES, band);
      if (distance - edge < intrusion) intrusion = distance - edge;
      if (this.#target === NOBODY ? distance < reach : i === this.#target) {
        reach = distance;
        reachEdge = edge;
      }
    }

    if (intrusion < 0) return intrusion;
    const stayWithin = Math.max(band.stayWithinTiles, reachEdge);
    if (reach > stayWithin) return Math.min(reach - stayWithin, OUT_OF_RANGE_CAP_TILES);
    return 0;
  }

  #grow(): void {
    const length = Math.max(16, this.#x.length * 2);
    const x = new Float64Array(length);
    const y = new Float64Array(length);
    const vx = new Float64Array(length);
    const vy = new Float64Array(length);
    const half = new Float64Array(length);
    x.set(this.#x);
    y.set(this.#y);
    vx.set(this.#vx);
    vy.set(this.#vy);
    half.set(this.#half);
    this.#x = x;
    this.#y = y;
    this.#vx = vx;
    this.#vy = vy;
    this.#half = half;
  }
}

/**
 * How near a body of this size is too near, from its centre, in tiles.
 *
 * **The setting names a gap, and is stated as a distance.** `keepAwayTiles` has
 * always meant "from the middle of an ordinary monster", which is what the
 * presets are tuned against — so the gap it asks for is that distance less the
 * ordinary body, and the same gap held against a body four times as wide is a
 * larger distance. Without this the number that keeps a minion at arm's length
 * left the player standing inside a boss.
 *
 * Floored at contact, so a keep-away of nought still means "not overlapping"
 * rather than "as close as you like".
 */
export function nearEdgeOf(halfTiles: number, band: StandoffBand): number {
  const gap = Math.max(band.keepAwayTiles - ENEMY_CONTACT_HALF_TILES, PLAYER_HALF_TILES);
  return halfTiles + gap;
}
