/**
 * Which hits Oryx's Sanctuary punishes, and when.
 *
 * Three of the Sanctuary's mechanics turn a landed shot into a penalty instead
 * of damage. Bullet collision is the *client's* call — it decides a shot hit
 * and says so with `ENEMYHIT` — so declining one is a matter of not sending the
 * report, and the whole of this feature is knowing which reports those are.
 *
 * Each rule is a fact about one object type plus one piece of state the world
 * model already holds, which is why this file is a table and a decision over
 * it. Nothing here tracks an entity and nothing here reads a packet: the state
 * stage has already applied every `UPDATE` and `NEWTICK` by the time a plugin
 * sees anything, so re-scanning them to learn an object id would be the same
 * work done twice.
 *
 * ## The object types, read out of `game-data/objects.xml`
 *
 * | type | `objects.xml` id | shown as |
 * |---|---|---|
 * | 45363 (`0xb133`) | `Oryx the Mad God 3` | the boss himself |
 * | 8701–8703 (`0x21fd`–`0x21ff`) | `Treasure Shuffle 1`–`3` | `Treasure Artifact` |
 * | 9635 (`0x25a3`) | `O3C Boss` | `Chancellor Dammah` |
 *
 * ## The guard, and why it is matched as a sentinel rather than a flag
 *
 * Oryx's guard is **not** a condition effect: nothing in the condition bitmask
 * an {@link EntityView} carries says it is up. It is stat {@link ANIMATION_STAT},
 * which while he is guarded holds one of two fixed values — one for the fight,
 * one for its exalted form. Both the tool this behaviour was taken from and
 * RealmShark read it that way, independently.
 *
 * This repository's `stat-types.json` names id 125 `ExaltedSpeed`, which
 * disagrees; the two tables were built at different times and one of them is
 * stale. Matching the two sentinels, rather than testing the stat for
 * "non-zero", is what makes leaving that unresolved safe: an exalt stat holds a
 * single digit, so a wrong id here can only ever mean this never fires — never
 * that it fires on something else. `/o3` prints the raw value, which is what
 * settles the question from a live fight rather than from a table.
 *
 * ## Dammah's monologue
 *
 * The chancellor announces himself, and interrupting him is what provokes the
 * counter. The only statement of that phase on the wire is the chat line, so
 * "he is speaking" means *he last said one of these*, and it ends when he says
 * anything else. That makes it exactly as current as his next line, which is
 * why the plugin also drops it on a map change.
 */

import type { EntityView } from '@brownie/plugin-api';

export const ORYX_THE_MAD_GOD_3 = 45363;
export const CHANCELLOR_DAMMAH = 9635;

/** The three artifacts of the treasure shuffle. */
export const TREASURE_ARTIFACTS: ReadonlySet<number> = new Set([8701, 8702, 8703]);

/** Stat id carrying the animation an entity is playing. See the note above. */
export const ANIMATION_STAT = 125;

/** The animation values Oryx plays while guarded — ordinary, then exalted. */
export const ORYX_GUARD_ANIMATIONS: ReadonlySet<number> = new Set([-935464302, -918686683]);

/**
 * The chat name the chancellor speaks under.
 *
 * The leading `#` is how this game marks a line as spoken by something that is
 * not a player, and no player name can contain one.
 */
export const DAMMAH_SPEAKER = '#Chancellor Dammah';

/** The lines during which hitting him is punished. */
export const DAMMAH_MONOLOGUE: ReadonlySet<string> = new Set([
  'Greetings, dogged peons! I am Dammah, and I shall be your unmaker!',
  'Ahem... Your uprising ends here. Lay down your feeble weapons and accept death.',
  'Do NOT interrupt me, impatient ones!',
  'I SAID DO NOT INTERRUPT ME! For this I shall hasten your end!',
  'No more! A steep price is to be paid for this brazen insolence in the face of my own grandeur!',
]);

/** What a hit would provoke. Named, so a count of them says which mechanic. */
export const Punishment = {
  OryxGuard: 'oryx-guard',
  TreasureShuffle: 'treasure-shuffle',
  DammahMonologue: 'dammah-monologue',
} as const;

export type Punishment = (typeof Punishment)[keyof typeof Punishment];

/** Which rules are switched on. One flag per mechanic, and they are unrelated. */
export interface PunishedHitRules {
  readonly oryxGuard: boolean;
  readonly treasureShuffle: boolean;
  readonly dammahMonologue: boolean;
}

/**
 * What hitting this target right now would provoke, or `undefined` for a hit
 * worth reporting.
 *
 * The three rules are independent, which is a correction rather than a port: in
 * the implementation this came from, the treasure branch returned before the
 * chancellor was ever considered, so switching the shuffle on quietly switched
 * the monologue off.
 */
export function punishmentFor(
  target: EntityView,
  dammahSpeaking: boolean,
  rules: PunishedHitRules,
): Punishment | undefined {
  switch (target.objectType) {
    case ORYX_THE_MAD_GOD_3: {
      if (!rules.oryxGuard) return undefined;
      const animation = target.stat(ANIMATION_STAT);
      if (animation === undefined || !ORYX_GUARD_ANIMATIONS.has(animation)) return undefined;
      return Punishment.OryxGuard;
    }
    case CHANCELLOR_DAMMAH:
      if (!rules.dammahMonologue || !dammahSpeaking) return undefined;
      return Punishment.DammahMonologue;
    default:
      if (!rules.treasureShuffle || !TREASURE_ARTIFACTS.has(target.objectType)) return undefined;
      return Punishment.TreasureShuffle;
  }
}
