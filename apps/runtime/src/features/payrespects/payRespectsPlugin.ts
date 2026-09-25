/**
 * Pay Respects: says `rip` or `F` in chat, once, when another player dies.
 *
 * **What tells it somebody died.** The server announces a player's death with
 * a `NOTIFICATION` of the death kind — the popup with the character's portrait
 * — and the dead player is named in its tokens. Reading that is
 * `playerDeath.ts`; nothing here parses anything.
 *
 * **One tribute per burst, then quiet.** The server rate-limits what a
 * character says and mutes rather than warns, and a party that wipes is half a
 * dozen deaths inside a few seconds. So a death that lands while a tribute is
 * already waiting is covered by it, and once one has been said the plugin
 * stays quiet for a cooldown the player sets.
 *
 * **Said after a short, random pause** — about the time it takes a person to
 * see the popup and type three letters — rather than on the packet. A reply
 * that lands in the same instant as every death, every time, reads as exactly
 * what it is.
 *
 * **Never for yourself.** Your own death ends the connection, and a `rip` for
 * yourself would be the last thing the session tried to say.
 */

import {
  PluginCategory,
  SendPriority,
  definePlugin,
  type Plugin,
  type SessionView,
} from '@brownie/plugin-api';
import { bareName } from '../../state/playerName.js';
import { deadPlayerName } from './playerDeath.js';

/**
 * What is said. One is picked at random for each tribute; edit freely.
 *
 * Every line goes out as ordinary chat, so it has to be something the chat box
 * would send: short, and never starting with `/`, which would make it a
 * command.
 */
export const TRIBUTES: readonly [string, ...string[]] = [
  'skill issue',
  'noob down',
  'ded on such ez boss?',
  'lul',
];

/** The shortest and longest pause before a tribute is said, in milliseconds. */
export const MIN_PAUSE_MS = 1000;
export const MAX_PAUSE_MS = 3000;

/**
 * How late a tribute may still be said, past its pause, in milliseconds.
 *
 * The pause is counted on the ticks the plugin only hears while it is on, so a
 * tribute that was waiting when the plugin was switched off would otherwise go
 * out whenever it is switched back on — a `rip` for a death nobody remembers.
 * Ticks arrive five times a second, so anything past a few of them is that.
 */
export const LATE_LIMIT_MS = 5000;

/**
 * How long the tribute is worth sending once it is handed to the outbound
 * queue — the same limit, for the same reason, on the queue's side.
 */
const SEND_EXPIRY_MS = LATE_LIMIT_MS;

/** Names the tribute in the session's outbound queue, so two never wait there. */
const SEND_KEY = 'pay-respects:tribute';

/** The chat packet the client sends when the player presses enter. */
const CHAT_PACKET = 'PLAYERTEXT';

/** What the composition root may hand over. */
export interface PayRespectsInputs {
  /**
   * A number in `[0, 1)`, like `Math.random` — which is what is used when
   * nothing is handed over. A test hands over something it can predict.
   */
  readonly random?: () => number;
}

/** A tribute waiting for its pause to end. */
interface PendingTribute {
  /** Who it is for — the first death of the burst, for the log. */
  readonly player: string;
  /** When it is due, on the world clock. */
  readonly dueAtMs: number;
}

/** What one session remembers between packets. */
interface RespectsState {
  pending: PendingTribute | undefined;
  /** When the last tribute was said, on the world clock. Never, at first. */
  lastSaidMs: number | undefined;
}

export function createPayRespectsPlugin(inputs: PayRespectsInputs = {}): Plugin {
  const random = inputs.random ?? Math.random;

  return definePlugin({
    meta: {
      id: 'pay-respects',
      name: 'Pay Respects',
      category: PluginCategory.Utility,
      description: 'Says rip or F in chat, once, when another player dies.',
    },

    setup(context) {
      const cooldownSeconds = context.settings.range('cooldownSeconds', {
        label: 'Stay quiet after a tribute (s)',
        default: 10,
        min: 0,
        max: 120,
        step: 5,
      });

      const bySession = new Map<string, RespectsState>();

      const stateFor = (session: SessionView): RespectsState => {
        let state = bySession.get(session.id);
        if (state === undefined) {
          state = { pending: undefined, lastSaidMs: undefined };
          bySession.set(session.id, state);
        }
        return state;
      };

      context.packets.on('NOTIFICATION', (packet, session) => {
        const player = deadPlayerName(packet.frame);
        if (player === undefined) return;
        if (player.toLowerCase() === bareName(session.self.name).toLowerCase()) return;

        const state = stateFor(session);
        // This burst already has its tribute on the way.
        if (state.pending !== undefined) return;

        const nowMs = session.world.gameTimeMs;
        if (
          state.lastSaidMs !== undefined &&
          nowMs - state.lastSaidMs < cooldownSeconds.get() * 1000
        ) {
          return;
        }
        state.pending = { player, dueAtMs: nowMs + pause(random) };
      });

      context.packets.on('NEWTICK', (_packet, session) => {
        const state = bySession.get(session.id);
        const pending = state?.pending;
        if (state === undefined || pending === undefined) return;

        const nowMs = session.world.gameTimeMs;
        if (nowMs < pending.dueAtMs) return;
        state.pending = undefined;
        if (nowMs - pending.dueAtMs > LATE_LIMIT_MS) return;

        // Counted from the decision rather than from `onSent`: this is a chat
        // cooldown, not a server one, and it has to cover a death that lands
        // while the line is still waiting its turn in the queue.
        state.lastSaidMs = nowMs;
        const text = pickTribute(random);
        context.log.info(`paying respects to ${pending.player}: ${text}`);
        session.sendToServer(
          CHAT_PACKET,
          { text },
          {
            // Anything else the runtime has to say goes first.
            priority: SendPriority.Background,
            key: SEND_KEY,
            expiresInMs: SEND_EXPIRY_MS,
          },
        );
      });

      // A tribute is for a death on the map it happened on. Carrying one into
      // the next would say `rip` to a room that saw nothing.
      context.packets.on('MAPINFO', (_packet, session) => {
        const state = bySession.get(session.id);
        if (state !== undefined) state.pending = undefined;
      });

      context.onDispose(
        context.sessions.onDisconnected((session) => {
          bySession.delete(session.id);
        }),
      );
      context.onDispose(() => {
        bySession.clear();
      });
    },
  });
}

/** How long to wait before saying anything, drawn anew for each tribute. */
function pause(random: () => number): number {
  return MIN_PAUSE_MS + random() * (MAX_PAUSE_MS - MIN_PAUSE_MS);
}

/** One of {@link TRIBUTES}, at random. */
function pickTribute(random: () => number): string {
  // In range by construction for a `random` that keeps to its contract; the
  // fallback is what a stray 1 would get instead of `undefined`.
  return TRIBUTES[Math.floor(random() * TRIBUTES.length)] ?? TRIBUTES[0];
}
