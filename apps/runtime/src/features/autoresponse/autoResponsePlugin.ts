/**
 * Auto Response: answers in chat when an NPC asks something the game expects a
 * player to answer there.
 *
 * **What there is to answer** is the catalogue in `chatEvents.ts`, and how a
 * line is recognised as one of its questions is `npcLines.ts`. This file is the
 * wiring: a switch per event, the pause, and when an answer stops being wanted.
 *
 * **Said after a short, random pause**, not on the packet. An answer that lands
 * in the same instant as the question, every time, reads as exactly what it is.
 * The pause starts when the NPC starts listening — some only take an answer a
 * few seconds after asking — and is cut short where the NPC stops listening
 * sooner, so a slow setting cannot leave a question unanswered.
 *
 * **Not said once it is not needed.** An answer anybody can give is dropped when
 * another player — or the player, typing it by hand — says it first, and every
 * waiting answer is dropped when the NPC moves on: when it says a line that
 * settles the question either way, or when the map changes. And nothing is
 * said to one NPC twice in a row: an NPC that asks again straight after hearing
 * the answer did not take it, saying it again is how a character gets muted,
 * and the Beekeeper's computer shuts down for good on a second wrong password.
 */

import {
  PluginCategory,
  definePlugin,
  type MutablePacket,
  type Plugin,
  type SessionView,
  type SettingHandle,
} from '@brownie/plugin-api';
import { CHAT_EVENTS, type ChatEvent } from './chatEvents.js';
import { foldEvents, foldLine, hearNpcLine, type FoldedPrompt } from './npcLines.js';

/** The chat packet the client sends when the player presses enter. */
const CHAT_PACKET = 'PLAYERTEXT';

/**
 * How far either side of the chosen pause an answer may land, as a share of it.
 *
 * Enough that no two answers are the same number of milliseconds apart, little
 * enough that the setting still means what it says.
 */
export const PAUSE_SPREAD = 0.3;

/**
 * How much of an event's window is kept back for the trip, in milliseconds.
 *
 * An answer is sent on a tick, waits its turn in the chat lane — which spaces
 * lines a little over a second apart — and then crosses the network. The pause
 * is cut short by this much, so an answer that queued behind another line
 * still lands inside the window it was written for.
 */
export const TRIP_ALLOWANCE_MS = 1500;

/**
 * How long the same answer is not given to the same NPC again, in
 * milliseconds.
 *
 * Long enough to cover an NPC asking again straight after hearing it; short
 * enough that the next stage of an event — Skuld wants `ready` before each of
 * his gauntlets, minutes apart — is answered as the first was.
 */
export const REPEAT_QUIET_MS = 30_000;

/**
 * How late an answer may still be said, past its pause, in milliseconds.
 *
 * The pause is counted on the ticks the plugin only hears while it is on, so an
 * answer that was waiting when the plugin was switched off would otherwise go
 * out whenever it is switched back on — a `ready` for a fight that has long
 * started. Ticks arrive five times a second, so anything past a few of them is
 * that.
 */
export const LATE_LIMIT_MS = 2000;

/** What the composition root may hand over. */
export interface AutoResponseInputs {
  /**
   * The events to answer — the catalogue, when nothing is handed over. A test
   * hands over events it wrote itself.
   */
  readonly events?: readonly ChatEvent[];
  /**
   * A number in `[0, 1)`, like `Math.random` — which is what is used when
   * nothing is handed over. A test hands over something it can predict.
   */
  readonly random?: () => number;
}

/** An answer waiting for its pause to end. */
interface PendingAnswer {
  readonly event: ChatEvent;
  readonly prompt: FoldedPrompt;
  /** One NPC, one answer — see {@link answerKey}. */
  readonly key: string;
  /** When it is due, on the world clock. */
  readonly dueAtMs: number;
  /** When the NPC stops listening for it, on the same clock. */
  readonly expiresAtMs: number;
}

/** What one session remembers between packets. */
interface ResponderState {
  pending: PendingAnswer[];
  /** When each answer was last given, by {@link answerKey}, on the world clock. */
  readonly givenAtMs: Map<string, number>;
}

