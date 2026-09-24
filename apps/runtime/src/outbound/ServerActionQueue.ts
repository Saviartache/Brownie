import {
  SendOutcome,
  SendPriority,
  Verdict,
  type MutablePacket,
  type SendOptions,
} from '@brownie/plugin-api';
import type { Logger } from '../core/logging/Logger.js';
import { ActionLane, laneOf, type ActionLaneEntry, type RefreshedField } from './actionLanes.js';

/**
 * One queue per session for everything the runtime sends toward the game
 * server.
 *
 * **The problem it exists for is that no plugin can see another one.**
 * Auto-loot spaces its pickups a second apart, auto-drink its potions by its
 * own cooldown, auto-ability its casts by the ability's own, and each of those
 * is correct on its own terms — but they are three clocks with nothing between
 * them, so the tick where a bag comes into reach while mana runs low while the
 * tome comes off cooldown puts three item packets on the wire inside a
 * millisecond. The server carries out one of them. The others get silence,
 * their plugins conclude nothing happened and ask again, and a few rounds of
 * that is the disconnect this repository already has three separate comments
 * about.
 *
 * So there is one clock, it lives here, and nothing goes around it.
 *
 * What it does, in order of how much it matters:
 *
 * 1. **Puts a paced packet on the wire only straight after one of the
 *    client's own.** The game client never sends anything ahead of the shot
 *    acknowledgements it owes: every send it makes first flushes a
 *    `SHOOTACKCOUNTER` for the shots it has taken in since its last one
 *    (`SocketManager.FlushAckMessages` in the game's own code). A packet
 *    injected at any other moment — from a timer, or from a server tick that
 *    has not reached the client yet — can overtake acknowledgements the client
 *    already owes, and the server then hears an action stamped later than
 *    acknowledgements that arrive after it: an order the real client cannot
 *    produce. Right after the client has spoken it owes nothing, so that is
 *    the only moment anything here goes out. See {@link clientPacketPassed}.
 * 2. **Spaces packets within a lane**, at the floor `actionLanes.ts` records —
 *    including around the *player's* own packets, which are counted here even
 *    though we did not send them. Two plugins can no longer collide, and
 *    neither can a plugin and the player.
 * 3. **Waits for one packet to settle before sending the next in its lane**,
 *    where the caller said how to tell. A second item move aimed with a
 *    picture of the inventory from before the first one is the other half of
 *    what the server refuses.
 * 4. **Backs off when the server says `FAILURE`.** That is the only
 *    unambiguous complaint the protocol has, and it is what precedes a kick.
 *    Each one holds every lane, and consecutive ones hold them longer, up to a
 *    cap — so the shape that ends sessions, a plugin retrying into a server
 *    that is already unhappy, cannot happen.
 * 5. **Drops what is no longer worth sending** rather than sending it late: a
 *    request past its deadline, a request a newer one replaced, an item
 *    request aimed at an inventory the player's own hands have since changed,
 *    and everything at all once the map changes.
 *
 * What it deliberately does *not* do is delay anything the table does not
 * name. An acknowledgement, an `ESCAPE`, a `MOVE` — those go out the moment
 * they are asked for, through the same call, untouched.
 */

/** How often an unconfirmed packet is asked again whether it landed. */
const CONFIRM_POLL_MS = 60;

/**
 * The one client packet that never ends what the client is saying.
 *
 * The client writes these immediately ahead of the message whose sending
 * flushed them, so after one of them that message is still to come — and a
 * packet of ours slipped in between would sit ahead of a message the
 * acknowledgements are meant to precede, stamped later than they are.
 */
const SHOT_ACKNOWLEDGEMENT = 'SHOOTACKCOUNTER';

/** Far enough in the past that the first packet of a session never waits. */
const NEVER = Number.NEGATIVE_INFINITY;

/** Do not rebuild the timer for a wake-up this close to the one already set. */
const RESCHEDULE_EPSILON_MS = 2;

