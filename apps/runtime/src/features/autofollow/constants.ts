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

/**
 * How close to the cursor an ally must stand to be picked by Shift+left-click,
 * in tiles.
 *
 * A pick is a click *on* somebody, not a search of the map: a tile is about the
 * width of a character, so clicking an ally takes them and clicking the ground
 * beside them takes nobody — which is what makes an empty click a cancel rather
 * than a grab at whoever happened to be nearest across the room.
 */
export const PICK_RADIUS_TILES = 1;
