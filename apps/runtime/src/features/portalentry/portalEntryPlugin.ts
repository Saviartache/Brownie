/**
 * `/back` — go through the last portal again — and `/enter`, which forces the
 * one under your feet.
 *
 * **`/back` replays a seat, not a walk.** Going through a portal ends with the
 * server sending a `RECONNECT`: a host, a world id and a *key*, which is the
 * seat that server is holding for this character in that world. The client
 * dials the address and presents the key, and the queue is not consulted —
 * the queue is what hands seats out, and this one has already been handed out.
 * So the whole of "take me back" is remembering that packet and sending it to
 * the client again, which is what makes a nexus-and-return cost no wait at all.
 * The seat is the server's to withdraw: a key it no longer honours fails the
 * connection, and nothing here can tell in advance which it will be.
 *
 * **What is remembered is every reconnect except the ones into the Nexus.**
 * Not "the last `USEPORTAL` we saw" — a portal entered by auto-portal or by
 * `/enter` is injected straight onto the wire and never passes back through the
 * plugin host, so correlating with the client's own packet would quietly forget
 * exactly the entries this feature exists to remember. The Nexus is where
 * `/back` is typed, so it is the one destination worth skipping.
 *
 * **`/enter` bypasses the client, not the server.** A portal the client
 * believes is full is one it refuses to send `USEPORTAL` for — the refusal is
 * local, and a packet built here never asks it. Whether the server then admits
 * the character is the server's answer and no plugin changes it, so the command
 * keeps asking for a while rather than pretending once was enough: a full
 * dungeon is full until somebody leaves.
 *
 * Neither command watches the world or acts on its own. They run when the
 * player types, and never otherwise.
 */

import { PluginCategory, definePlugin, type Plugin } from '@brownie/plugin-api';
import { GameId } from '../../constants/GameId.js';
import { DEFAULT_RETRY_SECONDS, REACH_TILES, RETRY_INTERVAL_MS } from './constants.js';
import { portalUnder } from './portals.js';

/** What the composition root hands over — none of it is on the plugin surface. */
export interface PortalEntryInputs {
  /** Whether an object type is a portal. See `ObjectCatalog.isPortal`. */
  readonly isPortal: (objectType: number) => boolean;
  /** Display name from the catalog, for a portal that carries no name stat. */
  readonly displayName: (objectType: number) => string | undefined;
}

/** A world the server let us into, and the seat it held for us there. */
interface LastEntry {
  readonly name: string;
  readonly host: string;
  readonly port: number;
  readonly gameId: number;
  readonly keyTime: number;
  readonly key: Buffer;
}

/** One `/enter` still asking. */
interface Attempt {
  readonly objectId: number;
  /** When to stop asking, on the world clock. */
  readonly untilMs: number;
  /** When the last `USEPORTAL` went out, on the same clock. */
  lastSentMs: number;
}

