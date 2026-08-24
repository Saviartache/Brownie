/**
 * Every question the dodge asks, and the one it asks first.
 *
 * **One question on the panel, and everything else under Advanced.** The planner
 * genuinely turns on all twenty-odd of its numbers and every one of them has a
 * reason, but a feature that asks twenty questions before it will switch on is a
 * feature nobody switches on. A preset answers the one question a person
 * actually has — how hard should it try — by writing the eleven numbers that
 * trade caution against interference; the rest belong to the machine and the
 * connection and are left alone. Moving one by hand is what turns the label into
 * Custom, so it never claims a preset the numbers are not.
 *
 * **Here rather than in the plugin** because it is the largest single thing the
 * feature does and none of the rest of it is about panels: what the planner does
 * with the numbers is `DodgeController`, how the fight is assembled is
 * `DodgeScene`, and the plugin is what puts the two together. See
 * `dodgePresets` for which numbers a preset owns and why the others are not
 * its business.
 */

import type { PluginContext, SessionView, SettingHandle } from '@brownie/plugin-api';
import type { DodgeSettings } from './DodgeController.js';
import {
  DODGE_PRESETS,
  DodgePresetId,
  presetMatches,
  type DodgePresetChoice,
  type DodgeTuning,
} from './dodgePresets.js';

/** The eleven a preset owns, as handles. See {@link DodgeTuning}. */
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
  readonly driving: {
    readonly respectIntent: SettingHandle<boolean>;
    readonly interceptControl: SettingHandle<boolean>;
    readonly speedPercent: SettingHandle<number>;
    readonly holdMs: SettingHandle<number>;
    readonly cursorWalk: SettingHandle<boolean>;
  };
}

