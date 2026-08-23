/**
 * What `objects.xml` says about an ability — the item in the second worn slot.
 *
 * **This replaces a table of class ids.** The reference implementation decided
 * what an ability does from the *character's* object type: one hand-written set
 * of eleven classes that aim, another of four that self-cast, and everything
 * else left out. That is the wrong question asked of the wrong object. A
 * Trickster holding a prism teleports and a Trickster holding a decoy prism
 * does not; a Warrior's helm buffs and a Kensei's sheath dashes. What an
 * ability does is a property of the *item*, the game states it, and a class
 * that never appeared in either set — every one added since the list was
 * written — silently did nothing.
 *
 * Two facts come out of an item and they are used for different things: how it
 * may be fired ({@link AbilityUse}) and what firing it gives you
 * ({@link AbilityFacts.benefits}). The second is what stops a priest's tome
 * going off in an empty hallway; see `abilityEffects.ts` for what the effect
 * names mean.
 *
 * Read once at startup with the rest of the catalog. Nothing here is hot.
 */

import {
  AIMED_EFFECTS,
  MOVEMENT_EFFECTS,
  benefitOf,
  type AbilityBenefit,
} from './abilityEffects.js';
import {
  attribute,
  childText,
  elementText,
  hasChild,
  parseGameNumber,
  scanElementsIn,
} from './xml.js';

/** How an ability may be cast without the player asking for it. */
export const AbilityUse = {
  /**
   * Never automatically. It moves the character, or it is held down.
   *
   * Both cases end the same way. A teleport fired on a timer walks the
   * character into whatever it landed next to; a held ability answers a second
   * press by *ending*, so casting one on a loop toggles it on and off rather
   * than using it. This is also what an ability the file describes in terms
   * nothing here recognises falls back to — see {@link readAbilityFacts}.
   */
  Never: 'never',
  /** Aimed at a point: cast it at an enemy, and only while one is in range. */
  Aimed: 'aimed',
  /** Cast on the character itself — a buff, an aura, a heal. */
  SelfCast: 'self-cast',
} as const;

export type AbilityUse = (typeof AbilityUse)[keyof typeof AbilityUse];

/** What the data file says about one ability item. */
export interface AbilityFacts {
  readonly use: AbilityUse;
  /** Mana one cast costs. 0 for an ability that states no cost. */
  readonly mpCost: number;
  /** The game's own cooldown, for the few abilities that declare one. */
  readonly cooldownMs: number | undefined;
  /**
   * How long the shortest thing it grants lasts, for the ones that grant
   * something the runtime cannot see on the character.
   *
   * A stat boost is the case this exists for: `AttBoost` and its five siblings
   * live in the second condition stat, which the runtime does not carry, so
   * "is it still up?" cannot be asked and the file's own duration is the only
   * answer there is. Anything that grants a *readable* condition is paced by
   * that bit instead, which is exact where this is a guess — wisdom stretches
   * every duration in the file and nothing here models that.
   *
   * `undefined` for an ability that grants nothing timed, such as a plain heal.
   */
  readonly refreshMs: number | undefined;
  /**
   * What it gives the character, in the order the file lists it.
   *
   * Empty for an ability that gives nothing this build can name — which is not
   * the same as an ability that gives nothing, and is why an empty list falls
   * back to "fire it when something is nearby" rather than to never firing.
   */
  readonly benefits: readonly AbilityBenefit[];
}

/** `<MultiPhase />` — the marker on an ability that is held down. */
const HELD_MARKER = 'MultiPhase';

const MS_PER_SECOND = 1000;

/**
 * Reads an item's ability facts, or `undefined` if it is not an ability.
 *
 * An item with no `<Activate>` at all does nothing when used and is not one.
 * Potions are excluded outright: they activate `Heal` like a tome does, they
 * cannot be worn in the ability slot, and reporting one as a self-cast ability
 * would only ever mislead something reading this.
 */
export function readAbilityFacts(element: string): AbilityFacts | undefined {
  if (hasChild(element, 'Potion')) return undefined;

  const activations = scanElementsIn(element, 'Activate');
  if (activations.length === 0) return undefined;

  let movement = false;
  let aimed = false;
  let refreshMs: number | undefined;
  const benefits: AbilityBenefit[] = [];

  for (const activation of activations) {
    const effect = elementText(activation) ?? '';
    if (MOVEMENT_EFFECTS.has(effect)) {
      movement = true;
      continue;
    }
    if (AIMED_EFFECTS.has(effect)) {
      aimed = true;
      continue;
    }

    const benefit = benefitOf(effect, activation);
    if (benefit === undefined) continue;
    benefits.push(benefit);

    // Only from what cannot be seen on the character: a duration kept beside a
    // readable bit would be a second, worse answer to a question the bit
    // already answers exactly.
    if (benefit.conditionBit !== 0) continue;
    const duration = durationMsOf(activation);
    if (duration !== undefined && (refreshMs === undefined || duration < refreshMs)) {
      refreshMs = duration;
    }
  }

  return {
    use: useOf(element, movement, aimed, benefits.length > 0),
    mpCost: parseGameNumber(childText(element, 'MpCost')) ?? 0,
    cooldownMs: secondsToMs(parseGameNumber(childText(element, 'Cooldown'))),
    refreshMs,
    benefits,
  };
}

/**
 * Which of the three an item's effects add up to.
 *
 * Ordered, because abilities combine: a prism throws a decoy *and* teleports,
 * and a sheath dashes *and* shoots. The one that decides is the one that makes
 * automatic use a bad idea, then the one that needs a target, then the rest.
 */
function useOf(element: string, movement: boolean, aimed: boolean, gives: boolean): AbilityUse {
  if (movement || hasChild(element, HELD_MARKER)) return AbilityUse.Never;
  if (aimed) return AbilityUse.Aimed;
  if (gives) return AbilityUse.SelfCast;
  // Every effect it declares is one nothing here recognises. Saying so is not
  // the same as saying it is safe to fire on a timer, and the game adds effects
  // faster than this file learns them.
  return AbilityUse.Never;
}

/** `duration="4.4"` — seconds, as the file writes every duration. */
function durationMsOf(activation: string): number | undefined {
  return secondsToMs(parseGameNumber(attribute(activation, 'duration')));
}

function secondsToMs(seconds: number | undefined): number | undefined {
  if (seconds === undefined || seconds <= 0) return undefined;
  return Math.round(seconds * MS_PER_SECOND);
}
