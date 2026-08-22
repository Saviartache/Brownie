import type { InventoryView, PermanentStats, SelfView } from '@brownie/plugin-api';
import { StatType } from '../constants/StatType.js';
import { PlayerInventory } from './PlayerInventory.js';
import { numericStat, stringStat, type StatEntry } from './stats.js';

/**
 * The game's own walking-speed constants.
 *
 * A character with no speed stat covers {@link MIN_WALK_TILES_PER_SECOND}; one
 * at the stat's cap covers {@link MAX_WALK_TILES_PER_SECOND}; in between it is
 * a straight line. These are the game's numbers, not this project's estimates,
 * and they have not changed in its lifetime.
 */
export const MIN_WALK_TILES_PER_SECOND = 4;
export const MAX_WALK_TILES_PER_SECOND = 9.6;
export const MAX_SPEED_STAT = 75;

/** Shared, so a character nobody has told us about costs no allocation. */
const NO_PERMANENT_STATS: PermanentStats = {
  attack: 0,
  defense: 0,
  speed: 0,
  dexterity: 0,
  vitality: 0,
  wisdom: 0,
};

/**
 * The local player.
 *
 * Kept apart from the entity store even though the player is also an entity,
 * because almost everything that reads state reads *this* — and a survival
 * decision that has to look itself up by object id first is a survival decision
 * that goes wrong the one time the id is not set yet.
 *
 * Defence has two sources: the stat the server sends, and the value the native
 * module reads out of game memory. The native reading wins when it exists,
 * because the server's stat omits some temporary modifiers, and auto-nexus
 * getting defence wrong is the difference between escaping and dying.
 */
export class SelfState implements SelfView {
  objectId = -1;
  /** The character's class, as an object type. -1 until the server sends us. */
  objectType = -1;
  name = '';
  x = 0;
  y = 0;
  hp = 0;
  mp = 0;
  conditions = 0;
  readonly #inventory = new PlayerInventory();

  get inventory(): InventoryView {
    return this.#inventory;
  }

  /**
   * The base maximum the server states, and the bonus the gear adds.
   *
   * Kept apart and added on the way out, because the server sends them apart
   * and the base alone is not a maximum: current health routinely exceeds it on
   * a geared character, so a threshold taken as a share of the base fires later
   * than it reads — which is how auto-nexus escaped a beat late.
   *
   * The bonus is the gear's *and* the exaltations', while the base already
   * carries the exaltations. So the sum can overstate the maximum by the
   * exalted slice — around fifty health on a fully exalted character, nothing
   * on any other. That is the harmless direction for everything reading it: a
   * larger maximum means a threshold reached sooner, so a drink comes early and
   * an escape comes early. Subtracting the slice would need a stat id neither
   * table in this repository agrees on, and being wrong about *that* would
   * overstate it by hundreds.
   */
  #maxHpBase = 0;
  #maxMpBase = 0;
  #hpBonus = 0;
  #mpBonus = 0;

  get maxHp(): number {
    return this.#maxHpBase + this.#hpBonus;
  }

  get maxMp(): number {
    return this.#maxMpBase + this.#mpBonus;
  }

  /**
   * The six as the server states them — class, level and potions, with neither
   * the gear bonus nor the exaltations folded in, which is what makes them
   * comparable against the per-class ceiling in `objects.xml`.
   *
   * One object, replaced rather than mutated, so a caller holding it across a
   * tick sees the character as it was rather than a record being edited.
   */
  permanentStats: PermanentStats = NO_PERMANENT_STATS;
  /** The speed *stat*, as the server states it. Not a speed — see below. */
  speedStat = 0;
  /**
   * The object type of the weapon in the first inventory slot, or -1 for none.
   *
   * The one inventory slot the runtime reads by name. Everything a shot does —
   * how fast it travels, how long it lives, how often it can be fired — is a
   * property of *this item*, so anything reasoning about the player's own shots
   * starts here rather than by watching them go past.
   */
  weaponType = -1;

  /**
   * How fast this character walks, in tiles per second.
   *
   * **Derived from the stat, not measured.** Measuring it from ground covered
   * is a tempting idea and a broken one: the ground was covered *because of a
   * command this system issued*, so a mistake feeds itself. An overestimate
   * lengthens the next step, which covers more ground, which raises the
   * estimate — and the character ends up outside the map. That happened twice
   * before this replaced it.
   *
   * The formula is the game's own and has been stable for the life of it:
   * speed runs from {@link MIN_WALK_TILES_PER_SECOND} at nought to
   * {@link MAX_WALK_TILES_PER_SECOND} at the stat's maximum, in a straight
   * line. It reads a number the server sent and depends on nothing this system
   * does, which is the property that matters.
   */
  get walkSpeedTilesPerSecond(): number {
    const share = Math.min(Math.max(this.speedStat, 0), MAX_SPEED_STAT) / MAX_SPEED_STAT;
    return (
      MIN_WALK_TILES_PER_SECOND + share * (MAX_WALK_TILES_PER_SECOND - MIN_WALK_TILES_PER_SECOND)
    );
  }

