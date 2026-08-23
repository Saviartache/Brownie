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
 * walked past — see `DodgeOutput.moveBy`. What comes out of here is the
 * step itself, and the module measures it from the position only it can see.
 *
 * Pure, and separate from the plugin, because every rule in it is a rule about
 * arithmetic that is worth checking without a session.
 */

import type { Position } from '@brownie/plugin-api';
import type { DodgePlan } from './DodgeController.js';

/**
 * How far ahead the module is pointed at, at least.
 *
 * The module walks *towards* an offset and stops when it is close enough, so one
 * nearer than a frame's step is a command to stand still. This is the floor
 * under "walk this way", and it is deliberately larger than one frame of the
 * fastest character in the game.
 */
const MIN_TARGET_TILES = 0.3;

/** Below this the command is not a walk, it is jitter. */
const MIN_COMMAND_SPEED = 0.2;

/** What to ask the module for, as an offset from wherever the player is. */
export interface WalkCommand {
  readonly offsetX: number;
  readonly offsetY: number;
  /** Tiles per second the step may cover. */
  readonly speedTilesPerSecond: number;
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
  /** How long the offset stands, which is what decides how far it reaches. */
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

  // At the speed the plan asked for, which is not always full: the safe place in
  // a wall of shots is often inside the ring rather than on it.
  //
  // **Except when something is standing on the player**, which is a shove rather
  // than a sidestep and is worth the margin the ordinary speed keeps in hand —
  // the whole complaint is that monsters get close anyway. The margin exists
  // because a command past the server's own limit is what makes it pull the
  // character back; the *limit* is what this spends, and no more.
  const urgency = plan.crowded ? request.fullSpeedTilesPerSecond : request.speedTilesPerSecond;
  let wantX = plan.dirX * urgency * plan.speedScale;
  let wantY = plan.dirY * urgency * plan.speedScale;

  const intent = request.intent;
  if (request.cancelIntent && intent !== undefined) {
    const cancelX = wantX - intent.x * request.speedTilesPerSecond;
    const cancelY = wantY - intent.y * request.speedTilesPerSecond;
    // Never past a right angle from the plan. If the direction they are steering
    // is not the one they are actually moving — a hand on the keys while a chat
    // box has them — the correction can otherwise point somewhere the plan never
    // asked for. This bounds that to "less help", never "the wrong way".
    if (cancelX * plan.dirX + cancelY * plan.dirY > 0) {
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
  const commanded = Math.min(magnitude, urgency);
  // Far enough that the module's per-frame step is never the thing that
  // truncates the walk. It is a direction, expressed as a distance.
  const distance = Math.max(MIN_TARGET_TILES, (commanded * request.holdMs) / 1000);
  return {
    offsetX: (wantX / magnitude) * distance,
    offsetY: (wantY / magnitude) * distance,
    speedTilesPerSecond: commanded,
  };
}