/** The numbers the queue runs on. The lane spacings are in `actionLanes.ts`. */
export interface ServerActionQueueTuning {
  /**
   * How long a request is worth sending for, when the caller does not say.
   *
   * Short on purpose: nearly everything queued here is a reaction to a world
   * that has moved on by the time three seconds have passed.
   */
  readonly defaultExpiryMs: number;
  /** How long to poll a caller's `confirm` for, when it does not say. */
  readonly defaultConfirmWindowMs: number;
  /** Most requests one lane will hold. Beyond it, the least wanted is dropped. */
  readonly maxQueuedPerLane: number;
  /** How long after a packet went out a `FAILURE` is still taken to be about it. */
  readonly failureAttributionMs: number;
  /** How long every lane is held after one `FAILURE`. Doubles per consecutive one. */
  readonly failureHoldMs: number;
  /** The cap that doubling stops at. */
  readonly maxFailureHoldMs: number;
  /** Quiet time after a `FAILURE` before the streak counts as broken. */
  readonly failureCalmMs: number;
}

const DEFAULT_TUNING: ServerActionQueueTuning = {
  defaultExpiryMs: 3000,
  defaultConfirmWindowMs: 1500,
  maxQueuedPerLane: 16,
  failureAttributionMs: 2500,
  failureHoldMs: 2000,
  maxFailureHoldMs: 15_000,
  failureCalmMs: 10_000,
};

export interface ServerActionQueueOptions {
  /**
   * Puts a packet on the wire, now.
   *
   * @returns false when it could not be built at all — a malformed field, a
   *   name the registry does not know. Such a request is dropped rather than
   *   retried: it would fail the same way next time.
   */
  readonly send: (packetName: string, fields: Record<string, unknown>) => boolean;
  /**
   * Fills in the fields that describe the moment of sending.
   *
   * Called immediately before {@link ServerActionQueueOptions.send}, never at
   * submission — see {@link ActionLaneEntry.refresh} for why a stamp built a
   * second ago is a packet the server throws away.
   */
  readonly refresh: (fields: Record<string, unknown>, which: readonly RefreshedField[]) => void;
  readonly log: Logger;
  /** Wall clock. Injectable so a test can drive the queue without waiting. */
  readonly now?: () => number;
  /**
   * Schedules the next pump, and returns a function that cancels it.
   *
   * Injectable for the same reason as {@link ServerActionQueueOptions.now}.
   */
  readonly schedule?: (fn: () => void, ms: number) => () => void;
  readonly tuning?: Partial<ServerActionQueueTuning>;
}

interface QueuedAction {
  readonly packetName: string;
  readonly fields: Record<string, unknown>;
  readonly entry: ActionLaneEntry;
  readonly priority: number;
  readonly key: string | undefined;
  readonly expiresAtMs: number;
  readonly confirm: (() => boolean) | undefined;
  readonly confirmWindowMs: number;
  readonly onSent: (() => void) | undefined;
  readonly onOutcome: ((outcome: SendOutcome) => void) | undefined;
  /** Submission order, which breaks ties between equal priorities. */
  readonly sequence: number;
  /** Whether it reached the wire. Its outcome alone cannot say — see `Dropped`. */
  sent: boolean;
  settled: boolean;
}

interface LaneState {
  readonly name: ActionLane;
  readonly queued: QueuedAction[];
  inFlight: QueuedAction | undefined;
  inFlightSentAtMs: number;
  inFlightDeadlineMs: number;
  /** When something last went out in this lane — ours or the player's own. */
  lastSentAtMs: number;
  /** The spacing that packet asks for, which the next one must also clear. */
  lastSpacingMs: number;
}

export class ServerActionQueue {
  readonly #send: (packetName: string, fields: Record<string, unknown>) => boolean;
  readonly #refresh: (fields: Record<string, unknown>, which: readonly RefreshedField[]) => void;
  readonly #log: Logger;
  readonly #now: () => number;
  readonly #schedule: (fn: () => void, ms: number) => () => void;
  readonly #tuning: ServerActionQueueTuning;

