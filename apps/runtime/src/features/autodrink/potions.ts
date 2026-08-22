/**
 * Which object types are health and mana potions.
 *
 * Answered from the game's own data — `<Activate>Heal</Activate>` under a
 * `<Potion />` — rather than from a list of ids. The reference implementation
 * kept the list by hand and it was already three variants short; the game adds
 * a "greater" tier of everything roughly once a year.
 */

import { PotionKind, type ItemFacts } from '../../gamedata/items.js';

/** What a potion restores. */
export const Quaff = {
  Health: 'health',
  Magic: 'magic',
} as const;

export type Quaff = (typeof Quaff)[keyof typeof Quaff];

/** What the catalog says about an item, or nothing when it has not been read. */
export type ItemLookup = (objectType: number) => ItemFacts | undefined;

/**
 * The six the game has shipped for the life of it, used only when the data
 * file has not been read.
 *
 * Auto-nexus takes the same position for the same reason: something that keeps
 * a character alive must not go quiet because an optional asset is missing. The
 * fallback answers only for an object the catalog cannot describe at all, so a
 * build that reassigns one of these ids is believed over this list.
 */
const WELL_KNOWN: ReadonlyMap<number, Quaff> = new Map([
  [2594, Quaff.Health], // Health Potion
  [2736, Quaff.Health], // Minor Health Potion
  [2795, Quaff.Health], // Greater Health Potion
  [2595, Quaff.Magic], // Magic Potion
  [2781, Quaff.Magic], // Minor Magic Potion
  [2796, Quaff.Magic], // Greater Magic Potion
]);

/** What drinking this object type would restore, or nothing if it is not a potion. */
export function quaffKindOf(objectType: number, item: ItemLookup): Quaff | undefined {
  if (objectType <= 0) return undefined;

  const facts = item(objectType);
  if (facts === undefined) return WELL_KNOWN.get(objectType);
  if (facts.potion?.kind === PotionKind.Heal) return Quaff.Health;
  if (facts.potion?.kind === PotionKind.Magic) return Quaff.Magic;
  return undefined;
}
