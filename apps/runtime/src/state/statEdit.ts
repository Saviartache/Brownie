/**
 * Editing the `Status` structure a decoded packet carries.
 *
 * The mirror of `stats.ts`, which reads one. Decoded field values are described
 * as deeply readonly because *reading* a packet should not imply the right to
 * rewrite it — so the casts that undo that live here, once, rather than in each
 * feature that has decided to.
 *
 * Edits are made **in place**: a status that keeps its place in the array is
 * the same object with one stat changed, and the packet is told once, by the
 * caller, that it needs re-encoding. Building replacement objects would
 * allocate one per entity per tick to say what a single field write says.
 */

import type { FieldValue } from '@brownie/protocol';

/** A `Status`, as something that may be edited. */
export interface MutableStatus {
  objectId?: FieldValue;
  data?: FieldValue;
}

/** One `StatData` inside a status. */
export interface MutableStat {
  id?: FieldValue;
  value?: FieldValue;
  stackCount?: FieldValue;
}

/** A `Status` element of `NEWTICK.statuses`. */
export function asStatus(value: FieldValue | undefined): MutableStatus | undefined {
  return asRecord(value);
}

/** The `Status` nested in an `Entity` element of `UPDATE.newObjs`. */
export function statusOfEntity(value: FieldValue | undefined): MutableStatus | undefined {
  const entity = asRecord(value);
  return entity === undefined ? undefined : asStatus(entity['status']);
}

/** The object type of an `Entity` element of `UPDATE.newObjs`. */
export function objectTypeOfEntity(value: FieldValue | undefined): number | undefined {
  const entity = asRecord(value);
  const objectType = entity?.['objectType'];
  return typeof objectType === 'number' ? objectType : undefined;
}

export function objectIdOf(status: MutableStatus): number {
  return typeof status.objectId === 'number' ? status.objectId : 0;
}

/** A status's stat array, or `undefined` for one that carries none. */
export function statsOf(status: MutableStatus): MutableStat[] | undefined {
  const data = status.data;
  return Array.isArray(data) ? data : undefined;
}

/**
 * The elements of an array field, or `undefined` for a field that is not one.
 *
 * `Array.isArray` cannot narrow to a *readonly* array — its guard is
 * `arg is any[]` — so every caller that walks `UPDATE.newObjs` needs this one
 * step to get back to a typed element. It lives here with the other casts.
 */
export function entriesOf(value: FieldValue | undefined): readonly FieldValue[] | undefined {
  return Array.isArray(value) ? (value as readonly FieldValue[]) : undefined;
}

export function findStat(stats: readonly MutableStat[], id: number): MutableStat | undefined {
  for (const stat of stats) {
    if (stat.id === id) return stat;
  }
  return undefined;
}

function asRecord(
  value: FieldValue | undefined,
): Record<string, FieldValue | undefined> | undefined {
  if (typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as unknown as Record<string, FieldValue | undefined>;
}
