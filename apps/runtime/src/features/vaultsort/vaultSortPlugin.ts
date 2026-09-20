/**
 * Vault sort: rearrange the chest you are standing at into a chosen order.
 *
 * **A key press, not a switch.** Sorting is something a player *does*, once,
 * standing at a chest — so the bind the overlay offers is bound to a hidden
 * boolean that the press sets and the plugin puts straight back, the same shape
 * noclip's armed setting has. A press during a sort that is already running
 * does not restart anything: the sort already running is working from the
 * freshest state there is, and a second opinion adds nothing.
 *
 * **One picture, adopted from whatever states it.** The first live run of this
 * stopped itself at once: the server sends a fresh `VAULTCONTENT` when the
 * chest's panel opens and when its contents change, so a snapshot that
 * included this feature's own first move arrived *before* the `INVRESULT` for
 * it — and a sort holding a private copy of the chest saw the snapshot
 * "disagree" and gave up. There is no private copy any more. The chest as
 * `VaultChests` holds it is the only picture, and every packet the server
 * sends about it is adopted, idempotently.
 *
 * **Every move goes into an empty slot.** The third live run proved that a
 * swap naming two *occupied* chest slots is not carried out as an exchange:
 * the server confirmed each one, the picture here updated, and the chest's
 * items piled into a single slot instead of trading places. A move into an
 * empty slot is the rearrangement the game's own client performs on a chest
 * and the one the reference mule ran a whole session on — so it is the only
 * shape this puts on the wire (see `planMoves`), and a chest with no empty
 * slot at all is refused rather than risked.
 *
 * What *does* stop a sort: three moves in a row that nothing confirmed — a
 * refusal is silence in this protocol, and re-sending against an unresponsive
 * chest forever is how a feature becomes a packet-a-second nuisance; a swap
 * the player's own hands made against the chest, because fighting the player
 * for their own inventory is rude even when it would win; the chest filling
 * up under the sort, with nowhere left to move through; the map changing; and
 * the chest leaving a fresh snapshot.
 *
 * **Pacing is a floor on everything this sends, and it is never reset.** Two
 * item moves inside half a second end the session — that is auto-loot's
 * lesson, paid for on a live connection — so the default here is the same
 * second. A full seasonal chest sorted from scratch is a few hundred moves,
 * which is deliberately a patient few minutes rather than a scramble the
 * server answers by hanging up.
 */

import {
  PluginCategory,
  SendOutcome,
  SendPriority,
  definePlugin,
  wasSent,
  type Plugin,
  type SessionView,
} from '@brownie/plugin-api';
import type { ItemFacts } from '../../gamedata/items.js';
import {
  VaultSortOrder,
  planMoves,
  sortedSlots,
  type PlannedMove,
  type SortableItem,
} from './sortPlan.js';
import {
  VaultChests,
  contentsDiffer,
  slotRefOf,
  type SlotRef,
  type VaultChest,
} from './vaultChests.js';

/** What the composition root hands over: the game's own data, read once. */
export interface VaultSortInputs {
  readonly item: (objectType: number) => ItemFacts | undefined;
  readonly displayName: (objectType: number) => string | undefined;
}

/**
 * How close the player must be to the chest. The same distance the game itself
 * insists on for taking from a bag — one tile, not a radius worth arguing
 * about — because a swap sent from further away is refused by the server.
 */
const CHEST_INTERACT_TILES = 1;

/** How long a move is waited on before it counts as unconfirmed. */
const PENDING_TIMEOUT_MS = 4000;

/** How many unconfirmed moves in a row end the sort. */
const MAX_UNCONFIRMED_MOVES = 3;

/** How often the sort looks at whether it may send its next move. */
const DRIVER_TICK_MS = 100;

/**
 * How long a move waiting in the session's outbound queue is still worth making.
 *
 * Shorter than {@link PENDING_TIMEOUT_MS}, because a request that has not left
 * yet describes the chest as it was when it was planned, and the plan is cheap
 * to make again. A lapsed one costs a driver tick, not a strike.
 */
const QUEUE_EXPIRY_MS = 2500;

/** The default least time between two moves — auto-loot's, for its reasons. */
const MOVE_INTERVAL_MS = 1000;

const ORDER_CHOICES = [
  [VaultSortOrder.Type, 'Type — weapons, abilities, armour, rings, then the rest'],
  [VaultSortOrder.Name, 'Alphabetical'],
  [VaultSortOrder.Feed, 'Feed power, best first'],
] as const;