  #serverDefense = 0;
  #nativeDefense: number | undefined;

  get defense(): number {
    return this.#nativeDefense ?? this.#serverDefense;
  }

  /** True once the server has told us which object we are, and we have health. */
  get alive(): boolean {
    return this.objectId >= 0 && this.hp > 0;
  }

  /** Whether the authoritative reading is in use, for diagnostics. */
  get defenseIsNative(): boolean {
    return this.#nativeDefense !== undefined;
  }

  /**
   * Records the value the native module read from game memory.
   *
   * `undefined` clears it — which is what happens when the player is not alive,
   * so a stale reading cannot survive into the next character.
   */
  setNativeDefense(value: number | undefined): void {
    this.#nativeDefense = value;
  }

  /** Called when the server tells us which object is ours. */
  bind(objectId: number): void {
    this.objectId = objectId;
  }

  /** Called when the object the server sent for us names the class it is. */
  bindClass(objectType: number): void {
    this.objectType = objectType;
  }

  moveTo(x: number, y: number): void {
    this.x = x;
    this.y = y;
  }

  applyStats(stats: readonly StatEntry[]): void {
    const hp = numericStat(stats, StatType.Hp);
    if (hp !== undefined) this.hp = hp;
    const maxHp = numericStat(stats, StatType.MaxHp);
    if (maxHp !== undefined) this.#maxHpBase = maxHp;
    const hpBonus = numericStat(stats, StatType.HpBoost);
    if (hpBonus !== undefined) this.#hpBonus = hpBonus;
    const mp = numericStat(stats, StatType.Mp);
    if (mp !== undefined) this.mp = mp;
    const maxMp = numericStat(stats, StatType.MaxMp);
    if (maxMp !== undefined) this.#maxMpBase = maxMp;
    const mpBonus = numericStat(stats, StatType.MpBoost);
    if (mpBonus !== undefined) this.#mpBonus = mpBonus;
    this.#applyPermanentStats(stats);
    this.#inventory.applyStats(stats);
    const speed = numericStat(stats, StatType.Speed);
    if (speed !== undefined) this.speedStat = speed;
    const weapon = numericStat(stats, StatType.Inventory0);
    if (weapon !== undefined) this.weaponType = weapon;
    const defense = numericStat(stats, StatType.Defense);
    if (defense !== undefined) this.#serverDefense = defense;
    const effects = numericStat(stats, StatType.Effects);
    if (effects !== undefined) this.conditions = effects;
    const name = stringStat(stats, StatType.Name);
    if (name !== undefined) this.name = name;
  }

  /**
   * Replaces the six only when one of them moved.
   *
   * They move when a potion is drunk or a level is gained — a handful of times
   * in a session — and this runs on every tick, so building the record
   * unconditionally would allocate one per tick to say what the last one said.
   */
  #applyPermanentStats(stats: readonly StatEntry[]): void {
    const current = this.permanentStats;
    const next: PermanentStats = {
      attack: numericStat(stats, StatType.Attack) ?? current.attack,
      defense: numericStat(stats, StatType.Defense) ?? current.defense,
      speed: numericStat(stats, StatType.Speed) ?? current.speed,
      dexterity: numericStat(stats, StatType.Dexterity) ?? current.dexterity,
      vitality: numericStat(stats, StatType.Vitality) ?? current.vitality,
      wisdom: numericStat(stats, StatType.Wisdom) ?? current.wisdom,
    };
    if (
      next.attack !== current.attack ||
      next.defense !== current.defense ||
      next.speed !== current.speed ||
      next.dexterity !== current.dexterity ||
      next.vitality !== current.vitality ||
      next.wisdom !== current.wisdom
    ) {
      this.permanentStats = next;
    }
  }

  /** Forgets the character, keeping nothing that could describe the next one. */
  reset(): void {
    this.objectId = -1;
    this.objectType = -1;
    this.name = '';
    this.x = 0;
    this.y = 0;
    this.hp = 0;
    this.mp = 0;
    this.#maxHpBase = 0;
    this.#maxMpBase = 0;
    this.#hpBonus = 0;
    this.#mpBonus = 0;
    this.conditions = 0;
    this.speedStat = 0;
    this.weaponType = -1;
    this.permanentStats = NO_PERMANENT_STATS;
    this.#inventory.reset();
    this.#serverDefense = 0;
    this.#nativeDefense = undefined;
  }
}
