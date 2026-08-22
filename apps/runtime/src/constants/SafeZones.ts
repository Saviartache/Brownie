/**
 * The maps where nothing can hurt you, and nothing you do is combat.
 *
 * Three features ask the same question for three reasons and would each have
 * carried a copy of the answer: auto-nexus must never escape from one of these,
 * and auto-drink and auto-loot must never touch items in one — the vault and
 * the pet yard are exactly where a player moves potions by hand, and an
 * automation reaching into that races the person using it.
 *
 * Matched by prefix rather than enumerated, because the game numbers its
 * duplicates: `Guild Hall 2`, `Pet Yard 3`, `Vault Explanation`. The reference
 * implementation listed them one by one and its list stopped at five of each.
 */

/** Names that are safe exactly as they stand. */
const SAFE_MAPS: ReadonlySet<string> = new Set([
  'nexus',
  'nexus explanation',
  'guild explanation',
  'cloth bazaar',
  'daily quest room',
  'daily login room',
]);

/** Names whose numbered and explanatory variants are all safe. */
const SAFE_PREFIXES: readonly string[] = ['vault', 'guild hall', 'pet yard'];

/** Whether this map is one where nothing fights and items move by hand. */
export function isSafeZone(mapName: string): boolean {
  const name = mapName.trim().toLowerCase();
  if (name === '') return false;
  if (SAFE_MAPS.has(name)) return true;
  for (const prefix of SAFE_PREFIXES) {
    if (name.startsWith(prefix)) return true;
  }
  return false;
}
