/**
 * Blasts that are coming, and where not to be standing when they land.
 *
 * **A thrown bomb is not a bullet, and modelling it as one gets both wrong.** A
 * shot is a moving point that threatens everywhere along its path; a blast is a
 * disc that threatens one place at one *instant* and nothing at all before or
 * after it. Feeding a blast through the projectile sweep would make the planner
 * either refuse the ground for the whole two seconds the bomb is in the air —
 * which is a leash, and the player has complained about enough of those — or
 * miss it entirely, because `ThreatField.build` drops anything whose position it
 * cannot ask for at the moment of planning, and a blast that has not landed yet
 * has no position to give. So this asks its own question, and it is a far
 * cheaper one: for each blast, where will this course have got to by the time it
 * goes off, and is that inside it.
 *
 * **A circle, not a square.** Everything else the dodge measures uses Chebyshev
 * distance because that is the shape of the game's own projectile collision (see
 * `hitbox.ts`), but an area effect is a radius — the client's own test is
 * `distance(player, centre) > radius`, which is how `autonexus` already reads
 * one. A square here would inflate a three-and-a-half tile blast into a
 * seven-by-seven box and push the planner out of ground that was never
 * dangerous.
 *
 * **"Blast", not "hazard", deliberately.** The planner already calls damaging
 * ground a hazard, and two meanings of one word in a file that reasons about
 * both is how a `hazardMs` gets compared against the wrong clock.
 *
 * Where they come from is somebody else's problem: this holds a list and answers
 * questions about it. What fills it in reads the wire — see `BlastStore`. That
 * split is what lets the planner be tested against blasts nobody had to throw.
 */

import { PLAYER_HALF_TILES } from './hitbox.js';
import type { Sweep } from './ThreatField.js';

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
 * same command latency the projectile sweep accounts for applies here, and the
 * arming moment is only as good as the duration the telegraph carried. A blast
 * is also all-or-nothing in a way a bullet is not — a shot that grazes costs
 * nothing, a blast edge that grazes costs the whole hit — so a margin buys more
 * here than it does there.
 */
export const BLAST_MARGIN_TILES = 0.35;

export class Blasts {
  #x = new Float64Array(0);
  #y = new Float64Array(0);
  #radius = new Float64Array(0);
  #armsAt = new Float64Array(0);
  #count = 0;
  /** How long "now" lasts, for {@link Sweep.urgentClearanceTiles}. */
  #reactWithinMs = 0;

  get count(): number {
    return this.#count;
  }

