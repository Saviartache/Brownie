/**
 * What a plugin can say about a packet it sends toward the game server.
 *
 * **The server is not a pipe, and two of our packets landing together is not
 * twice as much of anything — it is a refusal and, a few refusals later, a
 * disconnect.** Auto-loot measured it: two item moves four hundred
 * milliseconds apart ended the session, seven seconds apart did not. But every
 * feature that sends one of those moves has its own idea of when to send it,
 * and none of them can see the others — so auto-loot pacing itself perfectly
 * says nothing about the cast auto-ability fired in the same tick.
 *
 * So the pacing is not a plugin's job any more. Everything a plugin sends goes
 * through one queue per session, and what a plugin declares here is what that
 * queue needs in order to decide *between* plugins: how badly this one is
 * wanted, whether an older copy of it is still worth sending, when it stops
 * being worth sending at all, and how to tell whether it worked.
 *
 * All of it is optional. A plugin that says nothing gets ordinary priority, a
 * default deadline, and no confirmation — which is the behaviour every existing
 * call site had before the queue existed, minus the collisions.
 */

/** How a packet's journey ended. */
export const SendOutcome = {
  /** It went out, and nothing was watching for a result. */
  Sent: 'sent',
  /** It went out and {@link SendOptions.confirm} saw it take effect. */
  Confirmed: 'confirmed',
  /**
   * It went out and nothing confirmed it before the window closed.
   *
   * **Not the same as refused, and the protocol cannot tell them apart.** A
   * move the server declined and a move it was merely slow about both answer
   * with silence, so this is what silence is reported as. Retrying is
   * reasonable; treating it as a verdict on the request is not.
   */
  Unconfirmed: 'unconfirmed',
  /**
   * The server answered `FAILURE` while it was in flight.
   *
   * The one unambiguous refusal there is, and the signal the queue itself backs
   * off on. A plugin that sees this should stop asking for the same thing.
   */
  Refused: 'refused',
  /** Its deadline passed while it was still waiting its turn. Never sent. */
  Expired: 'expired',
  /** A newer request with the same {@link SendOptions.key} replaced it. Never sent. */
  Superseded: 'superseded',
  /** The map changed, the session closed, or the queue was full. Never sent. */
  Dropped: 'dropped',
} as const;

export type SendOutcome = (typeof SendOutcome)[keyof typeof SendOutcome];

/** Whether a packet was ever put on the wire. */
export function wasSent(outcome: SendOutcome): boolean {
  return (
    outcome === SendOutcome.Sent ||
    outcome === SendOutcome.Confirmed ||
    outcome === SendOutcome.Unconfirmed ||
    outcome === SendOutcome.Refused
  );
}

/**
 * How badly a packet is wanted, when two are waiting for the same slot.
 *
 * Priority decides *order*, never spacing: a survival packet takes the next
 * slot ahead of a pickup, and still waits for that slot. Jumping the spacing is
 * the thing that ends sessions, and there is no priority that is worth one.
 */
export const SendPriority = {
  /** Staying alive — a potion at a threshold. Ahead of everything else. */
  Survival: 40,
  /** Something the player asked for by pressing a key. */
  Requested: 30,
  /** The ordinary case: a cast, a portal, a teleport. */
  Normal: 20,
  /** Housekeeping — looting, sorting a vault. Yields to all of the above. */
  Background: 10,
} as const;

export interface SendOptions {
  /** Defaults to {@link SendPriority.Normal}. */
  readonly priority?: number;
  /**
   * Names the intent, so a newer request replaces an older one still waiting.
   *
   * A feature that asks every tick would otherwise queue a tick's worth of
   * duplicates behind one slow slot and then send all of them. The key is
   * scoped to the plugin by the host, so two plugins cannot collide on one.
   */
  readonly key?: string;
  /**
   * How long this is worth sending for, from now.
   *
   * A packet that waited past its deadline is dropped rather than sent late:
   * a drink for health that has since recovered, a pickup from a bag that is no
   * longer there. Defaults to the queue's own deadline.
   */
  readonly expiresInMs?: number;
  /**
   * Whether the packet has visibly taken effect.
   *
   * Polled after it goes out, until it answers true or the window closes.
   * **While it is unanswered nothing else in its lane is sent**, which is what
   * stops a second item move being aimed with a picture of the inventory from
   * before the first one.
   */
  readonly confirm?: () => boolean;
  /** How long to poll {@link confirm} for. Defaults to the queue's own window. */
  readonly confirmWindowMs?: number;
  /**
   * Called the moment it actually leaves, with the time it left.
   *
   * **This, not the call to send, is when a plugin's own clock starts.** A
   * cooldown measured from the request is measured from a moment that has
   * nothing to do with when the server heard it.
   */
  readonly onSent?: (sentAtMs: number) => void;
  /** Called exactly once, when the journey ends. */
  readonly onOutcome?: (outcome: SendOutcome) => void;
}
