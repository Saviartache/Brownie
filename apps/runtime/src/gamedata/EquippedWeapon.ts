/**
 * What the game's data says about the item in the weapon slot.
 *
 * **One resolution per weapon, not one per tick.** Everything here comes out of
 * `objects.xml`, which is read once at startup and never changes afterwards — so
 * the answer for a given item is the same for the life of the process. Both
 * features that ask are on a loop: auto-aim resolves the weapon on every aim and
 * the dodge planner on every plan, fifty times a second between them, and each
 * of those would be a catalog lookup and a whole flight flown for a number that
 * had not moved since the player last swapped an item.
 *
 * **A miss is not cached, and that is the one subtlety.** The catalogs are
 * parsed from disk while the proxy is already serving connections, so a lookup
 * during the first seconds of a session can fail for a weapon that will resolve
 * perfectly well a moment later. Remembering "unknown" would leave the features
 * guessing for the rest of the run.
 */

import type { ObjectCatalog } from '../state/ObjectCatalog.js';
import { ShotMotion } from '../state/projectiles/ShotMotion.js';
import { speedTilesPerMs, type ProjectileDefinition } from './projectiles.js';

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
  /**
   * Tiles per millisecond, as the shot leaves the weapon.
   *
   * Only the launch speed: a shot that brakes or speeds up does not keep it,
   * which is why {@link reachTiles} is flown rather than worked out from this.
   */
  readonly speedTilesPerMs: number;
  readonly lifetimeMs: number;
  /**
   * How far ahead one gets before it expires, in tiles.
   *
   * Precomputed rather than left to the caller: it is a whole flight worked
   * out once, and the two features that want it were each working it out for
   * themselves — which is two chances to disagree about what a weapon's range
   * means. See {@link forwardReachTiles} for why it is not speed times life.
   */
  readonly reachTiles: number;
}

/**
 * How many moments of a flight are looked at to find how far it gets.
 *
 * **Divisible by four on purpose.** The places a shot's reach peaks by
 * construction — the end of an ordinary flight, a boomerang's turn at half of
 * it, a fixed arc's tip at a quarter or three quarters — are then looked at
 * exactly rather than a step to one side. A shot that peaks anywhere else is
 * found within a step, which is a couple of milliseconds of flight. Paid once
 * per weapon.
 */
const REACH_SAMPLES = 1024;

/**
 * How far ahead of the player one of these gets before it expires, in tiles.
 *
 * **Flown, not multiplied.** Speed times life is right for a plain bullet and
 * wrong for a sixth of the game's weapons: an axe that brakes to a crawl a
 * quarter of the way through its life, a flail that comes back, one that
 * circles its thrower, a blade that hangs still and then shoots off. The live
 * report was the Jagged Hatchet — 33.75 tiles by the product, under five in the
 * game — and the engage ring, held at a share of that, walked the player off
 * the screen instead of holding the fight. So the shot is flown through
 * `ShotMotion`, the client's own motion code that every enemy shot is already
 * predicted with, and the reach is the furthest it gets.
 *
 * **Measured along the line it was fired on, not in any direction**, because
 * everything that reads it is asking how far off a monster can be and still be
 * hit by a shot aimed at it. For almost every weapon the two are the same. They
 * part for a fixed-arc weapon, whose figure bulges a quarter further out to the
 * side than it reaches ahead — its magnitude is the reach, as the reference
 * implementation's `WeaponProfile` also has it — and for the few shots that curl
 * away, where the ground ahead is the part a shot aimed straight can use.
 *
 * Still the item's own reach: the game scales a shot's speed and life by buffs
 * held in the client, and neither is on the wire. An unbuffed reach keeps
 * whatever reads it closer than it needs to be, which is the safe direction.
 */
function forwardReachTiles(definition: ProjectileDefinition): number {
  // Fired from the origin along x, so how far ahead it is at any moment is its
  // x. The bullet id only picks which side a wave or an arc sets off on, which
  // moves nothing ahead.
  const motion = new ShotMotion(definition, {
    bulletId: 0,
    x: 0,
    y: 0,
    angle: 0,
    speedMultiplier: 1,
    lifetimeMultiplier: 1,
  });
  let furthest = 0;
  for (let sample = 1; sample <= REACH_SAMPLES; sample += 1) {
    const at = motion.positionAt((motion.lifetimeMs * sample) / REACH_SAMPLES);
    if (at !== undefined && at.x > furthest) furthest = at.x;
  }
  return furthest;
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
      reachTiles: forwardReachTiles(definition),
    };
    this.#known.set(objectType, shot);
    return shot;
  }

  /** Forgets everything. For when the catalog behind it is replaced. */
  clear(): void {
    this.#known.clear();
  }
}
