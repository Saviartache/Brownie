/**
 * Turning a plan into something to say to the module.
 *
 * **Taking the wheel means cancelling their input, not out-shouting it.** The
 * module's step is applied on top of whatever the game's own movement did that
 * frame, so a player holding a key into a shot and a dodge pulling sideways
 * produce the diagonal between them — which is neither. With the direction they
 * are steering known, the command can be the *difference* between where they
 * should end up and where they are taking themselves, and the sum is the dodge.
 *
 * **An offset, never a place.** Where the player is arrives on the wire five
 * times a second while the character walks at the frame rate, so a heading added
 * to this side's idea of their position names somewhere they may already have
 * walked past — see `DodgeOutput.moveBy`. What comes out of here is the step
 * itself, and the module measures it from the position only it can see.
 *
 * **Which is also why the *hold* decides how far a walk goes, and not the
 * offset.** The module re-resolves an offset against the character's live
 * position on every frame, so it is a carrot rather than a destination: the
 * character never arrives at it, and keeps travelling at the commanded speed for
 * as long as the record stands. A walk of a third of a tile is therefore a walk
 * with a hold sized to a third of a tile, plus an offset long enough that the
 * module does not round the direction away. Sizing the *offset* instead — which
 * an older generation did, believing the module stopped on arrival — meant every
 * walk went as far as the hold allowed whatever distance the planner had chosen,
 * which is the whole of why small dodges were not possible before.
 *
 * **A hop is the same offset with a different lifetime**, and that is the whole
 * of what makes it instant: the module spends its entire per-frame allowance on
 * it and then the target is gone, where an ordinary walk keeps being carried
 * towards for as long as its hold lasts. See `Hop.ts`, and `DodgeOutput.hopBy`
 * for why the difference cannot be expressed as a shorter hold.
 *
 * Pure, and separate from the plugin, because every rule in it is a rule about
 * arithmetic that is worth checking without a session.
 */

import type { Position } from '@brownie/plugin-api';
import type { DodgePlan } from './DodgePlanner.js';
import { HOP_SPEED_TILES_PER_SECOND } from './Hop.js';

/**
 * How far ahead the module is pointed at, at least.
 *
 * A frame steps towards the offset by at most its own budget, so an offset
 * shorter than one frame's step is a command the module rounds away to nothing.
 * This is the floor under "walk this way", and it is deliberately larger than
 * one frame of the fastest character in the game.
 *
 * **A direction with a length, not a distance to cover.** How far the walk
 * actually goes is {@link WalkCommand.holdMs} — see the file note.
 */
const MIN_TARGET_TILES = 0.3;

/**
 * The shortest hold a walk is given, in milliseconds.
 *
 * One frame at any frame rate a person plays at, and then some: a hold shorter
 * than the gap between two frames can expire before a single frame has acted on
 * it, which is a command that does nothing at all.
 */
const MIN_WALK_HOLD_MS = 25;

/**
 * How long a hop stands before it lapses unspent.
 *
 * **A deadline, not a duration.** The record is spent by the first frame that
 * actually steps towards it, so this only bounds how long it may wait for one —
 * and a frame with nothing to measure the player's own walking against issues no
 * step at all, which is the ordinary case immediately after a quiet stretch. A
 * few frames of grace; past that the situation it was chosen for has moved on
 * and the next plan will choose again.
 */
export const HOP_HOLD_MS = 60;

/** Below this the command is not a walk, it is jitter. */
const MIN_COMMAND_SPEED = 0.2;

/** What to ask the module for, as an offset from wherever the player is. */
export interface WalkCommand {
  readonly offsetX: number;
  readonly offsetY: number;
  /** Tiles per second the step may cover. */
  readonly speedTilesPerSecond: number;
  /**
   * Whether the module should spend it on one frame and then forget it.
   *
   * The exact step. Everything else about the command is the same, and the
   * module still clamps it to what a single frame may carry — which is why a hop
   * is the only way to ask for a displacement smaller than a frame of walking.
   */
  readonly hop: boolean;
  /**
   * How long the record stands, in milliseconds.
   *
   * **For a walk this is the distance**, because the module keeps stepping
   * towards the offset for as long as the record lives. For a hop it is a
   * deadline: the first frame that steps spends it. See the file note.
   */
  readonly holdMs: number;
}

export interface WalkRequest {
  readonly plan: DodgePlan;
  /** Which way the player is steering, or nothing while they are not. */
  readonly intent: Position | undefined;
  /** What the planner is allowed to spend, in tiles per second. */
  readonly speedTilesPerSecond: number;
  /** And what the character can actually do, for a shove. */
  readonly fullSpeedTilesPerSecond: number;
  /** Whether their own input is being cancelled rather than added to. */
  readonly cancelIntent: boolean;
  /** The longest a walk may stand, which is the furthest one plan may carry. */
  readonly holdMs: number;
}

