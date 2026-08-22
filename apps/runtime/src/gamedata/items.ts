/**
 * What `objects.xml` says about an item, and about the containers items are
 * found in.
 *
 * **Everything here replaces a table of hard-coded object ids.** The reference
 * implementation carried lists of potion ids, stat-potion ids, bag types and
 * public-bag types, each written down by hand and each wrong the moment the
 * game added a variant — its list of loot bags was missing six of the thirty-one
 * the file describes, including both potion bags. The game ships the answers,
 * so they are read rather than remembered.
 *
 * Read once at startup, for the 12 500 objects that carry `<Item />` and the
 * thirty-one that are containers. Nothing here is on a hot path.
 */

import type { PermanentStats } from '@brownie/plugin-api';
import { readAbilityFacts, type AbilityFacts } from './abilities.js';
import {
  attribute,
  childText,
  elementText,
  hasChild,
  parseGameNumber,
  scanElementsIn,
} from './xml.js';

/** One of the six stats a potion raises permanently. */
export type PermanentStat = keyof PermanentStats;

/** What drinking a potion does. */
export const PotionKind = {
  /** Restores health now. */
  Heal: 'heal',
  /** Restores mana now. */
  Magic: 'magic',
  /** Raises one of the six permanent stats — {@link PotionFacts.raises}. */
  Permanent: 'permanent',
  /** Raises maximum health or mana permanently. */
  LifeOrMana: 'life-or-mana',
} as const;

export type PotionKind = (typeof PotionKind)[keyof typeof PotionKind];

export interface PotionFacts {
  readonly kind: PotionKind;
  /** Which stat it raises, for {@link PotionKind.Permanent}. */
  readonly raises: PermanentStat | undefined;
}

/** What the data file says about one item. */
export interface ItemFacts {
  /** Which slot it goes in. Every potion shares slot type 10. */
  readonly slotType: number;
  /** Its numeric tier, or `undefined` for an item that has none. */
  readonly tier: number | undefined;
  /** Untiered — one of a kind, marked `UT` in the item's labels. */
  readonly untiered: boolean;
  /** Part of a set, marked `ST`. Never also {@link untiered}. */
  readonly setItem: boolean;
  /** How many stack in one potion-belt slot. 0 when the belt refuses it. */
  readonly beltStack: number;
  /** What drinking it does, for the ones that are potions. */
  readonly potion: PotionFacts | undefined;
  /** What using it does, for the ones that are abilities. */
  readonly ability: AbilityFacts | undefined;
}

/** What the data file says about one container — a loot bag, a chest, a grave. */
export interface ContainerFacts {
  /** How many item slots it has. Eight, for every bag the game currently has. */
  readonly slots: number;
  /**
   * Whether anyone may take from it.
   *
   * A bag that accepts ordinary objects and not soulbound ones is the kind that
   * drops for the whole room — the white, brown and pink bags — so taking from
   * one takes it from somebody else, which is the only reason a pickup would
   * ever want to wait. A bag that accepts soulbound objects dropped for us
   * alone and nobody is racing for it.
   */
  readonly shared: boolean;
}

/** `<Class>Container</Class>` — the game's own marker for a bag or a chest. */
const CONTAINER_CLASS = 'Container';

/** The game's stat codes for the six, as `<Activate stat="…">` writes them. */
const PERMANENT_BY_CODE: ReadonlyMap<string, PermanentStat> = new Map([
  ['ATT', 'attack'],
  ['DEF', 'defense'],
  ['SPD', 'speed'],
  ['DEX', 'dexterity'],
  ['VIT', 'vitality'],
  ['WIS', 'wisdom'],
]);

/**
 * Reads an `<Object>` element's item facts, or `undefined` if it is not an item.
 *
 * `<Item />` is what marks one, and it is the marker rather than the presence of
 * a slot type because a few items declare no slot at all.
 */
export function readItemFacts(element: string): ItemFacts | undefined {
  if (!hasChild(element, 'Item')) return undefined;

  const labels = readLabels(element);
  return {
    slotType: parseGameNumber(childText(element, 'SlotType')) ?? -1,
    tier: parseGameNumber(childText(element, 'Tier')),
    // `UT` and `ST` are label tokens in this build; the tier element carries a
    // number or is absent. An older extraction wrote them into `<Tier>`, which
    // is why the reference implementation read them from there and then had to
    // guess "no tier plus a gear slot means untiered" for everything else.
    untiered: labels.has('UT'),
    setItem: labels.has('ST'),
    beltStack: readBeltStack(element),
    potion: readPotion(element),
    ability: readAbilityFacts(element),
  };
}

/** Reads a container's facts, or `undefined` if the object is not one. */
export function readContainerFacts(
  element: string,
  objectClass: string | undefined,
): ContainerFacts | undefined {
  if (objectClass !== CONTAINER_CLASS) return undefined;
  return {
    slots: countSlots(childText(element, 'SlotTypes')),
    // A vault chest is a `VaultContainer` and so is not one of these at all,
    // which is what keeps anything looting containers away from the vault.
    shared:
      hasChild(element, 'CanPutNormalObjects') && !hasChild(element, 'CanPutSoulboundObjects'),
  };
}

function readLabels(element: string): ReadonlySet<string> {
  const raw = childText(element, 'Labels');
  if (raw === undefined || raw === '') return EMPTY_LABELS;
  const labels = new Set<string>();
  for (const label of raw.split(',')) {
    const trimmed = label.trim().toUpperCase();
    if (trimmed !== '') labels.add(trimmed);
  }
  return labels;
}

const EMPTY_LABELS: ReadonlySet<string> = new Set<string>();

/** `<QuickslotAllowed maxstack="6" />`, or nothing for an item the belt refuses. */
function readBeltStack(element: string): number {
  const [allowed] = scanElementsIn(element, 'QuickslotAllowed');
  if (allowed === undefined) return 0;
  const stack = parseGameNumber(attribute(allowed, 'maxstack'));
  // Present without a stack size still means allowed; one is the honest floor.
  return stack !== undefined && stack > 0 ? Math.trunc(stack) : 1;
}

/**
 * What a potion does, from its `<Activate>` effect.
 *
 * Gated on `<Potion />` rather than on the effect alone: a healing tome also
 * activates `Heal`, and treating one as a potion would have anything drinking
 * for health try to quaff an ability.
 */
function readPotion(element: string): PotionFacts | undefined {
  if (!hasChild(element, 'Potion')) return undefined;

  for (const activate of scanElementsIn(element, 'Activate')) {
    const effect = elementText(activate);
    if (effect === 'Heal') return { kind: PotionKind.Heal, raises: undefined };
    if (effect === 'Magic') return { kind: PotionKind.Magic, raises: undefined };
    if (effect !== 'IncrementStat') continue;

    const code = attribute(activate, 'stat')?.trim().toUpperCase() ?? '';
    const raises = PERMANENT_BY_CODE.get(code);
    if (raises !== undefined) return { kind: PotionKind.Permanent, raises };
    // `MAXHP` and `MAXMP` raise the bar itself; `XP` is not a stat at all and
    // is deliberately not a potion any rule here acts on.
    if (code === 'MAXHP' || code === 'MAXMP') {
      return { kind: PotionKind.LifeOrMana, raises: undefined };
    }
  }
  return undefined;
}

/** `<SlotTypes>0, 0, 0, 0, 0, 0, 0, 0</SlotTypes>` — the count is the capacity. */
function countSlots(raw: string | undefined): number {
  if (raw === undefined) return 0;
  let slots = 0;
  for (const entry of raw.split(',')) {
    if (entry.trim() !== '') slots += 1;
  }
  return slots;
}
