/**
 * Area effects that have been announced but have not gone off yet.
 *
 * **The dodgeable half of an area effect happens before the `AOE` packet.** By
 * the time that arrives the blast has landed: the client answers it with an
 * `AOEACK` carrying where the player was, and the damage follows from that. What
 * *is* dodgeable is the telegraph — `SHOWEFFECT` announces a bomb leaving a
 * monster's hand, or a circle drawn on the ground, with where it will land and
 * how long it takes to get there. That is most of a second of warning, and it is
 * what this store holds.
 *
 * The reference implementation reached the same conclusion the long way round:
 * it hooked three separate IL2CPP methods on the client's throwable visuals and
 * then added a fourth path on the ShowEffect packet handler, which is the only
 * one of the four a proxy can have — and, being the packet, the only one that
 * cannot drift when the game is patched.
 *
 * **What arrives is a telegraph, not a measurement.** The wire says where and
 * when; it does not say how wide. The blast radius is only known once the `AOE`
 * lands, which is too late to plan around — so a predicted blast carries
 * {@link DEFAULT_BLAST_RADIUS_TILES}, the reference implementation's own figure,
 * and the `AOE` that follows is used to *check* the prediction rather than to
 * dodge. See {@link BlastStore.landed}.
 */

import type { BlastView } from '@brownie/plugin-api';

/**
 * How wide a telegraphed blast is assumed to be, in tiles.
 *
 * The reference implementation's `kDefaultAoeRadiusTiles`. It is a guess in both
 * directions — the one blast it could measure properly came out around three
 * tiles — and it is the honest thing to use, because the alternative is to treat
 * an unknown radius as nought and walk into it.
 */
export const DEFAULT_BLAST_RADIUS_TILES = 3.5;

/**
 * The `SHOWEFFECT` kinds worth avoiding, by the number the wire carries.
 *
 * Taken from the reference implementation, which established them by watching a
 * running game. Everything else this packet carries is decoration — a flash, a
 * beam, a trail — and reacting to those would have the planner dodging light.
 */
export const THROW_EFFECT = 4;
export const NOVA_EFFECT = 5;
export const CIRCLE_TELEGRAPH_EFFECT = 23;
export const AOE_EFFECT = 39;

/** Whether this kind of effect is a blast on its way down. */
export function isBlastEffect(effectType: number): boolean {
  return (
    effectType === THROW_EFFECT ||
    effectType === NOVA_EFFECT ||
    effectType === CIRCLE_TELEGRAPH_EFFECT ||
    effectType === AOE_EFFECT
  );
}

/**
 * The longest a telegraph is believed, in milliseconds.
 *
 * A duration far outside this is one the field did not mean what we read it as,
 * and a blast pencilled in eight seconds ahead would sit in the planner's way
 * for the whole of that. The reference implementation applied the same bound and
 * the same fallback.
 */
export const MAX_TELEGRAPH_MS = 8000;
export const DEFAULT_TELEGRAPH_MS = 600;

/** How long a landed blast is remembered, for matching a prediction to it. */
const CONFIRM_WINDOW_MS = 1500;

/** How near a landing has to be to a prediction to count as the same blast. */
const CONFIRM_TILES = 2.5;

/** The most blasts tracked at once. A boss fight is a handful; this is a bound. */
const MAX_BLASTS = 64;

interface TrackedBlast {
  x: number;
  y: number;
  radiusTiles: number;
  armsAtMs: number;
  confirmed: boolean;
}

export class BlastStore {
  #blasts: TrackedBlast[] = [];

  /**
   * How many predictions an `AOE` later landed on top of, and how many it did
   * not.
   *
   * **This is the feature checking its own homework.** Where a telegraph says a
   * bomb will land is a claim, and the `AOE` that follows is the answer sheet: a
   * prediction the detonation confirms is one the decode got right. Surfaced so
   * that a layout which has drifted after a patch shows up as a falling match
   * rate rather than as a dodge that quietly stopped working.
   */
  confirmed = 0;
  unmatched = 0;

  get size(): number {
    return this.#blasts.length;
  }

  /**
   * Records a blast a telegraph has announced.
   *
   * @param armsInMs How long until it lands. Bounded and defaulted rather than
   *   trusted: the duration is one field of a packet whose body is read from a
   *   layout recovered out of the game's own metadata, and a nonsense value
   *   there should cost a sensible default rather than a blast pencilled in for
   *   next week.
   */
  announce(gameTimeMs: number, x: number, y: number, armsInMs: number): boolean {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    const delay =
      Number.isFinite(armsInMs) && armsInMs > 0 && armsInMs <= MAX_TELEGRAPH_MS
        ? armsInMs
        : DEFAULT_TELEGRAPH_MS;

    this.#blasts.push({
      x,
      y,
      radiusTiles: DEFAULT_BLAST_RADIUS_TILES,
      armsAtMs: gameTimeMs + delay,
      confirmed: false,
    });
    // Oldest first, so a burst cannot grow this without bound.
    if (this.#blasts.length > MAX_BLASTS) this.#blasts.shift();
    return true;
  }

  /**
   * Records a blast that has already gone off.
   *
   * Too late to dodge — this is the damage event — so it is kept only long
   * enough to answer "did the telegraph get it right", and to give the true
   * radius to anything reading the store for a picture.
   */
  landed(gameTimeMs: number, x: number, y: number, radiusTiles: number): void {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;

    let matched = false;
    for (const blast of this.#blasts) {
      if (blast.confirmed) continue;
      if (Math.hypot(blast.x - x, blast.y - y) > CONFIRM_TILES) continue;
      // Landed, so it is no longer something to walk out of — and the radius it
      // really had is worth keeping for whatever is drawing it.
      blast.confirmed = true;
      blast.armsAtMs = gameTimeMs;
      if (Number.isFinite(radiusTiles) && radiusTiles > 0) blast.radiusTiles = radiusTiles;
      matched = true;
      break;
    }
    if (matched) this.confirmed += 1;
    else this.unmatched += 1;
  }

  /**
   * Drops blasts that have gone off and are no longer worth remembering.
   *
   * Called before every read, like the projectile store's own pruning and for
   * the same reason: the cost is proportional to what is live, and a timer would
   * either run when nothing is happening or leave stale blasts in the planner's
   * way between ticks.
   */
  prune(gameTimeMs: number): void {
    if (this.#blasts.length === 0) return;
    this.#blasts = this.#blasts.filter((blast) => gameTimeMs - blast.armsAtMs < CONFIRM_WINDOW_MS);
  }

  /** Blasts still on their way down, expired ones already removed. */
  values(gameTimeMs: number): Iterable<BlastView> {
    this.prune(gameTimeMs);
    return this.#blasts;
  }

  clear(): void {
    this.#blasts.length = 0;
    this.confirmed = 0;
    this.unmatched = 0;
  }
}
