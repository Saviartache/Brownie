/**
 * The three ready-made settings, and nothing about how they are applied.
 *
 * **Twenty-odd numbers is not a feature, it is homework.** Every one of them
 * earns its place — the planner's behaviour genuinely turns on all of them —
 * but almost nobody wants to answer twenty questions to switch a dodge on, and
 * the ones that matter most are not the ones with the most interesting names.
 * A preset answers the only question a person actually has: how hard should it
 * try, and how much should it interfere.
 *
 * **A preset owns the numbers that say "how cautious", and nothing else.** How
 * long a command lives, how much of the character's speed to use, how far off a
 * wall to plan, whether to mind the monsters at all — those are properties of a
 * machine, a connection or a preference, and a preset that quietly rewrote them
 * would be a preset that undoes somebody's setup every time they try another
 * one. What is here is the set that trades reacting early and leaving margin
 * against being left alone, plus the three that decide how hard the planner
 * thinks, because thinking harder is what makes the cautious end affordable.
 *
 * Each preset is a **full** assignment of the numbers it owns, so switching
 * between them can never leave a leftover from the previous one behind. They
 * are applied by writing them into the settings rather than by standing in
 * front of them: the advanced sliders then show what is actually in use, and
 * moving one is what turns the label into Custom. See `dodgePlugin`.
 */

/** The numbers a preset assigns. Every one is also a setting of its own. */
export interface DodgeTuning {
  /** How far ahead courses are compared. */
  readonly horizonMs: number;
  /** How soon trouble has to be to be this moment's problem. */
  readonly reactWithinMs: number;
  /** And how near, which is the half a clock cannot answer. */
  readonly reactWithinTiles: number;
  /** How finely shots are predicted. */
  readonly sampleStepMs: number;
  /** How many directions are considered. */
  readonly headings: number;
  /** When trouble is close enough to overrule the player firmly. */
  readonly urgentWithinMs: number;
  /** How much bigger than life every shot is treated as. */
  readonly hitScale: number;
  /** A flat margin on top of that. */
  readonly padTiles: number;
  /** How fast a far-ahead prediction stops being believed. */
  readonly driftTilesPerSecond: number;
  /** How much room counts as comfortable. */
  readonly safeClearanceTiles: number;
  /** How much space to keep between the character and a monster. */
  readonly keepAwayTiles: number;
}

export const DodgePresetId = {
  /** Steps in late and gives the wheel back early. */
  Relaxed: 'relaxed',
  /** What the planner was tuned and measured at. */
  Balanced: 'balanced',
  /** Wide margins, early reactions, more thinking per plan. */
  Cautious: 'cautious',
} as const;

export type DodgePresetId = (typeof DodgePresetId)[keyof typeof DodgePresetId];

/** `custom` is the user's own mix — choosing it applies nothing. */
export type DodgePresetChoice = DodgePresetId | 'custom';

export const DODGE_PRESETS: Readonly<Record<DodgePresetId, DodgeTuning>> = {
  relaxed: {
    horizonMs: 900,
    reactWithinMs: 300,
    reactWithinTiles: 4.5,
    sampleStepMs: 70,
    headings: 12,
    urgentWithinMs: 130,
    hitScale: 0.95,
    padTiles: 0.05,
    driftTilesPerSecond: 0.2,
    safeClearanceTiles: 0.05,
    keepAwayTiles: 1.5,
  },
  balanced: {
    horizonMs: 1000,
    reactWithinMs: 420,
    reactWithinTiles: 6,
    sampleStepMs: 60,
    headings: 16,
    urgentWithinMs: 160,
    hitScale: 1,
    padTiles: 0.1,
    driftTilesPerSecond: 0.2,
    safeClearanceTiles: 0.08,
    keepAwayTiles: 2,
  },
  cautious: {
    horizonMs: 1200,
    reactWithinMs: 560,
    reactWithinTiles: 8,
    sampleStepMs: 50,
    headings: 20,
    urgentWithinMs: 200,
    hitScale: 1.15,
    padTiles: 0.2,
    driftTilesPerSecond: 0.25,
    safeClearanceTiles: 0.14,
    keepAwayTiles: 2.5,
  },
};

const TUNING_KEYS = Object.keys(DODGE_PRESETS.balanced) as readonly (keyof DodgeTuning)[];

/**
 * How near two of these numbers have to be to count as the same one.
 *
 * They make a round trip through the overlay as decimal text — a slider snaps
 * to its step, the module prints six significant figures, the runtime parses
 * them back — and asking for bit-exact equality after that would have a preset
 * declare itself Custom because a tenth came back as 0.100000001.
 */
const SAME_TO = 1e-6;

/** Whether the current mix is still the one the preset label claims it is. */
export function presetMatches(current: DodgeTuning, preset: DodgeTuning): boolean {
  return TUNING_KEYS.every((key) => Math.abs(current[key] - preset[key]) <= SAME_TO);
}
