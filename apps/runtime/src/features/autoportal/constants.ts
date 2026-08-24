/** Timings and distances for auto-portal, kept apart from the plugin wiring. */

/** How close to a portal counts as being on it, in tiles. */
export const ENTER_RADIUS_TILES = 0.6;

/**
 * How long a walk target stands if nothing replaces it, in milliseconds.
 *
 * Re-issued every tick (~200 ms), so this only has to outlast a tick or two of
 * silence — long enough that a dropped packet does not stall the walk, short
 * enough that "no target" stops the player promptly.
 */
export const WALK_HOLD_MS = 500;

/**
 * Least time between `USEPORTAL` sends for the same portal, in milliseconds.
 *
 * Entering is not acknowledged and can be refused — a dungeon that filled up
 * first — so standing on a portal and asking again is how you get in once a slot
 * frees. Spaced so a portal that never opens is not a packet a tick.
 */
export const ENTER_INTERVAL_MS = 1000;
