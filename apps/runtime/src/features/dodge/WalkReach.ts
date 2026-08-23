/**
 * How far each direction can actually be walked before the ground stops
 * cooperating.
 *
 * **Two different answers, and conflating them is a bug with a feel.** A wall
 * merely stops the character — walking into one costs nothing but the step — so
 * it should make a heading *unattractive* and never make the planner seize the
 * wheel. Damaging ground costs health, so a course heading into it is exactly
 * the "mistake" this feature exists to prevent, and is worth overriding a player
 * for. They are measured together because they are the same probe, and reported
 * apart because they mean opposite things.
 *
 * **Cached, because geometry does not move and the probe is not free.** Asking
 * whether the player fits somewhere is four tile lookups and four object
 * lookups; a plan asks it a few hundred times, forty times a second. The
 * reference implementation measured this exact cost inside the game — six
 * hundred walkability calls per rebuild, on the game's own thread, late enough
 * to make its auto-nexus miss — and answered it the same way: recompute when the
 * player's tile changes, and on a slow timer for doors and destructibles.
 */

/** The ground, as far as anything deciding where to walk needs it. */
export interface Ground {
  /** Whether the player's whole body fits here — walls, objects, unknown map. */
  canStand(x: number, y: number): boolean;
  /**
   * Whether a course reaching here should be treated as walking into damage.
   *
   * **Not "is the game charging for this tile", which is a different question
   * and is answered by {@link DodgeSituation.onDamagingGround}.** This one is
   * about somewhere the player is not yet: the body is nearly half a tile
   * across, and asking about the point at the middle of it let a course put
   * three quarters of the character over lava and call it clear. It carries a
   * margin as well, because damaging ground is the one hazard worth standing
   * well clear of rather than merely outside. See `damagingGround.ts`.
   */
  isDamaging(x: number, y: number): boolean;
}

/** What one direction offers. Filled in place; never handed out. */
export interface Reach {
  /** Tiles until the body no longer fits. `Infinity` means "past the probe". */
  wallTiles: number;
  /** Tiles until the ground starts hurting. `Infinity` means "past the probe". */
  hazardTiles: number;
  /**
   * Tiles until the ground stops hurting.
   *
   * Only meaningful when the player is standing on damaging ground, where it is
   * the whole question: every direction is "on fire" at zero tiles, and the one
   * worth taking is whichever leaves soonest.
   */
  exitTiles: number;
}

/**
 * Spacing between probes along a heading.
 *
 * Under half a tile, so a single damaging tile cannot sit between two probes;
 * coarse enough that a five-tile reach is twenty-five questions rather than a
 * hundred.
 */
const PROBE_STEP_TILES = 0.2;

/**
 * How long a cached answer stands while the player holds still.
 *
 * Walls do not move, but doors open and destructibles fall, and the map arrives
 * in pieces — so "static" is true of the geometry and not of what we know about
 * it.
 */
const REFRESH_MS = 400;

export class WalkReach {
  #wall = new Float64Array(0);
  #hazard = new Float64Array(0);
  #exit = new Float64Array(0);

  #tileX = Number.NaN;
  #tileY = Number.NaN;
  #count = -1;
  #maxTiles = -1;
  #atMs = 0;

  /**
   * Measures the fixed heading table, or reuses the last measurement.
   *
   * @param headingX Unit components, `count` of them, in the planner's order.
   */
  refresh(
    selfX: number,
    selfY: number,
    headingX: Float64Array,
    headingY: Float64Array,
    count: number,
    maxTiles: number,
    ground: Ground,
    nowMs: number,
  ): void {
    const tileX = Math.floor(selfX);
    const tileY = Math.floor(selfY);
    const stale =
      tileX !== this.#tileX ||
      tileY !== this.#tileY ||
      count !== this.#count ||
      maxTiles !== this.#maxTiles ||
      nowMs - this.#atMs >= REFRESH_MS;
    if (!stale) return;

    if (this.#wall.length < count) {
      this.#wall = new Float64Array(count);
      this.#hazard = new Float64Array(count);
      this.#exit = new Float64Array(count);
    }

    const found: Reach = { wallTiles: Infinity, hazardTiles: Infinity, exitTiles: Infinity };
    for (let i = 0; i < count; i += 1) {
      this.probe(selfX, selfY, headingX[i] ?? 0, headingY[i] ?? 0, maxTiles, ground, found);
      this.#wall[i] = found.wallTiles;
      this.#hazard[i] = found.hazardTiles;
      this.#exit[i] = found.exitTiles;
    }

    this.#tileX = tileX;
    this.#tileY = tileY;
    this.#count = count;
    this.#maxTiles = maxTiles;
    this.#atMs = nowMs;
  }

  /** What {@link refresh} found for heading `index`. */
  wallTilesFor(index: number): number {
    return this.#wall[index] ?? Infinity;
  }

  hazardTilesFor(index: number): number {
    return this.#hazard[index] ?? Infinity;
  }

  exitTilesFor(index: number): number {
    return this.#exit[index] ?? Infinity;
  }

  /**
   * Measures one direction now, for a heading the table does not hold.
   *
   * The player's own direction is the case: it is whatever they are pressing,
   * changes on a keystroke, and is worth its own two dozen questions rather than
   * a cache that would be wrong for the frame that matters.
   */
  probe(
    selfX: number,
    selfY: number,
    dirX: number,
    dirY: number,
    maxTiles: number,
    ground: Ground,
    out: Reach,
  ): void {
    out.wallTiles = Infinity;
    out.hazardTiles = Infinity;
    out.exitTiles = Infinity;
    if (dirX === 0 && dirY === 0) return;

    for (let along = PROBE_STEP_TILES; along <= maxTiles; along += PROBE_STEP_TILES) {
      const x = selfX + dirX * along;
      const y = selfY + dirY * along;
      const damaging = ground.isDamaging(x, y);
      if (damaging) {
        if (out.hazardTiles === Infinity) out.hazardTiles = along;
      } else if (out.exitTiles === Infinity) {
        out.exitTiles = along;
      }
      if (!ground.canStand(x, y)) {
        // The last place that held, not the first that did not.
        out.wallTiles = along - PROBE_STEP_TILES;
        return;
      }
    }
  }
}
