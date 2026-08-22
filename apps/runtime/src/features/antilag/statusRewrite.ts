/**
 * What anti-lag does to one `Status`, the structure both `UPDATE` and
 * `NEWTICK` carry for every object.
 *
 * The decoded packet is edited **in place**: a status that keeps its place in
 * the array is the same object with one stat changed, and the pipeline is told
 * once, by the caller, that the packet needs re-encoding. Building replacement
 * objects would allocate one per entity per tick to say what a single field
 * write already says.
 *
 * Stat 2 is only on the wire when the size differs from the default, so hiding
 * has to *inject* it. Rewriting only what the server sent misses every
 * default-sized entity — which is most pets.
 */

import type { FieldValue } from '@brownie/protocol';
import { StatType } from '../../constants/StatType.js';
import type { SessionEntities } from './SessionEntities.js';
import {
  DEFAULT_SIZE,
  isOwnPet,
  isRemovable,
  targetSize,
  type AntiLagPolicy,
  type EntityKind,
} from './policy.js';

/** What happened to a status, and so what the caller owes the packet. */
export const StatusOutcome = {
  Untouched: 0,
  /** Edited in place: the packet must be re-encoded. */
  Changed: 1,
  /** Not to be forwarded: the caller drops it from the array. */
  Removed: 2,
} as const;

export type StatusOutcome = (typeof StatusOutcome)[keyof typeof StatusOutcome];

/**
 * A decoded `Status`, as something that may be edited.
 *
 * Decoded field values are plain objects and arrays — `FieldValue` describes
 * them as deeply readonly because *reading* a packet should not imply the right
 * to rewrite it, and this module is the one place that has decided to.
 */
export interface MutableStatus {
  objectId?: FieldValue;
  data?: FieldValue;
}

interface MutableStat {
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

function asRecord(
  value: FieldValue | undefined,
): Record<string, FieldValue | undefined> | undefined {
  if (typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as unknown as Record<string, FieldValue | undefined>;
}

export function objectIdOf(status: MutableStatus): number {
  return typeof status.objectId === 'number' ? status.objectId : 0;
}

export function rewriteStatus(
  policy: AntiLagPolicy,
  state: SessionEntities,
  status: MutableStatus,
  objectId: number,
  selfObjectId: number,
): StatusOutcome {
  const kind = state.kindOf(policy, objectId);
  if (kind === undefined) return StatusOutcome.Untouched;

  if (isRemovable(policy, kind)) {
    state.hide(objectId);
    return StatusOutcome.Removed;
  }

  return applySize(policy, state, status, objectId, kind, selfObjectId)
    ? StatusOutcome.Changed
    : StatusOutcome.Untouched;
}

function applySize(
  policy: AntiLagPolicy,
  state: SessionEntities,
  status: MutableStatus,
  objectId: number,
  kind: EntityKind,
  selfObjectId: number,
): boolean {
  const data = status.data;
  // A status with no stat array is not one to invent fields for.
  if (!Array.isArray(data)) return false;
  const stats = data as unknown as MutableStat[];

  const existing = findStat(stats, StatType.Size);
  const sent = existing?.value;
  if (existing !== undefined && typeof sent !== 'number') return false;
  const serverSize = typeof sent === 'number' ? sent : DEFAULT_SIZE;
  // A server-sent 0 is already invisible: there is nothing to win, and scaling
  // it would be a no-op anyway.
  if (serverSize <= 0) return false;

  const wanted = targetSize(policy, kind, isOwnPet(objectId, selfObjectId), serverSize);
  if (wanted === serverSize) return false;

  if (existing !== undefined) {
    existing.value = wanted;
    return true;
  }
  // Injected once per object: the client keeps a stat it has been told, so
  // repeating it every tick would grow every packet for nothing.
  if (!state.claimInjection(objectId)) return false;
  stats.push({ id: StatType.Size, value: wanted, stackCount: 0 });
  return true;
}

function findStat(stats: readonly MutableStat[], id: number): MutableStat | undefined {
  for (const stat of stats) {
    if (stat.id === id) return stat;
  }
  return undefined;
}
