/**
 * Every question the dodge asks, and the one it asks first.
 *
 * **One question on the panel, and everything else under Advanced.** The planner
 * genuinely turns on all twenty-odd of its numbers and every one of them has a
 * reason, but a feature that asks twenty questions before it will switch on is a
 * feature nobody switches on. A preset answers the one question a person
 * actually has — how hard should it try — by writing the twelve numbers that
 * trade caution against interference; the rest belong to the machine and the
 * connection and are left alone. Moving one by hand is what turns the label into
 * Custom, so it never claims a preset the numbers are not.
 *
 * **Here rather than in the plugin** because it is the largest single thing the
 * feature does and none of the rest of it is about panels: what the planner does
 * with the numbers is `DodgePlanner`, how the fight is assembled is `DodgeScene`,
 * and the plugin is what puts the two together. See `dodgePresets` for which
 * numbers a preset owns and why the others are not its business.
 */

import type { PluginContext, SessionView, SettingHandle } from '@brownie/plugin-api';
import type { DodgeSettings } from './DodgePlanner.js';
import { MAX_HOP_TILES } from './Hop.js';
import {
  DODGE_PRESETS,
  DodgePresetId,
  presetMatches,
  type DodgePresetChoice,
  type DodgeTuning,
} from './dodgePresets.js';

/** The twelve a preset owns, as handles. See {@link DodgeTuning}. */
export type DodgeTuningHandles = {
  readonly [K in keyof DodgeTuning]: SettingHandle<number>;
};

/** Everything the feature can be told, grouped by what it is about. */
export interface DodgeControls {
  readonly preset: SettingHandle<DodgePresetChoice>;
  readonly tuning: DodgeTuningHandles;
  /** How long before a plan takes effect. A property of the link, not a style. */
  readonly leadMs: SettingHandle<number>;
  readonly walls: {
    readonly avoid: SettingHandle<boolean>;
    readonly clearanceTiles: SettingHandle<number>;
  };
  readonly hazards: {
    readonly avoid: SettingHandle<boolean>;
    readonly clearanceTiles: SettingHandle<number>;
  };
  readonly avoidBlasts: SettingHandle<boolean>;
  readonly spacing: {
    readonly mindMonsters: SettingHandle<boolean>;
  };
  readonly hop: {
    readonly enabled: SettingHandle<boolean>;
    readonly tiles: SettingHandle<number>;
    readonly cooldownMs: SettingHandle<number>;
  };
  readonly driving: {
    readonly respectIntent: SettingHandle<boolean>;
    readonly interceptControl: SettingHandle<boolean>;
    readonly speedPercent: SettingHandle<number>;
    readonly holdMs: SettingHandle<number>;
    readonly cursorWalk: SettingHandle<boolean>;
  };
}

/** What the planner is tuned to right now. */
export function planningSettings(controls: DodgeControls): DodgeSettings {
  const tuning = controls.tuning;
  return {
    horizonMs: tuning.horizonMs.get(),
    tickMs: tuning.tickMs.get(),
    reactWithinMs: tuning.reactWithinMs.get(),
    headings: tuning.headings.get(),
    hitScale: tuning.hitScale.get(),
    padTiles: tuning.padTiles.get(),
    leadMs: controls.leadMs.get(),
    driftTilesPerSecond: tuning.driftTilesPerSecond.get(),
    safeClearanceTiles: tuning.safeClearanceTiles.get(),
    // Nought when the whole idea is switched off, so the search stops preferring
    // a distance nobody asked it to keep. Withdrawing the *refusal* to walk in
    // is the scene's, and it does that with the same switch.
    hazardClearTiles: controls.hazards.avoid.get() ? controls.hazards.clearanceTiles.get() : 0,
    holdGroundWeight: tuning.holdGroundWeight.get(),
    greed: tuning.greed.get(),
    maxExpansions: tuning.maxExpansions.get(),
    hopEnabled: controls.hop.enabled.get(),
    hopTiles: controls.hop.tiles.get(),
    hopCooldownMs: controls.hop.cooldownMs.get(),
  };
}