/**
 * A sort in flight.
 *
 * Nothing of the plan is kept between moves. Every move goes into a slot the
 * picture calls empty, so every move that lands changes the picture — which
 * means re-planning from the chest after each one always makes progress, and a
 * fresh plan can never re-ask a move that already happened. (That is not a
 * free property: it was earned by never exchanging two occupied slots. When
 * this feature still did that, a swap of two slots holding one item type
 * landed invisibly, and a re-planning sort re-asked it every second, forever.)
 */
interface SortRun {
  /** Which chest, by what the player calls it — stable across entity re-issues. */
  readonly label: string;
  /** The chest entity in the current map; re-pointed by each fresh snapshot. */
  chestObjectId: number;
  /**
   * The move that has been asked for and not yet seen to land.
   *
   * `sentAtMs` is when it **left**, which is not when it was decided: a move
   * goes into the session's one outbound queue and waits there for whatever
   * else the runtime is sending. It is positive infinity — "not out" — until
   * the queue says otherwise, so {@link PENDING_TIMEOUT_MS} is never spent on
   * a move that has not been asked yet.
   */
  pending: { move: PlannedMove; sentAtMs: number } | undefined;
  /** When the last move left, so the spacing floor spans the whole sort. */
  lastSendAtMs: number;
  /** Moves in a row that nothing confirmed. {@link MAX_UNCONFIRMED_MOVES} end it. */
  strikes: number;
  movesDone: number;
}

interface SessionState {
  readonly chests: VaultChests;
  run: SortRun | undefined;
}

