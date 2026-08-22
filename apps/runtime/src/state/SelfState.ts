import type { SelfView } from '@brownie/plugin-api';
import { StatType } from '../constants/StatType.js';
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
  name = '';
  x = 0;
  y = 0;
  hp = 0;
  maxHp = 0;
  mp = 0;
  maxMp = 0;
  conditions = 0;
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

  moveTo(x: number, y: number): void {
    this.x = x;
    this.y = y;
  }

  applyStats(stats: readonly StatEntry[]): void {
    const hp = numericStat(stats, StatType.Hp);
    if (hp !== undefined) this.hp = hp;
    const maxHp = numericStat(stats, StatType.MaxHp);
    if (maxHp !== undefined) this.maxHp = maxHp;
    const mp = numericStat(stats, StatType.Mp);
    if (mp !== undefined) this.mp = mp;
    const maxMp = numericStat(stats, StatType.MaxMp);
    if (maxMp !== undefined) this.maxMp = maxMp;
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

  /** Forgets the character, keeping nothing that could describe the next one. */
  reset(): void {
    this.objectId = -1;
    this.name = '';
    this.x = 0;
    this.y = 0;
    this.hp = 0;
    this.maxHp = 0;
    this.mp = 0;
    this.maxMp = 0;
    this.conditions = 0;
    this.speedStat = 0;
    this.weaponType = -1;
    this.#serverDefense = 0;
    this.#nativeDefense = undefined;
  }
}
