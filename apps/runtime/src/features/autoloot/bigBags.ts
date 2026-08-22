/**
 * Making loot bags large enough to see.
 *
 * A bag's size arrives as an ordinary stat on the object the server announces,
 * so raising it before the client reads the announcement is the whole trick —
 * nothing reaches the server and nothing about the bag changes but how big it
 * is drawn.
 *
 * **Done once, on the announcement.** The client keeps a stat it has been told,
 * so an `UPDATE` is the only packet that needs touching; the reference
 * implementation did the same and then failed to enlarge any bag whose size
 * stat the server had not bothered to send. This injects the stat when it is
 * absent, which is most of them.
 */

import type { MutablePacket } from '@brownie/plugin-api';
import { StatType } from '../../constants/StatType.js';
import {
  entriesOf,
  findStat,
  objectTypeOfEntity,
  statsOf,
  statusOfEntity,
} from '../../state/statEdit.js';
import { BIG_BAG_SIZE } from './constants.js';

/**
 * Enlarges every container announced by an `UPDATE`.
 *
 * @returns whether anything changed, which is what the caller owes the packet.
 */
export function enlargeBags(
  packet: MutablePacket,
  isContainer: (objectType: number) => boolean,
): boolean {
  const newObjs = entriesOf(packet.get('newObjs'));
  if (newObjs === undefined || newObjs.length === 0) return false;

  let changed = false;
  for (const entry of newObjs) {
    const objectType = objectTypeOfEntity(entry);
    if (objectType === undefined || !isContainer(objectType)) continue;

    const status = statusOfEntity(entry);
    const stats = status === undefined ? undefined : statsOf(status);
    if (stats === undefined) continue;

    const size = findStat(stats, StatType.Size);
    if (size === undefined) {
      stats.push({ id: StatType.Size, value: BIG_BAG_SIZE, stackCount: 0 });
      changed = true;
      continue;
    }
    // A size the server sent as text is a stat this is not: leave it alone
    // rather than replace a string with a number the client cannot read.
    if (typeof size.value !== 'number' || size.value === BIG_BAG_SIZE) continue;
    size.value = BIG_BAG_SIZE;
    changed = true;
  }

  if (changed) packet.set('newObjs', newObjs);
  return changed;
}
