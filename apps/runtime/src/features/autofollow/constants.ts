/** Distances and timings for auto-follow, kept apart from the plugin wiring. */

/**
 * How long a walk target stands if nothing replaces it, in milliseconds.
 *
 * Re-issued every tick (~200 ms), so this only has to outlast a tick or two of
 * silence — long enough that a dropped packet does not stall the walk, short
 * enough that "no fresh target" stops the character promptly. The same reasoning
 * as auto-portal's hold.
 */
export const WALK_HOLD_MS = 500;