export function createPortalEntryPlugin(inputs: PortalEntryInputs): Plugin {
  return definePlugin({
    meta: {
      id: 'portal-entry',
      name: 'Portal Entry',
      category: PluginCategory.Commands,
      description: 'Adds /back, which returns through the last portal, and /enter.',
    },

    setup(context) {
      const retrySeconds = context.settings.range('retrySeconds', {
        label: 'Keep asking for (seconds)',
        default: DEFAULT_RETRY_SECONDS,
        min: 0,
        max: 60,
        step: 5,
      });

      /**
       * The last world a reconnect carried this character into.
       *
       * Deliberately not per session, and deliberately not cleared when one
       * ends: the escape to the Nexus *is* a new session, and a seat forgotten
       * at that moment is the one moment `/back` exists for.
       */
      let last: LastEntry | undefined;
      /** Live `/enter` attempts, by session. An attempt cannot outlive its map. */
      const attempts = new Map<string, Attempt>();

      context.packets.on('RECONNECT', (packet, session) => {
        // Whatever we were asking for, this answers it — and the session is
        // about to end, so nothing should send into it on the way out.
        attempts.delete(session.id);

        const host = packet.string('host');
        const port = packet.number('port');
        const gameId = packet.number('gameId');
        const keyTime = packet.number('keyTime');
        const key = packet.get('key');
        // A reconnect we cannot read whole is one we cannot replay: a packet
        // built from half of it would dial somewhere with no seat to present.
        if (host === undefined || port === undefined) return;
        if (gameId === undefined || keyTime === undefined || !Buffer.isBuffer(key)) return;
        if (gameId === GameId.Nexus) return;

        // The decoder copies every byte array it reads, so this buffer is ours
        // to keep for as long as we like — it is not a view into a frame that
        // the next packet will overwrite.
        last = { name: packet.string('name') ?? '', host, port, gameId, keyTime, key };
        context.log.debug(`remembered the way back to ${last.name} (${host})`);
      });

      context.commands.register({
        name: 'back',
        description: 'Go through the last portal again, without the queue.',
        run: (_args, session) => {
          if (last === undefined) {
            session.notify('No portal to go back through yet.');
            return;
          }
          const where = last.name === '' ? last.host : last.name;
          session.notify(`Going back to ${where}...`);
          context.log.info(`replaying the reconnect to ${where} (${last.host})`);
          session.sendToClient('RECONNECT', { ...last });
        },
      });

      context.commands.register({
        name: 'enter',
        description: 'Use the portal under you, however full it says it is.',
        run: (_args, session) => {
          // Typing it again is how an attempt is called off. A player who meant
          // a different portal cancels and asks again, which is one keypress
          // more than guessing which of the two they meant.
          if (attempts.delete(session.id)) {
            session.notify('Stopped asking.');
            return;
          }

          const portal = portalUnder(session.world, session.self, inputs.isPortal, REACH_TILES);
          if (portal === undefined) {
            session.notify('No portal under you.');
            return;
          }

          const nowMs = session.world.gameTimeMs;
          const retryMs = retrySeconds.get() * 1000;
          session.notify(
            `Entering ${nameOf(portal.name, inputs.displayName(portal.objectType))}...`,
          );
          session.sendToServer('USEPORTAL', { objectId: portal.objectId });
          // Nothing to keep when the player asked for one attempt: an entry
          // that is already over must not be cancellable a tick later.
          if (retryMs > 0) {
            attempts.set(session.id, {
              objectId: portal.objectId,
              untilMs: nowMs + retryMs,
              lastSentMs: nowMs,
            });
          }
        },
      });

      context.packets.on('NEWTICK', (_packet, session) => {
        const attempt = attempts.get(session.id);
        if (attempt === undefined) return;

        const nowMs = session.world.gameTimeMs;
        if (nowMs >= attempt.untilMs) {
          attempts.delete(session.id);
          session.notify('Still no room. Stopped asking.');
          return;
        }
        // Aimed at the object rather than at wherever the player has drifted
        // to: standing exactly on a portal is not something anyone holds while
        // a dungeon empties, and `/enter` is how they say they are done.
        if (nowMs - attempt.lastSentMs < RETRY_INTERVAL_MS) return;
        attempt.lastSentMs = nowMs;
        session.sendToServer('USEPORTAL', { objectId: attempt.objectId });
      });

      // An object id is unique only within a map, so an attempt made in one is
      // aimed at nothing in the next.
      context.packets.on('MAPINFO', (_packet, session) => {
        attempts.delete(session.id);
      });

      context.sessions.onDisconnected((session) => {
        attempts.delete(session.id);
      });

      context.onDispose(() => {
        attempts.clear();
      });
    },
  });
}

/** What to call a portal: its own name, the catalog's, or neither. */
function nameOf(statName: string, catalogName: string | undefined): string {
  if (statName !== '') return statName;
  return catalogName ?? 'the portal';
}
