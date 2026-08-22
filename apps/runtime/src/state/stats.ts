/**
 * Reading a `StatData[]` array out of a decoded packet.
 *
 * The stat *ids* are named in `../constants/StatType.js`; this file is only the
 * logic that turns raw field values into typed lookups, kept apart from the
 * table it reads so data and parsing do not share a module.
 */

/** One stat as it arrives inside a `Status`. */
export interface StatEntry {
  readonly id: number;
  readonly value: number | string;
  readonly stackCount: number;
}

/**
 * Reads a `StatData[]` array out of a decoded packet.
 *
 * Field values arrive as `FieldValue`, which is honest about the fact that a
 * packet is data we were handed rather than data we constructed. Everything
 * that does not look like a stat is skipped rather than throwing: this runs on
 * every tick for every visible entity, and one malformed entry must not cost
 * the whole update.
 */
export function readStats(raw: unknown): StatEntry[] {
  if (!Array.isArray(raw)) return [];
  const stats: StatEntry[] = [];
  for (const entry of raw as unknown[]) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const id = record['id'];
    const value = record['value'];
    if (typeof id !== 'number') continue;
    if (typeof value !== 'number' && typeof value !== 'string') continue;
    const stackCount = record['stackCount'];
    stats.push({ id, value, stackCount: typeof stackCount === 'number' ? stackCount : 0 });
  }
  return stats;
}

export function numericStat(stats: readonly StatEntry[], id: number): number | undefined {
  for (const stat of stats) {
    if (stat.id === id && typeof stat.value === 'number') return stat.value;
  }
  return undefined;
}

export function stringStat(stats: readonly StatEntry[], id: number): string | undefined {
  for (const stat of stats) {
    if (stat.id === id && typeof stat.value === 'string') return stat.value;
  }
  return undefined;
}
