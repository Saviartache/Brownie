/**
 * The ground around the player, asked about once per tile.
 *
 * **A tile is not a point, and neither is a player.** Both questions this
 * answers are about a body: whether it fits somewhere, and whether any of it is
 * over ground that hurts. Asking about the single point at the middle of the
 * character let a course put three quarters of the body over lava and read as
 * clear — and then the first thing that moved it, a server correction, a
 * rounding, the next step, put the player in it.
 *
 * **What is cached is the tile, not the answer.** The planner probes a few
 * hundred places per plan and fifty plans go by a second, so the map cannot be
 * asked about each of them: `tileAt` builds a record per call and `canStandAt`
 * makes eight lookups. But a *direction* is the wrong thing to remember. Reach
 * along a heading is measured from wherever the player stood when it was
 * measured, so a table of them keyed on the player's tile is a table that is
 * wrong by up to a tile for as long as they are crossing it — which is a wall
 * reported a tile further off than it is, and a pool reported a tile short of
 * the body already in it. Tiles do not move; distances from the player do.
 *
 * So one flag pair per tile is kept and the geometry is redone exactly, every
 * plan, from where the character actually is. This is the reference
 * implementation's own discipline — `ZDodgeSensors` builds its blockers from a
 * grid of tile centres, and `XDodge`'s walkability cache recomputes on
 * grid-recentre and a slow timer, "never because a projectile spawned".
 *
 * **Unknown ground is refused, and is not damaging.** The server sends the
 * tiles around the player and no further, so "not been told about" is the edge
 * of what is known: a body may not be planned into it, and calling it a fire as
 * well would only make the planner flee the edge of its own knowledge.
 */

import type { TileView } from '@brownie/plugin-api';
import { packCoordinate } from '../../state/TileMap.js';
import { PLAYER_ENVIRONMENT_HALF_TILES } from './hitbox.js';

/** The part of the world this needs. Both are on `WorldView`. */
export interface GroundSource {
  canStandAt(x: number, y: number, clearanceTiles?: number): boolean;
  tileAt(x: number, y: number): TileView | undefined;
}

/** A body may not be here: a wall, an object owning the square, or unknown. */
const BLOCKED = 1;
/** The game charges health for standing here. */
const DAMAGING = 2;

/**
 * How long a tile's answer stands.
 *
 * Walls do not move, but doors open, destructibles fall, and the map arrives in
 * pieces — so "static" is true of the geometry and not of what we know about
 * it. The same slow re-probe, for the same reason, as the reference's.
 */
const REFRESH_MS = 400;

export class GroundCache {
  readonly #flags = new Map<number, number>();
  #source: GroundSource | undefined;
  #tileX = Number.NaN;
  #tileY = Number.NaN;
  #atMs = 0;

  /**
   * Points the cache at the world, dropping whatever has gone stale.
   *
   * Called once per plan, before anything asks. The player's tile is part of
   * the key because a step into the next one brings a ring of ground into reach
   * that has never been asked about — and because it is the cheap moment to
   * throw away the tiles behind them.
   */
  aim(source: GroundSource, selfX: number, selfY: number, nowMs: number): void {
    const tileX = Math.floor(selfX);
    const tileY = Math.floor(selfY);
    if (
      source === this.#source &&
      tileX === this.#tileX &&
      tileY === this.#tileY &&
      nowMs - this.#atMs < REFRESH_MS
    ) {
      return;
    }
    this.#flags.clear();
    this.#source = source;
    this.#tileX = tileX;
    this.#tileY = tileY;
    this.#atMs = nowMs;
  }

  /** Forgets the map. A new connection is a new map full of unknown ground. */
  clear(): void {
    this.#flags.clear();
    this.#source = undefined;
    this.#tileX = Number.NaN;
    this.#tileY = Number.NaN;
  }

  /**
   * Whether the body, widened by `clearanceTiles`, fits here.
   *
   * @param clearanceTiles Room to demand on every side. Floored at zero: a
   *   narrower body is a different question, and answering it here would let a
   *   plan walk where the player cannot.
   */
  canStand(x: number, y: number, clearanceTiles: number): boolean {
    return !this.#bodyCovers(x, y, clearanceTiles, BLOCKED);
  }

  /**
   * Whether the body, widened by `clearanceTiles`, covers ground that hurts.
   *
   * **Not "is the game charging for this tile"** — that one is about the tile
   * under the character's middle and is asked of the map directly. This is
   * about somewhere the player is not yet, so it is asked about the whole body
   * and a margin around it: damaging ground is the one hazard worth standing
   * well clear of rather than merely outside, because a wall costs a step, a
   * shot costs a graze, and a lava tile costs health every tick with nothing
   * left to dodge.
   */
  isDamaging(x: number, y: number, clearanceTiles: number): boolean {
    return this.#bodyCovers(x, y, clearanceTiles, DAMAGING);
  }

  /**
   * Whether any tile the widened body touches carries `flag`.
   *
   * Every tile in the box rather than its four corners: the corners are enough
   * only while the box is under two tiles across, which is true of every margin
   * the overlay offers and would stop being true the moment somebody raised the
   * limit. Two nested loops over at most three by three cannot be wrong.
   */
  #bodyCovers(x: number, y: number, clearanceTiles: number, flag: number): boolean {
    const half = PLAYER_ENVIRONMENT_HALF_TILES + Math.max(0, clearanceTiles);
    const fromX = Math.floor(x - half);
    const toX = Math.floor(x + half);
    const fromY = Math.floor(y - half);
    const toY = Math.floor(y + half);

    for (let tileX = fromX; tileX <= toX; tileX += 1) {
      for (let tileY = fromY; tileY <= toY; tileY += 1) {
        if ((this.#at(tileX, tileY) & flag) !== 0) return true;
      }
    }
    return false;
  }

  /** What one tile is, from the cache or from the map. */
  #at(tileX: number, tileY: number): number {
    const key = packCoordinate(tileX, tileY);
    const known = this.#flags.get(key);
    if (known !== undefined) return known;

    const source = this.#source;
    // Nothing to ask, so nowhere to stand. The planner is unaimed for exactly
    // one case — between sessions — and refusing every course is the right
    // answer to "which way should I dodge on a map I do not have".
    if (source === undefined) return BLOCKED;

    // **The middle of the tile, which is what makes one answer per tile the
    // whole of the question.** The body is under half a tile across, so asked
    // there it reaches into no other tile and the map's answer is about this
    // square alone — walls, objects that own it, and ground nobody has
    // described. Exactly the probe `ZDodgeSensors` builds its blocker grid
    // from. The body's real extent is put back by {@link #bodyCovers}.
    let flags = source.canStandAt(tileX + 0.5, tileY + 0.5, 0) ? 0 : BLOCKED;
    if (source.tileAt(tileX, tileY)?.damaging === true) flags |= DAMAGING;
    this.#flags.set(key, flags);
    return flags;
  }
}
