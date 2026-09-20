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

/**
 * How far the ally must move before the trail remembers another place, in
 * tiles.
 *
 * **The spacing is the whole cost of the feature.** A crumb per tick would
 * record the ally's jitter as geometry and hand the follow a polyline with
 * hundreds of nodes in it to search; a spacing near the width of a doorway
 * records the *shape* of their route — the corner, the gap, the turn — and
 * nothing else. Too coarse and a crumb lands on either side of a pillar with
 * the pillar between them, which is a route that cannot be walked.
 */
export const TRAIL_SPACING_TILES = 0.75;

/**
 * The most places the trail remembers.
 *
 * At the spacing above this is some thirty tiles of history, which is more than
 * a screen and far more than the corner the follow is actually trying to get
 * around. It is a bound rather than a target: the trail is pruned from the
 * front every tick as ground is covered, so it only ever approaches this while
 * the ally is running away faster than the character can follow — exactly when
 * dropping the oldest places is right, because they are the ones already behind.
 */
export const TRAIL_MAX_CRUMBS = 48;

/**
 * How close counts as having reached a remembered place, in tiles.
 *
 * Generous on purpose. A crumb is a waypoint and not a destination — arriving
 * *near* it has taken the character past whatever it was recorded to get them
 * past — and demanding the point itself is how a follow ends up shuffling on
 * the spot trying to hit a coordinate the server keeps rounding away from.
 */
export const CRUMB_REACHED_TILES = 0.6;

/**
 * How far off a place may be and still be worth testing a straight line to, in
 * tiles.
 *
 * **A walk target further than this is not one the follow can act on anyway**:
 * the map is only known around the player, so a line drawn across it runs into
 * ground nobody has described and is refused on that alone. Skipping those
 * saves the longest raycasts, which are also the ones certain to fail — and the
 * scan carries on to the nearer, older crumbs, which are the ones the character
 * is actually meant to be walking.
 */
export const SHORTCUT_REACH_TILES = 24;
