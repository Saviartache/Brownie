/**
 * Whether an item is worth taking.
 *
 * Pure, and the whole of the policy: everything in the plugin that decides
 * *what* to pick up asks this and nothing else, so the rules can be tested
 * against a table of items with no session, no bag and no packet.
 */

import { PotionKind, type ItemFacts } from '../../gamedata/items.js';

/** Which bucket a gear slot falls in, for the per-bucket tier thresholds. */
export const GearCategory = {
  Weapon: 'weapon',
  Ability: 'ability',
  Armor: 'armor',
  Ring: 'ring',
} as const;

export type GearCategory = (typeof GearCategory)[keyof typeof GearCategory];

/**
 * Slot type → bucket.
 *
 * The game's own numbering, and it is checked against the data file rather than
 * assumed: every slot type below holds items the file labels with the matching
 * category, and the two it leaves out are 10 — every potion, dye and consumable
 * the game has — and 26, which is pet eggs. Both have their own rules.
 */
const CATEGORY_BY_SLOT_TYPE: ReadonlyMap<number, GearCategory> = new Map([
  ...([1, 2, 3, 8, 17, 24] as const).map(
    (slot) => [slot, GearCategory.Weapon] as [number, GearCategory],
  ),
  ...([4, 5, 11, 12, 13, 15, 16, 18, 19, 20, 21, 22, 23, 25, 27, 28, 29, 30, 31] as const).map(
    (slot) => [slot, GearCategory.Ability] as [number, GearCategory],
  ),
  ...([6, 7, 14] as const).map((slot) => [slot, GearCategory.Armor] as [number, GearCategory]),
  ...([9] as const).map((slot) => [slot, GearCategory.Ring] as [number, GearCategory]),
]);

/** Every potion, dye and consumable shares this slot. */
const CONSUMABLE_SLOT_TYPE = 10;
/** Pet eggs, which have their own toggle. */
const EGG_SLOT_TYPE = 26;

/** What the player has asked to be picked up. */
export interface LootPreferences {
  readonly minWeaponTier: number;
  readonly minAbilityTier: number;
  readonly minArmorTier: number;
  readonly minRingTier: number;
  /** Take untiered items — the `UT` ones. */
  readonly untiered: boolean;
  /** Take set items — the `ST` ones. */
  readonly setItems: boolean;
  readonly healthPotions: boolean;
  readonly magicPotions: boolean;
  /** The six permanent stats. */
  readonly statPotions: boolean;
  /** The ones that raise the bar itself. */
  readonly lifeManaPotions: boolean;
  readonly eggs: boolean;
  readonly marks: boolean;
  /** Enchants an item must carry. 0 disables the filter. */
  readonly minEnchants: number;
  /** Taken whatever the rules say. */
  readonly always: ReadonlySet<number>;
  /** Never taken, whatever the rules say — including the list above. */
  readonly never: ReadonlySet<number>;
}

/** One item in one bag slot, as the rules need to see it. */
export interface LootCandidate {
  readonly objectType: number;
  /** What the catalog says, or `undefined` for an item it does not describe. */
  readonly facts: ItemFacts | undefined;
  /** The catalog's display name, for the rules that match on one. */
  readonly name: string;
  readonly enchants: number;
}

export function gearCategoryOf(slotType: number): GearCategory | undefined {
  return CATEGORY_BY_SLOT_TYPE.get(slotType);
}

/**
 * Whether to take this item.
 *
 * An item the catalog does not describe is left alone. The reference
 * implementation guessed at those — anything with no tier counted as untiered —
 * and the guess is what made it hoover up dyes and clothing. With no data file
 * read at all nothing is described, and auto-loot does nothing, which is the
 * honest outcome for a feature whose entire input is that file.
 */
export function shouldLoot(candidate: LootCandidate, preferences: LootPreferences): boolean {
  const { objectType, facts } = candidate;
  if (objectType <= 0) return false;
  if (preferences.never.has(objectType)) return false;
  if (preferences.always.has(objectType)) return true;
  if (facts === undefined) return false;

  const potion = potionWanted(facts, preferences);
  // A potion is never held to an enchant threshold: it cannot carry one.
  if (potion !== undefined) return potion;

  if (candidate.enchants < preferences.minEnchants) return false;
  if (facts.slotType === EGG_SLOT_TYPE) return preferences.eggs;
  if (preferences.marks && isMark(candidate.name)) return true;
  if (facts.untiered) return preferences.untiered && isGearSlot(facts.slotType);
  if (facts.setItem) return preferences.setItems;

  const category = gearCategoryOf(facts.slotType);
  if (category === undefined || facts.tier === undefined) return false;
  return facts.tier >= minimumTier(category, preferences);
}

/** The toggle for this potion, or `undefined` when the item is not one. */
function potionWanted(facts: ItemFacts, preferences: LootPreferences): boolean | undefined {
  switch (facts.potion?.kind) {
    case PotionKind.Heal:
      return preferences.healthPotions;
    case PotionKind.Magic:
      return preferences.magicPotions;
    case PotionKind.Permanent:
      return preferences.statPotions;
    case PotionKind.LifeOrMana:
      return preferences.lifeManaPotions;
    default:
      return undefined;
  }
}

/**
 * Untiered applies to gear, and to nothing else.
 *
 * Consumables and eggs carry no tier either and would otherwise all qualify —
 * which in the reference implementation meant every dye in the game.
 */
function isGearSlot(slotType: number): boolean {
  return slotType !== CONSUMABLE_SLOT_TYPE && slotType !== EGG_SLOT_TYPE;
}

/**
 * The exaltation tokens, recognised by name.
 *
 * The data file marks them no other way — there is no label and no slot of
 * their own — so this is a name match and says so.
 */
function isMark(name: string): boolean {
  return name.startsWith('Mark of ');
}

function minimumTier(category: GearCategory, preferences: LootPreferences): number {
  switch (category) {
    case GearCategory.Weapon:
      return preferences.minWeaponTier;
    case GearCategory.Ability:
      return preferences.minAbilityTier;
    case GearCategory.Armor:
      return preferences.minArmorTier;
    case GearCategory.Ring:
      return preferences.minRingTier;
  }
}

/**
 * Reads an always/never list.
 *
 * Object types, decimal or `0x`-prefixed, separated by anything that is not one
 * of those — a comma, a space, a newline. Ids rather than names because the
 * catalog is a one-way map from type to name and building the other direction
 * would cost a second copy of thirty thousand entries to serve two settings.
 */
export function parseItemList(text: string): ReadonlySet<number> {
  const items = new Set<number>();
  for (const token of text.split(/[^0-9a-fx]+/i)) {
    if (token === '') continue;
    const value = /^0x[0-9a-f]+$/i.test(token)
      ? Number.parseInt(token.slice(2), 16)
      : Number(token);
    if (Number.isFinite(value) && value > 0) items.add(Math.trunc(value));
  }
  return items;
}
