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
 * Everything below is read once at startup with the rest of the catalog.
 * Nothing here is on a hot path.
 */

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
  /** A buff, an aura or a heal centred on the character itself. */
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
   * How long what a self-cast grants lasts — the shortest of its effects.
   *
   * This is what makes "when is the buff worth casting again?" answerable from
   * the file instead of from a constant. The reference implementation recast
   * every self-buff every 2500 ms, which for a seal that lasts six seconds is
   * two casts in three thrown away, and for one that lasts two seconds is a
   * buff that spends a third of the fight down.
   *
   * The *shortest*, because a tome that grants an aura and a speed boost is
   * only fully applied while both stand. Wisdom extends what the file declares
   * and nothing here models that, so a recast on this figure is early rather
   * than late — which wastes a little mana and never leaves the buff down.
   *
   * `undefined` for an ability that grants nothing timed, such as a plain heal.
   */
  readonly refreshMs: number | undefined;
}

/**
 * Effects that move the character.
 *
 * Every one of these is a reason never to fire the ability on a timer, and the
 * reason is the same: where the character ends up stops being something the
 * player decided.
 */
const MOVEMENT_EFFECTS: ReadonlySet<string> = new Set([
  'Teleport',
  'TeleportToObject',
  'MarkAndTeleport',
  'Dash',
  'ChannelDash',
]);

/**
 * Effects that land where `USEITEM.itemUsePos` points.
 *
 * Also, and more importantly, the effects that are worth nothing without
 * something to use them on: every one of these either damages or places
 * something, so casting into an empty room is mana spent on nobody. A few of
 * them — the novas and the blasts — are actually centred on the character
 * whatever point is sent, and they are here rather than below because the
 * question this set answers is "does it need a target", and they do.
 */
const AIMED_EFFECTS: ReadonlySet<string> = new Set([
  'Shoot',
  'BulletNova',
  'BulletCreate',
  'ShurikenAbility',
  'Trap',
  'PoisonGrenade',
  'Lightning',
  'RaiseDead',
  'SpawnCreep',
  'ObjectToss',
  'Decoy',
  'Totem',
  'EffectBlast',
  'DetonateHex',
  'DamageNova',
  'DazeBlast',
  'StasisBlast',
  'VampireBlast',
]);

/** Effects that act on the character and whoever stands near it. */
const SELF_EFFECTS: ReadonlySet<string> = new Set([
  'ConditionEffectSelf',
  'ConditionEffectAura',
  'ClearConditionEffectSelf',
  'RemoveNegativeConditionsSelf',
  'StatBoostSelf',
  'StatBoostAura',
  'DamageMultAura',
  'BoostRange',
  'GenericActivate',
  'SelfTransform',
  'Heal',
  'HealNova',
  'Magic',
  'MagicNova',
  'Pet',
  // Invisibility. Auto-casting it is a real choice rather than an obvious one —
  // it breaks the moment the player shoots — but it is a buff on the character
  // and this file's job is to say what the item does, not whether to want it.
  // The plugin's self-cast switch is where that is decided.
  'Sneak',
]);

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
  let selfCast = false;
  let refreshMs: number | undefined;

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
    if (!SELF_EFFECTS.has(effect)) continue;

    selfCast = true;
    const duration = durationMsOf(activation);
    if (duration !== undefined && (refreshMs === undefined || duration < refreshMs)) {
      refreshMs = duration;
    }
  }

  return {
    use: useOf(element, movement, aimed, selfCast),
    mpCost: parseGameNumber(childText(element, 'MpCost')) ?? 0,
    cooldownMs: secondsToMs(parseGameNumber(childText(element, 'Cooldown'))),
    refreshMs,
  };
}

/**
 * Which of the three an item's effects add up to.
 *
 * Ordered, because abilities combine: a prism throws a decoy *and* teleports,
 * and a sheath dashes *and* shoots. The one that decides is the one that makes
 * automatic use a bad idea, then the one that needs a target, then the rest.
 */
function useOf(element: string, movement: boolean, aimed: boolean, selfCast: boolean): AbilityUse {
  if (movement || hasChild(element, HELD_MARKER)) return AbilityUse.Never;
  if (aimed) return AbilityUse.Aimed;
  if (selfCast) return AbilityUse.SelfCast;
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
