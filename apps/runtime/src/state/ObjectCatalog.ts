import type { ContainerFacts, ItemFacts } from '../gamedata/items.js';
import type { PermanentStatMaxima } from '../gamedata/playerClasses.js';
import type { ProjectileDefinition } from '../gamedata/projectiles.js';

/** One key-opened dungeon portal, for building a chooser of them. */
export interface DungeonPortal {
  readonly type: number;
  /** The `objects.xml` id, e.g. "Undead Lair Portal". */
  readonly name: string;
}

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
   * Whether one of these is a boss.
   *
   * `<Quest />` in `objects.xml` is the game's own answer — it is what puts the
   * arrow over a monster's head — and it covers 494 of them: the realm gods,
   * the dungeon bosses, and the named minibosses on the way. Nothing on the
   * wire says so, and the health bar does not settle it either: a Shatters
   * lever has five thousand hit points and is a switch.
   *
   * The reference implementation kept thirty-five object ids in a header, which
   * is the same list with every dungeon added since missing from it.
   */
  isQuest(objectType: number): boolean;
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
  /**
   * Whether one of these is part of the room rather than something that fights.
   *
   * **A lever is `<Enemy />` with a health bar.** So is a pot, a gravestone, a
   * treasure chest and a destructible wall — they are shot on purpose, so
   * nothing that decides what is worth *shooting* may skip them, and they never
   * chase anybody and never fire, so anything deciding where it is safe to
   * *stand* has no business measuring itself against one. The live report is a
   * Shatters lever: five thousand hit points, no attack, and a no-go circle
   * drawn round it the whole way across the village.
   *
   * `<KillStat stat="StructureKills"/>` in `objects.xml` is the game's own
   * answer, narrowed to the ones that declare no shots — a Pentaract tower is a
   * structure kill too, and it is a fight.
   */
  isScenery(objectType: number): boolean;
  /**
   * Whether one of these is a key-opened dungeon portal.
   *
   * `<DungeonPortal/>` in `objects.xml`, which is narrower than the `Portal`
   * class — it excludes realm, guild and event portals, leaving exactly the
   * ones a key pops. Nothing on the wire says so, so anything reacting to a
   * popped key has to ask the catalog.
   */
  isDungeonPortal(objectType: number): boolean;
  /** Every dungeon portal the data file describes, for building a chooser. */
  dungeonPortals(): readonly DungeonPortal[];
  /**
   * How wide one of these is, in tiles.
   *
   * **A monster's body is not one tile, and treating every one as though it
   * were is what lets a boss stand on top of somebody.** `<Size>` in
   * `objects.xml` is a percentage of the standard sprite — 400 on a large boss,
   * 60 on a scattering minion — and it scales the space the thing actually
   * takes up. Nothing on the wire carries it, so anything keeping its distance
   * has to ask the catalog.
   *
   * `undefined` for a type the catalog has never heard of, and for every type
   * while no data file has been read, so a caller can tell "one tile" from "no
   * idea" and pick its own fallback.
   */
  bodyTiles(objectType: number): number | undefined;
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
   * Whether one of these has any attack at all.
   *
   * **The game's own answer to "could this thing ever hurt anybody".** A
   * spawner, a spawn anchor, an emitter and a room controller declare no
   * `<Projectile>` between them, because firing is not what they are for — and
   * nothing else in the file separates them from a monster, since they carry
   * `<Enemy />` and a health bar exactly as it does.
   *
   * Not a licence to ignore one on its own: plenty of real monsters are melee
   * and declare no shots either. It is half of a test, and the other half is
   * whether the thing has ever been seen to move — see `DodgeScene`.
   */
  hasShots(objectType: number): boolean;
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
  isQuest: () => false,
  occupies: () => false,
  isScenery: () => false,
  isDungeonPortal: () => false,
  dungeonPortals: () => [],
  bodyTiles: () => undefined,
  displayName: () => undefined,
  projectile: () => undefined,
  hasShots: () => false,
  item: () => undefined,
  container: () => undefined,
  statMaxima: () => undefined,
};
