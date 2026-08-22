/**
 * What anti-lag does to one `Status`, the structure both `UPDATE` and
 * `NEWTICK` carry for every object.
 *
 * The decoded packet is edited in place — see `state/statEdit.ts`, which owns
 * the casts that make that legal and is shared with everything else that
 * rewrites a stat on its way past.
 *
 * Stat 2 is only on the wire when the size differs from the default, so hiding
 * has to *inject* it. Rewriting only what the server sent misses every
 * default-sized entity — which is most pets.
 */

import { StatType } from '../../constants/StatType.js';
import { findStat, statsOf, type MutableStatus } from '../../state/statEdit.js';
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
  // A status with no stat array is not one to invent fields for.
  const stats = statsOf(status);
  if (stats === undefined) return false;

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
