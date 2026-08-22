import type { TileView } from '@brownie/plugin-api';

/**
 * What the game's `tiles.xml` says about a ground type.
 *
 * Same reasoning as `ObjectCatalog`: whether a tile hurts or blocks is game
 * data, not something the packet stream states. Until the loader is ported this
 * answers "no", which is the safe direction — a feature that avoids damaging
 * tiles simply will not avoid any, rather than avoiding the wrong ones.
 */
export interface TileCatalog {
  isDamaging(tileType: number): boolean;
  isBlocking(tileType: number): boolean;
  /**
   * Whether standing on one of these carries the character along.
   *
   * `<Push />` in `tiles.xml`, and nothing on the wire says so: a conveyor
   * arrives as an ordinary ground type and the *client* is what reads the
   * marker and moves the player. Which is why a feature that does not want to
   * be moved changes what the client is told the ground is.
   */
  isPushing(tileType: number): boolean;
}

export const EMPTY_TILE_CATALOG: TileCatalog = {
  isDamaging: () => false,
  isBlocking: () => false,
  isPushing: () => false,
};

/**
 * The ground, as far as the server has revealed it.
 *
 * Sparse: a map only ever sends the tiles around the player, and a realm is
 * 2048×2048, so a dense array would be 4 M entries to hold a few thousand.
 * Keyed by a packed coordinate rather than a string, because this is written on
 * every `UPDATE` and read on every movement decision.
 */
export class TileMap {
  readonly #tiles = new Map<number, number>();
  readonly #catalog: TileCatalog;

  constructor(catalog: TileCatalog) {
    this.#catalog = catalog;
  }

  get size(): number {
    return this.#tiles.size;
  }

  set(x: number, y: number, tileType: number): void {
    this.#tiles.set(packCoordinate(x, y), tileType);
  }

  typeAt(x: number, y: number): number | undefined {
    return this.#tiles.get(packCoordinate(x, y));
  }

  at(x: number, y: number): TileView | undefined {
    const type = this.typeAt(x, y);
    if (type === undefined) return undefined;
    return {
      type,
      damaging: this.#catalog.isDamaging(type),
      blocking: this.#catalog.isBlocking(type),
    };
  }

  clear(): void {
    this.#tiles.clear();
  }
}

/**
 * Packs a tile coordinate into one number.
 *
 * Map coordinates are non-negative and below 2048, so 16 bits each is ample and
 * the result stays a small integer — which keeps the map's keys on V8's fast
 * path instead of turning every lookup into a string allocation.
 */
export function packCoordinate(x: number, y: number): number {
  return ((x & 0xffff) << 16) | (y & 0xffff);
}
