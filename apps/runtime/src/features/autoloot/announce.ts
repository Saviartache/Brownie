/**
 * What a bag is announced as, when the notifier is on.
 *
 * Names rather than ids, and enchant counts beside them, because the point of
 * the line is deciding whether to walk back for it.
 */

import { bagSlotItem, type NearbyBag } from './bags.js';
import { NOTIFY_ITEM_LIMIT } from './constants.js';
import { enchantCount, UNIQUE_DATA_STAT } from './enchants.js';

/** One line naming a bag's contents, or `empty` for one holding nothing. */
export function describeBag(
  bag: NearbyBag,
  displayName: (objectType: number) => string | undefined,
): string {
  const uniqueData = bag.entity.text(UNIQUE_DATA_STAT);
  const items: string[] = [];

  for (let slot = 0; slot < bag.facts.slots; slot += 1) {
    const objectType = bagSlotItem(bag.entity, slot);
    if (objectType <= 0) continue;
    const name = displayName(objectType) ?? `0x${objectType.toString(16)}`;
    const enchants = enchantCount(uniqueData, slot);
    items.push(enchants > 0 ? `${name} (+${String(enchants)})` : name);
  }

  if (items.length === 0) return 'empty';
  if (items.length <= NOTIFY_ITEM_LIMIT) return items.join(', ');
  return `${items.slice(0, NOTIFY_ITEM_LIMIT).join(', ')} (+${String(items.length - NOTIFY_ITEM_LIMIT)} more)`;
}
