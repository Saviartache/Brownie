/** Timings and distances for auto-teleport, kept apart from the plugin wiring. */

/**
 * How close the character must land to the target to count the teleport as
 * having worked, in tiles.
 *
 * A teleport-to-player drops the character on top of the target, but not to the
 * exact float — the server places them a step away and both may have moved a
 * frame's worth since the packet went out. Wide enough to confirm arrival,
 * narrow enough that standing across the room never reads as success.
 */
export const ARRIVE_TILES = 4;

/**
 * How long to wait for that arrival before calling the teleport refused, in
 * milliseconds.
 *
 * A teleport that works shows up as a position change within a tick or two;
 * silence past this is the server declining — a filled dungeon, a cooldown, or
 * a map that forbids it. Long enough to outlast a slow tick, short enough that a
 * refusal is learned promptly.
 */
export const CONFIRM_MS = 1500;

/**
 * How many refusals on one map before teleport is given up there.
 *
 * The game states no flag for "teleport is disabled here"; a blocked dungeon is
 * learned only by trying and not arriving. One miss can be a full instance or a
 * target who just left; a second, a whole cooldown later, is the map itself. The
 * count resets on arrival and on a new map — see the plugin's `MAPINFO` reset.
 */
export const MAX_FAILURES = 2;

/**
 * Least time between teleport attempts, in milliseconds.
 *
 * Comfortably past the game's own teleport cooldown, so a refusal counted here
 * is the map declining rather than the character still being on cooldown from
 * the last try — which is what lets {@link MAX_FAILURES} mean "blocked" and not
 * "too soon".
 */
export const TELEPORT_INTERVAL_MS = 5000;
