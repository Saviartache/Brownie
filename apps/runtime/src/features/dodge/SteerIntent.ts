/**
 * Which way the player is asking to walk.
 *
 * **Only the module can answer this, and not by reading a key.** Which world
 * direction `W` means depends on where the camera is pointing — the game maps
 * movement through it, so a rotated camera turns "forward" into any heading at
 * all. The module already knows how to ask the camera that question (see
 * `ScreenProjection.h`), so it sends the answer as a world direction and nothing
 * here has to know about keys, cameras or which way `y` counts.
 *
 * **It expires, and that is the whole of the safety.** A direction is used to
 * *subtract* the player's own movement when the dodge takes the wheel — see
 * `dodgePlugin`'s interception — so believing in one nobody is holding pushes
 * the character sideways for no reason. A module that was killed, unloaded or
 * restarted mid-stride stops saying anything, and silence has to mean "let go"
 * on its own. The release record makes that immediate;
 * {@link STEER_FRESH_MS} makes it certain.
 */

import type { Position } from '@brownie/plugin-api';

/**
 * How long a direction stands without being restated.
 *
 * A few of the module's heartbeats. Shorter than the walk-to-cursor target's,
 * because a stale steering direction is acted *against* rather than merely
 * followed.
 */
export const STEER_FRESH_MS = 350;

export interface SteerOptions {
  /** Injected so a test can move time instead of waiting for it. */
  readonly now?: () => number;
  readonly freshForMs?: number;
}

export class SteerTracker {
  readonly #now: () => number;
  readonly #freshForMs: number;

  #x = 0;
  #y = 0;
  /** Undefined whenever nobody is asking to move. */
  #atMs: number | undefined;

  constructor(options: SteerOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#freshForMs = options.freshForMs ?? STEER_FRESH_MS;
  }

  /**
   * Records which way the player is steering.
   *
   * Normalised here rather than trusted: the module sends thousandths of a unit
   * vector, and rounding four of those leaves a length that is close to one and
   * not one. A direction that did not parse, or that came through as no
   * direction at all, is dropped rather than stored — the alternative is a
   * cancellation term multiplied by `NaN`.
   */
  observe(x: number, y: number): void {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const length = Math.hypot(x, y);
    if (length < 1e-3) return;
    this.#x = x / length;
    this.#y = y / length;
    this.#atMs = this.#now();
  }

  /** The keys came up. Immediate, rather than waiting out the freshness. */
  release(): void {
    this.#atMs = undefined;
  }

  /** A unit direction, or nothing when the player is not steering. */
  direction(): Position | undefined {
    const at = this.#atMs;
    if (at === undefined) return undefined;
    if (this.#now() - at > this.#freshForMs) return undefined;
    return { x: this.#x, y: this.#y };
  }
}
