import type {
  BlastView,
  EntityView,
  ProjectileView,
  TileView,
  WorldView,
} from '@brownie/plugin-api';
import { PLAYER_HALF_TILES } from '../features/dodge/hitbox.js';
import type { BlastRadiusTable } from './blasts/BlastRadiusTable.js';
import { BlastStore } from './blasts/BlastStore.js';
import { EntityStore } from './EntityStore.js';
import { EMPTY_CATALOG, type ObjectCatalog } from './ObjectCatalog.js';
import { SelfState } from './SelfState.js';
import { ProjectileStore } from './projectiles/ProjectileStore.js';
import { EMPTY_TILE_CATALOG, TileMap, type TileCatalog } from './TileMap.js';

export interface MapInfo {
  readonly name: string;
  readonly displayName: string;
  readonly width: number;
  readonly height: number;
}

const NO_MAP: MapInfo = { name: '', displayName: '', width: 0, height: 0 };

export interface WorldStateOptions {
  readonly objects?: ObjectCatalog;
  readonly tiles?: TileCatalog;
  /**
   * What blasts have been measured at, shared across sessions.
   *
   * How wide an enemy's bomb is and how long it is in the air are properties of
   * the game, not of a connection — so the table outlives both the session and,
   * once the composition root persists it, the run. Its own when omitted, which
   * is what a test wants.
   */
  readonly blastRadii?: BlastRadiusTable;
  /** Injected so a test can drive time without waiting for it. */
  readonly now?: () => number;
}

/**
 * Everything derived from the packet stream for one session.
 *
 * Composed of the stores rather than being one class that does all of it: the
 * reference implementation's equivalent was 968 lines covering entities, tiles,
 * party membership, map info and projectiles, and it registered its own packet
 * hooks on top. Here, nothing in this file knows the proxy exists — the state
 * stage applies packets to it, and the stage's position in the pipeline is what
 * guarantees state is current before any plugin runs.
 */
export class WorldState implements WorldView {
  readonly self = new SelfState();
  // Named apart from the `entities()` / `tileAt()` methods `WorldView`
  // requires: the stores are what the state stage writes to, the methods are
  // what a plugin reads through.
  readonly entityStore: EntityStore;
  readonly tileMap: TileMap;
  readonly projectileStore = new ProjectileStore();
  readonly blastStore: BlastStore;
  /** The catalog in use, so the state stage can look a shot up. */
  readonly objects: ObjectCatalog;

  /**
   * Why announced shots did not end up tracked.
   *
   * A shot with no projectile definition is dropped rather than guessed at.
   * That is the right rule and a silent one: with no data for a monster, a
   * dodge has nothing in flight to avoid, and starved looks exactly like
   * broken. These counters are what tells the two apart.
   */
  readonly shots = { announced: 0, noOwner: 0, noDefinition: 0, tracked: 0 };

  #map: MapInfo = NO_MAP;
  #connectedAtMs: number | undefined;
  /** Wall time to the client's clock. `undefined` until it has said so. */
  #clientClockOffsetMs: number | undefined;
  /** The highest stamp the client has put on the wire, as a floor. */
  #latestClientStampMs = 0;
  readonly #now: () => number;

  constructor(options: WorldStateOptions = {}) {
    this.objects = options.objects ?? EMPTY_CATALOG;
    this.entityStore = new EntityStore(this.objects);
    this.tileMap = new TileMap(options.tiles ?? EMPTY_TILE_CATALOG);
    this.blastStore = new BlastStore(options.blastRadii);
    this.#now = options.now ?? Date.now;
  }

  get map(): MapInfo {
    return this.#map;
  }

  get mapName(): string {
    return this.#map.name;
  }

  /**
   * Milliseconds since this session reached the game server.
   *
   * Measured from our own connect, not from a server timestamp: the game's own
   * time base restarts on every map change, and code that wants "how long has
   * this connection been up" needs the one that does not.
   */
  get gameTimeMs(): number {
    return this.#connectedAtMs === undefined ? 0 : this.#now() - this.#connectedAtMs;
  }

