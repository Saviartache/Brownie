/**
 * How bad each of the game's conditions is to be hit by.
 *
 * **A hit that carries a condition is not a bigger hit, it is a different kind
 * of event**, and anything ranking shots has to be able to say so. Paralysed is
 * not eight hundred damage — it is every shot for the next three seconds landing
 * unopposed, because the character cannot move. The fights that kill people
 * begin with one of these, not with the shot that carried it.
 *
 * **Scored from a dodger's point of view, which is why the ordering is not the
 * game's own.** What matters here is what a condition does to the ability to
 * *keep dodging*: being unable to move is total, being slowed is most of the
 * way there, being unable to fire back is a fight that takes longer rather than
 * one that is lost. Something reading this to decide whether to drink a potion
 * would want a different table, and should have one.
 *
 * **The names are the ones `objects.xml` writes**, spaces and all, because that
 * is what a `<ConditionEffect>` element contains and translating them into the
 * bit indices in `constants/ConditionEffect.ts` first would be a second table to
 * keep in step for no gain — nothing here needs the bit, only the name.
 *
 * **Everything absent is nought, and that covers the common case.** Three
 * effects appear on nearly every projectile in the game — `In Combat`,
 * `Invulnerable` and `Invincible` — and all three are applied to the monster
 * that fired rather than to whoever it hits. Scoring those would make every shot
 * in the game a condition shot, which is the same as scoring none of them.
 */

/**
 * From nought for "nothing a dodger cares about" to one for "cannot move".
 *
 * The gaps are deliberate rather than a ranking: `TrajectoryScore` multiplies
 * this by one weight, so the difference between two entries is the whole of what
 * the planner will trade between them.
 */
const SEVERITY: Readonly<Record<string, number>> = {
  // Cannot move at all. Everything already in the air lands, and so does
  // everything fired while it runs.
  Paralyzed: 1,
  Petrify: 1,
  // Frozen in place. Untargetable is no comfort to a character standing in a
  // volley that was already fired.
  Stasis: 0.9,
  // **Movement inverted, which is worse for a planner than for a person.** Every
  // command this feature issues is a direction, and under Confused the character
  // goes the other way — so a dodge becomes a step *into* whatever it was
  // avoiding.
  Confused: 0.85,
  // Half speed. The trajectories the optimizer can reach shrink by half with it,
  // which is most of the way to not being able to dodge.
  Slowed: 0.7,
  // A chicken: no attack, and slower.
  Hexed: 0.7,
  // Cannot attack. The fight lasts longer, which is more shots to dodge.
  Stunned: 0.5,
  Silenced: 0.45,
  // No abilities, which is also no escape.
  Quiet: 0.45,
  // Damage over time, and it does not stop for anything the planner can do.
  Bleeding: 0.4,
  'Armor Broken': 0.4,
  Exposed: 0.35,
  // No healing while it runs, which turns a survivable fight into an attrition.
  Sick: 0.35,
  Curse: 0.3,
  Drought: 0.3,
  // Moved at random, which undoes a chosen displacement.
  Unstable: 0.3,
  Weak: 0.2,
  Dazed: 0.2,
  Darkness: 0.15,
  Blind: 0.15,
  Drunk: 0.15,
} as const;

/**
 * How bad the worst condition a shot carries is, from nought to one.
 *
 * The worst rather than the sum: a shot carrying paralyse and bleed is a
 * paralyse, and adding them would make two mild conditions outrank it.
 */
export function debuffSeverityOf(effects: readonly string[]): number {
  let worst = 0;
  for (const effect of effects) {
    const severity = SEVERITY[effect] ?? 0;
    if (severity > worst) worst = severity;
  }
  return worst;
}
