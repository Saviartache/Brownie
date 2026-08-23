/**
 * Whether a shot in flight is about to reach the player.
 *
 * **This is the half of auto-nexus that does not wait to be told.** Every other
 * signal the feature reads is an acknowledgement — the client saying a hit has
 * already happened — and that is the *last* moment at which an escape can still
 * beat the damage, not a comfortable one. The same hit was visible for most of a
 * second before it, as a shot with a known curve and a known size, and reading
 * it there is the difference between leaving before the hit and leaving in the
 * same breath as it.
 *
 * **Escaping on a forecast was a mistake once, and what changed is what the
 * forecast is for.** An earlier version of this feature predicted *danger* and
 * left whenever something was inbound, which in a bullet-hell is always. What is
 * predicted here is arithmetic — the health left if these particular shots land
 * — and it answers to a floor of its own, far below the one a hit that has
 * actually landed is measured against. Shots that will land and leave health
 * standing are the ordinary state of a fight, and the whole of what the caller
 * does with them is nothing.
 *
 * **The hit test is the game's own, and it is exact.** The same axis-aligned
 * square the dodge planner sweeps — see `dodge/hitbox.ts`, which is where the
 * shape and the player's half-extent come from — at the shot's own size, with no
 * caution scale and no pad. Widening it would buy escapes from shots that were
 * going to miss, and the caution this feature needs lives in the threshold,
 * where it can be seen and tuned.
 *
 * **The player is taken to stand still.** Where they will walk is not knowable,
 * and guessing would be guessing in the unsafe direction: the honest worst case
 * is that they hold their ground, and if that case is fatal the escape should
 * fire. The window is short for the same reason — over a few hundred
 * milliseconds nobody moves far enough for the assumption to matter.
 */

import type { Position } from '@brownie/plugin-api';
import { effectiveHalf, minChebyshevOnSegment } from '../dodge/hitbox.js';

/** No caution scale: this counts hits that will connect, not ones that graze. */
const EXACT_HIT_SCALE = 1;
const NO_PAD_TILES = 0;

/** What the forecast needs of a shot. A `ProjectileView` is one. */
export interface ForecastShot {
  /** `undefined` once it has expired — gone, not "still at its last place". */
  positionAt(gameTimeMs: number): Position | undefined;
  /** The shot's own collision half-extent, in tiles. */
  readonly collisionHalfTiles: number;
  /** When it stops existing, on the same clock `positionAt` is asked in. */
  readonly expiresAtMs: number;
}

/**
 * Whether `shot` would strike a player standing still at `player`, within
 * `withinMs` of now.
 *
 * Sampled into a polyline and swept *between* the samples rather than at them,
 * which is what lets a fast shot be seen at all: one crossing the player
 * entirely between two predicted positions overlaps neither, and testing them
 * would call it a miss. The step therefore bounds how far a curve may bend
 * between samples, not how far a shot may travel — `ThreatField` samples the
 * same way for the same reason.
 *
 * A shot whose motion the model does not describe — one that accelerates or
 * turns — is predicted as the straight line `positionAt` gives, and counted like
 * any other. Under-counting is the unsafe direction here, and the window is
 * short enough that the error inside it is small.
 *
 * @param sampleStepMs Spacing between predicted positions. Floored at one
 *   millisecond: a step of nought would not advance.
 */
export function strikesWithin(
  gameTimeMs: number,
  player: Position,
  shot: ForecastShot,
  withinMs: number,
  sampleStepMs: number,
): boolean {
  const untilMs = Math.min(withinMs, shot.expiresAtMs - gameTimeMs);
  if (!(untilMs >= 0)) return false;

  const half = effectiveHalf(shot.collisionHalfTiles, EXACT_HIT_SCALE, NO_PAD_TILES);
  const step = Math.max(1, sampleStepMs);

  const from = shot.positionAt(gameTimeMs);
  if (from === undefined) return false;
  let x0 = from.x - player.x;
  let y0 = from.y - player.y;

  for (let offset = step; ; offset += step) {
    // The last segment ends on the window rather than past it, so a shot
    // arriving just after it is not counted against this decision.
    const at = Math.min(offset, untilMs);
    const to = shot.positionAt(gameTimeMs + at);
    if (to === undefined) return false;
    const x1 = to.x - player.x;
    const y1 = to.y - player.y;
    if (minChebyshevOnSegment(x0, y0, x1, y1) < half) return true;
    if (at >= untilMs) return false;
    x0 = x1;
    y0 = y1;
  }
}
