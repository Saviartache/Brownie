/**
 * Stat ids, as the game numbers them.
 *
 * Only the ones the runtime acts on by name are listed here. The **full,
 * verified** id → name table lives in `stat-types.json` beside the packet
 * definitions, and `readStats` reads every id it is sent regardless — so a
 * plugin can read a stat this file never names without anything here changing.
 * Enumerating the whole table in code as well would duplicate that JSON and let
 * the two drift; this stays the curated set that runtime code references
 * directly.
 *
 * `Effects` and `Effects2` are the two halves of the condition bitmask that
 * {@link ConditionEffect} indexes into.
 */
export const StatType = {
  MaxHp: 0,
  Hp: 1,
  Size: 2,
  MaxMp: 3,
  Mp: 4,
  Level: 7,
  /**
   * The first inventory slot, which for a character is the weapon.
   *
   * The eleven slots that follow are `Inventory1` upwards; only this one is
   * named here, because it is the only one anything reads by name — see
   * `SelfState.weaponType`.
   */
  Inventory0: 8,
  Attack: 20,
  Defense: 21,
  Speed: 22,
  Vitality: 26,
  Wisdom: 27,
  Dexterity: 28,
  /** First condition-effect bitmask — bits 0–30. */
  Effects: 29,
  Name: 31,
  AccountId: 38,
  /** A string stat, and the only one that says two players are on one team. */
  GuildName: 62,
  /** Second condition-effect bitmask — bits 31+. Not tracked by state yet. */
  Effects2: 95,
} as const;

export type StatTypeName = keyof typeof StatType;
export type StatType = (typeof StatType)[StatTypeName];
