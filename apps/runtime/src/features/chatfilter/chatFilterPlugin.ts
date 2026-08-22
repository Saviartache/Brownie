/**
 * Chat filter: keeps the shop bots out of the chat box.
 *
 * A `TEXT` packet the filter claims is dropped on its way to the game client,
 * so the message is never drawn and never enters the client's chat history. The
 * server is not told anything — it does not know the client has a proxy, and a
 * message it has already sent cannot be unsent. Nothing here reads or writes
 * anything the player says.
 *
 * Three questions are asked in order, and the order is the policy:
 *
 * 1. Is this someone whose messages are never worth hiding — the player
 *    themselves, the server, an NPC? Those are never examined at all.
 * 2. Is the sender on a list? Blocked wins over allowed, because a list of
 *    names is a decision already made and a *pattern* on the allow list is the
 *    thing more likely to have caught someone by accident.
 * 3. Does the message match a signal in one of the enabled categories?
 *
 * What it recognises and why is `spamSignals.ts`; how a message is folded
 * before being read is `scanText.ts`. This file is the wiring: the settings,
 * the sender rules, and what is counted.
 */

import { PluginCategory, definePlugin, type Plugin, type SettingHandle } from '@brownie/plugin-api';
import { matchesAnyRule, parseSenderRules, type SenderRules } from './senderRules.js';
import { scanText } from './scanText.js';
import { SPAM_CATEGORIES, firstMatchingSignal, type SpamCategory } from './spamSignals.js';

/**
 * Names that are not a player.
 *
 * The server speaks through `TEXT` too — announcements, `#` guild traffic, the
 * empty name a system line carries — and hiding those would hide the game
 * telling the player something.
 */
const SYSTEM_SENDERS: ReadonlySet<string> = new Set(['', '*', '#', '[server]']);

/** Reported in place of a signal id when a name was on the blocked list. */
const BLOCKED_SENDER = 'blocked-sender';

export function createChatFilterPlugin(): Plugin {
  return definePlugin({
    meta: {
      id: 'chat-filter',
      name: 'Chat Filter',
      category: PluginCategory.Utility,
      description: 'Hides shop bots and spam from the chat box, before the client draws them.',
      enabledByDefault: true,
    },

    setup(context) {
      const switches: readonly { category: SpamCategory; handle: SettingHandle<boolean> }[] =
        SPAM_CATEGORIES.map((option) => ({
          category: option.category,
          handle: context.settings.boolean(option.key, {
            group: 'Hide',
            label: option.label,
            default: option.enabledByDefault,
          }),
        }));

      const allowList = context.settings.text('allowList', {
        group: 'Senders',
        label: 'Never hide — one name or /pattern/ per line',
        default: '',
      });

      const blockList = context.settings.text('blockList', {
        group: 'Senders',
        label: 'Always hide — one name or /pattern/ per line',
        default: '',
      });

      const compile = (name: string, handle: SettingHandle<string>): SenderRules => {
        const rules = parseSenderRules(handle.get());
        // Reported, not swallowed: a pattern that does not compile is a line
        // the player is expecting to work.
        for (const line of rules.invalid) {
          context.log.warn(`${name} list: "${line}" is not a valid pattern, so it is ignored`);
        }
        return rules;
      };

      const switchedOn = (): ReadonlySet<SpamCategory> =>
        new Set(switches.filter(({ handle }) => handle.get()).map(({ category }) => category));

      // Folded when something changes rather than per message: a nexus sends
      // chat several times a second, and none of this is rediscovered by a
      // packet arriving.
      let enabled = switchedOn();
      let allow = compile('allow', allowList);
      let block = compile('block', blockList);

      const refreshCategories = (): void => {
        enabled = switchedOn();
      };

      for (const { handle } of switches) context.onDispose(handle.onChange(refreshCategories));
      context.onDispose(
        allowList.onChange(() => {
          allow = compile('allow', allowList);
        }),
      );
      context.onDispose(
        blockList.onChange(() => {
          block = compile('block', blockList);
        }),
      );

      const hidden = new Map<string, number>();
      let hiddenTotal = 0;
      let last: { sender: string; reason: string } | undefined;

      const hide = (sender: string, reason: string): void => {
        hiddenTotal++;
        hidden.set(reason, (hidden.get(reason) ?? 0) + 1);
        last = { sender, reason };
        context.log.debug(`hid a message from ${sender} (${reason})`);
      };

      context.packets.on('TEXT', (packet, session) => {
        // Nothing to do rather than nothing to say: with every category off and
        // no blocked names, the whole handler is a decision already made.
        if (enabled.size === 0 && block.rules.length === 0) return;
        if (packet.opaque) return;

        const sender = (packet.string('name') ?? '').trim();
        const senderLower = sender.toLowerCase();
        if (SYSTEM_SENDERS.has(senderLower)) return;
        if (senderLower === session.self.name.trim().toLowerCase()) return;

        // Negative fame is not a player: it is how this game marks the NPCs and
        // the server-side speakers that share the packet with real chat.
        const stars = packet.number('numStars');
        if (stars !== undefined && stars < 0) return;

        if (matchesAnyRule(block.rules, sender)) {
          packet.drop();
          hide(sender, BLOCKED_SENDER);
          return;
        }
        if (matchesAnyRule(allow.rules, sender)) return;

        // `cleanText` first — it is what the client draws with the game's own
        // profanity filter on — but *either* field can be the empty one, and
        // `??` would take an empty censored form as the message. A line whose
        // clean form is blank is precisely a line worth reading in full.
        const clean = packet.string('cleanText') ?? '';
        const body = clean === '' ? (packet.string('text') ?? '') : clean;
        if (body === '') return;

        const signal = firstMatchingSignal(scanText(body), enabled);
        if (signal === undefined) return;

        packet.drop();
        hide(sender, signal.id);
      });

      context.commands.register({
        name: 'chatfilter',
        description: 'Show what the chat filter has hidden this session.',
        run: (_args, session) => {
          session.notify(summarise(hiddenTotal, hidden, last));
        },
      });

      // Per session, like the rest of the runtime's counters: the number worth
      // reading is what this character has been shown, not what some earlier
      // connection was.
      context.sessions.onConnected(() => {
        hidden.clear();
        hiddenTotal = 0;
        last = undefined;
      });
    },
  });
}

/** One line for the chat box — what was hidden, and the most recent of them. */
function summarise(
  total: number,
  byReason: ReadonlyMap<string, number>,
  last: { sender: string; reason: string } | undefined,
): string {
  if (total === 0) return 'Chat filter: nothing hidden this session.';

  const reasons = [...byReason]
    .sort(([, a], [, b]) => b - a)
    .map(([reason, count]) => `${reason} ${String(count)}`)
    .join(', ');
  const tail = last === undefined ? '' : ` Last: ${last.sender} (${last.reason}).`;
  return `Chat filter: ${String(total)} hidden this session — ${reasons}.${tail}`;
}