/**
 * What to command, or nothing at all.
 *
 * Nothing means the wheel goes back: either the plan is to hold, or what the
 * player is already doing *is* the plan, and both are reasons to say nothing
 * rather than to nudge.
 */
export function walkCommand(request: WalkRequest): WalkCommand | undefined {
  const plan = request.plan;
  if (!plan.steer) return undefined;

  // **The hop is not adjusted for what they are pressing, and does not need to
  // be.** It is a single frame, so the ground they cover under their own power
  // during it is a fraction of a tile — and the module already subtracts exactly
  // that from what it carries, from the position only it can see. Subtracting a
  // guess about it here as well would take the same ground off twice.
  if (plan.hop && plan.stepTiles > 0) {
    return {
      offsetX: plan.dirX * plan.stepTiles,
      offsetY: plan.dirY * plan.stepTiles,
      speedTilesPerSecond: HOP_SPEED_TILES_PER_SECOND,
      hop: true,
      holdMs: HOP_HOLD_MS,
    };
  }

  // At full speed, always: a step that is worth walking is worth arriving at,
  // and how far to go is the plan's own answer rather than something to spend
  // speed on. Crossing a lane of fire slowly is the one way of crossing it that
  // does not work.
  //
  // **Except when something is standing on the player**, which is a shove rather
  // than a sidestep and is worth the margin the ordinary speed keeps in hand —
  // the whole complaint is that monsters get close anyway. The margin exists
  // because a command past the server's own limit is what makes it pull the
  // character back; the *limit* is what this spends, and no more.
  const speed = plan.crowded ? request.fullSpeedTilesPerSecond : request.speedTilesPerSecond;
  const intent = request.intent;
  const standing = plan.dirX === 0 && plan.dirY === 0;

  // **Standing still deliberately, against a player who is walking somewhere
  // that costs them.** There is no step to correct here — the correction *is*
  // the command, and it is their own input turned around. Kept apart from the
  // ordinary case below because the guard there is a test against the planned
  // direction, and there is not one.
  if (standing) {
    if (!request.cancelIntent || intent === undefined) return undefined;
    return {
      offsetX: -intent.x * MIN_TARGET_TILES,
      offsetY: -intent.y * MIN_TARGET_TILES,
      speedTilesPerSecond: request.speedTilesPerSecond,
      hop: false,
      holdMs: request.holdMs,
    };
  }

  let wantX = plan.dirX * speed;
  let wantY = plan.dirY * speed;

  if (request.cancelIntent && intent !== undefined) {
    const cancelX = wantX - intent.x * request.speedTilesPerSecond;
    const cancelY = wantY - intent.y * request.speedTilesPerSecond;
    // Never past a right angle from the plan. If the direction they are steering
    // is not the one they are actually moving — a hand on the keys while a chat
    // box has them — the correction can otherwise point somewhere the plan never
    // asked for. This bounds that to "less help", never "the wrong way".
    //
    // **Nought is admitted, and that is the case worth naming**: a correction of
    // no length means what they are already doing *is* the plan, which falls
    // through the floor below and hands the wheel back. Refused here, it became
    // a command to walk exactly the way they were already walking — harmless,
    // and a plugin that never stopped talking.
    if (cancelX * plan.dirX + cancelY * plan.dirY >= 0) {
      wantX = cancelX;
      wantY = cancelY;
    }
  }

  const magnitude = Math.hypot(wantX, wantY);
  // The correction cancelled out: what they are doing already *is* the plan.
  if (magnitude < MIN_COMMAND_SPEED) return undefined;

  // Capped at what the character can walk. A cancellation can ask for more than
  // that, and a command past the character's own speed is what makes the server
  // pull them back — so the correction is allowed to be partial and is never
  // allowed to be a snap-back.
  const commanded = Math.min(magnitude, speed);
  // **The plan's own step, and no further — expressed as a hold.** The module
  // keeps stepping towards an offset for as long as the record stands, so what
  // bounds the distance is time rather than the offset's own length. This is
  // what makes "into the gap and stand" carry itself out if no further plan ever
  // arrives, and it is what lets a third of a tile actually be a third of a
  // tile.
  //
  // Never longer than the caller allows, because everything past the next plan
  // is a decision already withdrawn; never shorter than a frame, because a
  // record that expires before any frame has acted on it is a command that did
  // nothing at all.
  const holdMs = Math.min(
    request.holdMs,
    Math.max(MIN_WALK_HOLD_MS, (plan.stepTiles / commanded) * 1000),
  );
  // The offset is a direction with a length, and the length only has to clear
  // what one frame would round away.
  const reach = Math.max(MIN_TARGET_TILES, plan.stepTiles);
  return {
    offsetX: (wantX / magnitude) * reach,
    offsetY: (wantY / magnitude) * reach,
    speedTilesPerSecond: commanded,
    hop: false,
    holdMs,
  };
}
