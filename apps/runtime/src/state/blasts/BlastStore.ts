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
 * **What arrives is a telegraph, and it says where and when but never how
 * wide.** The width is measured afterwards, off the `AOE` that follows, and
 * remembered against the thrower — see {@link BlastRadiusTable}. A key that has
 * thrown before is planned around its measured radius from the moment it is
 * announced; a key that has not gets {@link DEFAULT_BLAST_RADIUS_TILES}, because
 * an unknown blast must still be treated as dangerous.
 */

import type { BlastView } from '@brownie/plugin-api';
import { BlastRadiusTable } from './BlastRadiusTable.js';

/**
 * How wide a telegraphed blast is assumed to be, in tiles.
 *
 * The reference implementation's `kDefaultAoeRadiusTiles`. It is a guess in both
 * directions — the one blast it could measure properly came out around three
 * tiles — and it is the honest thing to use for a key nothing has been measured
 * for, because the alternative is to treat an unknown radius as nought and walk
 * into it.
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

/** What a telegraph carries. See {@link BlastStore.announce}. */
export interface BlastTelegraph {
  /** Where it will land. */
  readonly x: number;
  readonly y: number;
  /**
   * How long until it lands, from the telegraph's own duration field.
   *
   * Bounded and defaulted rather than trusted: the duration is one field of a
   * packet whose body is read from a layout recovered out of the game's own
   * metadata, and a nonsense value there should cost a measured or a sensible
   * delay rather than a blast pencilled in for next week.
   */
  readonly armsInMs: number;
  /**
   * The object type of whatever announced it, or {@link UNKNOWN_ORIGIN_TYPE}.
   *
   * Half of the key the measured radius is remembered under, and nothing else:
   * whether the *thrower* is worth dodging at all is decided before this, by
   * whoever read the packet. See `StateStage`.
   */
  readonly originType: number;
  /** The effect's colour, the other half of that key. */
  readonly color: number;
}

/** What a detonation carries. See {@link BlastStore.landed}. */
export interface BlastLanding {
  readonly x: number;
  readonly y: number;
  /** How far it actually reached, which is the number worth remembering. */
  readonly radiusTiles: number;
  /**
   * Whether it could hurt anybody.
   *
   * A teammate's heal is an area effect in every respect the wire cares about,
   * and it lands where teammates are — which is where we are. One counted as a
   * detonation confirms whatever prediction it happens to land near, cancelling
   * a real bomb still on its way down, and teaches the radius table a number
   * from an ability nobody has to dodge.
   */
  readonly harmful: boolean;
}

/**
 * An origin nothing could be resolved for.
 *
 * Neither read from the table nor written to it: every unresolved thrower would
 * otherwise share one key, and a radius measured off whichever of them landed
 * first would be applied to all the rest. "We do not know whose this is" has to
 * mean the default, not a stranger's measurement.
 */
export const UNKNOWN_ORIGIN_TYPE = -1;

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
  /** When the telegraph arrived, so a landing gives the flight time away. */
  announcedAtMs: number;
  originType: number;
  color: number;
}

export class BlastStore {
  #blasts: TrackedBlast[] = [];
  readonly #radii: BlastRadiusTable;

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

  /**
   * @param radii Where measurements are read from and written back to. Shared
   *   across sessions and across runs, because what an enemy's bomb does is a
   *   property of the game rather than of a connection. Its own by default, so
   *   a store built without one still learns within the run.
   */
  constructor(radii: BlastRadiusTable = new BlastRadiusTable()) {
    this.#radii = radii;
  }

  get size(): number {
    return this.#blasts.length;
  }

  /**
   * Records a blast a telegraph has announced.
   *
   * The radius is the one measured for this key when there is one, and the
   * default when there is not. The delay is the telegraph's own duration when it
   * reads as a duration, the measured flight time when it does not, and a flat
   * default when neither is available — in that order, because the packet is
   * talking about *this* bomb and the table is only talking about its siblings.
   */
  announce(gameTimeMs: number, telegraph: BlastTelegraph): boolean {
    if (!Number.isFinite(telegraph.x) || !Number.isFinite(telegraph.y)) return false;

    const measured =
      telegraph.originType === UNKNOWN_ORIGIN_TYPE
        ? undefined
        : this.#radii.lookUp(telegraph.originType, telegraph.color);
    const armsInMs = telegraph.armsInMs;
    const flightMs = measured?.flightMs ?? 0;
    const delay =
      Number.isFinite(armsInMs) && armsInMs > 0 && armsInMs <= MAX_TELEGRAPH_MS
        ? armsInMs
        : flightMs > 0
          ? flightMs
          : DEFAULT_TELEGRAPH_MS;

    this.#blasts.push({
      x: telegraph.x,
      y: telegraph.y,
      radiusTiles: measured?.radiusTiles ?? DEFAULT_BLAST_RADIUS_TILES,
      armsAtMs: gameTimeMs + delay,
      confirmed: false,
      announcedAtMs: gameTimeMs,
      originType: telegraph.originType,
      color: telegraph.color,
    });
    // Oldest first, so a burst cannot grow this without bound.
    if (this.#blasts.length > MAX_BLASTS) this.#blasts.shift();
    return true;
  }

  /**
   * Records a blast that has already gone off.
   *
   * Too late to dodge — this is the damage event — so what it is kept for is
   * everything the *next* one needs: whether the telegraph was read correctly,
   * how wide the blast really was, and how long it was in the air. The last two
   * are learned only from a detonation that matched a prediction, because the
   * flight time only exists as the gap between the two and because a key learned
   * from an unmatched landing is a key nothing would ever look up.
   */
  landed(gameTimeMs: number, landing: BlastLanding): void {
    if (!Number.isFinite(landing.x) || !Number.isFinite(landing.y)) return;
    // Nothing to dodge, nothing to confirm, nothing to learn. Not counted as
    // unmatched either: it is not a missed prediction, it is not a blast.
    if (!landing.harmful) return;

    for (const blast of this.#blasts) {
      if (blast.confirmed) continue;
      if (Math.hypot(blast.x - landing.x, blast.y - landing.y) > CONFIRM_TILES) continue;

      if (blast.originType !== UNKNOWN_ORIGIN_TYPE) {
        this.#radii.learn(
          blast.originType,
          blast.color,
          landing.radiusTiles,
          gameTimeMs - blast.announcedAtMs,
        );
      }
      // Landed, so it is no longer something to walk out of — and the radius it
      // really had is worth keeping for whatever is drawing it.
      blast.confirmed = true;
      blast.armsAtMs = gameTimeMs;
      if (Number.isFinite(landing.radiusTiles) && landing.radiusTiles > 0) {
        blast.radiusTiles = landing.radiusTiles;
      }
      this.confirmed += 1;
      return;
    }
    this.unmatched += 1;
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

  /**
   * Drops everything this session knew.
   *
   * The measured radii are deliberately untouched: they describe the game rather
   * than the connection, and a map change is exactly when the same enemy is
   * about to be met again.
   */
  clear(): void {
    this.#blasts.length = 0;
    this.confirmed = 0;
    this.unmatched = 0;
  }
}
