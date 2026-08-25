/**
 * Blasts that are coming, and where not to be standing when they land.
 *
 * **A thrown bomb is not a bullet, and modelling it as one gets both wrong.** A
 * shot is a moving point that threatens everywhere along its path; a blast is a
 * disc that threatens one place at one *instant* and nothing at all before or
 * after it. Feeding one through the shot index would make the search either
 * refuse the ground for the whole two seconds the bomb is in the air — a leash,
 * and the player has complained about enough of those — or miss it entirely,
 * because a blast that has not landed yet has no position to sample.
 *
 * So it answers its own question, and it is a far cheaper one: for each blast,
 * is this step of the walk standing inside it at the moment it goes off. That
 * shape fits the search exactly — every step is a place and a window of time —
 * where the previous generation had to sweep a whole straight course past every
 * blast and merge three numbers back out of it.
 *
 * **A circle, not a square.** Everything else the dodge measures uses Chebyshev
 * distance because that is the shape of the game's own projectile collision (see
 * `hitbox.ts`), but an area effect is a radius — the client's own test is
 * `distance(player, centre) > radius`, which is how `autonexus` already reads
 * one. A square here would inflate a three-and-a-half tile blast into a
 * seven-by-seven box and push the search out of ground that was never dangerous.
 *
 * **"Blast", not "hazard", deliberately.** The planner already calls damaging
 * ground a hazard, and two meanings of one word in a file that reasons about
 * both is how a deadline gets compared against the wrong clock.
 *
 * Where they come from is somebody else's problem: this holds a list and answers
 * questions about it. What fills it in reads the wire — see `BlastStore`. That
 * split is what lets the search be tested against blasts nobody had to throw.
 */

import type { BlastField } from './DodgeSearch.js';
import { PLAYER_HALF_TILES } from './hitbox.js';

/** One blast the planner has been told about. */
export interface BlastView {
  readonly x: number;
  readonly y: number;
  /** How far it reaches from its centre, in tiles. */
  readonly radiusTiles: number;
  /**
   * When it goes off, on the same clock the plan is made against.
   *
   * A single moment rather than a window: an area effect in this game damages
   * whoever is inside it once, as it lands. Standing in the crater afterwards
   * costs nothing, and a planner that thought otherwise would refuse the ground
   * that has just become the safest on the screen.
   */
  readonly armsAtMs: number;
}

/**
 * How much beyond a blast's stated edge is worth avoiding, in tiles.
 *
 * The radius the server sends is exact; where the *player* will be is not. The
 * same command latency the shot tracks account for applies here, and the arming
 * moment is only as good as the duration the telegraph carried. A blast is also
 * all-or-nothing in a way a bullet is not — a shot that grazes costs nothing, a
 * blast edge that grazes costs the whole hit — so a margin buys more here than
 * it does there.
 */
export const BLAST_MARGIN_TILES = 0.35;

export class Blasts implements BlastField {
  #x = new Float64Array(0);
  #y = new Float64Array(0);
  /** The distance from the centre at which a body is clear, margin included. */
  #required = new Float64Array(0);
  /** When each lands, relative to the moment the plan is being made for. */
  #armsIn = new Float64Array(0);
  #count = 0;

  get count(): number {
    return this.#count;
  }

  /**
   * Takes the blasts that could catch this plan, and forgets the rest.
   *
   * One that has already gone off cannot be dodged, and one landing past the
   * horizon is not this plan's problem — the next fifty plans will each get
   * another look at it.
   *
   * @param withinTiles How far the player could get within the horizon. A blast
   *   whose edge is further than that plus its own radius is one no step could
   *   walk into.
   */
  collect(
    blasts: Iterable<BlastView>,
    gameTimeMs: number,
    selfX: number,
    selfY: number,
    withinTiles: number,
    horizonMs: number,
  ): void {
    this.#count = 0;
    for (const blast of blasts) {
      const armsIn = blast.armsAtMs - gameTimeMs;
      if (!(armsIn >= 0) || armsIn > horizonMs) continue;
      const reach = withinTiles + blast.radiusTiles;
      if (Math.abs(blast.x - selfX) > reach || Math.abs(blast.y - selfY) > reach) continue;

      if (this.#count >= this.#x.length) this.#grow();
      this.#x[this.#count] = blast.x;
      this.#y[this.#count] = blast.y;
      this.#required[this.#count] = blast.radiusTiles + PLAYER_HALF_TILES + BLAST_MARGIN_TILES;
      this.#armsIn[this.#count] = armsIn;
      this.#count += 1;
    }
  }

  /** Drops everything. Used when the feature is off, so a stale list cannot score. */
  clear(): void {
    this.#count = 0;
  }

  /**
   * The least room a body standing here has, over the blasts landing in the
   * window.
   *
   * `Infinity` when none of them lands in it, which is the answer for nearly
   * every step of nearly every plan. Negative once the place is inside one.
   *
   * Both ends inclusive: a blast landing exactly on the seam between two steps
   * is measured against both, and taking the smaller of two equal answers costs
   * nothing — where excluding it from both would be a bomb nobody dodged.
   */
  clearanceAt(x: number, y: number, fromMs: number, toMs: number): number {
    let room = Infinity;
    for (let i = 0; i < this.#count; i += 1) {
      const armsIn = this.#armsIn[i] ?? 0;
      if (armsIn < fromMs || armsIn > toMs) continue;
      const dx = (this.#x[i] ?? 0) - x;
      const dy = (this.#y[i] ?? 0) - y;
      const here = Math.sqrt(dx * dx + dy * dy) - (this.#required[i] ?? 0);
      if (here < room) room = here;
    }
    return room;
  }

  /**
   * The soonest anything lands, or `Infinity`.
   *
   * **What lets a wide blast raise its hand before it is too late to leave.** A
   * reaction window sized for sidestepping a bullet says nothing useful about a
   * three-tile disc: walking out of one takes the better part of a second, so a
   * blast judged on when it *lands* sits quietly outside the window until there
   * is no longer time to go anywhere. The planner uses this to decide whether to
   * speak, not where to go.
   */
  soonestMs(): number {
    let soonest = Infinity;
    for (let i = 0; i < this.#count; i += 1) {
      const armsIn = this.#armsIn[i] ?? 0;
      if (armsIn < soonest) soonest = armsIn;
    }
    return soonest;
  }

  #grow(): void {
    const length = Math.max(8, this.#x.length * 2);
    const x = new Float64Array(length);
    const y = new Float64Array(length);
    const required = new Float64Array(length);
    const armsIn = new Float64Array(length);
    x.set(this.#x);
    y.set(this.#y);
    required.set(this.#required);
    armsIn.set(this.#armsIn);
    this.#x = x;
    this.#y = y;
    this.#required = required;
    this.#armsIn = armsIn;
  }
}
