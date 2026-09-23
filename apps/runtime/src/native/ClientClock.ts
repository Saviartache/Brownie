/**
 * The client's frame clock, read against the session's own.
 *
 * **Two clocks that tick together and start apart.** The client counts from
 * when the game started and stamps every frame with it; a shot's age and the
 * moment the player stood somewhere are both on that clock. The runtime counts
 * from when the session connected, and every shot it flies is on that one. Both
 * are real time, so the difference between them is one number — and finding it
 * is all it takes to put what the client said on the clock everything else
 * here runs on.
 *
 * **The quickest frame says it best.** A frame arrives some time after it was
 * stamped: the rest of the frame drawn, the pipe, the event loop. That delay is
 * never negative, so each arrival gives the offset *plus* a delay, and the
 * smallest of them is the closest to the offset itself. Sixty frames a second
 * is plenty of chances for one to come through with next to no delay.
 *
 * **Over a window, not for ever.** The session's clock is wall time, which the
 * system is entitled to nudge, and a minimum kept for the whole session would
 * hold on to a value from before the nudge. So the smallest is taken over the
 * last one to two windows, and a clock that moved is followed within one.
 *
 * What is left over is the shortest delay a frame ever makes, a millisecond or
 * two, and it moves everything the client said by the same amount — the player
 * and every shot together — so where they are *relative to each other*, which
 * is what a hit is, does not move at all.
 */

/** How long one window of arrivals is, in milliseconds. */
export const CLIENT_CLOCK_WINDOW_MS = 1000;

export class ClientClock {
  /** The session clock minus the client's, once anything has arrived. */
  #offsetMs: number | undefined;
  #windowStartMs = 0;
  #windowMin = Number.POSITIVE_INFINITY;
  #previousMin = Number.POSITIVE_INFINITY;

  /** Whether anything has been heard to set the offset by. */
  get known(): boolean {
    return this.#offsetMs !== undefined;
  }

  /**
   * One frame's stamp, and when it arrived on the session's clock.
   *
   * A stamp that is not a number is not an arrival: it is dropped rather than
   * allowed to become an offset nothing else could ever beat.
   */
  observe(arrivedAtMs: number, frameTimeMs: number): void {
    const sample = arrivedAtMs - frameTimeMs;
    if (!Number.isFinite(sample)) return;

    if (
      this.#offsetMs === undefined ||
      arrivedAtMs - this.#windowStartMs >= CLIENT_CLOCK_WINDOW_MS
    ) {
      this.#previousMin = this.#offsetMs === undefined ? Number.POSITIVE_INFINITY : this.#windowMin;
      this.#windowMin = Number.POSITIVE_INFINITY;
      this.#windowStartMs = arrivedAtMs;
    }
    this.#windowMin = Math.min(this.#windowMin, sample);
    this.#offsetMs = Math.min(this.#windowMin, this.#previousMin);
  }

  /** A moment on the client's clock, on the session's; nothing until known. */
  toSession(frameTimeMs: number): number | undefined {
    return this.#offsetMs === undefined ? undefined : frameTimeMs + this.#offsetMs;
  }

  /** Forgets everything — for a new session, or a new game on the other end. */
  reset(): void {
    this.#offsetMs = undefined;
    this.#windowStartMs = 0;
    this.#windowMin = Number.POSITIVE_INFINITY;
    this.#previousMin = Number.POSITIVE_INFINITY;
  }
}
