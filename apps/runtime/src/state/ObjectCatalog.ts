import type { ContainerFacts, ItemFacts } from '../gamedata/items.js';
import type { PermanentStatMaxima } from '../gamedata/playerClasses.js';
import type { ProjectileDefinition } from '../gamedata/projectiles.js';

/**
 * What the game's own data says about an object type.
 *
 * Whether an object type is a player, an enemy or scenery is not derivable from
 * the packet stream — it lives in the game's `objects.xml`. Rather than guess
 * from id ranges, which drifts every time the game adds content, the state
 * layer asks a catalog and the catalog is supplied from outside.
 *
 * Until the game-data loader is ported, {@link EMPTY_CATALOG} answers "I do not
 * know", and `isPlayer` / `isEnemy` are false everywhere. That is deliberate:
 * a state layer that confidently reports the wrong answer is worse than one
 * that reports none, because a feature built on it fails silently.
 */
export interface ObjectCatalog {
  isPlayer(objectType: number): boolean;
  isEnemy(objectType: number): boolean;
  /**
   * Whether one of these follows a player around.
   *
   * `<Pet/>` in `objects.xml` is how the game marks one, and nothing in the
   * packet stream says so: a pet arrives as an ordinary object with an ordinary
   * type. Anti-lag needs it because pets are the single largest population in a
   * crowded map and the one nobody is looking at.
   */
  isPet(objectType: number): boolean;
  /**
   * Whether one of these can never be damaged, whatever its health says.
   *
   * `<Invincible />` in `objects.xml`, and it covers a quarter of everything
   * the file marks as an enemy: spawn anchors, emitters, room controllers and
   * the props a boss fight decorates itself with. They carry health and they
   * answer to `<Enemy />`, so nothing about them on the wire distinguishes them
   * from the monster standing next to them — which is why this is asked of the
   * game's own data rather than derived from a packet.
   *
   * Distinct from the {@link EntityView.conditions} bit of nearly the same
   * name: that one is a boss phase that ends, this one is what the thing is.
   */
  isInvincible(objectType: number): boolean;
  /**
   * Whether one of these stands in the way.
   *
   * **In this game a wall is an object, not a tile.** It stands on ordinary
   * floor, and that floor is perfectly walkable ground as far as the tile map
   * is concerned — so anything deciding where to walk by looking at tiles alone
   * walks straight into walls, which is what a dodge did until this existed.
   * `OccupySquare` and `FullOccupy` in `objects.xml` are how the game marks
   * one.
   */
  occupies(objectType: number): boolean;
  /** Display name from the catalog, when the entity carries no name stat. */
  displayName(objectType: number): string | undefined;
  /**
   * How one of this object's shots moves.
   *
   * `ENEMYSHOOT` names a shot by index within its owner, so both are needed to
   * say anything at all about where it is going.
   */
  projectile(objectType: number, bulletType: number): ProjectileDefinition | undefined;
  /**
   * What one of these is as an item — its slot, its tier, whether drinking it
   * does anything.
   *
   * Asked of the data file for the same reason as everything above it: none of
   * it is on the wire. A bag announces the *ids* it holds and nothing else, so
   * whether one of them is a tier-13 bow or a health potion is a question only
   * this can answer. `undefined` for an object that is not an item, and for
   * every object at all while no data file has been read — which is what makes
   * anything built on it do nothing rather than something wrong.
   */
  item(objectType: number): ItemFacts | undefined;
  /**
   * What one of these holds, for the loot bags, chests and graves.
   *
   * `<Class>Container</Class>` is the marker, and it excludes the vault chest —
   * which the file classes separately — so nothing looting containers can reach
   * into the vault by accident.
   */
  container(objectType: number): ContainerFacts | undefined;
  /** How high a playable class's stats go, for deciding a potion is wasted. */
  statMaxima(objectType: number): PermanentStatMaxima | undefined;
}

export const EMPTY_CATALOG: ObjectCatalog = {
  isPlayer: () => false,
  isEnemy: () => false,
  isPet: () => false,
  isInvincible: () => false,
  occupies: () => false,
  displayName: () => undefined,
  projectile: () => undefined,
  item: () => undefined,
  container: () => undefined,
  statMaxima: () => undefined,
};
