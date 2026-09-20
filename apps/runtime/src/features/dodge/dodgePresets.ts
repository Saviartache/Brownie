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
 * wall to plan — those are properties of a
 * machine, a connection or a preference, and a preset that quietly rewrote them
 * would be a preset that undoes somebody's setup every time they try another
 * one.
 *
 * **Two of them are about how hard it thinks.** The planner rolls futures
 * forward now, so how far ahead it looks, how finely it slices that and how many
 * candidates it may try are the levers that buy the cautious end its accuracy —
 * where an older generation bought the same thing with a wider hitbox. They
 * belong to the preset for exactly that reason: thinking harder is what makes
 * both caution and precision affordable rather than merely twitchy.
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
  /** How long one tick of the planner's horizon lasts. */
  readonly tickMs: number;
  /** How soon trouble has to be to be this moment's problem. */
  readonly reactWithinMs: number;
  /** How many directions the optimizer considers. */
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
  /** How far off that ground the character can still fight from. */
  readonly dpsRadiusTiles: number;
  /** The most futures one plan may roll out. */
  readonly budget: number;
  /** How much space to keep between the character and a monster. */
  readonly keepAwayTiles: number;
}

export const DodgePresetId = {
  /** Steps in late, gives the wheel back early, and thinks less about it. */
  Relaxed: 'relaxed',
  /** What the planner was tuned and measured at. */
  Balanced: 'balanced',
  /** Wide margins, early reactions, a finer horizon and more futures in it. */
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
    // alone" comes to. Safe to ask for now that the pull cannot be spent on a
    // tight step at all — see `DodgeSettings.holdGroundWeight`.
    holdGroundWeight: 0.4,
    // The widest of the three, because "leave me alone" also means "do not
    // fuss about a tenth of a tile".
    dpsRadiusTiles: 0.35,
    budget: 140,
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
    holdGroundWeight: 0.35,
    dpsRadiusTiles: 0.2,
    budget: 200,
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
    // **The lowest of the three and no longer by much.** Its wide margins are
    // what a step is measured against before the pull is credited at all, so
    // this is the preset the pull costs least: measured across four fights and
    // five firing phases, doubling it changed its hits not at all.
    holdGroundWeight: 0.3,
    // **The tightest ring of the three, and it is not caution — it is the
    // point.** Thinking harder is what makes a tenth of a tile a real answer
    // instead of a rounding, so the preset that thinks hardest is the one that
    // can afford to insist on staying put.
    dpsRadiusTiles: 0.12,
    // **Measured, not chosen.** A screen with six ranks of fire on it is what
    // spends a budget, and this is what keeps that plan inside a few
    // milliseconds — which at fifty plans a second is the difference between a
    // few per cent of a core and a third of one.
    budget: 280,
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
