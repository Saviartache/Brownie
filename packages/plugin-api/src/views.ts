/**
 * Read-only views of runtime state.
 *
 * These are interfaces, not classes, and they live here rather than in the
 * runtime so the dependency runs one way: the runtime implements what plugins
 * are promised, instead of plugins reaching into whatever the runtime happens
 * to hold. A plugin cannot mutate state — it can only observe it and send
 * packets, which is the same power the game client has.
 *
 * Every view is a *snapshot accessor*, valid for the duration of the call that
 * handed it out. Holding one across ticks and expecting it to update is a
 * mistake; ask again.
 */

export interface Position {
  readonly x: number;
  readonly y: number;
}

/** The local player. */
export interface SelfView extends Position {
  readonly objectId: number;
  readonly name: string;
  readonly hp: number;
  readonly maxHp: number;
  readonly mp: number;
  readonly maxMp: number;
  /** Defence as the runtime believes it, including the native module's reading. */
  readonly defense: number;
  /**
   * How fast this character walks, in tiles per second.
   *
   * Derived from the speed stat the server sends, never measured from movement:
   * anything deciding where to walk would otherwise be reading back its own
   * output, and an overestimate would feed itself until the character left the
   * map. It has done exactly that.
   */
  readonly walkSpeedTilesPerSecond: number;
  /** Object type of the equipped weapon, or -1 when there is not one. */
  readonly weaponType: number;
  readonly alive: boolean;
  /** Bitmask of active condition effects. */
  readonly conditions: number;
}

/** Anything with an object id in the current map. */
export interface EntityView extends Position {
  readonly objectId: number;
  /** The game's object type, as `objects.xml` defines it. */
  readonly objectType: number;
  readonly name: string;
  readonly hp: number;
  readonly maxHp: number;
  readonly isEnemy: boolean;
  readonly isPlayer: boolean;
  /**
   * Bitmask of active condition effects, as {@link SelfView.conditions} carries
   * them for the local player.
   *
   * The first condition stat only — bits 0 to 30 — which is where every effect
   * that decides whether something can be *hurt* lives: invulnerable,
   * invincible, stasis. A monster wearing one of those absorbs every shot aimed
   * at it and takes no damage at all, so anything choosing what to shoot has to
   * be able to see it.
   */
  readonly conditions: number;
  /**
   * The guild this player belongs to, or empty for none.
   *
   * Only a player carries one, and only once the server has sent the stat —
   * which it does with the object itself. Kept as the server's own spelling, so
   * two members of one guild compare equal without either side folding case.
   */
  readonly guildName: string;
}

/** One enemy shot in flight. */
export interface ProjectileView extends Position {
  readonly ownerId: number;
  readonly bulletId: number;
  readonly bulletType: number;
  readonly damage: number;
  /**
   * Half the side of the square this shot is hit-tested with, in tiles.
   *
   * The game's projectile collision is an axis-aligned square, and how big it is
   * is a property of the shot rather than a constant — a boss's shot can be
   * several times the width of a rat's. Anything deciding whether a shot will
   * land needs this one; assuming the standard size dodges the wrong way for
   * exactly the shots worth dodging.
   */
  readonly collisionHalfTiles: number;
  /**
   * Whether {@link positionAt} describes this shot's whole path.
   *
   * False for the ones that accelerate or turn — the spirals that curl as they
   * travel — where the prediction is a straight line for something that is not
   * one. Anything acting on a prediction should leave room around one of these
   * in proportion to how far ahead it asked, rather than believing it exactly.
   */
  readonly motionModelled: boolean;
  /**
   * When it was fired and when it stops existing, on the world's clock.
   *
   * The pair rather than either alone: how much of a shot's life is left says
   * nothing without how long that life was, and anything drawing or ranking
   * shots by how soon they end needs both.
   */
  readonly firedAtMs: number;
  readonly expiresAtMs: number;
  /**
   * Where the shot will be at a given game time, or `undefined` once it has
   * expired — which is different from "at its last position".
   */
  positionAt(gameTimeMs: number): Position | undefined;
}

export interface TileView {
  readonly type: number;
  /** True when standing here costs health. */
  readonly damaging: boolean;
  /** True when the tile cannot be walked through. */
  readonly blocking: boolean;
}

export interface WorldView {
  readonly mapName: string;
  /** Milliseconds since this connection reached the game server. */
  readonly gameTimeMs: number;
  entities(): Iterable<EntityView>;
  entity(objectId: number): EntityView | undefined;
  players(): Iterable<EntityView>;
  enemies(): Iterable<EntityView>;
  tileAt(x: number, y: number): TileView | undefined;
  /**
   * Whether the player could stand here.
   *
   * Not the same question as `tileAt(x, y)?.blocking`, and the difference is
   * the whole reason this exists. **A wall in this game is an object, not a
   * tile**: it stands on ordinary floor, so the tile beneath it is walkable
   * ground, and anything asking only the tile map walks into every wall there
   * is. This asks both, and tests the player's body rather than a single point.
   *
   * @param clearanceTiles Extra room to demand on every side, for a caller that
   *   wants somewhere to stand rather than the last place that fits. Standing
   *   flush against a wall is legal and is where the game's own collision
   *   starts holding a character in place, so anything *planning* a walk asks
   *   for more than nothing here. Negative values are floored at zero: a
   *   smaller body is a different question and not one this answers.
   */
  canStandAt(x: number, y: number, clearanceTiles?: number): boolean;
  /**
   * Enemy shots **currently in flight**. Empty without the game's projectile
   * data.
   *
   * In flight is the whole of it: a shot is dropped the instant it reaches the
   * end of the lifetime its own data declares — which is 600–2000 ms in this
   * game, and sooner than it sounds. Anything reacting to a client→server
   * acknowledgement is asking about a shot whose flight has *already* ended, so
   * it must record what it needs when the shot is announced rather than looking
   * for it here.
   */
  projectiles(): Iterable<ProjectileView>;
}

/**
 * One live connection between the game client and a game server.
 *
 * This is what a handler acts on: a plugin never sees a socket, a cipher or the
 * pipeline, only the things it could legitimately want to do to a session.
 */
export interface SessionView {
  readonly id: string;
  readonly self: SelfView;
  readonly world: WorldView;
  /** The game server this session is connected to. */
  readonly server: { readonly host: string; readonly port: number };
  /** Sends a packet to the game server, as though the client had sent it. */
  sendToServer(packetName: string, fields: Readonly<Record<string, unknown>>): void;
  /** Sends a packet to the game client, as though the server had sent it. */
  sendToClient(packetName: string, fields: Readonly<Record<string, unknown>>): void;
  /** Shows a line in the game's own chat, locally. Never reaches the server. */
  notify(text: string, from?: string): void;
}
