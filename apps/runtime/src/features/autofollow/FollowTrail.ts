/**
 * The route an ally actually took, so the follow can take it too.
 *
 * **A straight line is not a route, and that was the bug.** The follow aimed at
 * where the ally stood and handed the heading to the native mover, which walks
 * it and tests nothing on the way. An ally who rounded a corner, crossed a
 * doorway or stepped behind a pillar was therefore an ally the character ran at
 * through a wall — wedged against it at full speed, for as long as they stayed
 * there, because the target the plugin published every tick never stopped
 * pointing into the scenery.
 *
 * So the trail remembers where the ally has *been*. Somebody walked those
 * places, in that order, moments ago: it is a route known to be walkable,
 * around whatever the straight line runs into, and following it is the whole of
 * getting round a corner without a pathfinder, a tile graph or a search.
 *
 * **What keeps it cheap is that the trail is not followed literally.** Retracing
 * every place the ally stood would copy their dithering and lose ground on
 * every step; instead the follow looks from where it stands for the *furthest*
 * remembered place it can walk straight to and goes there, dropping everything
 * older. That is string-pulling, and it costs a handful of line tests against a
 * tile cache. In open ground the furthest such place is the ally themselves and
 * the trail collapses to nothing, so this is the old behaviour exactly — the
 * memory only earns its keep at the moment sight is lost, which is the moment
 * it is needed.
 *
 * The crumbs are pruned from three sides: the front as ground is covered, the
 * middle by the string pull, and the back by a hard cap. A session's trail is
 * bounded at a few dozen points and usually holds one or two.
 */

import type { Position } from '@brownie/plugin-api';
import {
  CRUMB_REACHED_TILES,
  SHORTCUT_REACH_TILES,
  TRAIL_MAX_CRUMBS,
  TRAIL_SPACING_TILES,
} from './constants.js';
import { followPoint, tilesBetween } from './followMath.js';

/** Whether the character's body fits everywhere on the line between two places. */
export type PathTest = (from: Position, to: Position) => boolean;

export class FollowTrail {
  /** Oldest first. The ally's own current position is never in here. */
  readonly #crumbs: Position[] = [];
  #forId: number | undefined;

  /**
   * Name the ally these places belong to, forgetting them if it has changed.
   *
   * A trail is only evidence about a route because one person walked it in
   * order; splicing a new ally's positions onto the end of an old ally's makes
   * a polyline nobody ever walked, with a jump across the map in the middle of
   * it.
   */
  aim(objectId: number): void {
    if (objectId === this.#forId) return;
    this.#forId = objectId;
    this.#crumbs.length = 0;
  }

  /**
   * Remember where the ally is, if they have moved far enough to be worth it.
   *
   * See {@link TRAIL_SPACING_TILES} for why the spacing rather than every tick.
   */
  record(at: Position): void {
    const last = this.#crumbs.at(-1);
    if (last !== undefined && tilesBetween(last, at) < TRAIL_SPACING_TILES) return;
    this.#crumbs.push({ x: at.x, y: at.y });
    if (this.#crumbs.length > TRAIL_MAX_CRUMBS) this.#crumbs.shift();
  }

  /** Forget the route and the ally. A new map is a new world. */
  clear(): void {
    this.#crumbs.length = 0;
    this.#forId = undefined;
  }

  /** How many places stand. For tests and diagnostics; nothing steers by it. */
  get length(): number {
    return this.#crumbs.length;
  }

  /**
   * Where to walk this tick, or nothing when the character should stand still.
   *
   * The polyline is the remembered places followed by the ally themselves, and
   * the answer is the furthest node on it that can be walked to in a straight
   * line — scanned from the ally backwards, so the first hit is the furthest
   * and the scan is over as soon as sight is clear. Only the last leg keeps the
   * player's distance: an intermediate crumb is a corner to get round, and
   * stopping short of a corner is stopping *at* the wall it was recorded to
   * avoid.
   *
   * Every node older than the one chosen is dropped, bar one. **The spare is
   * not slack.** Heading straight for the ally clears the whole trail, and an
   * ally who steps behind a pillar the tick after that would leave nothing to
   * retrace but the straight line that no longer works; the kept crumb is where
   * they stood a moment before, which is on this side of whatever they have
   * just gone behind.
   */
  steer(
    self: Position,
    target: Position,
    keepDistanceTiles: number,
    walkable: PathTest,
  ): Position | undefined {
    // Ground covered. Done first so a crumb underfoot is never the answer to
    // "where next", which is how a follow ends up shuffling on the spot.
    for (;;) {
      const first = this.#crumbs[0];
      if (first === undefined || tilesBetween(self, first) > CRUMB_REACHED_TILES) break;
      this.#crumbs.shift();
    }

    for (let i = this.#crumbs.length; i >= 0; i -= 1) {
      const atTarget = i === this.#crumbs.length;
      const node = this.#crumbs[i] ?? target;
      // Too far to be a walk target on a map that is only known nearby, and the
      // longest line test of the lot. The nearer, older crumbs still get asked.
      if (tilesBetween(self, node) > SHORTCUT_REACH_TILES) continue;
      if (!walkable(self, node)) continue;
      // The spare is kept only on the last leg; a crumb is reached and done
      // with, and everything behind it with it.
      this.#crumbs.splice(0, atTarget ? Math.max(0, i - 1) : i);
      return atTarget ? followPoint(self, target, keepDistanceTiles) : node;
    }

    // Nothing in sight at all — a corner tighter than the trail records, or a
    // map we have not been told about. The oldest crumb is the nearest thing to
    // a route we have, and walking at it is what the follow did before this
    // existed. Better to edge towards the route than to give up standing still.
    return this.#crumbs[0] ?? followPoint(self, target, keepDistanceTiles);
  }
}
