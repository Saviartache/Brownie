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

/**
 * One of the player's own item slots.
 *
 * Addressed by the id the item packets address it by — one flat space covering
 * what the character wears, what it carries, its backpack and its potion belt —
 * because `SlotObject.slotId` is one field and anything that *moves* an item has
 * to name the slot the way the packet will.
 */
export interface ItemSlotView {
  /** 0–11 the character's own slots (0–3 worn), 12–27 backpack, belt above. */
  readonly slotId: number;
  /** What is in it, or -1 when it is empty. */
  readonly objectType: number;
  /** How many are stacked here. 0 for a slot the game does not stack. */
  readonly quantity: number;
}

/**
 * The player's own item slots, as the server last stated them.
 *
 * **A slot the server has not stated is absent, not empty**, and that
 * distinction is the whole reason this is a list of slots rather than a fixed
 * array with -1 in the gaps. Which stat carries which slot is a fact about a
 * game build, and the two tables in this repository do not agree about the
 * backpack or the belt — so a build that moved them leaves this reporting
 * *nothing* for those slots, and anything reading it does less rather than
 * something wrong. Treating an unstated slot as empty is how a swap gets aimed
 * at a slot that is actually full.
 */
export interface InventoryView {
  /** The eight slots the character carries, 4–11. Never the worn ones. */
  carried(): readonly ItemSlotView[];
  /** The backpack, 12–27. Empty for a character without one. */
  backpack(): readonly ItemSlotView[];
  /** The potion belt. */
  belt(): readonly ItemSlotView[];
  /** One slot by the id the item packets use. */
  at(slotId: number): ItemSlotView | undefined;
}

/**
 * The six stats a potion raises permanently, as the server states them.
 *
 * Class, level and potions — not the gear bonus and not exaltations, which the
 * server sends separately. That is what makes them comparable against the
 * per-class maximum in the game's own data, and the only reason anything here
 * needs them.
 *
 * Kept together, and apart from {@link SelfView.defense}: that one is defence
 * *as the runtime believes it*, native reading and temporary effects included,
 * which is the right number for surviving a hit and the wrong one for asking
 * whether a potion would be wasted.
 */
export interface PermanentStats {
  readonly attack: number;
  readonly defense: number;
  readonly speed: number;
  readonly dexterity: number;
  readonly vitality: number;
  readonly wisdom: number;
}

/** The local player. */
export interface SelfView extends Position {
  readonly objectId: number;
  /**
   * The character's own object type — its class, as `objects.xml` names it.
   *
   * Read straight off the object the server sent for us rather than looked up
   * in the world by id, for the same reason everything else here is: the id is
   * not set until the server names it, and a lookup that fails then is a
   * feature that silently does nothing for the first seconds of a session.
   */
  readonly objectType: number;
  readonly name: string;
  readonly hp: number;
  /**
   * The health bar's maximum — **the base the server states plus the bonus the
   * gear adds**, which is the number the game itself draws the bar against.
   *
   * The two arrive as separate stats, and the base alone is not a maximum of
   * anything: current health routinely exceeds it, so a threshold taken as a
   * share of it fires later than it reads. Auto-nexus escaped late for exactly
   * that reason.
   */
  readonly maxHp: number;
  readonly mp: number;
  /** The mana bar's maximum, on the same terms as {@link maxHp}. */
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
  /** What the character is wearing, carrying and drinking from. */
  readonly inventory: InventoryView;
  /** The stats a potion raises permanently, for deciding whether one is wasted. */
  readonly permanentStats: PermanentStats;
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
  /**
   * A numeric stat by id, for the ones this view does not name.
   *
   * The runtime keeps every stat the server sent for an entity, including ids
   * nothing in it names — so a feature that needs one does not need the state
   * layer to learn about it first. That is the whole of what this is for: a
   * boss phase written into a stat this file has no business enumerating.
   *
   * @returns `undefined` for a stat the server has not sent for this entity,
   *   and for one whose value is a string — those are {@link text}, because a
   *   stat's type is a property of the id and not something to discover per
   *   entity.
   */
  stat(id: number): number | undefined;

  /**
   * A text stat by id — the mirror of {@link stat}, for the ids that carry a
   * string.
   *
   * Which those are is fixed per id and listed in the protocol's own stat
   * table, so a caller asks the accessor that matches what the id holds rather
   * than discovering the type at runtime. What is behind one of these is
   * usually not text at all but a packed blob the game encodes as a string —
   * a container's enchants, for instance — so a caller is expected to decode
   * it, and to survive a build that encodes it differently.
   *
   * @returns `undefined` for a stat the server has not sent, and for one whose
   *   value is a number.
   */
  text(id: number): string | undefined;
}

/**
 * One area effect that has been announced.
 *
 * A blast is a disc and a deadline, which is a different shape of danger from a
 * shot: it threatens one place at one instant and nothing at all before or after
 * it. Reacting to it is therefore not a matter of getting out of a line but of
 * not being inside a circle at a particular moment.
 */
export interface BlastView extends Position {
  /** How far it reaches from its centre, in tiles. */
  readonly radiusTiles: number;
  /** When it lands, on the world's own clock. */
  readonly armsAtMs: number;
  /**
   * Whether the detonation has been seen on the wire.
   *
   * False for a telegraph — a prediction of where and when, which is the only
   * kind worth avoiding. True once it has gone off, at which point it is history
   * and the safest ground on the screen.
   */
  readonly confirmed: boolean;
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
  /**
   * The game client's own clock, as the server has been hearing it.
   *
   * **Not {@link gameTimeMs}, and the difference is not academic.** That one
   * counts from the moment *this proxy* opened the server link; this one is the
   * number the game client itself stamps on everything it sends, read off its
   * own packets. They agree only if the client's clock happens to start where
   * our connection did, and it does not — the client has usually been running
   * for a while, through other maps, before the connection this session is
   * carrying.
   *
   * **Anything sending a packet with a `time` field must use this one.** The
   * server checks that stamp against what the client has been telling it, and
   * a packet stamped with the wrong clock is dropped without a word: no error,
   * no effect, and — because nothing acknowledges an item move either — no way
   * to tell it apart from a refusal. Auto-loot and auto-drink both spent a
   * session sending perfectly formed packets into that silence.
   *
   * Falls back to {@link gameTimeMs} until the client has said something the
   * clock can be read from, which it does within the first moments.
   */
  readonly clientTimeMs: number;
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

  /**
   * Area effects that have been announced and have not landed yet.
   *
   * A thrown bomb, a nova, a circle drawn on the ground — the things the game
   * telegraphs before they go off. Unlike a shot these are not in flight in any
   * useful sense: each is a place, a width and a moment, and the only question
   * worth asking about one is whether you will be standing in it when it lands.
   *
   * A blast that has already gone off stays here briefly with
   * {@link BlastView.confirmed} set, because the packet that reports the
   * detonation is what proves the telegraph was read correctly. Nothing should
   * dodge a confirmed one: it is over.
   */
  blasts(): Iterable<BlastView>;
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
