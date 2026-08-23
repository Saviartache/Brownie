/**
 * What the game's `<Activate>` effect names mean.
 *
 * Three questions are answered here and they are not the same question. Where
 * an ability is used (it moves you, it is aimed, it is cast on yourself) says
 * *how* it may be fired. What it gives you says *when* firing it is worth
 * anything — and that second one is the whole reason this file exists.
 *
 * **A heal cast at full health is a heal thrown away.** The implementation this
 * came from fired the ability slot on a fixed interval for as long as mana
 * allowed, so a priest's tome went off every 2.5 seconds in an empty hallway,
 * and a warrior's helm renewed a berserk that was already up. Neither is a
 * timing problem. The item states what it does — `Heal`, an aura of `Healing`,
 * a boost to `ATT` — and whether that is worth having is a question about the
 * character right now, which `features/autoability/worthCasting.ts` asks.
 *
 * Read once at startup with the rest of the catalog. Nothing here is hot.
 */

import { ConditionEffect, conditionBitLow } from '../constants/ConditionEffect.js';
import { attribute } from './xml.js';

/** What having an ability go off actually gives the character. */
export const BenefitKind = {
  /** Health, now or over time. Worth nothing while the bar is full. */
  Health: 'health',
  /** Mana. Worth nothing while that bar is full either. */
  Mana: 'mana',
  /** Damage, or something done to whatever is nearby. Needs something nearby. */
  Offence: 'offence',
  /** Protection. Also needs something to be protected from. */
  Defence: 'defence',
  /** Speed, sight, stealth — worth having whenever it is not already on. */
  Utility: 'utility',
  /** Removes what has already gone wrong. Needs something to have gone wrong. */
  Cleanse: 'cleanse',
} as const;

export type BenefitKind = (typeof BenefitKind)[keyof typeof BenefitKind];

/** One thing an ability gives, and how to tell it is already given. */
export interface AbilityBenefit {
  readonly kind: BenefitKind;
  /**
   * The condition-effect bit it puts on the character, or 0 for none.
   *
   * This is what makes "it is already up" answerable without a timer: a berserk
   * aura sets the `Berserk` bit on the caster, and the server states it, so
   * recasting can wait for the bit to clear instead of for a guess at how long
   * wisdom stretched the duration to.
   *
   * 0 has two causes and both mean the same thing to a caller — nothing to
   * check. An instant heal grants no lasting condition at all, and a stat boost
   * grants one the runtime cannot see: `AttBoost` and its five siblings live in
   * the second condition stat, which {@link SelfView.conditions} does not carry.
   * Those fall back to the ability's own declared duration.
   */
  readonly conditionBit: number;
}

/**
 * Effects that move the character.
 *
 * Every one of these is a reason never to fire the ability on a timer, and the
 * reason is the same: where the character ends up stops being something the
 * player decided.
 */
