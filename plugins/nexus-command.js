// @ts-check
/**
 * `/nexus` — leaves for the nexus.
 *
 * The first plugin that acts on the *game* rather than describing it: it sends
 * `ESCAPE` to the server as though the client had sent it. That is the path
 * every later feature rests on — auto-nexus, movement, looting — and it is the
 * one with real failure modes, because a packet built wrongly desynchronises
 * the RC4 keystream and takes the rest of the connection with it. Proving it
 * with one empty-bodied packet, on purpose, is cheaper than discovering it
 * during a dungeon.
 *
 * **Deliberately not automatic.** Auto-nexus belongs to a later stage and needs
 * offsets, incoming damage and a threshold to be worth trusting; this one fires
 * when the player asks and never otherwise, so the only thing being tested here
 * is whether the packet lands.
 *
 * A confirmation setting is off by default: an escape you did not mean is a
 * lost dungeon, not a lost character, and the second key press costs more than
 * it saves for most people.
 */

import { definePlugin, PluginCategory } from '@brownie/plugin-api';

/** How long a pending confirmation stays open. */
const CONFIRM_WINDOW_MS = 5000;

export default definePlugin({
  meta: {
    id: 'nexus-command',
    name: 'Nexus Command',
    category: PluginCategory.Commands,
    description: 'Adds /nexus, which leaves for the nexus.',
  },

  setup(context) {
    const confirm = context.settings.boolean('confirm', {
      label: 'Ask before leaving',
      default: false,
    });

    /** When the current confirmation expires, or 0 when none is pending. */
    let pendingUntil = 0;

    context.commands.register({
      name: 'nexus',
      description: 'Leave for the nexus.',
      run: (_args, session) => {
        const now = Date.now();

        if (confirm.get() && now > pendingUntil) {
          pendingUntil = now + CONFIRM_WINDOW_MS;
          session.notify(
            'Are you sure? Type /nexus again within 5 seconds to escape to the Nexus.',
          );
          return;
        }

        // Cleared before sending, not after: if the send throws, a second
        // attempt should ask again rather than inherit an open confirmation.
        pendingUntil = 0;
        session.sendToServer('ESCAPE', {});
        context.log.info('sent ESCAPE');
      },
    });

    // A pending confirmation belongs to the session it was asked in. Carrying
    // one across a reconnect would make the first `/nexus` of a new session
    // fire without asking.
    context.sessions.onConnected(() => {
      pendingUntil = 0;
    });
  },
});