export function createVaultSortPlugin(inputs: VaultSortInputs): Plugin {
  return definePlugin({
    meta: {
      id: 'vault-sort',
      name: 'Vault Sort',
      category: PluginCategory.Items,
      description: 'Sorts the vault chest you stand at — by type, name or feed power.',
      // Inert until the key is pressed — nothing runs between presses — so it
      // starts enabled: a key that does nothing until a panel is opened fails
      // the first time it is wanted.
      enabledByDefault: true,
      bindable: [
        {
          setting: 'sortNow',
          label: 'Sort now',
          announce: { name: 'Vault Sort', on: 'sorting', off: 'rearmed' },
        },
      ],
    },

    setup(context) {
      const orderBy = context.settings.select<VaultSortOrder>('orderBy', {
        label: 'Sort by',
        default: VaultSortOrder.Type,
        options: ORDER_CHOICES,
      });
      // Where the server's real limit sits is not known — four hundred
      // milliseconds between two moves ends the session and seven seconds
      // plainly does not — so the floor is the player's to widen, not ours to
      // shrink below what auto-loot taught.
      const moveIntervalMs = context.settings.range('moveIntervalMs', {
        label: 'Least time between moves (ms)',
        default: MOVE_INTERVAL_MS,
        min: 500,
        max: 5000,
        step: 100,
        advanced: true,
      });
      // The bind's slot. Hidden: it is a one-shot the key sets and this puts
      // back, not a knob anything draws.
      const sortNow = context.settings.boolean('sortNow', {
        default: false,
        hidden: true,
      });
      // A run that died mid-sort must not come back armed: nothing would fire
      // on the change, and the next press would look like no change at all.
      if (sortNow.get()) sortNow.set(false);

      const bySession = new Map<string, SessionState>();
      const stateFor = (session: SessionView): SessionState => {
        let state = bySession.get(session.id);
        if (state === undefined) {
          state = { chests: new VaultChests(), run: undefined };
          bySession.set(session.id, state);
        }
        return state;
      };

      const sortable = (objectType: number): SortableItem | undefined => {
        const facts = inputs.item(objectType);
        const name = inputs.displayName(objectType) ?? '';
        if (facts === undefined) {
          // Named but not described — a catalog gap, not a chest stranger:
          // it still sorts, by name, among the rest.
          return name === '' ? undefined : { name, slotType: -1, tier: undefined, feedPower: 0 };
        }
        return {
          name,
          slotType: facts.slotType,
          tier: facts.tier,
          feedPower: facts.feedPower,
        };
      };

      /** Records that the move that was out has landed, however we came to see it. */
      const moveLanded = (run: SortRun): void => {
        run.pending = undefined;
        run.strikes = 0;
        run.movesDone += 1;
      };

      /**
       * Plans the sort from the chest as it stands right now: the order the
       * player asked for, and the moves into empty slots that reach it.
       */
      const planFor = (chest: VaultChest): readonly PlannedMove[] =>
        planMoves(chest.contents, sortedSlots(chest.contents, orderBy.get(), sortable));

      /** The one line a full chest gets — see {@link begin} for why it refuses. */
      const fullChest = 'The chest is full — leave a slot empty for the sort to move through.';

      const stop = (session: SessionView, state: SessionState, why: string): void => {
        state.run = undefined;
        session.notify(why, 'Vault Sort');
      };

      // ── The press ────────────────────────────────────────────────────────

      const begin = (session: SessionView | undefined): void => {
        if (session === undefined) return;
        const state = stateFor(session);

        if (state.run !== undefined) {
          session.notify('Already sorting — press again once it finishes.', 'Vault Sort');
          return;
        }

        const chest = nearestChest(session, state.chests);
        if (chest === undefined) {
          session.notify(
            state.chests.chests().length > 0
              ? `No vault chest within ${String(CHEST_INTERACT_TILES)} tile of you.`
              : 'No vault chest seen yet — enter the vault first.',
            'Vault Sort',
          );
          return;
        }

        const items = chest.contents.filter((type) => type >= 0).length;
        if (items === 0) {
          session.notify('The chest is empty.', 'Vault Sort');
          return;
        }
        // With nowhere to move through, the only rearrangement left is the
        // exchange of two occupied slots — the one shape a live server carried
        // out as anything but an exchange. An honest refusal beats a scrambled
        // chest.
        if (items === chest.contents.length) {
          session.notify(fullChest, 'Vault Sort');
          return;
        }

        const moves = planFor(chest);
        if (moves.length === 0) {
          session.notify('Already in order — nothing to move.', 'Vault Sort');
          return;
        }

        state.run = {
          label: chest.label,
          chestObjectId: chest.objectId,
          pending: undefined,
          // Sent in the past: the first move may leave as soon as the driver
          // next looks, which is the point of pressing the key.
          lastSendAtMs: -Number.MAX_SAFE_INTEGER,
          strikes: 0,
          movesDone: 0,
        };
        session.notify(
          `Sorting the ${chest.label} — ${counted(items, 'item')}, ${counted(moves.length, 'move')}.`,
          'Vault Sort',
        );
      };

      // Rearm only after the press has been consumed: the hotkey router reads
      // the setting back to say what the key did, and a reset it could already
      // see would have the line say "rearmed" on the press that asked for a
      // sort.
      sortNow.onChange((on) => {
        if (!on) return;
        context.timers.setTimeout(() => {
          sortNow.set(false);
        }, 0);
        begin(context.sessions.current());
      });

      context.commands.register({
        name: 'sortvault',
        description: 'Sort the vault chest you are standing at.',
        run: (_args, session) => {
          begin(session);
        },
      });

      // ── The chest as the server states it ────────────────────────────────

      context.packets.on('VAULTCONTENT', (packet, session) => {
        const state = stateFor(session);
        const snapshot = (
          objectId: unknown,
          contents: unknown,
          label: string,
        ): VaultChest | undefined =>
          typeof objectId === 'number' && Array.isArray(contents)
            ? { objectId, contents: contents.map(toItemType), label }
            : undefined;

        const run = state.run;
        const before = run === undefined ? undefined : state.chests.chestByLabel(run.label);
        state.chests.replace(
          snapshot(packet.number('vaultChestObjectId'), packet.get('vaultContents'), 'vault chest'),
          snapshot(
            packet.number('seasonalSpoilChestObjectId'),
            packet.get('seasonalSpoilContent'),
            'seasonal spoils chest',
          ),
        );
        context.log.debug(
          `snapshot: ${
            state.chests
              .chests()
              .map(
                (chest) =>
                  `${chest.label} #${String(chest.objectId)} (${String(chest.contents.length)} slots)`,
              )
              .join(', ') || 'no chests'
          }`,
        );

        if (run === undefined) return;
        const after = state.chests.chestByLabel(run.label);
        if (after === undefined) {
          stop(session, state, 'Sort stopped — the chest left the vault list.');
          return;
        }
        run.chestObjectId = after.objectId;
        // A snapshot that includes a move of ours before its result reached us
        // is that move landing, not the chest moving on: the plan is asked for
        // afresh after every move, so this needs no explaining away.
        if (run.pending !== undefined && contentsDiffer(before?.contents, after.contents)) {
          moveLanded(run);
        }
      });

      context.packets.on('INVRESULT', (packet, session) => {
        const state = stateFor(session);
        const from = slotRefOf(packet.get('fromSlot'));
        const to = slotRefOf(packet.get('toSlot'));
        if (from === undefined || to === undefined) return;

        const run = state.run;
        const pending = run?.pending;
        // Ours by the slots it names and nothing else: the server checks the
        // types a move carries before executing it, so a result through our two
        // slots is our move as we asked it — and the types a result *reports*
        // are the one part of this protocol a live session has already
        // disagreed with us about, so they are not read back for these.
        if (
          run !== undefined &&
          pending !== undefined &&
          namesTheMove(from, to, pending.move, run.chestObjectId)
        ) {
          state.chests.move(run.chestObjectId, pending.move.from, pending.move.to);
          context.log.debug(
            `move result (ours): #${String(from.objectId)} slot ${String(from.slotId)} -> ` +
              `#${String(to.objectId)} slot ${String(to.slotId)}`,
          );
          moveLanded(run);
          return;
        }

        const watched = state.chests
          .chests()
          .some((chest) => chest.objectId === from.objectId || chest.objectId === to.objectId);
        if (!watched) return;
        const changed = state.chests.applyResult(from, to);
        context.log.debug(
          `move result (someone else's, ${changed ? 'changed the chest' : 'no visible change'}): ` +
            `#${String(from.objectId)} slot ${String(from.slotId)} type ${String(from.objectType)} <-> ` +
            `#${String(to.objectId)} slot ${String(to.slotId)} type ${String(to.objectType)}`,
        );
      });

      // A swap the player's own hands made against the sorting chest. Ours do
      // not come through here: an injected packet joins the stream below the
      // pipeline, so the only swaps this sees are the client's own.
      context.packets.on('INVENTORYSWAP', (packet, session) => {
        const state = stateFor(session);
        const run = state.run;
        if (run === undefined) return;
        const one = slotRefOf(packet.get('slotObject1'));
        const two = slotRefOf(packet.get('slotObject2'));
        if (
          (one !== undefined && one.objectId === run.chestObjectId) ||
          (two !== undefined && two.objectId === run.chestObjectId)
        ) {
          stop(session, state, 'Sort stopped — you moved something yourself.');
        }
      });

      // ── The driver ───────────────────────────────────────────────────────

      context.timers.setInterval(() => {
        const session = context.sessions.current();
        if (session === undefined) return;
        const state = stateFor(session);
        const run = state.run;
        if (run === undefined) return;

        const chest = state.chests.chest(run.chestObjectId);
        if (chest === undefined) {
          stop(session, state, 'Sort stopped — the chest left the vault list.');
          return;
        }
        const nowMs = session.world.gameTimeMs;

        if (run.pending !== undefined && nowMs - run.pending.sentAtMs > PENDING_TIMEOUT_MS) {
          // A move nothing confirms is one the server did not carry out, and
          // it never says why. The same move is tried again from the same
          // picture — a refusal is not held against it, for the same reason as
          // auto-loot's — until three in a row say the chest will not answer.
          run.pending = undefined;
          run.strikes += 1;
          context.log.info(`a move went unconfirmed (${String(run.strikes)} in a row)`);
          if (run.strikes >= MAX_UNCONFIRMED_MOVES) {
            stop(session, state, 'Sort stopped — a move went unconfirmed.');
            return;
          }
        }
        if (run.pending !== undefined) return;

        // The plan is asked for afresh every move. That is safe only because
        // every move lands in an empty slot and so always changes the chest the
        // next plan is derived from — see {@link SortRun}.
        if (!chest.contents.some((type) => type < 0)) {
          // Filled under the sort — a deposit into the last gap, most likely.
          // Same refusal, same reason, as a chest that started full.
          stop(session, state, fullChest);
          return;
        }
        const moves = planFor(chest);
        if (moves.length === 0) {
          state.run = undefined;
          session.notify(
            `Sorted the ${run.label} in ${counted(run.movesDone, 'move')}.`,
            'Vault Sort',
          );
          return;
        }
        if (nowMs - run.lastSendAtMs < moveIntervalMs.get()) return;

        const move = moves[0];
        if (move === undefined) return;
        // The `objectType` the server checks against its own view of both
        // slots: what the chest holds right now, empty spelled as the -1 the
        // packets spell it as. The destination is an empty slot by construction.
        const fromType = chest.contents[move.from] ?? -1;
        const toType = chest.contents[move.to] ?? -1;
        const pending = { move, sentAtMs: Number.POSITIVE_INFINITY };
        run.pending = pending;
        session.sendToServer(
          'INVENTORYSWAP',
          {
            // Both are rewritten by the session at the instant the packet
            // leaves — the clock because a stamp the server reads as going
            // backwards is dropped without a word, the position because the
            // player can walk away from the chest while a move waits its turn.
            // Filled in here as well so the packet's shape is visible where it
            // is built.
            time: Math.trunc(session.world.clientTimeMs),
            position: { x: session.self.x, y: session.self.y },
            slotObject1: { objectId: chest.objectId, slotId: move.from, objectType: fromType },
            slotObject2: { objectId: chest.objectId, slotId: move.to, objectType: toType },
            // No `tickId`: the definition carries it as a trailing optional and
            // this build of the game does not — filling it in was what had every
            // swap answered with `Bad message received`.
          },
          {
            // Sorting a chest is the most patient thing the runtime does and
            // the least urgent: it yields the lane to anything at all.
            priority: SendPriority.Background,
            // One move outstanding by construction — the driver will not plan
            // another while `pending` is set — so this is a guard rather than a
            // rule, and it costs nothing to state.
            key: 'vault-sort:move',
            expiresInMs: QUEUE_EXPIRY_MS,
            onSent: () => {
              const sentAtMs = session.world.gameTimeMs;
              pending.sentAtMs = sentAtMs;
              run.lastSendAtMs = sentAtMs;
            },
            onOutcome: (outcome) => {
              if (run.pending !== pending) return;
              if (outcome === SendOutcome.Refused) {
                run.pending = undefined;
                stop(session, state, 'Sort stopped — the server refused a move.');
                return;
              }
              // Superseded, expired, dropped: it never left, so there is
              // nothing to wait on and nothing to hold against the chest. The
              // driver plans the same move again from the same picture.
              if (!wasSent(outcome)) run.pending = undefined;
            },
          },
        );
      }, DRIVER_TICK_MS);

      // ── Lifecycle ────────────────────────────────────────────────────────

      // An object id is only unique within a map, and the chests belong to the
      // vault: both the snapshot and any sort in flight are about a map the
      // player has left.
      context.packets.on('MAPINFO', (_packet, session) => {
        const state = stateFor(session);
        state.chests.clear();
        state.run = undefined;
      });

      context.sessions.onDisconnected((session) => {
        bySession.delete(session.id);
      });

      context.onDispose(() => {
        bySession.clear();
      });
    },
  });
}

