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
  /**
   * Whether the player is holding a place, which a key is bound to.
   *
   * *Which* place is not here: it is captured where the plugin can see the
   * character, and it dies with the map. See `dodgePlugin`.
   */
  readonly anchor: SettingHandle<boolean>;
  /**
   * Closing on the enemy under the cursor, and how near to close.
   *
   * *Which* enemy is not here, for the reason the anchor's place is not: an
   * object id names something else in the next map and nothing at all after a
   * restart. See `dodgePlugin`.
   */
  readonly engage: {
    readonly enabled: SettingHandle<boolean>;
    readonly rangePercent: SettingHandle<number>;
  };
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
  /**
   * Whether area attacks are dodged at all — the telegraphed blasts and the
   * discs round enemies that blast themselves. Off, only projectiles are.
   */
  readonly avoidBlasts: SettingHandle<boolean>;
  /**
   * Whether the ground round a turret, a spawner or a trap that fires is kept
   * off — its point blank, where its next shot lands before a step aside could.
   */
  readonly avoidEmitters: SettingHandle<boolean>;
  readonly spacing: {
    readonly mindMonsters: SettingHandle<boolean>;
  };
  readonly driving: {
    readonly respectIntent: SettingHandle<boolean>;
    readonly interceptControl: SettingHandle<boolean>;
    readonly speedPercent: SettingHandle<number>;
    readonly holdMs: SettingHandle<number>;
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
    // Nought when the whole idea is switched off, so the planner stops preferring
    // a distance nobody asked it to keep. Withdrawing the *refusal* to walk in
    // is the scene's, and it does that with the same switch.
    hazardClearTiles: controls.hazards.avoid.get() ? controls.hazards.clearanceTiles.get() : 0,
    holdGroundWeight: tuning.holdGroundWeight.get(),
    dpsRadiusTiles: tuning.dpsRadiusTiles.get(),
    budget: tuning.budget.get(),
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

  // **The one control here that is an action rather than a preference**, and
  // the reason it is a setting at all: what a key moves is a boolean the host
  // owns, so the switch a key presses and the switch a person clicks are the
  // same one. Where the anchor *is* is the plugin's — see `dodgePlugin` — and
  // deliberately not a setting: it is a place on a map, meaningless in the next
  // one and worse than meaningless after a restart.
  const anchor = settings.boolean('anchor', {
    group: 'Anchor',
    label: 'Hold the ground you are standing on',
    default: false,
  });

  // **The same idea as the anchor, aimed at something that moves.** A place the
  // player names is ground; an enemy they name is a *distance* from a thing that
  // walks, and the planner is handed one exactly as it is handed the other — as
  // somewhere to be, which every other term of the cost model then argues with.
  // Its own switch because it repurposes a chord auto-follow already answers,
  // and somebody who only wants the ally half must be able to say so.
  const engageEnabled = settings.boolean('engageTargets', {
    group: 'Engage',
    label: 'Shift+left-click an enemy to close on it',
    default: true,
  });
  // **A share of the weapon's own reach, which is why it is a percentage.** How
  // far a fight is fought is a property of the item in hand — see
  // `DodgeCatalog.weaponReachTiles` — and what a person actually wants to say is
  // how much of it to give away for safety. Short of the full reach on purpose:
  // standing at the exact edge is a shot that expires on arrival the moment
  // either side moves.
  const engageRangePercent = settings.range('engageRangePercent', {
    group: 'Engage',
    label: 'And hold it at (% of your weapon range)',
    default: 75,
    min: 20,
    max: 100,
    step: 5,
    visibleWhen: { key: 'engageTargets', equals: [true] },
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
  // **The slice, and the biggest single lever on what a plan costs.** Every
  // candidate future is priced at every tick, so halving this doubles both the
  // number of ticks and the number of danger-field queries. It is *not* the
  // smallest movement the planner can describe — the move it commands is sampled
  // at its own resolution, down to a twentieth of a tile.
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
  // Every heading is tried at two distances in the coarse pass and at all of
  // them around the winner, so this is the other big lever on cost. Twelve is a
  // thirty-degree ring, which is finer than the width of a gap at the distance a
  // gap is away — and the pattern recogniser aims between the spokes anyway.
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
  // **What a route is charged, per tick, for each tile it sits away from where
  // the player meant to be.** Raising it gives the ground back sooner; lowering
  // it lets the planner walk further to be safer.
  //
  // **Turn it up as far as you like: it cannot buy a tight step.** A step short
  // of comfortable is charged on the ground it left rather than the ground it
  // reached, so the way home is only ever worth anything by way of steps that
  // keep their room — round the fire, in the other direction, or not at all.
  // See `TrajectoryScore`. What this actually decides is how much *movement* is
  // worth spending to be back where you were.
  const holdGroundWeight = settings.range('holdGroundWeight', {
    label: 'Hold your ground',
    group: 'Control',
    advanced: true,
    default: DODGE_PRESETS[DodgePresetId.Balanced].holdGroundWeight,
    min: 0.05,
    max: 2,
    step: 0.05,
  });
  // **How near the anchor the character can still fight from.** The anchor is a
  // damage-dealing position, not merely a place to stand, so leaving this ring
  // at all is charged a flat price the distance term can never pay back — which
  // is what makes a twentieth of a tile strictly preferred to half a tile when
  // both are safe. Widen it to be left alone about small movements; narrow it to
  // be pinned to the spot.
  const dpsRadiusTiles = settings.range('dpsRadiusTiles', {
    label: 'Stay within (tiles) of your ground',
    group: 'Control',
    advanced: true,
    default: DODGE_PRESETS[DodgePresetId.Balanced].dpsRadiusTiles,
    min: 0,
    max: 1.5,
    step: 0.01,
  });
  // The backstop rather than a target: an ordinary plan settles in a fraction of
  // this, and what it bounds is the worst case — a screen full of fire with no
  // clean way through, which is exactly when a plan must still arrive on time.
  // Each unit is one future rolled the whole way to the horizon.
  const budget = settings.range('planBudget', {
    label: 'Thinking budget (futures)',
    group: 'Reaction',
    advanced: true,
    default: DODGE_PRESETS[DodgePresetId.Balanced].budget,
    min: 40,
    max: 600,
    step: 20,
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
  // runs across one is a walk that starts from inside it, which is the case the
  // ratchet below exists to still allow.
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
  // moment it is most needed.
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
  // **Every area attack, and off means projectiles only.** Two kinds of it: the
  // thrown bombs, novas and circles the game telegraphs before they land — a
  // disc that goes off at a moment rather than a point that travels, read from
  // the telegraph because the packet reporting the blast arrives after the
  // damage — and the discs round enemies learned to blast themselves, which
  // have no telegraph at all and are only ever kept out of. See `DodgeScene`.
  //
  // One switch for both because the question is one: whether this dodge minds
  // area damage. Somebody who would rather tank or outheal it wants the planner
  // left to the bullets, and a disc it still stepped round would be exactly the
  // interference they switched off. It is also the way out if a patch moves the
  // telegraph, which rests on a packet body worked out rather than stated — a
  // mask byte and nine conditional fields, see `docs/protocol.md`.
  const avoidBlasts = settings.boolean('avoidBlasts', {
    label: 'Dodge area attacks (bombs, novas, self-blasts)',
    group: 'Safety',
    advanced: true,
    default: true,
  });
  // **The things that fire and can never be hurt**: spawners, emitters, turrets
  // and traps, most of them drawn as nothing. They are no body to keep room from,
  // so without this the planner walked straight onto them — and a shot fired
  // from where the character is standing lands before any step aside can. What
  // is kept off is how far each one's own shots get in a command lead and a step,
  // worked out from its data; see `PointBlank`.
  //
  // Its own switch rather than the area-attack one, because it is about shots,
  // and because it refuses ground: somebody holding a doorway a dormant spawner
  // sits in needs a way to say that one is fine.
  const avoidEmitters = settings.boolean('avoidEmitters', {
    label: 'Keep off turrets and spawners that fire',
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
    dpsRadiusTiles,
    budget,
    keepAwayTiles,
  };

  bindPreset(context, preset, tuning);

  return {
    preset,
    anchor,
    engage: { enabled: engageEnabled, rangePercent: engageRangePercent },
    tuning,
    leadMs,
    walls: { avoid: avoidWalls, clearanceTiles: wallClearanceTiles },
    hazards: { avoid: avoidDamagingGround, clearanceTiles: hazardClearanceTiles },
    avoidBlasts,
    avoidEmitters,
    spacing: { mindMonsters },
    driving: { respectIntent, interceptControl, speedPercent, holdMs },
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
    dpsRadiusTiles: tuning.dpsRadiusTiles.get(),
    budget: tuning.budget.get(),
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
