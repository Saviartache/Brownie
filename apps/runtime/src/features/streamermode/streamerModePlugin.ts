/**
 * Streamer mode: shows a stand-in identity wherever this client draws yours.
 *
 * Three things name a character on screen — its name, its guild and its star
 * count — and a stand-in for one of them is not a disguise while the other two
 * are still on the screen beside it. So all three are replaced together, and
 * each is a setting.
 *
 * **Server→client only, and that is the whole safety argument.** The identity
 * the game server holds, the one every other player's client draws and the one
 * anything typed into the chat box is sent under are all untouched — the
 * stand-in exists between the proxy and this one client, in the same way the
 * skin changer's skin does. Rewriting what the client *sends* would be a
 * different feature and a broken one: the server would refuse a `/tell`
 * addressed by a name nobody has, and a message that mentioned the alias would
 * be rewritten into the real name and published to everyone, which is the exact
 * opposite of what this is for.
 *
 * Where an identity is drawn, and all of it is covered:
 *
 * 1. The character's own stats, drawn over its head — `UPDATE` creates them and
 *    `NEWTICK` is where they are stated again. See {@link IdentityDisguise},
 *    which is also where the reason for stating them twice is written down.
 * 2. Who a chat line is from, who it is addressed to, and the stars beside it.
 * 3. The line itself, wherever somebody says the name — a whisper, a guild
 *    greeting, the server announcing a death. A chat box is on screen just as
 *    much as the character is, and this is where a name actually gets read out.
 *
 * **An empty alias leaves the name alone; an empty guild blanks the guild.**
 * The two settings read differently on purpose: every character has a name and
 * a blank one is not something the game has any reason to survive, while having
 * no guild is the ordinary state of most characters and is itself a disguise.
 */

import {
  PluginCategory,
  definePlugin,
  type MutablePacket,
  type Plugin,
  type SessionView,
} from '@brownie/plugin-api';
import { StatType } from '../../constants/StatType.js';
import { findStatus } from '../../state/StatOverrides.js';
import { IdentityDisguise, type StatValue } from './IdentityDisguise.js';
import { namePattern } from './namePattern.js';

const DEFAULT_ALIAS = 'Streamer';

/**
 * As many stars as anyone will ever need to look ordinary.
 *
 * Past what the game's own rank reaches, deliberately: the point of the number
 * is to be unremarkable, and where exactly the real ceiling sits is a fact
 * about a game build that this has no reason to encode.
 */
const MAX_STARS = 100;

/** Every field of a chat line that can carry a name. */
const TEXT_FIELDS = ['name', 'recipient', 'text', 'cleanText'] as const;

export function createStreamerModePlugin(): Plugin {
  return definePlugin({
    meta: {
      id: 'streamer-mode',
      name: 'Streamer Mode',
      category: PluginCategory.Utility,
      description: 'Shows a stand-in name, guild and star count in place of yours.',
    },

    setup(context) {
      const alias = context.settings.text('alias', {
        label: 'Name',
        default: DEFAULT_ALIAS,
        // The game's own names are at most ten characters, and the client draws
        // this one over the character's head at whatever width it is given.
        maxLength: 16,
      });
      const guild = context.settings.text('guild', {
        label: 'Guild — empty for none',
        default: '',
        maxLength: 24,
      });
      const stars = context.settings.range('stars', {
        label: 'Stars',
        default: 0,
        min: 0,
        max: MAX_STARS,
        step: 1,
      });

      const disguises = new Map<string, IdentityDisguise>();
      /** The stats to hold, folded when a setting moves rather than per packet. */
      const targets = new Map<number, StatValue>();
      // Compiled when the name changes rather than per message: a busy nexus
      // sends chat several times a second and the name moves once a session.
      let compiled: { name: string; pattern: RegExp | undefined } | undefined;

      const refreshTargets = (): void => {
        targets.clear();
        const shown = alias.get().trim();
        if (shown !== '') targets.set(StatType.Name, shown);
        targets.set(StatType.GuildName, guild.get().trim());
        targets.set(StatType.Stars, stars.get());
      };
      refreshTargets();
      for (const setting of [alias, guild, stars]) {
        context.onDispose(setting.onChange(refreshTargets));
      }

      const patternFor = (name: string): RegExp | undefined => {
        if (compiled?.name !== name) compiled = { name, pattern: namePattern(name) };
        return compiled.pattern;
      };

      const disguiseOf = (sessionId: string): IdentityDisguise => {
        let disguise = disguises.get(sessionId);
        if (disguise === undefined) {
          disguise = new IdentityDisguise();
          disguises.set(sessionId, disguise);
        }
        return disguise;
      };

      const rewriteStats = (
        packet: MutablePacket,
        field: 'newObjs' | 'statuses',
        session: SessionView,
        announced: boolean,
      ): void => {
        if (packet.opaque || session.self.objectId < 0) return;

        const entries = packet.get(field);
        if (!Array.isArray(entries)) return;
        const status = findStatus(entries, session.self.objectId, announced);
        if (status === undefined) return;
        if (!disguiseOf(session.id).applyTo(status, targets, announced)) return;
        packet.set(field, entries);
      };

      context.packets.on('UPDATE', (packet, session) => {
        rewriteStats(packet, 'newObjs', session, true);
      });
      context.packets.on('NEWTICK', (packet, session) => {
        rewriteStats(packet, 'statuses', session, false);
      });

      context.packets.on('TEXT', (packet, session) => {
        if (packet.opaque) return;

        // Our own line is ours because of the object it came from, whatever the
        // server chose to write beside it. A system line carries -1, which is
        // why this asks whether the character has an id at all first.
        const objectId = session.self.objectId;
        const mine = objectId >= 0 && packet.number('objectId') === objectId;
        if (mine && packet.number('numStars') !== stars.get()) {
          packet.set('numStars', stars.get());
        }

        const shown = alias.get().trim();
        if (shown === '') return;
        const real = session.self.name.trim();
        // Nothing to hide before the server has named the character, and
        // nothing to do for a player whose name the alias already is.
        if (real === '' || real === shown) return;
        const pattern = patternFor(real);
        if (pattern === undefined) return;

        if (mine && packet.string('name') !== shown) packet.set('name', shown);

        for (const field of TEXT_FIELDS) {
          const value = packet.string(field);
          if (value === undefined || value === '') continue;
          // A function replacement, because `$&` in an alias would otherwise be
          // read as "what was matched" and put the real name back.
          const next = value.replace(pattern, () => shown);
          if (next !== value) packet.set(field, next);
        }
      });

      context.onDispose(
        context.sessions.onDisconnected((session) => {
          disguises.delete(session.id);
        }),
      );
      context.onDispose(() => {
        disguises.clear();
      });
    },
  });
}
