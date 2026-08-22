/**
 * Character-class object ids.
 *
 * Ported from the reference implementation. These are also carried in the
 * game's own `objects.xml`, which stays the authoritative source — this is a
 * convenience for code that needs to name a class without a catalog lookup, not
 * a second source of truth. Nothing reads it yet; it is here for the combat
 * features (auto-aim, abilities) that will.
 */
export const ClassId = {
  Rogue: 768,
  Archer: 775,
  Wizard: 782,
  Samurai: 785,
  Bard: 796,
  Warrior: 797,
  Knight: 798,
  Paladin: 799,
  Assassin: 800,
  Necromancer: 801,
  Huntress: 802,
  Mystic: 803,
  Trickster: 804,
  Sorcerer: 805,
  Ninja: 806,
  Summoner: 817,
  Kensei: 818,
} as const;

export type ClassIdName = keyof typeof ClassId;
export type ClassId = (typeof ClassId)[ClassIdName];
