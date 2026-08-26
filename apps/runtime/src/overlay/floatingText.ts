/**
 * A line of the game's own text, over the player.
 *
 * The runtime has two other ways to say something and neither is where somebody
 * looks mid-fight: the overlay is behind the game window, and chat scrolls. So
 * anything the player has to read *while playing* — a countdown, a switch that
 * has just moved — goes here.
 *
 * This module is the record and the palette, and nothing else. What to say is
 * the caller's; how the module draws it is `FloatingText.h`. Kept apart from
 * both because there are now several callers, and the record was being spelled
 * out at each of them.
 *
 * **The message is the whole of the rest of the record**, separators included,
 * which is why it comes last and why nothing about it is escaped. See
 * `docs/ipc.md`.
 */

/** A colour as the three channels the `text` record carries. */
export interface FloatingTextColour {
  readonly red: number;
  readonly green: number;
  readonly blue: number;
}

/** A switch that is on, and a budget with plenty left. */
export const ON_COLOUR: FloatingTextColour = { red: 0x20, green: 0xdc, blue: 0x00 };

/** A switch that is off, and a budget with none left. */
export const OFF_COLOUR: FloatingTextColour = { red: 0xff, green: 0x00, blue: 0x19 };

/**
 * One line, in the given colour, replacing whatever was waiting.
 *
 * **A colon reads and a hyphen does not.** The game's floating-text font draws
 * a hyphen as a star sprite, so `Noclip - 15s left` reaches the screen as
 * `Noclip * 15s left`. Callers punctuate accordingly.
 */
export function floatingTextRecord(text: string, colour: FloatingTextColour): string {
  return ['text', colour.red, colour.green, colour.blue, text].join('|');
}
