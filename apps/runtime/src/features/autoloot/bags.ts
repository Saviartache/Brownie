/**
 * The containers on the ground: which ones are near, and what is in them.
 *
 * Which object types are containers comes out of `objects.xml`
 * (`<Class>Container</Class>`) rather than a list of ids. The reference
 * implementation's list named twenty-three and the file describes thirty-one —
 * it was missing both potion bags, the material bag and the gravestone. It also
 * hard-coded eight slots per bag; the file states the number.
 */

import type { EntityView, Position, WorldView } from '@brownie/plugin-api';
import { StatType } from '../../constants/StatType.js';
import type { ContainerFacts } from '../../gamedata/items.js';

/** A container in the world, with what the data file says about it. */
export interface NearbyBag {
  readonly entity: EntityView;
  readonly facts: ContainerFacts;
  readonly distanceTiles: number;
}

export type ContainerLookup = (objectType: number) => ContainerFacts | undefined;

/**
 * Every container within `radiusTiles`, nearest first.
 *
 * One pass over the world's entities, which is where the cost is: a busy realm
 * holds a few hundred and this runs once a tick. Nearest first so that stepping
 * between two overlapping bags empties the one being stood on.
 */
export function findBags(
  world: WorldView,
  from: Position,
  container: ContainerLookup,
  radiusTiles: number,
): NearbyBag[] {
  const found: NearbyBag[] = [];
  for (const entity of world.entities()) {
    const facts = container(entity.objectType);
    if (facts === undefined || facts.slots <= 0) continue;
    const distanceTiles = Math.hypot(entity.x - from.x, entity.y - from.y);
    if (distanceTiles > radiusTiles) continue;
    found.push({ entity, facts, distanceTiles });
  }
  found.sort((a, b) => a.distanceTiles - b.distanceTiles);
  return found;
}

/**
 * What is in one of a container's slots, or -1 when it is empty.
 *
 * A container states its contents in the same stats a character states its own
 * inventory in, counting from {@link StatType.Inventory0} — which is the one
 * part of the slot-stat numbering both tables in this repository agree on.
 */
export function bagSlotItem(entity: EntityView, slot: number): number {
  const objectType = entity.stat(StatType.Inventory0 + slot);
  return objectType === undefined ? -1 : Math.trunc(objectType);
}