/** What the controller is tuned to right now. */
export function planningSettings(controls: DodgeControls): DodgeSettings {
  const tuning = controls.tuning;
  return {
    horizonMs: tuning.horizonMs.get(),
    reactWithinMs: tuning.reactWithinMs.get(),
    engageWithinTiles: tuning.engageWithinTiles.get(),
    sampleStepMs: tuning.sampleStepMs.get(),
    headings: tuning.headings.get(),
    hitScale: tuning.hitScale.get(),
    padTiles: tuning.padTiles.get(),
    leadMs: controls.leadMs.get(),
    driftTilesPerSecond: tuning.driftTilesPerSecond.get(),
    safeClearanceTiles: tuning.safeClearanceTiles.get(),
    urgentWithinMs: tuning.urgentWithinMs.get(),
    avoidWalls: controls.walls.avoid.get(),
    avoidDamagingGround: controls.hazards.avoid.get(),
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
  // The eleven below are a preset's whole assignment: how soon and how near
  // trouble has to be, how much margin to leave around it, and how hard to
  // think about the answer. Moving any of them by hand is what turns the label
  // above into Custom — see `applyPreset` and `onTuningChanged`.

  // **Long enough that running away stops looking clever.** A shot travels
  // faster than a character, so fleeing along its own line always survives a
  // *short* window — and a planner whose window is short therefore prefers the
  // backpedal that gets it cornered over the sidestep that ends the problem.
  // The reference implementation answered this with a bias term against moving
  // along the incoming flow; the horizon is the same answer without a weight to
  // tune, because at a second the arithmetic already shows the flight failing.
  const horizonMs = settings.range('horizonMs', {
    label: 'Look ahead (ms)',
    group: 'Reaction',
    advanced: true,
    default: 1000,
    min: 300,
    max: 2000,
    step: 50,
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
  // **How close a shot gets before the character is moved, and the setting that
  // decides how the whole feature reads.** Shots in this game live for a second
  // or two, so a planner that acts on anything that will *reach* the player
  // eventually is acting on nearly everything on the screen: the character
  // shuffles from the moment a monster fires and is out of position by the time
  // the shot is anywhere near. Live report: "we catch half the shots we should
  // not, because you start dodging them at the spawn." Measured where the shot
  // is right now, so it means what it says.
  //
  // **It never changes what is predicted.** Everything in the air is still
  // swept and still ranks the courses, which is what stops a dodge of the near
  // shot from walking into the far one. This decides only when to speak.
  //
  // Safe to keep tight because it is not the only trigger: a shot too fast, or
  // a pattern too wide, to be answered from this distance raises its hand on the
  // escape deadline instead — see `ThreatField.escapeTiles` — which asks whether
  // there is still *time*, not how far away anything is. Blasts are not gated by
  // it at all: an area effect is a place, not an approach.
  const engageWithinTiles = settings.range('engageWithinTiles', {
    label: 'Start dodging a shot within (tiles)',
    group: 'Reaction',
    advanced: true,
    default: 2.5,
    min: 1,
    max: 8,
    step: 0.25,
  });
  // **Coarser than a stepped planner's step, and that is the point.** The sweep
  // between two samples is exact, so this bounds how far a *curve* may bend
  // between them rather than how far a shot may travel — a straight shot is
  // described perfectly by two samples however far apart. It is the single
  // biggest lever on what a plan costs.
  const sampleStepMs = settings.range('stepMs', {
    label: 'Prediction sample (ms)',
    group: 'Reaction',
    advanced: true,
    default: 60,
    min: 20,
    max: 120,
    step: 10,
  });
  // Each one is swept, and in a dense pattern each is swept at three speeds — so
  // this is the other big lever on cost. Sixteen is what the reference's own
  // rollout planner settled on.
  const headings = settings.range('headings', {
    label: 'Directions considered',
    group: 'Reaction',
    advanced: true,
    default: 16,
    min: 8,
    max: 48,
    step: 4,
  });
  const urgentWithinMs = settings.range('urgentWithinMs', {
    label: 'Trouble is urgent within (ms)',
    group: 'Reaction',
    advanced: true,
    default: 160,
    min: 50,
    max: 500,
    step: 10,
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
  // What `positionAt` does not model — turn rate and the client's own
  // clock — grows with how far ahead it is asked. This is the price of that, and
  // it is why the planner can be trusted tightly up close.
  const driftTilesPerSecond = settings.range('driftTilesPerSecond', {
    label: 'Distrust far predictions (tiles/s)',
    group: 'Safety',
    advanced: true,
    default: 0.2,
    min: 0,
    max: 1,
    step: 0.05,
  });
  const safeClearanceTiles = settings.range('safeClearanceTiles', {
    label: 'Room that counts as safe (tiles)',
    group: 'Safety',
    advanced: true,
    default: 0.08,
    min: 0,
    max: 0.5,
    step: 0.01,
  });
  // **Room to dodge in, and the reason it is a distance rather than a hit
  // test.** A monster pressed against the player has already taken the space
  // every escape needs, so by the time contact damage says so there is nowhere
  // left to go. Raised on its own to the distance at which the bodies touch, so
  // nought here still means "not inside it".
  //
  // Stated from the middle of an ordinary, one-tile monster; what actually holds
  // is the gap it works out to, so a boss four tiles across is kept four times
  // as far off its centre and exactly as far off its edge. See
  // `EnemyBodies.nearEdgeOf`.
  //
  // Owned by the preset, unlike the switch in the spacing group: how much room
  // to insist on is exactly the trade the preset is about.
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
  });
  const avoidDamagingGround = settings.boolean('avoidDamagingGround', {
    label: 'Refuse to walk onto damaging ground',
    group: 'Safety',
    advanced: true,
    default: true,
  });
  // **Wider than the wall margin, and for a reason walls do not have.** Walking
  // into a wall costs a step; standing in lava costs health every tick, and
  // there is nothing to dodge once you are in it. The planner also has no way to
  // be sure where the character will actually end up — the server has its own
  // opinion, the command lands a frame late — so a course planned to stop
  // exactly at the edge is a course that gets a toe in it. Dropped when the
  // player is already standing that close, exactly as the wall margin is, so it
  // can never be the thing holding them there.
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
    reactWithinMs,
    engageWithinTiles,
    sampleStepMs,
    headings,
    urgentWithinMs,
    hitScale,
    padTiles,
    driftTilesPerSecond,
    safeClearanceTiles,
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
    driving: { respectIntent, interceptControl, speedPercent, holdMs, cursorWalk },
  };
}

/**
 * Keeps the label and the numbers telling the same story.
 *
 * Choosing a preset writes its eleven; moving any of the eleven by hand makes
 * the label Custom. The guard is what stops the first of the eleven writes
 * flipping the label and the remaining ten landing on a preset nobody chose.
 */
function bindPreset(
  context: PluginContext,
  preset: SettingHandle<DodgePresetChoice>,
  tuning: DodgeTuningHandles,
): void {
  const readTuning = (): DodgeTuning => ({
    horizonMs: tuning.horizonMs.get(),
    reactWithinMs: tuning.reactWithinMs.get(),
    engageWithinTiles: tuning.engageWithinTiles.get(),
    sampleStepMs: tuning.sampleStepMs.get(),
    headings: tuning.headings.get(),
    urgentWithinMs: tuning.urgentWithinMs.get(),
    hitScale: tuning.hitScale.get(),
    padTiles: tuning.padTiles.get(),
    driftTilesPerSecond: tuning.driftTilesPerSecond.get(),
    safeClearanceTiles: tuning.safeClearanceTiles.get(),
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
