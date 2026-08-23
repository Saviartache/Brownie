import { createReadStream } from 'node:fs';
import type { ObjectCatalog } from '../state/ObjectCatalog.js';
import type { TileCatalog } from '../state/TileMap.js';
import { readContainerFacts, readItemFacts, type ContainerFacts, type ItemFacts } from './items.js';
import { readPermanentStatMaxima, type PermanentStatMaxima } from './playerClasses.js';
import { readProjectiles, type ProjectileDefinition } from './projectiles.js';
import {
  attribute,
  childText,
  hasChild,
  parseGameNumber,
  scanElements,
  scanElementsIn,
} from './xml.js';

/** What the runtime keeps about one object type. */
export interface ObjectDefinition {
  readonly type: number;
  readonly id: string;
  readonly isPlayer: boolean;
  readonly isEnemy: boolean;
  readonly isPet: boolean;
  /** Whether one of these takes no damage ever — a spawner, an emitter, a prop. */
  readonly isInvincible: boolean;
  /** Whether one of these blocks the square it stands on — a wall, a rock. */
  readonly occupies: boolean;
  /** Whether one of these is part of the room rather than something that fights. */
  readonly isScenery: boolean;
  /** How wide one of these is, in tiles. See {@link ObjectCatalog.bodyTiles}. */
  readonly bodyTiles: number;
  /** Indexed by `bulletType`, which is the index the game shoots them by. */
  readonly projectiles: ReadonlyMap<number, ProjectileDefinition>;
  /**
   * What it is as an item, for the third of the file that is one.
   *
   * Absent — not an empty record — for everything else, so the twenty thousand
   * monsters, walls and props carry one undefined field rather than six fields
   * describing an item they are not.
   */
  readonly item: ItemFacts | undefined;
  /** What it holds, for the thirty-one objects that hold things. */
  readonly container: ContainerFacts | undefined;
  /** How high its stats go, for the objects that are playable classes. */
  readonly statMaxima: PermanentStatMaxima | undefined;
}

/** What the runtime keeps about one ground type. */
export interface TileDefinition {
  readonly type: number;
  readonly id: string;
  readonly damaging: boolean;
  readonly blocking: boolean;
  /** Whether standing on one carries the character along — see {@link TileCatalog.isPushing}. */
  readonly pushing: boolean;
}

/**
 * The game's own answer to "what is object type 0x30e?".
 *
 * Four fields per object, out of the fifty the file carries. Keeping only what
 * something reads is what turns a 32 MB document into a catalog that costs a
 * few megabytes and can stay resident for the life of the process.
 */
export class GameObjectCatalog implements ObjectCatalog {
  readonly #byType: ReadonlyMap<number, ObjectDefinition>;

  constructor(definitions: Iterable<ObjectDefinition>) {
    const byType = new Map<number, ObjectDefinition>();
    for (const definition of definitions) byType.set(definition.type, definition);
    this.#byType = byType;
  }

  get size(): number {
    return this.#byType.size;
  }

  get(objectType: number): ObjectDefinition | undefined {
    return this.#byType.get(objectType);
  }

  isPlayer(objectType: number): boolean {
    return this.#byType.get(objectType)?.isPlayer ?? false;
  }

  isEnemy(objectType: number): boolean {
    return this.#byType.get(objectType)?.isEnemy ?? false;
  }

  isPet(objectType: number): boolean {
    return this.#byType.get(objectType)?.isPet ?? false;
  }

  isInvincible(objectType: number): boolean {
    return this.#byType.get(objectType)?.isInvincible ?? false;
  }

  occupies(objectType: number): boolean {
    return this.#byType.get(objectType)?.occupies ?? false;
  }

  isScenery(objectType: number): boolean {
    return this.#byType.get(objectType)?.isScenery ?? false;
  }

  bodyTiles(objectType: number): number | undefined {
    return this.#byType.get(objectType)?.bodyTiles;
  }

  displayName(objectType: number): string | undefined {
    return this.#byType.get(objectType)?.id;
  }