  /**
   * The game client's own clock, as the server has been hearing it.
   *
   * Kept as an offset from wall time rather than a stored reading, so it stays
   * current between the packets it is calibrated from. Until one of those has
   * arrived this answers {@link gameTimeMs}, which is the closest thing there
   * is to it and wrong in the same direction.
   *
   * **Never behind the last stamp the client itself sent.** What the client
   * puts on the wire is a rising sequence and the server is entitled to read it
   * as one, so a packet injected into the middle of that stream carrying an
   * *earlier* time is the timeline going backwards. The estimate can be a
   * little behind — every calibration is taken from a reading that was already
   * a moment old — and the floor is what keeps that small lag from becoming a
   * malformed sequence.
   */
  get clientTimeMs(): number {
    if (this.#clientClockOffsetMs === undefined) return this.gameTimeMs;
    const estimate = this.#now() + this.#clientClockOffsetMs;
    return Math.max(0, estimate, this.#latestClientStampMs);
  }

  /**
   * Records the client's own time, off a packet the client stamped.
   *
   * Re-read on every such packet rather than fixed once: the reading a
   * calibration is taken from is always a little stale — a movement record
   * describes where the player *was* — and taking the latest keeps that lag
   * from being frozen in for the life of the session.
   */
  calibrateClientClock(clientTimeMs: number): void {
    if (!Number.isFinite(clientTimeMs) || clientTimeMs <= 0) return;
    this.#clientClockOffsetMs = clientTimeMs - this.#now();
    if (clientTimeMs > this.#latestClientStampMs) this.#latestClientStampMs = clientTimeMs;
  }

  /** Called once, when the server connection is established. */
  markConnected(): void {
    this.#connectedAtMs ??= this.#now();
  }

  /**
   * Enters a new map.
   *
   * Everything positional is dropped. Entities and tiles from the previous map
   * are not stale data to be refreshed — they describe somewhere the player is
   * no longer standing, and an object id is only unique within a map.
   */
  enterMap(info: MapInfo): void {
    this.#map = info;
    this.entityStore.clear();
    this.tileMap.clear();
    // Shots from the previous map cannot still be in the air in this one, and
    // neither can anything that was about to land in it.
    this.projectileStore.clear();
    this.blastStore.clear();
  }

  entities(): Iterable<EntityView> {
    return this.entityStore.values();
  }

  entity(objectId: number): EntityView | undefined {
    return this.entityStore.get(objectId);
  }

  players(): Iterable<EntityView> {
    return this.entityStore.players();
  }

  enemies(): Iterable<EntityView> {
    return this.entityStore.enemies();
  }

  tileAt(x: number, y: number): TileView | undefined {
    return this.tileMap.at(x, y);
  }

  /**
   * Whether the player could stand here.
   *
   * Asks both sources, because the game has two: the ground can be a wall, and
   * so can an *object* standing on ordinary ground. Anything consulting only
   * the tile map walks into every wall in the game.
   *
   * **The player's corners are tested, not their centre.** A body is a square
   * of about 0.43 tiles across, so a centre on free ground says nothing about
   * whether the body fits — and the difference is exactly the case of squeezing
   * along a wall, which is where a dodge spends most of its time.
   *
   * Unknown ground is refused. The server sends tiles around the player and no
   * further, so "not told about" is the edge of what is known, and walking
   * confidently into it is how a plan ends up somewhere nobody checked.
   *
   * `clearanceTiles` widens the body rather than the wall, which is the same
   * answer and one number to apply. Floored at zero because a *narrower* body
   * is a different question — whether something smaller than the player fits —
   * and answering it here would quietly let a plan walk where the player
   * cannot.
   */
  canStandAt(x: number, y: number, clearanceTiles = 0): boolean {
    const half = PLAYER_HALF_TILES + Math.max(0, clearanceTiles);
    return (
      this.#standable(x - half, y - half) &&
      this.#standable(x + half, y - half) &&
      this.#standable(x - half, y + half) &&
      this.#standable(x + half, y + half)
    );
  }

  #standable(x: number, y: number): boolean {
    const tile = this.tileMap.at(x, y);
    if (tile === undefined || tile.blocking) return false;
    return !this.entityStore.blocksAt(x, y);
  }

  projectiles(): Iterable<ProjectileView> {
    return this.projectileStore.values(this.gameTimeMs);
  }

  blasts(): Iterable<BlastView> {
    return this.blastStore.values(this.gameTimeMs);
  }
}