export function createAutoResponsePlugin(inputs: AutoResponseInputs = {}): Plugin {
  const random = inputs.random ?? Math.random;
  const catalogue = inputs.events ?? CHAT_EVENTS;

  return definePlugin({
    meta: {
      id: 'auto-response',
      name: 'Auto Response',
      category: PluginCategory.Utility,
      description: 'Answers in chat when an NPC asks something the game expects an answer to.',
    },

    setup(context) {
      // Folded here, once: a malformed entry fails this plugin as it loads
      // rather than anything else, and no line heard in a session refolds it.
      const events = foldEvents(catalogue);

      const switches = new Map<ChatEvent, SettingHandle<boolean>>();
      for (const { source } of events) {
        switches.set(
          source,
          context.settings.boolean(source.id, {
            group: 'Answer',
            label: source.label,
            default: source.enabledByDefault,
          }),
        );
      }

      const pauseMs = context.settings.range('pauseMs', {
        label: 'Answer after about (ms)',
        default: 1500,
        min: 0,
        max: 5000,
        step: 100,
      });

      const bySession = new Map<string, ResponderState>();

      const stateFor = (session: SessionView): ResponderState => {
        let state = bySession.get(session.id);
        if (state === undefined) {
          state = { pending: [], givenAtMs: new Map() };
          bySession.set(session.id, state);
        }
        return state;
      };

      const heardQuestion = (
        session: SessionView,
        event: ChatEvent,
        prompt: FoldedPrompt,
      ): void => {
        if (switches.get(event)?.get() !== true) {
          context.log.debug(`${event.label}: asked, but switched off`);
          return;
        }

        const state = stateFor(session);
        const nowMs = session.world.gameTimeMs;
        const key = answerKey(event, prompt);
        if (state.pending.some((answer) => answer.key === key)) return;
        const givenAtMs = state.givenAtMs.get(key);
        if (givenAtMs !== undefined && nowMs - givenAtMs < REPEAT_QUIET_MS) {
          context.log.info(
            `${event.label}: asked again straight after the answer, not repeating it`,
          );
          return;
        }

        const earliestMs = event.listensAfterMs;
        const latestMs = Math.max(earliestMs, event.windowMs - TRIP_ALLOWANCE_MS);
        const pause = Math.min(earliestMs + spreadPause(pauseMs.get(), random), latestMs);
        state.pending.push({
          event,
          prompt,
          key,
          dueAtMs: nowMs + pause,
          expiresAtMs: nowMs + event.windowMs,
        });
      };

      const heardNpc = (session: SessionView, speaker: string, line: string): void => {
        const heard = hearNpcLine(events, speaker, line);
        if (heard === undefined) return;
        switch (heard.kind) {
          case 'prompt':
            heardQuestion(session, heard.event, heard.prompt);
            return;
          case 'settled': {
            const state = bySession.get(session.id);
            if (state !== undefined) {
              state.pending = state.pending.filter((answer) => answer.event !== heard.event);
            }
            return;
          }
          case 'other':
            // Logged, because a question whose wording has drifted from the
            // catalogue looks, from here, exactly like an NPC that asked nothing.
            context.log.debug(`${heard.event.label}: ${speaker} said "${line}"`);
            return;
        }
      };

      // Anybody's line, the player's included: one typed by hand goes to the
      // server as chat and comes back as this packet like everybody else's.
      const heardPlayer = (session: SessionView, line: string): void => {
        const state = bySession.get(session.id);
        if (state === undefined || state.pending.length === 0) return;
        const said = foldLine(line);
        state.pending = state.pending.filter((answer) => {
          if (!answer.event.anyoneCanAnswer || answer.prompt.answer !== said) return true;
          context.log.info(`${answer.event.label}: answered by somebody else first`);
          return false;
        });
      };

      context.packets.on('TEXT', (packet, session) => {
        if (packet.opaque) return;
        const line = spokenLine(packet);
        if (line === '') return;

        // Negative fame is how this game marks a speaker that is not a player.
        const stars = packet.number('numStars');
        if (stars !== undefined && stars < 0) {
          heardNpc(session, packet.string('name') ?? '', line);
          return;
        }
        // Only what was said aloud. A whisper or a guild line carries the
        // person it is for, and an NPC hears neither.
        if ((packet.string('recipient') ?? '') !== '') return;
        heardPlayer(session, line);
      });

      context.packets.on('NEWTICK', (_packet, session) => {
        const state = bySession.get(session.id);
        if (state === undefined || state.pending.length === 0) return;

        const nowMs = session.world.gameTimeMs;
        const due = state.pending.filter((answer) => nowMs >= answer.dueAtMs);
        if (due.length === 0) return;
        state.pending = state.pending.filter((answer) => nowMs < answer.dueAtMs);

        for (const answer of due) {
          if (nowMs - answer.dueAtMs > LATE_LIMIT_MS || nowMs >= answer.expiresAtMs) continue;
          // Counted from the decision rather than from `onSent`: this guards
          // against the NPC asking again, and a question repeated while the
          // answer is still queued is one it has to cover.
          state.givenAtMs.set(answer.key, nowMs);
          const text = answer.prompt.source.answer;
          context.log.info(`${answer.event.label}: answering "${text}"`);
          session.sendToServer(
            CHAT_PACKET,
            { text },
            {
              // One NPC, one answer, rather than one per plugin: two questions
              // asked together are owed two answers, and one must not quietly
              // replace the other in the queue.
              key: `auto-response:${answer.key}`,
              expiresInMs: answer.expiresAtMs - nowMs,
            },
          );
        }
      });

      // A question is for the room it was asked in, and the NPC that asked it
      // is gone with the room.
      context.packets.on('MAPINFO', (_packet, session) => {
        bySession.delete(session.id);
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

/**
 * What names one answer to one NPC: the event and the answer, folded.
 *
 * Not the question. The Beekeeper's computer asks for its password and then,
 * after a wrong one, gives a hint — two questions, one answer — and saying
 * that answer again because it was asked a second way is saying it twice.
 */
function answerKey(event: ChatEvent, prompt: FoldedPrompt): string {
  return `${event.id}:${prompt.answer.trim()}`;
}

/**
 * What a chat line says.
 *
 * `text` is what the speaker sent and `cleanText` the game's profanity-filtered
 * copy of it. Either can be the empty one, so it is the first that is not.
 */
function spokenLine(packet: MutablePacket): string {
  const text = packet.string('text') ?? '';
  return text === '' ? (packet.string('cleanText') ?? '') : text;
}

/** The pause, give or take {@link PAUSE_SPREAD} of it, drawn anew for each answer. */
function spreadPause(pauseMs: number, random: () => number): number {
  return pauseMs * (1 - PAUSE_SPREAD + 2 * PAUSE_SPREAD * random());
}