  projectile(objectType: number, bulletType: number): ProjectileDefinition | undefined {
    return this.#byType.get(objectType)?.projectiles.get(bulletType);
  }

  item(objectType: number): ItemFacts | undefined {
    return this.#byType.get(objectType)?.item;
  }

  container(objectType: number): ContainerFacts | undefined {
    return this.#byType.get(objectType)?.container;
  }

  statMaxima(objectType: number): PermanentStatMaxima | undefined {
    return this.#byType.get(objectType)?.statMaxima;
  }
}

export class GameTileCatalog implements TileCatalog {
  readonly #byType: ReadonlyMap<number, TileDefinition>;

  constructor(definitions: Iterable<TileDefinition>) {
    const byType = new Map<number, TileDefinition>();
    for (const definition of definitions) byType.set(definition.type, definition);
    this.#byType = byType;
  }

  get size(): number {
    return this.#byType.size;
  }

  get(tileType: number): TileDefinition | undefined {
    return this.#byType.get(tileType);
  }

  isDamaging(tileType: number): boolean {
    return this.#byType.get(tileType)?.damaging ?? false;
  }

  isBlocking(tileType: number): boolean {
    return this.#byType.get(tileType)?.blocking ?? false;
  }

  isPushing(tileType: number): boolean {
    return this.#byType.get(tileType)?.pushing ?? false;
  }
}

/** The size a `<Size>`-less object is drawn at, as the file's percentages go. */
const STANDARD_SIZE_PERCENT = 100;

/**
 * What a body's stated size is allowed to come out as, in tiles.
 *
 * The file is maintained by somebody else and carries decorative entries with
 * sizes in the thousands — a backdrop, a beam of light — which as a keep-away
 * distance would push a planner across the room. The ceiling is a little above
 * the largest boss anybody fights; the floor keeps a shrunken minion from
 * reporting a body of nothing at all.
 */
const MIN_BODY_TILES = 0.25;
const MAX_BODY_TILES = 6;

/**
 * How wide one object is, from what the file says about its size.
 *
 * `<Size>` is a percentage of the standard one-tile sprite. A few hundred
 * objects randomise it between `<MinSize>` and `<MaxSize>` instead; the larger
 * of those is taken, because this feeds a distance something is kept at and the
 * cost of guessing small is being stood on.
 */
function readBodyTiles(element: string): number {
  const stated =
    parseGameNumber(childText(element, 'Size')) ??
    parseGameNumber(childText(element, 'MaxSize')) ??
    STANDARD_SIZE_PERCENT;
  if (!Number.isFinite(stated) || stated <= 0) return 1;
  return Math.min(MAX_BODY_TILES, Math.max(MIN_BODY_TILES, stated / STANDARD_SIZE_PERCENT));
}

/** What the file's kill counter is called for the things that are not monsters. */
const STRUCTURE_KILL_STAT = 'StructureKills';

/**
 * Whether the game counts breaking one of these as breaking part of the room.
 *
 * **`<Enemy />` is not the game's own idea of a monster, and this is.** A lever,
 * a pot, a gravestone and a destructible wall are all `<Enemy />` with health,
 * and the only thing in the file that separates them from the thing shooting at
 * you is which counter their death goes on — `StructureKills` rather than
 * `HumanoidKills`, `BeastKills` or nothing at all.
 *
 * Paired everywhere it is used with "and it declares no shots", because a
 * structure is allowed to be dangerous: a Pentaract tower, an Oryx tower and a
 * trap are all structure kills, and every one of them is a fight.
 */
function killsAsStructure(element: string): boolean {
  const [killStat] = scanElementsIn(element, 'KillStat');
  return killStat !== undefined && attribute(killStat, 'stat') === STRUCTURE_KILL_STAT;
}

/**
 * Reads `objects.xml`.
 *
 * An entry without a usable type or id is skipped rather than failing the load:
 * the file is 35 000 entries maintained by someone else, and refusing all of
 * them because one is malformed would take the whole catalog away over a typo.
 */
