import type { EntityView } from '@brownie/plugin-api';
import type { ObjectCatalog } from './ObjectCatalog.js';
import { packCoordinate } from './TileMap.js';
import { StatType } from '../constants/StatType.js';
import { numericStat, stringStat, type StatEntry } from './stats.js';

/**
 * One visible object, as the runtime tracks it.
 *
 * `stats` keeps every stat the server sent, including ids nothing here names,
 * so a plugin can read one without this file learning about it. The named
 * fields are a convenience over the same data, refreshed on every update.
 */
export class EntityRecord implements EntityView {
  x = 0;
  y = 0;
  hp = 0;
  maxHp = 0;
  name = '';
  /** Stat id → latest value. */
  readonly stats = new Map<number, number | string>();

  constructor(
    readonly objectId: number,
    readonly objectType: number,
    private readonly catalog: ObjectCatalog,
  ) {}

  get isPlayer(): boolean {
    return this.catalog.isPlayer(this.objectType);
  }

  get isEnemy(): boolean {
    return this.catalog.isEnemy(this.objectType);
  }

  get guildName(): string {
    const value = this.stats.get(StatType.GuildName);
    return typeof value === 'string' ? value : '';
  }

  /**
   * Read from the stat map rather than mirrored into a field, unlike hp and
   * name: it changes on the tick a boss phases and is read only by the features
   * that care, so a copy kept up to date on every update would be work done for
   * the entities nobody asks about.
   */
  get conditions(): number {
    const value = this.stats.get(StatType.Effects);
    return typeof value === 'number' ? value : 0;
  }

  /** A numeric stat by id, for stats this class does not name. */
  stat(id: number): number | undefined {
    const value = this.stats.get(id);
    return typeof value === 'number' ? value : undefined;
  }

  /** A text stat by id — the mirror of {@link stat}, for the string ones. */
  text(id: number): string | undefined {
    const value = this.stats.get(id);
    return typeof value === 'string' ? value : undefined;
  }

  applyStats(stats: readonly StatEntry[]): void {
    for (const stat of stats) this.stats.set(stat.id, stat.value);

    const hp = numericStat(stats, StatType.Hp);
    if (hp !== undefined) this.hp = hp;
    const maxHp = numericStat(stats, StatType.MaxHp);
    if (maxHp !== undefined) this.maxHp = maxHp;
    const name = stringStat(stats, StatType.Name);
    if (name !== undefined) this.name = name;
  }

  moveTo(x: number, y: number): void {
    this.x = x;
    this.y = y;
  }
}

/**
 * Every object currently visible.
 *
 * A plain map keyed by object id, with explicit add and remove. The reference
 * implementation folded this together with tiles, party membership, map info
 * and projectile tracking into one 968-line class that also registered its own
 * packet hooks — so what updated it, and in what order relative to plugins, was
 * decided by the order the composition root happened to construct things in.
 */
export class EntityStore {
  readonly #entities = new Map<number, EntityRecord>();
  readonly #catalog: ObjectCatalog;

  /**
   * Squares a wall stands on, and which object put each one there.
   *
   * **In this game a wall is an object, not a tile**: it stands on ordinary
   * floor, so anything deciding where to walk from the tile map alone walks
   * into walls. Kept as a set updated when objects arrive and leave rather than
   * computed on demand, because the planner asks about walkability for every
   * step of every candidate heading — thousands of times per plan.
   */
  readonly #occupied = new Set<number>();
  readonly #occupiedBy = new Map<number, number>();

  /**
   * The enemies and the players, as arrays, rebuilt only when membership
   * changes.
   *
   * **Membership changes rarely; these are read constantly.** Every tick, every
   * combat feature asks for the enemies — auto-aim twice, once to sample motion
   * and once to choose — and answering with a generator costs an iterator step
   * and a result object per entity per ask. With a realm's four hundred
   * entities that was the single largest allocator in a tick.
   *
   * Invalidated when an object arrives or leaves, which is what changes the
   * answer. Moving does not: a monster that walked is the same monster in the
   * same list, and rebuilding for that would undo the whole point.
   */
  #enemyCache: EntityRecord[] | undefined;
  #playerCache: EntityRecord[] | undefined;

  constructor(catalog: ObjectCatalog) {
    this.#catalog = catalog;
  }

  get size(): number {
    return this.#entities.size;
  }

  get(objectId: number): EntityRecord | undefined {
    return this.#entities.get(objectId);
  }

  /**
   * Adds an object, or refreshes one already present.
   *
   * The server re-sends an object that is already known when it re-enters view,
   * so this is an upsert rather than an insert — treating it as an insert would
   * lose the stats already accumulated for a boss that walked off screen.
   */
  upsert(objectId: number, objectType: number, x: number, y: number): EntityRecord {
    let entity = this.#entities.get(objectId);
    if (entity === undefined || entity.objectType !== objectType) {
      entity = new EntityRecord(objectId, objectType, this.#catalog);
      this.#entities.set(objectId, entity);
      this.#invalidate();
    }
    entity.moveTo(x, y);
    if (this.#catalog.occupies(objectType)) this.#occupy(objectId, x, y);
    return entity;
  }

  remove(objectId: number): boolean {
    this.#vacate(objectId);
    const removed = this.#entities.delete(objectId);
    if (removed) this.#invalidate();
    return removed;
  }

  clear(): void {
    this.#entities.clear();
    this.#occupied.clear();
    this.#occupiedBy.clear();
    this.#invalidate();
  }

  #invalidate(): void {
    this.#enemyCache = undefined;
    this.#playerCache = undefined;
  }

  /** Whether a wall stands on this square. A set lookup, and it has to be. */
  blocksAt(x: number, y: number): boolean {
    return this.#occupied.has(packCoordinate(Math.floor(x), Math.floor(y)));
  }

  /** Records a wall's square, moving it if the object was somewhere else. */
  #occupy(objectId: number, x: number, y: number): void {
    const key = packCoordinate(Math.floor(x), Math.floor(y));
    const previous = this.#occupiedBy.get(objectId);
    if (previous === key) return;
    if (previous !== undefined) this.#occupied.delete(previous);
    this.#occupiedBy.set(objectId, key);
    this.#occupied.add(key);
  }

  #vacate(objectId: number): void {
    const key = this.#occupiedBy.get(objectId);
    if (key === undefined) return;
    this.#occupiedBy.delete(objectId);
    this.#occupied.delete(key);
  }

  values(): IterableIterator<EntityRecord> {
    return this.#entities.values();
  }

  /**
   * Every player, as an array the caller must not modify.
   *
   * Handed out rather than copied: the copy would be per call, which is the
   * cost this exists to remove. Callers see it through `EntityView`, which is
   * read-only, and the store rebuilds it rather than mutating it in place — so
   * a caller holding one across a change sees the world as it was, not a list
   * being edited underneath it.
   */
  players(): readonly EntityRecord[] {
    this.#playerCache ??= this.#collect((entity) => entity.isPlayer);
    return this.#playerCache;
  }

  /** Every enemy, on the same terms. */
  enemies(): readonly EntityRecord[] {
    this.#enemyCache ??= this.#collect((entity) => entity.isEnemy);
    return this.#enemyCache;
  }

  #collect(matches: (entity: EntityRecord) => boolean): EntityRecord[] {
    const found: EntityRecord[] = [];
    for (const entity of this.#entities.values()) {
      if (matches(entity)) found.push(entity);
    }
    return found;
  }
}