/**
 * How fast this character may be told to walk.
 *
 * **Derived from the speed stat the server sent, not measured.** Measuring it
 * from ground covered feeds this system's own output back into its input: an
 * overestimate lengthens the next step, which covers more ground, which raises
 * the estimate. Two attempts at damping that ended with a character outside the
 * map. A stat is a number nothing here influences, which is the property that
 * fixes it.
 *
 * Held a little under the full figure, because what the formula gives is the
 * *limit* the server will accept, with nothing left over for latency or for the
 * rounding in every step along the way.
 */
export function walkSpeedOf(session: SessionView, controls: DodgeControls): number {
  return (session.self.walkSpeedTilesPerSecond * controls.driving.speedPercent.get()) / 100;
}

export function declareDodgeControls(context: PluginContext): DodgeControls {
  const settings = context.settings;

  // **The only control most people should ever touch.** Registered first
  // because that is the order the overlay draws in.
  const preset = settings.select<DodgePresetChoice>('preset', {
    group: 'Preset',
    label: 'How hard it tries',
    default: DodgePresetId.Balanced,
    options: [
      [DodgePresetId.Relaxed, 'Relaxed — steps in late, leaves your walking alone'],
      [DodgePresetId.Balanced, 'Balanced — what it was tuned at'],
      [DodgePresetId.Cautious, 'Cautious — wide margins, takes the wheel sooner'],
      ['custom', 'Custom (your own numbers)'],
    ],
  });

  // ── What the preset writes ──────────────────────────────────────────────
  //
  // The twelve below are a preset's whole assignment: how soon trouble has to
  // be, how much margin to leave around it, how hard to hold the player's own
  // ground, and how hard to think about the answer. Moving any of them by hand
  // is what turns the label above into Custom.

  // **Long enough that running away stops looking clever.** A shot travels
  // faster than a character, so fleeing along its own line always survives a
  // *short* window — and a planner whose horizon is short therefore prefers the
  // backpedal that gets it cornered over the sidestep that ends the problem. At
  // nearly a second the arithmetic already shows the flight failing, which is
  // why nothing here needs a term against retreat.
  const horizonMs = settings.range('horizonMs', {
    label: 'Look ahead (ms)',
    group: 'Reaction',
    advanced: true,
    default: 900,
    min: 300,
    max: 2000,
    step: 50,
  });
  // **The lattice, and the biggest single lever on what a plan costs.** One tick
  // is one step of walking, so it is also the smallest movement the planner can
  // describe — about seven tenths of a tile at an ordinary speed, which is a
  // bullet's width plus the player's. Halving it doubles both the depth needed
  // to see the same distance and the work at every level of it.
  const tickMs = settings.range('tickMs', {
    label: 'Planning step (ms)',
    group: 'Reaction',
    advanced: true,
    default: 100,
    min: 50,
    max: 200,
    step: 10,
  });
  // **The knob that decides whether this is help or a leash.** Looking a second
  // ahead is what tells a real escape from a postponement; *acting* on
  // everything a second away is what stops the player walking up to anything
  // that is shooting, because a shot across the room will reach them eventually
  // and "eventually" was being treated as "now".
  const reactWithinMs = settings.range('reactWithinMs', {
    label: 'Only act on trouble within (ms)',
    group: 'Reaction',
    advanced: true,
    default: 420,
    min: 100,
    max: 1200,
    step: 20,
  });
  // Each direction is a branch at every level of the search, so this is the
  // other big lever on cost. Twelve is a thirty-degree ring, which is finer than
  // the width of a gap at the distance a gap is away.
  const headings = settings.range('headings', {
    label: 'Directions considered',
    group: 'Reaction',
    advanced: true,
    default: 12,
    min: 8,
    max: 32,
    step: 4,
  });

  const hitScale = settings.range('hitScale', {
    label: 'Caution (hit size)',
    group: 'Safety',
    advanced: true,
    default: 1,
    min: 0.5,
    max: 2,
    step: 0.05,
  });
  const padTiles = settings.range('latencyPadTiles', {
    label: 'Extra margin (tiles)',
    group: 'Safety',
    advanced: true,
    default: 0.1,
    min: 0,
    max: 1,
    step: 0.05,
  });
  // What `positionAt` does not model — turn rate and the client's own clock —
  // grows with how far ahead it is asked. This is the price of that, and it is
  // why the planner can be trusted tightly up close.
  const driftTilesPerSecond = settings.range('driftTilesPerSecond', {
    label: 'Distrust far predictions (tiles/s)',
    group: 'Safety',
    advanced: true,
    default: 0.2,
    min: 0,
    max: 1,
    step: 0.05,
  });
  // **A gradient, not a bar, which is what changed.** The search charges for
  // every tile of room a step is short of this, so it is no longer "the least
  // that counts as safe" but "the point at which more room stops being worth
  // walking for". Raising it makes the planner spread out; lowering it lets it
  // thread.
  const safeClearanceTiles = settings.range('safeClearanceTiles', {
    label: 'Room worth walking for (tiles)',
    group: 'Safety',
    advanced: true,
    default: 0.25,
    min: 0,
    max: 0.8,
    step: 0.01,
  });
  // **The number the whole feel of the feature is quoted against.** It is what a
  // route is charged, per tick, for each tile it sits away from where the player
  // meant to be — so raising it buys a tighter dodge that gives the ground back
  // sooner, and lowering it lets the planner walk further to be safer. Nothing
  // else in the cost model is on the panel, because everything else is a ratio
  // against this one.
  const holdGroundWeight = settings.range('holdGroundWeight', {
    label: 'Hold your ground',
    group: 'Control',
    advanced: true,
    default: 1,
    min: 0.2,
    max: 3,
    step: 0.1,
  });
  // **What the search is allowed to settle for.** One searches exactly and
  // slowest; above it the route is within this factor of the best one and is
  // found in a fraction of the expansions. A plan is remade fifty times a second
  // and thrown away before it is walked, so a little slack is nearly free.
  const greed = settings.range('greed', {
    label: 'Search slack (×)',
    group: 'Reaction',
    advanced: true,
    default: 1.6,
    min: 1,
    max: 3,
    step: 0.1,
  });
  // The backstop rather than a target: an ordinary plan settles in a fraction of
  // this, and what it bounds is the worst case — a screen full of fire with no
  // clean way through, which is exactly when a plan must still arrive on time.
  const maxExpansions = settings.range('maxExpansions', {
    label: 'Thinking budget (nodes)',
    group: 'Reaction',
    advanced: true,
    default: DODGE_PRESETS[DodgePresetId.Balanced].maxExpansions,
    min: 100,
    max: 2000,
    step: 50,
  });
  // **Room to dodge in, and the reason it is a distance rather than a hit
  // test.** A monster pressed against the player has already taken the space
  // every escape needs, so by the time contact damage says so there is nowhere
  // left to go. Stated from the middle of an ordinary, one-tile monster; what
  // actually holds is the gap it works out to, so a boss four tiles across is
  // kept four times as far off its centre and exactly as far off its edge.
  const keepAwayTiles = settings.range('keepAwayTiles', {
    label: 'Keep monsters at least (tiles)',
    group: 'Spacing',
    advanced: true,
    default: 2.5,
    min: 0,
    max: 6,
    step: 0.25,
  });

  // ── What is yours whatever the preset says ──────────────────────────────
  //
  // Latency, the character's own speed, how far off a wall to plan, and every
  // switch below: properties of a machine, a connection or a preference rather
  // than of how cautious the planner should be. A preset that rewrote these
  // would undo somebody's setup every time they tried another one.

  const leadMs = settings.range('leadMs', {
    label: 'Command lead (ms)',
    group: 'Reaction',
    advanced: true,
    default: 60,
    min: 0,
    max: 200,
    step: 10,
  });
  const avoidWalls = settings.boolean('avoidWalls', {
    label: 'Know where the walls are',
    group: 'Safety',
    advanced: true,
    default: true,
  });
  // **Room to spare, not room to fit.** A position where the body exactly fits
  // is legal and is where the game's own collision starts holding a character
  // against the geometry — so a dodge that plans to the last millimetre plans to
  // be stuck. This is how far off a wall the planner keeps; see where it is
  // applied for why it is dropped once the player is already inside it.
  const wallClearanceTiles = settings.range('wallClearanceTiles', {
    label: 'Keep clear of walls by (tiles)',
    group: 'Safety',
    advanced: true,
    default: 0.25,
    min: 0,
    max: 1.5,
    step: 0.05,
    visibleWhen: { key: 'avoidWalls', equals: [true] },
  });
  const avoidDamagingGround = settings.boolean('avoidDamagingGround', {
    label: 'Refuse to walk onto damaging ground',
    group: 'Safety',
    advanced: true,
    default: true,
  });
  // **Wider than the wall margin, and it is a harder rule as well.** Walking
  // into a wall costs a step; standing in lava costs health every tick and
  // leaves nothing to dodge with, so a step that would end inside this radius is
  // *refused* rather than charged for — there is no arrangement of shots for
  // which walking into a pool is the answer. What is left when the only way out
  // runs across one is the emergency step, which covers the same ground on a
  // single frame and lands on the far side; see `Hop`.
  //
  // The margin exists because the planner has no way to be sure where the
  // character will actually end up — the server has its own opinion, the command
  // lands a frame late — so a route planned to stop exactly at the edge is a
  // route that gets a toe in it.
  //
  // **Not dropped when the player is already inside it, unlike the wall's**, and
  // that difference is what the live report was about. The rule is a ratchet
  // rather than a fence: a step may never end nearer a pool than the better of
  // where the character already is and this distance. Somebody who has been
  // pushed inside can therefore still move — within the band, and outwards — so
  // it can never hold them in there, and it never quietly turns itself off the
  // moment it is most needed. The emergency step obeys the same rule, because a
  // hop is the easier way through a barrier.
  const hazardClearanceTiles = settings.range('hazardClearanceTiles', {
    label: 'Keep clear of lava and damaging ground by (tiles)',
    group: 'Safety',
    advanced: true,
    default: 0.5,
    min: 0,
    max: 2,
    step: 0.05,
    visibleWhen: { key: 'avoidDamagingGround', equals: [true] },
  });
  // **Thrown bombs, novas and telegraphed circles.** A different shape of danger
  // from a bullet — a disc that goes off at a moment rather than a point that
  // travels — and it is read from the telegraph the game sends before it lands,
  // because the packet that reports the blast itself arrives after the damage.
  // Its own switch because it rests on a packet body worked out rather than
  // stated — a mask byte and nine conditional fields, see `docs/protocol.md` —
  // so there is a way to turn it off if a patch moves it.
  const avoidBlasts = settings.boolean('avoidBlasts', {
    label: 'Dodge thrown bombs and area effects',
    group: 'Safety',
    advanced: true,
    default: true,
  });
  // **The master switch for the planner knowing where the monsters are.** Off,
  // it is a pure bullet-dodger: it will thread a perfect gap and finish standing
  // inside a boss.
  const mindMonsters = settings.boolean('avoidEnemyBodies', {
    label: 'Mind where the monsters are',
    group: 'Spacing',
    advanced: true,
    default: true,
  });

  // ── The emergency step ──────────────────────────────────────────────────
  //
  // A frame's worth of movement spent at once, for the shot that lands before a
  // step of walking finishes. Its own group because it is the one thing here
  // that is not a walk, and because the numbers that bound it are the module's
  // rather than a matter of taste — see `Hop.ts`.

  const hopEnabled = settings.boolean('hopEnabled', {
    label: 'Sidestep instantly when there is no time to walk',
    group: 'Emergency',
    default: true,
  });
  // Capped at what one frame may actually carry. Asking for more does not move
  // the character further — the module clamps it — it only makes the planner
  // choose a landing place nothing ever reaches.
  const hopTiles = settings.range('hopTiles', {
    label: 'Instant sidestep distance (tiles)',
    group: 'Emergency',
    advanced: true,
    default: MAX_HOP_TILES,
    min: 0.2,
    max: MAX_HOP_TILES,
    step: 0.05,
    visibleWhen: { key: 'hopEnabled', equals: [true] },
  });
  // **What stops it becoming a way of walking.** One frame at the limit is a
  // step the character could have taken; one every frame is a sprint, and the
  // server takes those back. Long enough that a burst is a burst.
  const hopCooldownMs = settings.range('hopCooldownMs', {
    label: 'And no sooner than every (ms)',
    group: 'Emergency',
    advanced: true,
    default: 400,
    min: 100,
    max: 2000,
    step: 50,
    visibleWhen: { key: 'hopEnabled', equals: [true] },
  });

  const respectIntent = settings.boolean('respectIntent', {
    label: 'Leave your own walking alone while it is safe',
    group: 'Control',
    advanced: true,
    default: true,
  });
  const interceptControl = settings.boolean('interceptControl', {
    label: 'Cancel your input while it has the wheel',
    group: 'Control',
    advanced: true,
    default: true,
  });
  const speedPercent = settings.range('speedPercent', {
    label: 'Walk at (% of full speed)',
    group: 'Control',
    advanced: true,
    default: 92,
    min: 50,
    max: 100,
    step: 2,
  });
  // How long a step stands if nothing replaces it. A few planning intervals, not
  // a server tick: everything past the next plan is time the player keeps
  // walking towards a decision already withdrawn.
  const holdMs = settings.range('holdMs', {
    label: 'Keep walking for (ms)',
    group: 'Control',
    advanced: true,
    default: 120,
    min: 50,
    max: 500,
    step: 10,
  });
  const cursorWalk = settings.boolean('cursorWalk', {
    label: 'Ctrl+middle-click walks to your cursor',
    group: 'Control',
    advanced: true,
    default: true,
  });

  const tuning: DodgeTuningHandles = {
    horizonMs,
    tickMs,
    reactWithinMs,
    headings,
    hitScale,
    padTiles,
    driftTilesPerSecond,
    safeClearanceTiles,
    holdGroundWeight,
    greed,
    maxExpansions,
    keepAwayTiles,
  };

  bindPreset(context, preset, tuning);

  return {
    preset,
    tuning,
    leadMs,
    walls: { avoid: avoidWalls, clearanceTiles: wallClearanceTiles },
    hazards: { avoid: avoidDamagingGround, clearanceTiles: hazardClearanceTiles },
    avoidBlasts,
    spacing: { mindMonsters },
    hop: { enabled: hopEnabled, tiles: hopTiles, cooldownMs: hopCooldownMs },
    driving: { respectIntent, interceptControl, speedPercent, holdMs, cursorWalk },
  };
}