export async function readObjectDefinitions(
  chunks: AsyncIterable<string | Buffer>,
): Promise<ObjectDefinition[]> {
  const definitions: ObjectDefinition[] = [];
  for await (const element of scanElements(chunks, 'Object')) {
    const type = parseGameNumber(attribute(element, 'type'));
    const id = attribute(element, 'id');
    if (type === undefined || id === undefined) continue;

    // Read once and passed on: three of the facts below are decided by it, and
    // it is a regular expression over a whole element either way.
    const objectClass = childText(element, 'Class');
    // Read once for the same reason, and read *before* the record because
    // whether this thing has an attack of its own is half of `isScenery`.
    const projectiles = readProjectiles(element);

    definitions.push({
      type,
      id,
      // `<Class>Player</Class>` is how the game marks a playable class, and
      // `<Enemy />` how it marks something that fights back. Neither is
      // derivable from an id range, which is why this file is read at all.
      isPlayer: objectClass === 'Player',
      isEnemy: hasChild(element, 'Enemy'),
      // `<Pet />` marks a follower. The `Pet` *class* covers only some of them,
      // which is why the marker is read rather than the class.
      isPet: hasChild(element, 'Pet'),
      // `<Invincible />` marks something that answers to `<Enemy />` and can
      // still never be hurt — 1435 of the file's 5381 enemies. Almost none of
      // them carry `<MaxHitPoints>`, which is the same fact said twice and the
      // reason a health-based guess at this would nearly work and then quietly
      // fail on the eight that do.
      isInvincible: hasChild(element, 'Invincible'),
      // Either marks a square as blocked. `FullOccupy` also stops sight, which
      // nothing here needs — for walking they mean the same thing.
      occupies: hasChild(element, 'OccupySquare') || hasChild(element, 'FullOccupy'),
      // The game's own word for a thing that is part of the room, and the
      // absence of any shot to go with it. See {@link killsAsStructure}.
      isScenery: killsAsStructure(element) && projectiles.length === 0,
      bodyTiles: readBodyTiles(element),
      projectiles: new Map(projectiles.map((p) => [p.bulletType, p])),
      item: readItemFacts(element),
      container: readContainerFacts(element, objectClass),
      statMaxima: readPermanentStatMaxima(element, objectClass),
    });
  }
  return definitions;
}

/** Reads `tiles.xml`. Same tolerance for a bad entry, for the same reason. */
export async function readTileDefinitions(
  chunks: AsyncIterable<string | Buffer>,
): Promise<TileDefinition[]> {
  const definitions: TileDefinition[] = [];
  for await (const element of scanElements(chunks, 'Ground')) {
    const type = parseGameNumber(attribute(element, 'type'));
    const id = attribute(element, 'id');
    if (type === undefined || id === undefined) continue;

    const minDamage = parseGameNumber(childText(element, 'MinDamage')) ?? 0;
    const maxDamage = parseGameNumber(childText(element, 'MaxDamage')) ?? 0;
    definitions.push({
      type,
      id,
      damaging: minDamage > 0 || maxDamage > 0,
      blocking: hasChild(element, 'NoWalk'),
      // `<Push />` is the game's own marker, and it is exactly the 36 grounds
      // the reference implementation listed by name — conveyors, whirlpools,
      // sludge, flowing sand. Reading the marker instead of the names is what
      // makes the 37th one work without an edit here.
      pushing: hasChild(element, 'Push'),
    });
  }
  return definitions;
}

/** Streams a file in chunks, so a 32 MB document never exists in memory at once. */
export function fileChunks(path: string): AsyncIterable<string | Buffer> {
  return createReadStream(path, { encoding: 'utf8', highWaterMark: 256 * 1024 });
}

export async function loadObjectCatalog(path: string): Promise<GameObjectCatalog> {
  return new GameObjectCatalog(await readObjectDefinitions(fileChunks(path)));
}

export async function loadTileCatalog(path: string): Promise<GameTileCatalog> {
  return new GameTileCatalog(await readTileDefinitions(fileChunks(path)));
}
