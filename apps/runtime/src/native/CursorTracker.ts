/**
 * Where the player is pointing, as a place on the map.
 *
 * **Only the module can say it, and this is the runtime's whole memory of it.**
 * A cursor is a point on a window; the map is somewhere else entirely, and
 * turning one into the other means asking the game's own camera where things
 * are. The module measures it against that camera and sends tiles twenty times
 * a second while anything is watching — see `ScreenProjection.h` for how and
 * `docs/ipc.md` for the record.
 *
 * **A place, not a direction, and the difference is the whole feature.** This
 * used to be an angle scavenged from the client's shot path, on the argument
 * that a cursor names a direction and nothing else. A live session settled it:
 * that angle is zero on every call, so everything ranking by it ranked by due
 * east. A point is also strictly more: "nearest the cursor" becomes a distance
 * to somewhere the player actually pointed rather than a cone around a bearing.
 *
 * **It expires, and that is the safety.** The module says nothing when nobody
 * is watching, and a module that was killed, unloaded or restarted mid-aim says
 * nothing either — so silence has to mean "we do not know" on its own, which is
 * what {@link CURSOR_FRESH_MS} makes it mean.
 */

import type { Position } from '@brownie/plugin-api';

/**
 * How long a reading stands without being restated.
 *
 * Ten of the module's, so a stalled frame or a busy loop does not drop an aim
 * that is still wanted, and short enough that a module which stops talking
 * stops steering within half a second.
 */
export const CURSOR_FRESH_MS = 500;

export interface CursorTrackerOptions {
  /** Injected so a test can move time instead of waiting for it. */
  readonly now?: () => number;
  readonly freshForMs?: number;
}

export class CursorTracker {
  readonly #now: () => number;
  readonly #freshForMs: number;

  #x = 0;
  #y = 0;
  /** Undefined whenever there is no reading to act on. */
  #atMs: number | undefined;

  constructor(options: CursorTrackerOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#freshForMs = options.freshForMs ?? CURSOR_FRESH_MS;
  }

  /**
   * Records where the cursor is.
   *
   * A field that did not parse arrives as `NaN` and is dropped rather than
   * stored: a point nobody can locate would be an aim at `NaN`, which the
   * module would faithfully pass to the game.
   */
  observe(x: number, y: number): void {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    this.#x = x;
    this.#y = y;
    this.#atMs = this.#now();
  }

  /** Forgets it now, rather than waiting out the freshness. */
  release(): void {
    this.#atMs = undefined;
  }

  /** Where the player is pointing, or nothing when nobody knows. */
  point(): Position | undefined {
    const at = this.#atMs;
    if (at === undefined) return undefined;
    if (this.#now() - at > this.#freshForMs) return undefined;
    return { x: this.#x, y: this.#y };
  }
}