  readonly #lanes = new Map<ActionLane, LaneState>();

  #sequence = 0;
  #cancelWake: (() => void) | undefined;
  #wakeAtMs = Number.POSITIVE_INFINITY;

  /** Until when every lane is quiet because the server complained. */
  #holdUntilMs = NEVER;
  #failureStreak = 0;
  #lastFailureAtMs = NEVER;
  #closed = false;
  /**
   * Whether a paced packet may go out right now.
   *
   * True only for the length of {@link clientPacketPassed}: straight after the
   * client has spoken is the one point in its stream where it owes nothing.
   */
  #mayDispatch = false;

  constructor(options: ServerActionQueueOptions) {
    this.#send = options.send;
    this.#refresh = options.refresh;
    this.#log = options.log;
    this.#now = options.now ?? Date.now;
    this.#schedule = options.schedule ?? defaultSchedule;
    this.#tuning = { ...DEFAULT_TUNING, ...options.tuning };

    for (const name of Object.values(ActionLane)) {
      this.#lanes.set(name, {
        name,
        queued: [],
        inFlight: undefined,
        inFlightSentAtMs: NEVER,
        inFlightDeadlineMs: NEVER,
        lastSentAtMs: NEVER,
        lastSpacingMs: 0,
      });
    }
  }

  /** How many requests are waiting, across every lane. For tests and the log. */
  get depth(): number {
    let total = 0;
    for (const lane of this.#lanes.values()) total += lane.queued.length;
    return total;
  }

  /** True while the server's last word was a complaint and nothing is going out. */
  get holding(): boolean {
    return this.#now() < this.#holdUntilMs;
  }

  /**
   * Sends a packet that is not paced, or queues one that is.
   *
   * @returns true when it went out during this call. That is every packet the
   *   lane table does not name, and a paced one only when it is asked for
   *   while the queue is already following one of the client's own packets —
   *   see {@link clientPacketPassed}. False means it is waiting, and
   *   {@link SendOptions.onOutcome} is how the caller learns what became of it.
   */
  submit(packetName: string, fields: Record<string, unknown>, options: SendOptions = {}): boolean {
    if (this.#closed) {
      this.#finish(options.onOutcome, SendOutcome.Dropped);
      return false;
    }

    const entry = laneOf(packetName);
    // Not a paced packet: an acknowledgement, an escape, a movement. The queue
    // is not in the way of those and must never be why one is late.
    if (entry === undefined) {
      if (!this.#send(packetName, fields)) {
        this.#finish(options.onOutcome, SendOutcome.Dropped);
        return false;
      }
      this.#report(options.onSent);
      this.#finish(options.onOutcome, SendOutcome.Sent);
      return true;
    }

    const lane = this.#lane(entry.lane);
    const nowMs = this.#now();
    const action: QueuedAction = {
      packetName,
      fields,
      entry,
      priority: options.priority ?? SendPriority.Normal,
      key: options.key,
      expiresAtMs: nowMs + (options.expiresInMs ?? this.#tuning.defaultExpiryMs),
      confirm: options.confirm,
      confirmWindowMs: options.confirmWindowMs ?? this.#tuning.defaultConfirmWindowMs,
      onSent: options.onSent,
      onOutcome: options.onOutcome,
      sequence: ++this.#sequence,
      sent: false,
      settled: false,
    };

    this.#supersede(lane, action);
    lane.queued.push(action);
    this.#trim(lane);
    this.pump();
    return action.sent;
  }

  /**
   * Shows the queue a packet the server sent, before any plugin reacts to it.
   *
   * **A `FAILURE` is the server's only unambiguous complaint**, and it arrives
   * shortly after whatever caused it — so it is charged to what we last sent,
   * and holds every lane while it is worked out.
   *
   * Nothing is sent from here. A server packet is exactly the moment the
   * client has not yet caught up with — see {@link clientPacketPassed}.
   *
   * Takes the packet rather than a description of it. This runs for every
   * server packet of a session, the busiest path there is, and building a
   * small object to describe each one would be an allocation per packet.
   */
  observe(packet: MutablePacket): void {
    if (this.#closed) return;

    if (packet.name === 'FAILURE') {
      // The fields are read only here: an opaque `FAILURE` has none to give,
      // and the complaint still counts — it just cannot be described.
      this.#onFailure(packet.number('errorId'), packet.string('errorMessage'));
      return;
    }
    // An object id is only unique within a map, and so is everything queued
    // against one. Delivering a pickup into the map after the one it was asked
    // for is worse than not delivering it.
    if (packet.name === 'MAPINFO') {
      this.clear('the map changed');
      return;
    }
    this.pump();
  }

  /**
   * One of the client's own packets has just been dealt with — forwarded to
   * the server, or withheld by a stage — and nothing has been read from either
   * side since.
   *
   * **The only moment a paced packet goes out.** Every packet the game client
   * sends is preceded by the shot acknowledgements it owes, so right after one
   * of them it owes none: a packet of ours placed here sits where the client's
   * own next action would, behind every acknowledgement for a shot the client
   * had seen, and stamped no later than anything the client says next. Placed
   * anywhere else it can overtake an acknowledgement the client already owes.
   * The client answers every server tick with a `MOVE`, so the wait for this
   * is at most a tick and usually far less.
   *
   * A packet a stage withheld is still such a moment — the acknowledgements
   * ahead of it went out — but the server never heard it, so it neither counts
   * against a lane nor makes anything of ours stale.
   */
  clientPacketPassed(packet: MutablePacket): void {
    if (this.#closed) return;
    if (packet.verdict !== Verdict.Drop) this.#heardFromClient(packet.name);
    if (packet.name === SHOT_ACKNOWLEDGEMENT) return;

    this.#mayDispatch = true;
    try {
      this.pump();
    } finally {
      this.#mayDispatch = false;
    }
  }

  /**
   * Sends whatever is due, resolves whatever has settled, and arranges to be
   * called again.
   *
   * Idempotent and cheap when there is nothing to do, which is most of the
   * time: it runs on every packet as well as on its own timer, and waking early
   * is not a problem because it simply finds nothing due. Only a pump inside
   * {@link clientPacketPassed} sends anything paced; every other one settles,
   * expires and waits.
   */
  pump(): void {
    if (this.#closed) return;
    const nowMs = this.#now();

    if (this.#failureStreak > 0 && nowMs - this.#lastFailureAtMs > this.#tuning.failureCalmMs) {
      this.#failureStreak = 0;
    }

    for (const lane of this.#lanes.values()) {
      this.#resolveInFlight(lane, nowMs);
      this.#dropExpired(lane, nowMs);
      if (!this.#mayDispatch) continue;
      if (lane.inFlight !== undefined) continue;
      if (nowMs < this.#holdUntilMs) continue;

      const next = this.#next(lane);
      if (next === undefined) continue;
      // The longer of what the packet before asked for and what this one asks
      // for, so one expensive packet raises the floor around itself.
      const spacing = Math.max(lane.lastSpacingMs, next.entry.spacingMs);
      if (nowMs - lane.lastSentAtMs < spacing) continue;

      this.#dispatch(lane, next, nowMs);
    }

    this.#arrangeWake(nowMs);
  }

  /** Gives up on everything waiting and in flight, telling each caller why. */
  clear(reason: string): void {
    let dropped = 0;
    for (const lane of this.#lanes.values()) {
      for (const action of lane.queued.splice(0)) {
        dropped += 1;
        this.#settle(action, SendOutcome.Dropped);
      }
      const inFlight = lane.inFlight;
      if (inFlight === undefined) continue;
      lane.inFlight = undefined;
      // **Not dropped: it was sent.** All that is being given up on is watching
      // for it, and a caller told "never left" about a packet the server has
      // already acted on would put its own bookkeeping back by one move.
      this.#settle(inFlight, SendOutcome.Unconfirmed);
    }
    if (dropped > 0) this.#log.debug(`dropped ${String(dropped)} queued packets: ${reason}`);
  }

  /** Stops the queue for good. Nothing goes out after this. */
  dispose(): void {
    if (this.#closed) return;
    // Closed *before* the drain, not after: an outcome handler is a plugin's
    // code and may well answer by asking to send something. Asked after this
    // line, it is refused at once; asked before it, the request would land in a
    // queue that has just been emptied and will never be emptied again.
    this.#closed = true;
    this.clear('the session closed');
    this.#cancelWake?.();
    this.#cancelWake = undefined;
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  #lane(name: ActionLane): LaneState {
    const lane = this.#lanes.get(name);
    // Every lane is built in the constructor from the same enumeration the
    // table draws from, so this cannot happen — but throwing here is better
    // than a non-null assertion that would hide a table gone stale.
    if (lane === undefined) throw new Error(`no such lane: ${name}`);
    return lane;
  }

  /**
   * Counts a packet the player's own client put on the wire.
   *
   * **A lane's floor applies to the player exactly as it applies to us** — a
   * plugin racing the player's hands is the same collision as two plugins
   * racing. Our own packets never come through here, so nothing is counted
   * twice.
   *
   * **And an item packet of theirs changes the inventory every item request
   * still waiting here was aimed with.** A swap into the slot they have just
   * filled, or a drink from the slot they have just emptied, names contents
   * the server no longer has — and the reference implementation found that the
   * server hangs up over a swap whose slot contents disagree with its own
   * rather than ignoring it. So those are dropped, and each plugin asks again
   * from the next tick's picture.
   */
  #heardFromClient(packetName: string): void {
    const entry = laneOf(packetName);
    if (entry === undefined) return;
    const lane = this.#lane(entry.lane);
    lane.lastSentAtMs = this.#now();
    lane.lastSpacingMs = entry.spacingMs;

    if (entry.lane !== ActionLane.Item || lane.queued.length === 0) return;
    const stale = lane.queued.splice(0);
    for (const action of stale) this.#settle(action, SendOutcome.Dropped);
    this.#log.debug(
      `dropped ${String(stale.length)} queued item packets: the player moved or used an item`,
    );
  }

  /** Replaces an older request that named the same intent. */
  #supersede(lane: LaneState, action: QueuedAction): void {
    if (action.key === undefined) return;
    for (let i = lane.queued.length - 1; i >= 0; i--) {
      const existing = lane.queued[i];
      if (existing === undefined || existing.key !== action.key) continue;
      lane.queued.splice(i, 1);
      this.#settle(existing, SendOutcome.Superseded);
    }
  }

  /**
   * Holds the lane to its cap by dropping the least wanted request.
   *
   * A queue that grows without bound eventually sends a minute of stale
   * intentions in a burst, which is the exact failure it exists to prevent. The
   * cheapest and oldest goes, never the newest: what was just asked for
   * describes the world as it is now.
   */
  #trim(lane: LaneState): void {
    while (lane.queued.length > this.#tuning.maxQueuedPerLane) {
      let worstIndex = 0;
      for (let i = 1; i < lane.queued.length; i++) {
        const candidate = lane.queued[i];
        const worst = lane.queued[worstIndex];
        if (candidate === undefined || worst === undefined) continue;
        if (
          candidate.priority < worst.priority ||
          (candidate.priority === worst.priority && candidate.sequence < worst.sequence)
        ) {
          worstIndex = i;
        }
      }
      const [dropped] = lane.queued.splice(worstIndex, 1);
      if (dropped === undefined) return;
      this.#log.warn(`the ${lane.name} queue is full; dropped a ${dropped.packetName}`);
      this.#settle(dropped, SendOutcome.Dropped);
    }
  }

  /** The most wanted request, oldest first among equals. */
  #next(lane: LaneState): QueuedAction | undefined {
    let best: QueuedAction | undefined;
    for (const action of lane.queued) {
      if (
        best === undefined ||
        action.priority > best.priority ||
        (action.priority === best.priority && action.sequence < best.sequence)
      ) {
        best = action;
      }
    }
    return best;
  }

  #dropExpired(lane: LaneState, nowMs: number): void {
    for (let i = lane.queued.length - 1; i >= 0; i--) {
      const action = lane.queued[i];
      if (action === undefined || nowMs < action.expiresAtMs) continue;
      lane.queued.splice(i, 1);
      this.#settle(action, SendOutcome.Expired);
    }
  }

  #resolveInFlight(lane: LaneState, nowMs: number): void {
    const action = lane.inFlight;
    if (action === undefined) return;
    if (this.#confirmed(action)) {
      lane.inFlight = undefined;
      // Evidence that the server is listening, which breaks a streak of
      // complaints properly rather than waiting the calm period out.
      this.#failureStreak = 0;
      this.#settle(action, SendOutcome.Confirmed);
      return;
    }
    if (nowMs < lane.inFlightDeadlineMs) return;
    lane.inFlight = undefined;
    this.#settle(action, SendOutcome.Unconfirmed);
  }

  #confirmed(action: QueuedAction): boolean {
    const confirm = action.confirm;
    if (confirm === undefined) return false;
    try {
      return confirm();
    } catch (cause) {
      // A confirmation that throws is a broken caller, not a refusal. Report it
      // and let the deadline decide, so one bad predicate cannot wedge a lane.
      this.#log.error(`confirming ${action.packetName} threw`, cause);
      return false;
    }
  }

  #dispatch(lane: LaneState, action: QueuedAction, nowMs: number): void {
    const index = lane.queued.indexOf(action);
    if (index >= 0) lane.queued.splice(index, 1);

    this.#refresh(action.fields, action.entry.refresh);
    // Counted as sent before the result is known: a packet the encoder refused
    // never reached the server, but one that did must hold the lane even if
    // everything after it goes wrong.
    lane.lastSentAtMs = nowMs;
    lane.lastSpacingMs = action.entry.spacingMs;

    if (!this.#send(action.packetName, action.fields)) {
      this.#settle(action, SendOutcome.Dropped);
      return;
    }

    action.sent = true;
    this.#report(action.onSent);

    if (action.confirm === undefined) {
      this.#settle(action, SendOutcome.Sent);
      return;
    }
    lane.inFlight = action;
    lane.inFlightSentAtMs = nowMs;
    lane.inFlightDeadlineMs = nowMs + action.confirmWindowMs;
  }

  /**
   * Charges a `FAILURE` to whatever we last sent, and goes quiet.
   *
   * **Quiet either way, including when nothing of ours can be blamed.** We
   * cannot prove a complaint was not about us — the packet names nothing — and
   * the cost of being wrong in the two directions is not remotely symmetric: a
   * pickup delayed two seconds against a session ended.
   */
  #onFailure(errorId: number | undefined, errorMessage: string | undefined): void {
    const nowMs = this.#now();

    let blamedLane: LaneState | undefined;
    for (const lane of this.#lanes.values()) {
      if (lane.inFlight === undefined) continue;
      if (nowMs - lane.inFlightSentAtMs > this.#tuning.failureAttributionMs) continue;
      if (blamedLane === undefined || lane.inFlightSentAtMs > blamedLane.inFlightSentAtMs) {
        blamedLane = lane;
      }
    }

    this.#failureStreak += 1;
    this.#lastFailureAtMs = nowMs;
    const holdMs = Math.min(
      this.#tuning.failureHoldMs * 2 ** (this.#failureStreak - 1),
      this.#tuning.maxFailureHoldMs,
    );
    this.#holdUntilMs = Math.max(this.#holdUntilMs, nowMs + holdMs);

    const described = `FAILURE [${String(errorId ?? -1)}] ${errorMessage ?? ''}`.trim();
    const quiet = `every lane is quiet for ${String(holdMs)} ms`;
    const blamed = blamedLane?.inFlight;
    if (blamedLane !== undefined && blamed !== undefined) {
      blamedLane.inFlight = undefined;
      this.#settle(blamed, SendOutcome.Refused);
      this.#log.warn(`${described} — charged to our ${blamed.packetName}; ${quiet}`);
    } else {
      this.#log.warn(`${described} — nothing of ours was in flight, but ${quiet}`);
    }

    this.pump();
  }

  /** Works out when the next thing could possibly happen, and sleeps until then. */
  #arrangeWake(nowMs: number): void {
    let wakeAtMs = Number.POSITIVE_INFINITY;
    const soonest = (at: number): void => {
      if (at < wakeAtMs) wakeAtMs = at;
    };

    for (const lane of this.#lanes.values()) {
      if (lane.inFlight !== undefined) {
        // Polled, because a confirmation is a fact about the world rather than
        // a packet: the inventory filling is what proves a move landed, and no
        // single packet announces it.
        soonest(Math.min(lane.inFlightDeadlineMs, nowMs + CONFIRM_POLL_MS));
      }
      // **Never to send.** A waiting packet goes out behind the client's next
      // one of its own and at no other time, so the timer's only business
      // with it is dropping it at its deadline — and telling its caller so
      // while the session is quiet enough that nothing else would.
      for (const action of lane.queued) soonest(action.expiresAtMs);
    }

    if (wakeAtMs === Number.POSITIVE_INFINITY) {
      this.#cancelWake?.();
      this.#cancelWake = undefined;
      this.#wakeAtMs = Number.POSITIVE_INFINITY;
      return;
    }
    // A wake-up already due at or before this one is left alone: pumping early
    // costs a walk over three mostly empty lanes, while rebuilding the timer on
    // every packet costs a timer per packet.
    if (this.#cancelWake !== undefined && this.#wakeAtMs <= wakeAtMs + RESCHEDULE_EPSILON_MS) {
      return;
    }
    this.#cancelWake?.();
    this.#wakeAtMs = wakeAtMs;
    // **Never zero.** A wake-up already due means the pass above found work it
    // could not do and could not say why; waking immediately would find the
    // same thing and ask again, forever, at whatever rate the event loop
    // allows. Degrading to a slow poll turns a bug into a delay.
    const delayMs = wakeAtMs - nowMs;
    this.#cancelWake = this.#schedule(
      () => {
        this.#cancelWake = undefined;
        this.#wakeAtMs = Number.POSITIVE_INFINITY;
        this.pump();
      },
      delayMs > 0 ? delayMs : CONFIRM_POLL_MS,
    );
  }

  #settle(action: QueuedAction, outcome: SendOutcome): void {
    if (action.settled) return;
    action.settled = true;
    this.#finish(action.onOutcome, outcome);
  }

  /** Runs a caller's outcome handler once, isolating its failure. */
  #finish(onOutcome: ((outcome: SendOutcome) => void) | undefined, outcome: SendOutcome): void {
    if (onOutcome === undefined) return;
    try {
      onOutcome(outcome);
    } catch (cause) {
      this.#log.error(`an outcome handler threw on "${outcome}"`, cause);
    }
  }

  #report(onSent: (() => void) | undefined): void {
    if (onSent === undefined) return;
    try {
      onSent();
    } catch (cause) {
      this.#log.error('a sent handler threw', cause);
    }
  }
}

function defaultSchedule(fn: () => void, ms: number): () => void {
  const handle = setTimeout(fn, ms);
  // The queue must never be the reason the process cannot exit: what is waiting
  // in it is a convenience, and shutdown is not negotiable.
  handle.unref();
  return () => {
    clearTimeout(handle);
  };
}
