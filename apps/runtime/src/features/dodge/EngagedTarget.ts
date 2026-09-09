/**
 * The enemy the player picked to fight, as named from outside the plugin.
 *
 * **Shared between two features and owned by neither**, exactly as `FollowTarget`
 * is. The dodge takes the enemy under a Shift+left-click and holds a distance
 * from it; auto-aim reads the same id and stays on it while it can be hurt. The
 * two never touch each other — they touch this — which keeps a plugin from
 * reaching into another plugin's internals and keeps the coordination in the one
 * place the composition root owns.
 *
 * **Holding a distance from something and shooting at it are one decision**, and
 * that is why this exists rather than a second click. Somebody who has said "this
 * is the thing I am fighting" has said it once; having to say it again to a
 * different feature is the runtime asking the player to do its coordination.
 *
 * It holds an object id, not an entity: what the enemy is *doing* is a question
 * for the world on the tick that acts, and an id is the only part of the answer
 * that stays meaningful in between. It stops meaning anything at all on the next
 * map, which is why the dodge clears it there.
 */
export class EngagedTarget {
  #objectId: number | undefined;

  /** Name the enemy being fought, or `undefined` to let go of one. */
  set(objectId: number | undefined): void {
    this.#objectId = objectId;
  }

  /** The enemy being fought, or nothing when none is. */
  current(): number | undefined {
    return this.#objectId;
  }
}
