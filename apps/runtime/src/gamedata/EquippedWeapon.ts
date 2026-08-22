/**
 * What the game's data says about the item in the weapon slot.
 *
 * **One resolution per weapon, not one per tick.** Everything here comes out of
 * `objects.xml`, which is read once at startup and never changes afterwards — so
 * the answer for a given item is the same for the life of the process. Both
 * features that ask are on a loop: auto-aim resolves the weapon on every aim and
 * the dodge planner on every plan, fifty times a second between them, and each
 * of those was a catalog lookup, three multiplications and a fresh object for a
 * number that had not moved since the player last swapped an item.
 *
 * **A miss is not cached, and that is the one subtlety.** The catalogs are
 * parsed from disk while the proxy is already serving connections, so a lookup
 * during the first seconds of a session can fail for a weapon that will resolve
 * perfectly well a moment later. Remembering "unknown" would leave the features
 * guessing for the rest of the run.
 */

import type { ObjectCatalog } from '../state/ObjectCatalog.js';
import { reachTiles, speedTilesPerMs } from './projectiles.js';

/** How the player's own shots move, and how far they get. */
export interface WeaponShot {
  /**
   * The item's own id from `objects.xml`, for a person to read.
   *
   * Nothing decides anything by it. It is here so that what the overlay shows
   * can be checked against the data file it came out of — a range that looks
   * wrong is a different problem depending on whether the weapon named is the
   * one in the player's hand.
   */
  readonly name: string;
  /** Tiles per millisecond. */
  readonly speedTilesPerMs: number;
  readonly lifetimeMs: number;
  /**
   * How far one gets before it expires, in tiles.
   *
   * Precomputed rather than left to the caller: it is the same product every
   * time, and the two features that want it were each working it out for
   * themselves — which is two chances to disagree about what a weapon's range
   * means. See {@link reachTiles} for the parametric case, which is not a
   * product at all.
   */
  readonly reachTiles: number;
}

export class EquippedWeapon {
  readonly #catalog: () => ObjectCatalog;
  /**
   * Keyed by object type. Bounded by how many weapons the player equips in one
   * session, which is a handful — no eviction, because there is nothing to
   * evict.
   */
  readonly #known = new Map<number, WeaponShot>();

  /**
   * @param catalog Read through a callback rather than taken by value, so a
   *   session that starts before the data files finish loading picks them up
   *   when they do. The same reason the composition root hands the catalog to
   *   every other feature this way.
   */
  constructor(catalog: () => ObjectCatalog) {
    this.#catalog = catalog;
  }

  /**
   * The shot a weapon fires, or `undefined` for no weapon and for one the
   * catalog does not describe.
   *
   * A weapon declares one `<Projectile>`, which the reader indexes from zero. A
   * weapon with several — a few do — has them at successive indices and the
   * first is the one it fires by default.
   */
  of(objectType: number): WeaponShot | undefined {
    if (objectType < 0) return undefined;
    const known = this.#known.get(objectType);
    if (known !== undefined) return known;

    const catalog = this.#catalog();
    const definition = catalog.projectile(objectType, 0);
    if (definition === undefined) return undefined;
    const shot: WeaponShot = {
      name: catalog.displayName(objectType) ?? `type 0x${objectType.toString(16)}`,
      speedTilesPerMs: speedTilesPerMs(definition),
      lifetimeMs: definition.lifetimeMs,
      reachTiles: reachTiles(definition),
    };
    this.#known.set(objectType, shot);
    return shot;
  }

  /** Forgets everything. For when the catalog behind it is replaced. */
  clear(): void {
    this.#known.clear();
  }
}
