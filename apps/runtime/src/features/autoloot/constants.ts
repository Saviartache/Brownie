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
 * Spacing between consecutive pickups. The *first* pickup on a bag is immediate.
 *
 * Stepping onto a bag and waiting a quarter of a second before anything happens
 * is the difference people notice, so the spacing is reset the moment the
 * player steps off every bag.
 */
export const PICKUP_INTERVAL_MS = 250;

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
 * How long a destination slot stays claimed after a potion is sent to it.
 *
 * Long, and deliberately: a belt slot's count is the only evidence a potion
 * landed, and it lags. Claiming the slot for half a minute is what stops a
 * second potion being sent to a slot that is about to fill.
 */
export const SLOT_CLAIM_MS = 30_000;

/** How long a bag slot stays claimed after a potion has been taken from it. */
export const BAG_SLOT_CLAIM_MS = 30_000;

/**
 * How long to leave a freshly seen shared bag alone.
 *
 * A white bag drops for the whole room, and taking from one the instant it
 * appears is what the delay exists to avoid. Only shared bags — see
 * `ContainerFacts.shared`.
 */
export const SHARED_BAG_DELAY_MS = 2000;

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

/** How often at most the guard says anything, so spam cannot fill the log. */
export const GUARD_LOG_INTERVAL_MS = 1500;
