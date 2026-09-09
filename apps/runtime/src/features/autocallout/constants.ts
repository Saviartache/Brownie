/** Timings and protocol constants for the automatic portal callout. */

/**
 * The callout kind that announces a portal.
 *
 * Read off a live Ctrl + left-click on a Puppet Master's Theatre portal:
 * `PLAYERCALLOUT calloutType=1 value=274676`, where the value was the object id
 * of that portal as it stood in the Nexus. Nothing in `objects.xml` says this —
 * the kinds are an enum inside the client — so it is a constant with its
 * provenance written down rather than a knob, and a patch that renumbers them
 * is a one-line change here.
 */
export const PORTAL_CALLOUT_TYPE = 1;

/**
 * Least time between announcements, in milliseconds.
 *
 * The server rate-limits what a character says, and an account that trips that
 * limit is muted rather than warned. Three portals popping together are three
 * announcements, so they are spaced rather than sent at once — which is what
 * makes naming every one of them safe.
 */
export const ANNOUNCE_INTERVAL_MS = 1500;

/**
 * How long after arriving on a map its portals count as already there.
 *
 * **The Nexus is full of portals somebody else opened.** Walking in and
 * announcing all of them is both a lie — they did not just drop — and a burst
 * of chat that would earn a mute in one go. So the portals that appear while
 * the map is still loading are recorded silently, and only what pops afterwards
 * is news. Long enough for a busy Nexus to finish arriving, short enough that a
 * key popped moments after you land is still caught.
 */
export const SETTLE_MS = 4000;

/**
 * Most announcements that may be waiting their turn.
 *
 * A bound on state rather than a policy: at one every {@link
 * ANNOUNCE_INTERVAL_MS} a queue this long is already half a minute behind the
 * room, and anything older than that has stopped being news. The oldest is what
 * gives way, because the newest is the portal still standing there.
 */
export const MAX_PENDING = 16;

/**
 * How far a portal can be and still be announced, in tiles.
 *
 * The whole map, in practice. Ctrl+click needs the portal under the cursor; the
 * server was never asked for that, it was asked for an object id — so distance
 * is not something this has to respect. A bound is kept anyway so nothing
 * reaches across a realm the character is standing at the edge of.
 */
export const REACH_TILES = 200;
