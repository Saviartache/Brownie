/** Distances and timings for the portal commands, kept apart from the wiring. */

/**
 * How far from a portal still counts as standing on it, in tiles.
 *
 * A portal occupies one square and the player types `/enter` while on it, so a
 * whole tile is generous enough to survive the drift between what the client
 * draws and what the last `NEWTICK` said — and tight enough that two portals
 * side by side in the Nexus cannot both answer.
 */
export const REACH_TILES = 1;

/**
 * Least time between `USEPORTAL` sends while forcing an entry, in milliseconds.
 *
 * Entering is not acknowledged and can be refused — a dungeon that filled up
 * first — so asking again is how you get in once a slot frees. Spaced as
 * auto-portal spaces it, so a portal that never opens is not a packet a tick.
 */
export const RETRY_INTERVAL_MS = 1000;

/** How long `/enter` keeps asking, in seconds, until the player says otherwise. */
export const DEFAULT_RETRY_SECONDS = 10;