/** The chest nearest the player that the snapshot describes, within reach. */
function nearestChest(session: SessionView, chests: VaultChests): VaultChest | undefined {
  let nearest: VaultChest | undefined;
  let nearestDistance = Infinity;
  for (const chest of chests.chests()) {
    const entity = session.world.entity(chest.objectId);
    if (entity === undefined) continue;
    const distanceTiles = Math.hypot(entity.x - session.self.x, entity.y - session.self.y);
    if (distanceTiles > CHEST_INTERACT_TILES) continue;
    if (distanceTiles < nearestDistance) {
      nearest = chest;
      nearestDistance = distanceTiles;
    }
  }
  return nearest;
}

/** A slot's contents as the model keeps it: an item type, or below zero empty. */
function toItemType(raw: unknown): number {
  const value = Math.trunc(Number(raw));
  return Number.isFinite(value) ? value : -1;
}

/** `2 moves`, `1 move` — a count and its unit, for a line a player reads. */
function counted(count: number, unit: string): string {
  return `${String(count)} ${count === 1 ? unit : `${unit}s`}`;
}

/**
 * Whether a result names the two slots of a move of ours, either way round.
 *
 * Deliberately blind to the contents the result reports: matching on those was
 * a belief the server did not share, and checking beliefs is what stopped the
 * first live sort. The slots and the chest are identification enough.
 */
function namesTheMove(
  from: SlotRef,
  to: SlotRef,
  move: PlannedMove,
  chestObjectId: number,
): boolean {
  if (from.objectId !== chestObjectId || to.objectId !== chestObjectId) return false;
  return (
    (from.slotId === move.from && to.slotId === move.to) ||
    (from.slotId === move.to && to.slotId === move.from)
  );
}