/**
 * Keeps the label and the numbers telling the same story.
 *
 * Choosing a preset writes its twelve; moving any of the twelve by hand makes
 * the label Custom. The guard is what stops the first of the twelve writes
 * flipping the label and the remaining eleven landing on a preset nobody chose.
 */
function bindPreset(
  context: PluginContext,
  preset: SettingHandle<DodgePresetChoice>,
  tuning: DodgeTuningHandles,
): void {
  const readTuning = (): DodgeTuning => ({
    horizonMs: tuning.horizonMs.get(),
    tickMs: tuning.tickMs.get(),
    reactWithinMs: tuning.reactWithinMs.get(),
    headings: tuning.headings.get(),
    hitScale: tuning.hitScale.get(),
    padTiles: tuning.padTiles.get(),
    driftTilesPerSecond: tuning.driftTilesPerSecond.get(),
    safeClearanceTiles: tuning.safeClearanceTiles.get(),
    holdGroundWeight: tuning.holdGroundWeight.get(),
    greed: tuning.greed.get(),
    maxExpansions: tuning.maxExpansions.get(),
    keepAwayTiles: tuning.keepAwayTiles.get(),
  });

  let applying = false;

  const applyPreset = (choice: DodgePresetChoice): void => {
    if (choice === 'custom') return; // their own numbers — nothing to apply
    const values = DODGE_PRESETS[choice];
    applying = true;
    try {
      for (const key of Object.keys(values) as (keyof DodgeTuning)[]) {
        tuning[key].set(values[key]);
      }
    } finally {
      applying = false;
    }
  };

  const onTuningChanged = (): void => {
    if (applying) return;
    const current = preset.get();
    // The numbers no longer are the ones the preset names, so stop claiming they
    // are rather than showing a label that lies.
    if (current !== 'custom' && !presetMatches(readTuning(), DODGE_PRESETS[current])) {
      preset.set('custom');
    }
  };

  context.onDispose(preset.onChange(applyPreset));
  for (const handle of Object.values(tuning)) {
    context.onDispose(handle.onChange(onTuningChanged));
  }
  // A build that adds a number to a preset, or changes one, would otherwise
  // leave a persisted mix labelled with a preset it no longer matches.
  onTuningChanged();
}