export const MOVEMENT_EFFECTS: ReadonlySet<string> = new Set([
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
 * whatever point is sent, and they are here rather than below because what this
 * set decides is "does it need a target", and they do.
 */
export const AIMED_EFFECTS: ReadonlySet<string> = new Set([
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

/** Effects that say what they give in their own name. */
const DIRECT_BENEFITS: ReadonlyMap<string, AbilityBenefit> = new Map([
  ['Heal', { kind: BenefitKind.Health, conditionBit: 0 }],
  ['HealNova', { kind: BenefitKind.Health, conditionBit: 0 }],
  ['Magic', { kind: BenefitKind.Mana, conditionBit: 0 }],
  ['MagicNova', { kind: BenefitKind.Mana, conditionBit: 0 }],
  ['RemoveNegativeConditionsSelf', { kind: BenefitKind.Cleanse, conditionBit: 0 }],
  // The rogue's cloak. Its bit is what stops it being recast every interval for
  // as long as the mana lasts, which is what invisibility looks like otherwise.
  [
    'Sneak',
    { kind: BenefitKind.Utility, conditionBit: conditionBitLow(ConditionEffect.Invisible) },
  ],
  ['BoostRange', { kind: BenefitKind.Offence, conditionBit: 0 }],
  ['DamageMultAura', { kind: BenefitKind.Offence, conditionBit: 0 }],
  ['SelfTransform', { kind: BenefitKind.Utility, conditionBit: 0 }],
  ['Pet', { kind: BenefitKind.Utility, conditionBit: 0 }],
]);

/**
 * The condition effects an ability is worth casting *for*, by the name the file
 * writes in `effect="…"`.
 *
 * Only the ones that help. An ability that puts `Drunk` or `Bleeding` on its
 * own caster — the game has a dozen, all of them jokes or set-item drawbacks —
 * contributes nothing here, so it is never a reason to fire and never blocks
 * one either.
 */
const CONDITION_BENEFITS: ReadonlyMap<string, AbilityBenefit> = new Map([
  ['Healing', { kind: BenefitKind.Health, conditionBit: conditionBitLow(ConditionEffect.Healing) }],
  // Mana regeneration. Its bit is in the second condition stat, so this one is
  // decided by the mana bar alone — see {@link AbilityBenefit.conditionBit}.
  [
    'Energized',
    { kind: BenefitKind.Mana, conditionBit: conditionBitLow(ConditionEffect.Energized) },
  ],
  [
    'Damaging',
    { kind: BenefitKind.Offence, conditionBit: conditionBitLow(ConditionEffect.Damaging) },
  ],
  [
    'Berserk',
    { kind: BenefitKind.Offence, conditionBit: conditionBitLow(ConditionEffect.Berserk) },
  ],
  [
    'Armored',
    { kind: BenefitKind.Defence, conditionBit: conditionBitLow(ConditionEffect.Armored) },
  ],
  [
    'Invulnerable',
    { kind: BenefitKind.Defence, conditionBit: conditionBitLow(ConditionEffect.Invulnerable) },
  ],
  [
    'Invincible',
    { kind: BenefitKind.Defence, conditionBit: conditionBitLow(ConditionEffect.Invincible) },
  ],
  [
    'StunImmune',
    { kind: BenefitKind.Defence, conditionBit: conditionBitLow(ConditionEffect.StunImmune) },
  ],
  [
    'ArmorBrokenImmune',
    { kind: BenefitKind.Defence, conditionBit: conditionBitLow(ConditionEffect.ArmorBrokenImmune) },
  ],
  ['Speedy', { kind: BenefitKind.Utility, conditionBit: conditionBitLow(ConditionEffect.Speedy) }],
  [
    'NinjaSpeedy',
    { kind: BenefitKind.Utility, conditionBit: conditionBitLow(ConditionEffect.NinjaSpeedy) },
  ],
  [
    'Invisible',
    { kind: BenefitKind.Utility, conditionBit: conditionBitLow(ConditionEffect.Invisible) },
  ],
]);

/**
 * What raising a stat is for, by the code the file writes in `stat="…"`.
 *
 * None of these carries a bit this runtime can read, so they are the abilities
 * that still need a duration behind them.
 */
const STAT_BENEFITS: ReadonlyMap<string, BenefitKind> = new Map([
  ['ATT', BenefitKind.Offence],
  ['DEX', BenefitKind.Offence],
  ['DEF', BenefitKind.Defence],
  ['VIT', BenefitKind.Defence],
  ['MAXHP', BenefitKind.Defence],
  ['SPD', BenefitKind.Utility],
  ['WIS', BenefitKind.Utility],
  ['MAXMP', BenefitKind.Utility],
]);

/**
 * Everything a cleanse would take off, folded into one mask.
 *
 * The first condition stat only, which is the one the runtime carries. `Curse`,
 * `Silenced` and `Petrified` are also negative and also removable and are *not*
 * here, because their bits live in the second stat — so an ability that only
 * ever fires for one of those would never fire. That is the honest failure: it
 * does nothing rather than firing on a bit it read from the wrong word.
 */
export const NEGATIVE_CONDITIONS =
  conditionBitLow(ConditionEffect.Quiet) |
  conditionBitLow(ConditionEffect.Weak) |
  conditionBitLow(ConditionEffect.Slowed) |
  conditionBitLow(ConditionEffect.Sick) |
  conditionBitLow(ConditionEffect.Dazed) |
  conditionBitLow(ConditionEffect.Stunned) |
  conditionBitLow(ConditionEffect.Blind) |
  conditionBitLow(ConditionEffect.Hallucinating) |
  conditionBitLow(ConditionEffect.Drunk) |
  conditionBitLow(ConditionEffect.Confused) |
  conditionBitLow(ConditionEffect.Paralyzed) |
  conditionBitLow(ConditionEffect.Bleeding) |
  conditionBitLow(ConditionEffect.ArmorBroken) |
  conditionBitLow(ConditionEffect.Hexed) |
  conditionBitLow(ConditionEffect.Unstable) |
  conditionBitLow(ConditionEffect.Darkness);

/**
 * What one `<Activate>` gives the character, or `undefined` for one that gives
 * it nothing worth firing for.
 *
 * @param effect The element's text — `Heal`, `ConditionEffectAura`, `Shoot`.
 * @param activation The element itself, for the effects that name what they do
 *   in an attribute rather than in their own text.
 */
export function benefitOf(effect: string, activation: string): AbilityBenefit | undefined {
  const direct = DIRECT_BENEFITS.get(effect);
  if (direct !== undefined) return direct;

  if (effect === 'ConditionEffectSelf' || effect === 'ConditionEffectAura') {
    return CONDITION_BENEFITS.get(attribute(activation, 'effect') ?? '');
  }

  // The one effect that states who it is pointed at, which is what makes a
  // knight's helm an offensive ability rather than a buff that never lands: it
  // stuns, and it stuns whatever else is standing there.
  if (effect === 'GenericActivate') {
    if (attribute(activation, 'target') === 'enemy') {
      return { kind: BenefitKind.Offence, conditionBit: 0 };
    }
    return CONDITION_BENEFITS.get(attribute(activation, 'effect') ?? '');
  }

  if (effect === 'StatBoostSelf' || effect === 'StatBoostAura') {
    const kind = STAT_BENEFITS.get(attribute(activation, 'stat')?.trim().toUpperCase() ?? '');
    return kind === undefined ? undefined : { kind, conditionBit: 0 };
  }

  return undefined;
}
