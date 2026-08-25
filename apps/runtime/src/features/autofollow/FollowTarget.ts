/**
 * The ally auto-follow is walking after, as set from outside the plugin.
 *
 * **Shared between two features and owned by neither.** Auto-teleport, having
 * carried the character to a teammate at the boss, names that teammate here;
 * auto-follow reads it and walks after them. The two never touch each other —
 * they touch this — which keeps a plugin from reaching into another plugin's
 * internals and keeps the coordination in one place the composition root owns,
 * exactly as the cursor and the steer signal are owned.
 *
 * It holds an object id, not a position: where the target *is* is a question for
 * the world on the tick the follow acts, and an id is what stays meaningful
 * across a teleport (which keeps the same map, so the same ids).
 */
export class FollowTarget {
  #objectId: number | undefined;

  /** Name the ally to follow. Replaces any earlier one. */
  request(objectId: number): void {
    this.#objectId = objectId;
  }

  /** Forget the ally, so nothing follows until one is named again. */
  clear(): void {
    this.#objectId = undefined;
  }

  /** The ally to follow, or nothing when none is set. */
  current(): number | undefined {
    return this.#objectId;
  }
}
