/**
 * The three ready-made settings, and nothing about how they are applied.
 *
 * **A dozen numbers is not a feature, it is homework.** Every one of them earns
 * its place — the planner's behaviour genuinely turns on all of them — but
 * almost nobody wants to answer twelve questions to switch a dodge on, and the
 * ones that matter most are not the ones with the most interesting names. A
 * preset answers the only question a person actually has: how hard should it
 * try, and how much should it interfere.
 *
 * **A preset owns the numbers that say "how cautious", and nothing else.** How
 * long a command lives, how much of the character's speed to use, how far off a
 * wall to plan, whether the hop is allowed at all — those are properties of a
 * machine, a connection or a preference, and a preset that quietly rewrote them
 * would be a preset that undoes somebody's setup every time they try another
 * one.
 *
 * **Two of them are about how hard it thinks, and that is new.** The planner is
 * a search now, so how far ahead it looks, how finely it steps and how much
 * slack it allows itself are the levers that buy the cautious end its accuracy —
 * where the previous generation bought the same thing with a wider hitbox. They
 * belong to the preset for exactly that reason: thinking harder is what makes
 * caution affordable rather than merely twitchy.
 *
 * Each preset is a **full** assignment of the numbers it owns, so switching
 * between them can never leave a leftover from the previous one behind. They are
 * applied by writing them into the settings rather than by standing in front of
 * them: the advanced sliders then show what is actually in use, and moving one
 * is what turns the label into Custom. See `dodgeControls`.
 */

/** The numbers a preset assigns. Every one is also a setting of its own. */
export interface DodgeTuning {
  /** How far ahead routes are searched. */
  readonly horizonMs: number;
  /** How long one step of the search's lattice lasts. */
  readonly tickMs: number;
  /** How soon trouble has to be to be this moment's problem. */
  readonly reactWithinMs: number;
  /** How many directions the search considers. */
  readonly headings: number;
  /** How much bigger than life every shot is treated as. */
  readonly hitScale: number;
  /** A flat margin on top of that. */
  readonly padTiles: number;
  /** How fast a far-ahead prediction stops being believed. */
  readonly driftTilesPerSecond: number;
  /** How much room counts as comfortable. */
  readonly safeClearanceTiles: number;
  /** How hard it tries to give the player their own ground back. */
  readonly holdGroundWeight: number;
  /** How much slack the search allows itself, as a multiplier. */
  readonly greed: number;
  /** The most nodes one plan may expand. */
  readonly maxExpansions: number;
  /** How much space to keep between the character and a monster. */
  readonly keepAwayTiles: number;
}

export const DodgePresetId = {
  /** Steps in late, gives the wheel back early, and thinks less about it. */
  Relaxed: 'relaxed',
  /** What the planner was tuned and measured at. */
  Balanced: 'balanced',
  /** Wide margins, early reactions, a finer lattice and more of it. */
  Cautious: 'cautious',
} as const;

export type DodgePresetId = (typeof DodgePresetId)[keyof typeof DodgePresetId];

/** `custom` is the user's own mix — choosing it applies nothing. */
export type DodgePresetChoice = DodgePresetId | 'custom';

export const DODGE_PRESETS: Readonly<Record<DodgePresetId, DodgeTuning>> = {
  relaxed: {
    horizonMs: 800,
    tickMs: 110,
    reactWithinMs: 300,
    headings: 8,
    hitScale: 0.95,
    padTiles: 0.05,
    driftTilesPerSecond: 0.15,
    safeClearanceTiles: 0.18,
    // The highest of the three, because holding their ground is what "leave me
    // alone" comes to — but still far under the room a shot needs, for the
    // reason every preset shares. See `DodgeSettings.holdGroundWeight`.
    holdGroundWeight: 0.3,
    greed: 2,
    maxExpansions: 300,
    keepAwayTiles: 2,
  },
  balanced: {
    horizonMs: 900,
    tickMs: 100,
    reactWithinMs: 420,
    headings: 12,
    hitScale: 1,
    padTiles: 0.1,
    driftTilesPerSecond: 0.2,
    safeClearanceTiles: 0.25,
    holdGroundWeight: 0.25,
    greed: 1.6,
    maxExpansions: 400,
    keepAwayTiles: 2.5,
  },
  cautious: {
    horizonMs: 1000,
    tickMs: 100,
    reactWithinMs: 560,
    headings: 12,
    hitScale: 1.1,
    padTiles: 0.16,
    driftTilesPerSecond: 0.3,
    safeClearanceTiles: 0.35,
    holdGroundWeight: 0.15,
    greed: 1.4,
    // **Measured, not chosen.** A screen with six ranks of fire on it is what
    // spends a budget, and this is what keeps that plan inside a few
    // milliseconds — which at fifty plans a second is the difference between a
    // few per cent of a core and a third of one.
    maxExpansions: 500,
    keepAwayTiles: 3,
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