  /**
   * Takes the blasts that could catch this plan, and forgets the rest.
   *
   * Dropped here rather than in the scoring loop: one that has already gone off
   * cannot be dodged, and one landing past the horizon is not this plan's
   * problem — the next fifty plans will each get another look at it.
   *
   * Arming times are stored relative to now, which is the clock every candidate
   * is swept on.
   *
   * @param withinTiles How far the player could get within the horizon. A blast
   *   whose edge is further than that plus its own radius is one no course could
   *   walk into.
   * @param reactWithinMs How long "now" lasts. Only decides which blasts count
   *   towards {@link Sweep.urgentClearanceTiles}; every one collected is swept.
   */
  collect(
    blasts: Iterable<BlastView>,
    gameTimeMs: number,
    selfX: number,
    selfY: number,
    withinTiles: number,
    horizonMs: number,
    reactWithinMs: number,
  ): void {
    this.#count = 0;
    this.#reactWithinMs = Math.max(0, Math.min(reactWithinMs, horizonMs));
    for (const blast of blasts) {
      const armsIn = blast.armsAtMs - gameTimeMs;
      if (!(armsIn >= 0) || armsIn > horizonMs) continue;
      const reach = withinTiles + blast.radiusTiles;
      if (Math.abs(blast.x - selfX) > reach || Math.abs(blast.y - selfY) > reach) continue;

      if (this.#count >= this.#x.length) this.#grow();
      this.#x[this.#count] = blast.x;
      this.#y[this.#count] = blast.y;
      this.#radius[this.#count] = blast.radiusTiles;
      this.#armsAt[this.#count] = armsIn;
      this.#count += 1;
    }
  }

  /** Drops everything. Used when the feature is off, so a stale list cannot score. */
  clear(): void {
    this.#count = 0;
  }

  /**
   * Walks one straight course past every blast, merging into `out`.
   *
   * **Merged into the projectile sweep's own three numbers rather than reported
   * beside them**, because "when is this course first in trouble" has one answer
   * whatever is causing it, and every ranking term the planner has is built on
   * those three. A blast that catches a course is exactly as much an impact as a
   * bullet that does, and it should lose to a course that survives for exactly
   * that reason. `out` is expected to have been filled by
   * {@link ThreatField.sweep} first; every write here is a minimum.
   *
   * The lead is the same model the projectile sweep uses: nothing has been
   * walked yet when the plan is made, so travel counts from `leadMs` and not
   * before. A blast landing inside the lead is one this decision cannot move out
   * of, and it is scored where the player already stands.
   *
   * **`unsafeAtMs` is the moment it becomes too late, not the moment it lands**
   * — and that difference is what makes a wide blast dodgeable at all. The
   * caller's reaction window is sized for sidestepping a bullet, which takes a
   * tile; walking out of a three-tile disc takes six hundred milliseconds, so a
   * blast reported at its landing time would sit quietly outside the window
   * until there was no longer time to leave, and then announce itself as
   * unavoidable. Reporting the deadline instead lets one rule serve both: a wide
   * blast raises its hand early, a small or distant one stays quiet, and neither
   * needs a window of its own.
   *
   * @param walkTilesPerMs What the character can do flat out, which is what the
   *   deadline is measured against — not `tilesPerMs`, which is this particular
   *   course's speed and is nought for the one that stands still.
   * @param fromMs When this course begins, for a course described by more than
   *   one call — see `ThreatField.sweep`. One landing before it went off over an
   *   earlier leg, and is that leg's to have answered for.
   */
  sweep(
    selfX: number,
    selfY: number,
    dirX: number,
    dirY: number,
    tilesPerMs: number,
    walkTilesPerMs: number,
    leadMs: number,
    fromMs: number,
    untilMs: number,
    maxTravelTiles: number,
    safeMarginTiles: number,
    out: Sweep,
  ): void {
    for (let i = 0; i < this.#count; i += 1) {
      const armsAt = this.#armsAt[i] ?? 0;
      if (armsAt > untilMs || armsAt < fromMs) continue;

      const centreX = this.#x[i] ?? 0;
      const centreY = this.#y[i] ?? 0;
      const required = (this.#radius[i] ?? 0) + PLAYER_HALF_TILES + BLAST_MARGIN_TILES;

      const travel = Math.min(tilesPerMs * Math.max(0, armsAt - leadMs), maxTravelTiles);
      const dx = selfX + dirX * travel - centreX;
      const dy = selfY + dirY * travel - centreY;
      const room = Math.sqrt(dx * dx + dy * dy) - required;

      if (room < out.clearanceTiles) out.clearanceTiles = room;
      // One landing inside the reaction window is what "now" means for a blast:
      // it is a single instant rather than a path, so it either falls in the
      // window or it does not.
      if (armsAt <= this.#reactWithinMs && room < out.urgentClearanceTiles) {
        out.urgentClearanceTiles = room;
      }
      if (room <= 0 && armsAt < out.impactMs) out.impactMs = armsAt;
      if (room >= safeMarginTiles) continue;

      // How much ground is between the player and being clear of it, and how
      // long that takes at a dead run. Measured from where they are now rather
      // than from where this course ends, because it answers "when must
      // *something* be done", which is a question about the player and not
      // about the candidate being scored.
      const here = Math.hypot(selfX - centreX, selfY - centreY);
      const shortfall = Math.max(0, required + safeMarginTiles - here);
      const deadline = walkTilesPerMs > 0 ? armsAt - shortfall / walkTilesPerMs - leadMs : armsAt;
      const mustAct = Math.max(fromMs, Math.min(armsAt, deadline));
      if (mustAct < out.unsafeAtMs) out.unsafeAtMs = mustAct;
    }
  }

  #grow(): void {
    const length = Math.max(8, this.#x.length * 2);
    const x = new Float64Array(length);
    const y = new Float64Array(length);
    const radius = new Float64Array(length);
    const armsAt = new Float64Array(length);
    x.set(this.#x);
    y.set(this.#y);
    radius.set(this.#radius);
    armsAt.set(this.#armsAt);
    this.#x = x;
    this.#y = y;
    this.#radius = radius;
    this.#armsAt = armsAt;
  }
}
