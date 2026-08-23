/**
 * Whether firing the ability right now would accomplish anything, and what for.
 *
 * **The question the reference implementation never asked.** It fired the
 * ability slot on a fixed interval for as long as mana allowed, which for a
 * priest means a tome every 2.5 seconds at full health, in an empty hallway,
 * for the whole walk to the dungeon — a heal thrown away and the mana that
 * would have paid for the next real one with it.
 *
 * An ability gives specific things (`gamedata/abilityEffects.ts` reads them out
 * of the file) and each of them is worth having only under a specific
 * condition: health while health is missing, a berserk aura while something is
 * there to shoot, a cleanse while something is actually wrong. One benefit
 * being wanted is enough — a tome that heals *and* clears debuffs is worth
 * casting for either.
 *
 * **An aimed effect is not one of them, and that is the subtle part.** Several
 * support abilities carry an attack as a rider: `pD Tome` heals, puts up a
 * healing aura *and* fires a shot; `Tome of Holy Guidance` heals and drops a
 * damage nova. Letting that rider decide is how a 180-mana heal ends up going
 * off every 700 ms for as long as anything is on screen, which is exactly what
 * it did. Being aimed says *where* the cast is pointed; what the ability gives
 * says *whether* to cast at all.
 *
 * **An ability that gives nothing nameable has no answer here, and that is the
 * right answer.** A quiver, a spell, a trap and a scepter are worth firing when
 * the player says so and not when a monster walks into range, so nothing
 * decides that for them — see `autoAbilityPlugin.ts`, which points those where
 * the shots are going and leaves the key press to the player.
 *
 * Pure, and separate from the plugin, because this is the part that is either
 * right or wrong: everything around it is packets and settings.
 */

import {
  BenefitKind,
  NEGATIVE_CONDITIONS,
  type AbilityBenefit,
} from '../../gamedata/abilityEffects.js';

/** The character, as this decision sees it. */
export interface CastMoment {
  /** Health as a share of the bar, 0–100. */
  readonly hpPercent: number;
  /** Mana as a share of the bar, 0–100. */
  readonly mpPercent: number;
  /** The first condition stat — what is currently on the character. */
  readonly conditions: number;
  /**
   * Whether there is anything in range worth using an ability on.
   *
   * A function because answering costs a pass over every visible enemy, and
   * most of what is asked here does not need the answer: a priest walking with
   * a full health bar is turned down by the health rule alone, and a realm has
   * several hundred entities in it. Expected to be cheap on the second call.
   */
  enemyNear(): boolean;
}

/**
 * The three decisions that are the player's rather than the data file's.
 *
 * Everything else here is a fact: an offensive aura needs something to be
 * offensive at, and no setting changes that. These three are genuinely a
 * preference — where "hurt enough to spend an ability on" sits, and whether a
 * buff is worth mana with nothing to fight.
 */
export interface CastPreferences {
  /** Cast a healing ability at or below this share of the health bar. */
  readonly hpPercent: number;
  /** Cast a mana ability at or below this share of the mana bar. */
  readonly mpPercent: number;
  /**
   * Whether speed and stealth are worth mana with nothing to fight.
   *
   * A warrior's helm grants a berserk aura *and* a speed boost, so with this on
   * it is renewed for the whole walk across the realm — which some players want
   * and most would call the ability firing for no reason. Off, the speed comes
   * back the moment there is something to run past.
   */
  readonly utilityOutOfCombat: boolean;
}

/**
 * Which benefit makes casting worth it now, or `undefined` for nothing.
 *
 * Named rather than reduced to a boolean because the rules here overlap: a tome
 * that heals and cleanses passes for two different reasons, and a test that can
 * only see "yes" cannot tell a heal that fired for the cleanse rule from one
 * that fired for the right one. Costs nothing — the loop already has it in hand.
 *
 * @param benefits What the ability gives. Empty is an ability whose effects this
 *   build cannot name — every attack ability in the game, and anything built
 *   out of an effect this build has not learned — and nothing here is a reason
 *   to fire one.
 */
export function castReason(
  benefits: readonly AbilityBenefit[],
  moment: CastMoment,
  preferences: CastPreferences,
): BenefitKind | undefined {
  for (const benefit of benefits) {
    // Already on the character. This is exact where a duration is a guess — the
    // server states the bit, and wisdom stretches every duration in the file by
    // an amount nothing here models.
    if (benefit.conditionBit !== 0 && (moment.conditions & benefit.conditionBit) !== 0) continue;
    if (wantedFor(benefit.kind, moment, preferences)) return benefit.kind;
  }
  return undefined;
}

function wantedFor(kind: BenefitKind, moment: CastMoment, preferences: CastPreferences): boolean {
  switch (kind) {
    case BenefitKind.Health:
      return moment.hpPercent <= preferences.hpPercent;
    case BenefitKind.Mana:
      return moment.mpPercent <= preferences.mpPercent;
    // Both need something to be aimed at or defended against, and neither can
    // find out for itself: an aura hits whatever is standing in it, and armour
    // matters only while something is hitting back.
    case BenefitKind.Offence:
    case BenefitKind.Defence:
      return moment.enemyNear();
    // Speed, sight, stealth — the one kind that is worth something with nothing
    // around, and therefore the one the player has to have a say in.
    case BenefitKind.Utility:
      return preferences.utilityOutOfCombat || moment.enemyNear();
    case BenefitKind.Cleanse:
      return (moment.conditions & NEGATIVE_CONDITIONS) !== 0;
  }
}

/** A share of a bar, or 100 for a bar the server has not stated. */
export function percentOf(current: number, maximum: number): number {
  if (maximum <= 0) return 100;
  return (current / maximum) * 100;
}
