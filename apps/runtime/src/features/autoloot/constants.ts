/**
 * The numbers auto-loot runs on.
 *
 * Nearly all of them came off the reference implementation, where they were
 * tuned against the live game rather than reasoned about — so they are carried
 * over unchanged and named, which is what makes a future change to one a
 * deliberate act with a reason attached instead of a tweak to a bare literal.
 */

/**
 * How close the player must be to a bag to take from it.
 *
 * The game requires standing on it. One tile, not a radius worth arguing about:
 * a swap sent from further away is refused by the server.
 */
export const ON_TOP_TILES = 1;

/**
 * The least time between two item packets of ours — **across bags, not within
 * one.**
 *
 * The reference implementation spaced consecutive pickups by a quarter of a
 * second and reset that spacing the moment the player stepped off every bag, so
 * the first take from each new bag went out immediately. That reset is what
 * killed sessions:
 *
 * ```
 * 08:03:11.952  took 2594 from bag 291383 slot 0 into slot 1000000
 * 08:03:18.964  took 2595 from bag 291531 slot 0 into slot 7
 * 08:03:19.373  took 2594 from bag 291532 slot 0 into slot 1000000
 * 08:03:19.476  FAILURE, empty message, and the connection closed
 * ```
 *
 * Seven seconds between the first two and nothing happened; four hundred
 * milliseconds between the next two — a different bag, so the spacing had been
 * reset — and the server refused the second and hung up. Every disconnect this
 * feature has caused has that shape: two item moves inside half a second.
 *
 * So the spacing is a floor on *everything* auto-loot sends and is never reset.
 * A second is far above the four hundred milliseconds that fails and far below
 * the seven that plainly works; it is the default rather than a constant
 * because where the real limit sits between them is not known.
 */
export const PICKUP_INTERVAL_MS = 1000;

/** How long before the same bag slot is tried again after an attempt. */
export const RETRY_ITEM_AFTER_MS = 1500;

/**
 * How long a swap is waited on before it is assumed lost.
 *
 * A swap is not acknowledged as itself: what confirms it is the destination
 * slot filling on a later tick. The server can refuse one silently — a bag
 * emptied by somebody else is the ordinary case — so this is what stops a
 * refusal from wedging every later pickup behind it.
 */
export const PENDING_TIMEOUT_MS = 1200;

/**
 * How long to leave a freshly seen shared bag alone.
 *
 * A white bag drops for the whole room, and taking from one the instant it
 * appears is what the delay exists to avoid. Only shared bags — see
 * `ContainerFacts.shared`.
 */
export const SHARED_BAG_DELAY_MS = 2000;

/**
 * How long auto-loot stands down after a move the server did not carry out.
 *
 * A refusal is answered with silence, so what it was about is not knowable from
 * the wire: the slot aimed at, the distance, the spacing between packets. What
 * is knowable is that sending the next move immediately — at another slot, or
 * at the same one — is guessing, and each guess costs a packet. So it waits,
 * and waits longer each time it happens again.
 */
export const REFUSED_PAUSE_MS = 5000;

/** The longest that stand-down grows to, however many refusals follow. */
export const REFUSED_PAUSE_MAX_MS = 60_000;

/** Ticks of standing still before an idle player stops looting. */
export const STATIONARY_TICK_LIMIT = 100;

/** Movement below this in a tick is standing still. */
export const MOVEMENT_EPSILON = 0.05;

/** How far away a bag is still worth announcing. */
export const NOTIFY_RADIUS_TILES = 16;

/** How many of a bag's items to name before summarising the rest. */
export const NOTIFY_ITEM_LIMIT = 8;

/** What the "big loot bags" setting writes into a bag's size stat. */
export const BIG_BAG_SIZE = 175;

/** How long auto-loot stands down after the player touches a potion by hand. */
export const MANUAL_PAUSE_MS = 4000;

/**
 * How long the player's own potion packets are held back after auto-loot sends
 * one of its own.
 *
 * The narrow window in which both are in flight is the one that desynchronises
 * the client's inventory, and it is the player's packet that is dropped because
 * ours has already gone.
 */
export const MANUAL_BLOCK_MS = 1200;
