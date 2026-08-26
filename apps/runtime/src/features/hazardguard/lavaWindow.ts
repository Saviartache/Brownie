/**
 * How long a refusal may last before the server stops believing it.
 *
 * **The server tolerates about ten seconds of a character standing in damaging
 * ground without admitting to it, and then drops the connection.** That is the
 * whole reason this file exists: withholding `GROUNDDAMAGE` works, and
 * withholding it *indefinitely* ends the session. So the refusal is a window
 * that recharges — it holds for a few seconds, lets one admission through, and
 * opens again from that moment. What the server sees is a character reporting
 * damaging ground every few seconds instead of twice a second, which is a
 * conversation it is willing to keep having.
 *
 * Kept apart from the plugin because this is the part worth testing: a window
 * that fails to close is a disconnect, and a window that never reopens is a
 * feature that worked once.
 *
 * **Entering is inferred from the gap, because nothing on the wire says it.**
 * There is no "you stepped onto lava" packet — only the client admitting damage,
 * once every half second or so while it stands there. So a `GROUNDDAMAGE` that
 * arrives after a quiet stretch is the character walking *in*, and the quiet
 * stretch is what "out" looks like. That is what makes the window re-arm by
 * walking out and back rather than on a timer of its own.
 */

import type { FloatingTextColour } from '../../overlay/floatingText.js';
import { rampColour, SPENT_COLOUR } from '../noclip/holdBudget.js';

/**
 * The longest a window may be, in seconds.
 *
 * Comfortably inside the server's patience, and a ceiling rather than a
 * preference: the setting it bounds is the one number in this feature that can
 * cost a session, so it is not left to a slider's maximum being changed later.
 */
export const MAX_HOLD_SECONDS = 8;

/** What this window is doing now. */
export interface WindowState {
  /** Whether the admission that arrived should be withheld. */
  readonly withhold: boolean;
  /**
   * When the open window started, or nothing when none is open.
   *
   * Carried back out rather than kept here so the caller owns the state and
   * this stays a function of its arguments — which is what makes the rule
   * checkable without a session.
   */
  readonly openedAtMs: number | undefined;
  /** Whether this call is what opened it. The countdown starts on that edge. */
  readonly opened: boolean;
}

/**
 * What to do with a `GROUNDDAMAGE` that has just arrived.
 *
 * **Windows recharge on their own.** A spent one lets exactly the admission in
 * front of it through and then opens the next window from that moment, so a
 * character standing in lava is protected for `holdMs`, takes one tick of
 * damage, and is protected again. The server hears from it once per cycle,
 * which at any hold this allows is far inside the ten seconds it waits — and
 * that one admission is what buys the silence either side of it.
 *
 * The alternative — spend one window and then take everything until the
 * character walks out — is safer against the disconnect by a margin nobody
 * needs, and leaves a long crossing costing full damage for all but its first
 * three seconds.
 *
 * @param lastGroundAtMs When the previous one arrived, or nothing if this is
 *   the first since the guard was armed.
 * @param openedAtMs When the current window opened, or nothing when none is.
 * @param holdMs How long a window lasts.
 * @param rearmMs How long a gap counts as the character having walked out.
 */
export function windowFor(
  nowMs: number,
  lastGroundAtMs: number | undefined,
  openedAtMs: number | undefined,
  holdMs: number,
  rearmMs: number,
): WindowState {
  // Walked in: the first admission after a quiet stretch starts the cycle over,
  // whatever phase the last one left it in — so coming back to a hazard gives a
  // whole window rather than the remainder of one. This is also the first call
  // of a session, where there is no previous admission to measure a gap from.
  const entered = lastGroundAtMs === undefined || nowMs - lastGroundAtMs >= rearmMs;
  const startedAt = entered ? nowMs : openedAtMs;

  if (startedAt === undefined || nowMs - startedAt >= holdMs) {
    // Either nothing was open or what was open has run out. This admission is
    // the one that goes through — and the next window starts here, which is
    // what makes the protection recharge without the character having to move.
    return { withhold: false, openedAtMs: nowMs, opened: true };
  }

  return { withhold: true, openedAtMs: startedAt, opened: entered };
}

/** What the countdown says over the character, and the colour to say it in. */
export interface CountdownLine {
  readonly secondsLeft: number;
  readonly spent: boolean;
  readonly text: string;
  readonly colour: FloatingTextColour;
}

/**
 * Where an open window stands after `elapsedMs`.
 *
 * **Rounded up, so the last second reads as one and not as zero** — the same
 * rule the noclip countdown follows, and for the same reason: a countdown that
 * sits on zero reads as one that has stopped working.
 *
 * The colour ramp is noclip's, reused rather than copied. It is a green-to-red
 * line over a share of a budget, which is exactly what this is; a second
 * implementation of it would be a second thing to get wrong.
 *
 * **A colon, not a dash**, for the reason `holdBudget.ts` records: the game's
 * floating-text font draws a hyphen as a star sprite.
 */
export function countdownFor(elapsedMs: number, holdSeconds: number): CountdownLine {
  const hold = Math.max(1, Math.floor(holdSeconds));
  const elapsed = Math.max(0, elapsedMs) / 1000;
  const left = Math.max(0, Math.ceil(hold - elapsed));

  if (left === 0) {
    // Not "off": the window recharges the moment the next admission goes
    // through, so what this second actually costs is one tick of damage. A line
    // saying the feature had stopped would be describing something else.
    return {
      secondsLeft: 0,
      spent: true,
      text: 'Hazard guard: taking one',
      colour: SPENT_COLOUR,
    };
  }
  return {
    secondsLeft: left,
    spent: false,
    text: `Hazard guard: ${String(left)}s left`,
    colour: rampColour(elapsed / hold),
  };
}
