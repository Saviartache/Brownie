/**
 * Which of our packets the game server rate-limits, and how far apart it wants
 * them.
 *
 * **A table, because the answer is a fact about the live game and not a rule
 * anything here can derive.** Every number below was either measured against a
 * real session or is a deliberately conservative guess standing in for a
 * measurement nobody has taken; each says which it is. Nothing is paced on
 * suspicion alone — a packet this file does not name goes out the moment it is
 * asked for, and that is the great majority of them.
 *
 * **A lane is a set of packets the server appears to count together.** Two
 * lanes do not wait for each other: a portal entry has never been observed to
 * interfere with an item move, and making them share a floor would mean paying
 * for a limit that is not there. Within one lane the wait between two packets
 * is the longer of what the one before asks for and what the one after asks
 * for, so a cheap packet following an expensive one still waits out the
 * expensive one.
 */

/** A set of packets the server counts together. */
export const ActionLane = {
  /** Anything that moves or uses an item. The one lane with measurements. */
  Item: 'item',
  /** Leaving the map under your own power: portals and teleports. */
  Travel: 'travel',
  /** Anything that reaches other players — chat and callouts. */
  Social: 'social',
} as const;

export type ActionLane = (typeof ActionLane)[keyof typeof ActionLane];

export interface ActionLaneEntry {
  readonly lane: ActionLane;
  /**
   * The least time that must pass either side of this packet within its lane.
   *
   * Either side, not after: it is used as `max(previous, next)`, so one
   * expensive packet in a lane raises the floor around itself without every
   * other packet in that lane having to know about it.
   */
  readonly spacingMs: number;
  /**
   * Fields that describe the moment the packet *leaves*, not the moment it was
   * asked for, and are therefore filled in at the last instant.
   *
   * **A queued packet carrying the stamp it was built with is a packet the
   * server throws away.** The client's clock is a rising sequence the server
   * checks against, so a stamp from a second ago is that sequence going
   * backwards — and a rejection for that reason is silent, which makes it
   * indistinguishable from the move simply not working. Same for a position:
   * an item move names where the player is standing, and by the time it goes
   * out they have walked.
   */
  readonly refresh: readonly ('time' | 'position')[];
}

/**
 * The measured one.
 *
 * ```
 * 08:03:18.964  took 2595 from bag 291531 slot 0 into slot 7
 * 08:03:19.373  took 2594 from bag 291532 slot 0 into slot 1000000
 * 08:03:19.476  FAILURE, empty message, and the connection closed
 * ```
 *
 * Four hundred milliseconds between two item moves ends the session; seven
 * seconds plainly does not, and nothing in between has been measured. A second
 * is the figure both auto-loot and vault-sort settled on after paying for it,
 * and it is the floor the whole lane is held to.
 */
const ITEM_MOVE_SPACING_MS = 1000;

/**
 * Using an item, as against moving one.
 *
 * Deliberately far below {@link ITEM_MOVE_SPACING_MS}, and not measured: a
 * player in trouble drinks several potions a second and the game does not
 * object, so pacing a drink like a bag pickup would be inventing a limit in
 * order to obey it. What the lane *does* guarantee is that a use following a
 * move still waits out the move, which is the collision that was actually
 * observed.
 */
const ITEM_USE_SPACING_MS = 250;

/** Unmeasured. A portal entry is idempotent; the spacing is politeness. */
const TRAVEL_SPACING_MS = 600;

/** Unmeasured. Chat is rate-limited by the server's own visible cooldown. */
const SOCIAL_SPACING_MS = 1200;

const ENTRIES: ReadonlyMap<string, ActionLaneEntry> = new Map([
  [
    'INVENTORYSWAP',
    { lane: ActionLane.Item, spacingMs: ITEM_MOVE_SPACING_MS, refresh: ['time', 'position'] },
  ],
  ['INVDROP', { lane: ActionLane.Item, spacingMs: ITEM_MOVE_SPACING_MS, refresh: [] }],
  ['USEITEM', { lane: ActionLane.Item, spacingMs: ITEM_USE_SPACING_MS, refresh: ['time'] }],
  ['USEPORTAL', { lane: ActionLane.Travel, spacingMs: TRAVEL_SPACING_MS, refresh: [] }],
  ['TELEPORT', { lane: ActionLane.Travel, spacingMs: TRAVEL_SPACING_MS, refresh: [] }],
  ['PLAYERCALLOUT', { lane: ActionLane.Social, spacingMs: SOCIAL_SPACING_MS, refresh: [] }],
  ['PLAYERTEXT', { lane: ActionLane.Social, spacingMs: SOCIAL_SPACING_MS, refresh: [] }],
] as const);

/**
 * The lane a packet belongs to, or `undefined` for one that is not paced.
 *
 * **Not being in the table is the common case and the right default.** An
 * acknowledgement is an answer the server is already waiting on, an `ESCAPE` is
 * somebody's life, and a `MOVE` is the player walking — delaying any of those
 * to be polite about a rate limit that does not apply to them would be strictly
 * worse than sending them.
 */
export function laneOf(packetName: string): ActionLaneEntry | undefined {
  return ENTRIES.get(packetName);
}
