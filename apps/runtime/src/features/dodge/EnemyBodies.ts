/**
 * Where the monsters are, and how far out of the fight a place is.
 *
 * **A dodge that only avoids bullets walks itself out of the fight.** Every
 * course that gives ground survives a little longer than every course that does
 * not, so a planner ranking on survival alone drifts backwards until it is out
 * of weapon range — and then it is a movement feature with the damage switched
 * off. One distance answers that: how far past the weapon's reach a place
 * leaves us, so the shots we are dodging between are also shots we are shooting
 * back through.
 *
 * The reference implementation arrived at the same number from the other end —
 * `DangerPlanner` parked at `weaponRange × 0.9` and `ZDodge` at `× 0.85` —
 * having built goal-seeking to get there. Nothing here seeks a goal: this is a
 * preference between courses the planner was choosing between anyway, which is
 * why it costs one comparison and cannot fight the player for the wheel.
 *
 * **And there is deliberately no bubble around a monster.** Keeping a set
 * distance from whatever is shooting reads, in the moment, as running away from
 * the shots — the room it insists on is taken by walking *back*, which is the
 * one direction a wave of fire is never crossed by. Threading the gap is the
 * dodge; where the shooter is standing is not this feature's business.
 *
 * **Culled twice, and the second cull is the one that makes the distance mean
 * anything.** A realm holds hundreds of enemies and a plan can reach five tiles,
 * so distance drops most of them — but distance alone left the list full of
 * things that are enemies only on paper. A wall in this game is an object with
 * hit points and the enemy flag, and better than a quarter of what
 * `objects.xml` marks as an enemy is a spawner, an emitter or a room controller
 * that can neither be hurt nor hurt anybody. With those in, "how far is the
 * monster" was answered by the room: a pillar satisfied the reach while the boss
 * stood out of range. The caller says which is which; see
 * {@link EnemyBodies.collect}.
 *
 * **And they move.** The packet stream says where a monster is and never where
 * it is going, so with the list frozen at the last sighting a place is judged
 * against a fight that has moved on. Each body carries the velocity the caller
 * derived, and a place is judged at the moment the player would be standing in
 * it.
 */

import type { EntityView } from '@brownie/plugin-api';
import type { Motion } from '../../state/MotionTracker.js';

/**
 * How big a body is when the catalog has nothing to say about it, in tiles.
 *
 * The reference implementation's figure, and the size the game draws anything
 * whose data omits `<Size>` at.
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
 * **Believing it at all is what keeps the answer about the fight rather than
 * about the last packet.** A monster walking out of reach and one walking into
 * it look identical frozen, and a course judged against where everything stood
 * a tick ago is a course judged against a fight that has moved on.
 *
 * Bounded because a monster is free to turn, stop or die, and a velocity
 * carried a whole second is a claim about a decision it has not made yet. Long
 * enough to cover the half of the horizon the reach is actually sampled at.
 */
export const MAX_BODY_LOOKAHEAD_MS = 600;

/** No body is the one being shot at. */
const NOBODY = -1;

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
   * **What the reach is measured to.** "Stay within your weapon's range" is a
   * distance to something, and the nearest body is the wrong something: it kept
   * the player in reach of whatever wandered closest while the monster they
   * were shooting walked away.
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
   *   not a monster to keep in reach of at all.
   *
   *   **Not every `<Enemy/>` is a monster, and in a dungeon most of them are
   *   not.** A wall in this game is an object with hit points and the enemy
   *   flag, and better than a quarter of what `objects.xml` marks as an enemy is
   *   a spawner, an emitter or a room controller that can never be hurt and
   *   never hurts anybody. Counting those had the reach measuring the scenery:
   *   the rule that keeps the player in weapon range was satisfied by a spawn
   *   anchor across the room while the boss stood outside it. Auto-aim already
   *   refuses the same two, for the same reason and out of the same catalog.
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
      // one far enough to change that answer, but where it *is* decides both
      // the reach and where its circle gets drawn.
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
   * How far past the weapon's reach a place sits, in tiles. Never negative.
   *
   * Nought anywhere inside the reach, and nought as well when nothing has been
   * collected — no monsters is not a position to leave, and answering anything
   * else would have the planner ranking courses by a distance to nobody.
   *
   * Distance is measured centre to centre and round, unlike the square the
   * game's collision uses (see `hitbox.ts`), because weapon range is a radius.
   *
   * @param stayWithinTiles How far the weapon reaches, or `Infinity` while
   *   range is not being kept — in which case nowhere is out of it.
   * @param aheadMs How far into the future the place being asked about is. The
   *   bodies are carried forward by their own movement over it, capped at
   *   {@link MAX_BODY_LOOKAHEAD_MS} — so "how good a place is this" is answered
   *   about the moment the player would arrive rather than about now.
   */
  outOfRangeAt(x: number, y: number, stayWithinTiles: number, aheadMs = 0): number {
    if (this.#count === 0 || stayWithinTiles === Infinity) return 0;

    const ahead = Math.min(Math.max(aheadMs, 0), MAX_BODY_LOOKAHEAD_MS);
    // How far this place is from the one worth staying in range of, which is
    // the target when there is one and the nearest body when there is not.
    let reach = Infinity;
    for (let i = 0; i < this.#count; i += 1) {
      const dx = (this.#x[i] ?? 0) + (this.#vx[i] ?? 0) * ahead - x;
      const dy = (this.#y[i] ?? 0) + (this.#vy[i] ?? 0) * ahead - y;
      const distance = Math.hypot(dx, dy);
      if (this.#target === NOBODY ? distance < reach : i === this.#target) reach = distance;
    }

    if (reach > stayWithinTiles) return Math.min(reach - stayWithinTiles, OUT_OF_RANGE_CAP_TILES);
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
