import { createReadStream } from 'node:fs';
import type { ObjectCatalog } from '../state/ObjectCatalog.js';
import type { TileCatalog } from '../state/TileMap.js';
import { readProjectiles, type ProjectileDefinition } from './projectiles.js';
import { attribute, childText, hasChild, parseGameNumber, scanElements } from './xml.js';

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
  /** Indexed by `bulletType`, which is the index the game shoots them by. */
  readonly projectiles: ReadonlyMap<number, ProjectileDefinition>;
}

/** What the runtime keeps about one ground type. */
export interface TileDefinition {
  readonly type: number;
  readonly id: string;
  readonly damaging: boolean;
  readonly blocking: boolean;
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

  displayName(objectType: number): string | undefined {
    return this.#byType.get(objectType)?.id;
  }

  projectile(objectType: number, bulletType: number): ProjectileDefinition | undefined {
    return this.#byType.get(objectType)?.projectiles.get(bulletType);
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

    definitions.push({
      type,
      id,
      // `<Class>Player</Class>` is how the game marks a playable class, and
      // `<Enemy />` how it marks something that fights back. Neither is
      // derivable from an id range, which is why this file is read at all.
      isPlayer: childText(element, 'Class') === 'Player',
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
      projectiles: new Map(readProjectiles(element).map((p) => [p.bulletType, p])),
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
