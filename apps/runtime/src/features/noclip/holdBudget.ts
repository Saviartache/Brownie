/**
 * The arithmetic of a hold that is on a clock.
 *
 * Noclip stops the client's own walkability check, and the server pulls the
 * player back anyway — so the runtime stops telling it, by dropping the `MOVE`
 * packets while noclip is on. A server that hears nothing for long enough drops
 * the connection instead, which is why the hold is on a budget, and why what is
 * left of that budget has to be readable at a glance from inside the game.
 *
 * Kept apart from the plugin because this is the part worth testing: a colour
 * that never reaches red, or a countdown that reads one second late, is a
 * warning that arrives after the thing it was warning about.
 */

/** A colour as the three channels the module's text record carries. */
export interface HoldColour {
  readonly red: number;
  readonly green: number;
  readonly blue: number;
}

/** Plenty of budget left. */
const START: HoldColour = { red: 0x20, green: 0xdc, blue: 0x00 };

/** None of it left. Also what the last message is shown in. */
const END: HoldColour = { red: 0xff, green: 0x00, blue: 0x19 };

export const SPENT_COLOUR = END;

/**
 * Green at the start of the budget, red at the end of it, and the straight line
 * between — a bar would need somewhere to draw it, and this is one number.
 *
 * `spent` is the share of the budget gone, and is clamped rather than refused:
 * a colour is not worth failing a countdown over.
 */
export function rampColour(spent: number): HoldColour {
  const share = Math.min(1, Math.max(0, Number.isFinite(spent) ? spent : 1));
  const channel = (from: number, to: number): number => Math.round(from + (to - from) * share);
  return {
    red: channel(START.red, END.red),
    green: channel(START.green, END.green),
    blue: channel(START.blue, END.blue),
  };
}

/** What the countdown says, and the colour to say it in. */
export interface HoldState {
  readonly secondsLeft: number;
  readonly spent: boolean;
  readonly text: string;
  readonly colour: HoldColour;
}

/**
 * Where a hold stands after `elapsedMs`, given a budget in whole seconds.
 *
 * **Rounded up, so the last second is shown as one and not as zero.** A
 * countdown that reaches zero and keeps going reads as one that has stopped
 * working, and the hold is in fact still on until {@link HoldState.spent}.
 */
export function holdState(elapsedMs: number, budgetSeconds: number): HoldState {
  const budget = Math.max(1, Math.floor(budgetSeconds));
  const elapsed = Math.max(0, elapsedMs) / 1000;
  const left = Math.max(0, Math.ceil(budget - elapsed));

  // **A colon, not a dash.** The game's floating-text font draws a hyphen as a
  // star sprite, so `Noclip - 15s left` reads as `Noclip * 15s left` on screen.
  if (left === 0) {
    return {
      secondsLeft: 0,
      spent: true,
      text: `Noclip off: ${String(budget)}s hold spent`,
      colour: SPENT_COLOUR,
    };
  }
  return {
    secondsLeft: left,
    spent: false,
    text: `Noclip: ${String(left)}s left`,
    colour: rampColour(elapsed / budget),
  };
}
