/**
 * Calls out every dungeon portal that drops, the moment it drops.
 *
 * **What the game does.** Ctrl + left-click on a portal makes the client send
 * one `PLAYERCALLOUT`, and the *server* turns that into the line everyone in
 * the Nexus reads: `{dungeon} ({grade}) just dropped!`. The wording and the
 * grade are the server's; nothing here composes them, which is why an
 * announcement made from this reads as the game's own.
 *
 * **The callout names an object, not a dungeon.** A live capture settled it:
 * `calloutType=1 value=274676`, the object id of a Puppet Master's Theatre
 * portal standing in the Nexus. The server looks that object up in the world
 * the character is in — so only a portal actually standing here can be
 * announced, and a dungeon nobody opened cannot be, by this or by anything else
 * the client can send.
 *
 * **Every portal is named once and only once.** Three keys popped together are
 * three announcements, spaced so the server's chat limit is not tripped; a
 * portal already named is remembered and never named again, however long it
 * stands there. What is remembered dies with the map, because an object id
 * means nothing in the next one.
 *
 * **A portal that was already standing when you arrived is not news.** The
 * Nexus is full of them, and announcing the lot on arrival is both untrue and a
 * burst of chat that earns a mute in one go — so the first {@link SETTLE_MS} of
 * a map records its portals silently. See `constants.ts`.
 */

import { PluginCategory, definePlugin, type Plugin, type SessionView } from '@brownie/plugin-api';
import type { DungeonPortal } from '../../state/ObjectCatalog.js';
import {
  ANNOUNCE_INTERVAL_MS,
  MAX_PENDING,
  PORTAL_CALLOUT_TYPE,
  REACH_TILES,
  SETTLE_MS,
} from './constants.js';
import { announceablePortals, type AnnounceablePortal } from './portals.js';

/** The packet a Ctrl+click sends, and the one this sends in its place. */
const CALLOUT_PACKET = 'PLAYERCALLOUT';

/**
 * How long a callout waiting in the session's outbound queue is worth making.
 *
 * Generous: a portal that has been open for a few seconds is still worth
 * naming, and the thing this guards against is a callout surfacing minutes
 * later about a dungeon everybody has already left.
 */
const CALLOUT_EXPIRY_MS = 8000;

/** What the composition root hands over — none of it is on the plugin surface. */
export interface AutoCalloutInputs {
  /** Whether an object type is a key-opened dungeon portal. */
  readonly isDungeonPortal: (objectType: number) => boolean;
  /** Every dungeon portal the game data describes, for naming one by type. */
  readonly dungeonPortals: () => readonly DungeonPortal[];
}

/** What one session remembers between ticks. */
interface CalloutState {
  /** Portal object ids already seen, announced or arrived-with. */
  readonly seen: Set<number>;
  /** Portals waiting their turn, oldest first. */
  readonly pending: AnnounceablePortal[];
  /** Until when this map's portals count as already there, on the world clock. */
  readonly settleUntilMs: number;
  /** When the last announcement went out, on the same clock. Never, at first. */
  lastSentMs: number | undefined;
}

function newState(nowMs: number): CalloutState {
  return { seen: new Set(), pending: [], settleUntilMs: nowMs + SETTLE_MS, lastSentMs: undefined };
}

export function createAutoCalloutPlugin(inputs: AutoCalloutInputs): Plugin {
  // A fixed catalog fact, so it is built once here rather than per tick: what a
  // portal object type is called as a dungeon.
  const namesByType = new Map<number, string>();
  for (const portal of inputs.dungeonPortals()) namesByType.set(portal.type, portal.dungeonName);
  const dungeonName = (objectType: number): string | undefined => namesByType.get(objectType);

  return definePlugin({
    meta: {
      id: 'auto-callout',
      name: 'Auto Callout',
      category: PluginCategory.Utility,
      description: 'Announces each dungeon portal that drops, as the game does on Ctrl+click.',
    },

    setup(context) {
      const bySession = new Map<string, CalloutState>();

      // Created on first sight rather than only on `MAPINFO`, so switching the
      // plugin on mid-map settles exactly as arriving on one does: the portals
      // already standing there are recorded, not shouted about.
      const stateFor = (session: SessionView): CalloutState => {
        let state = bySession.get(session.id);
        if (state === undefined) {
          state = newState(session.world.gameTimeMs);
          bySession.set(session.id, state);
        }
        return state;
      };

      const announce = (
        session: SessionView,
        state: CalloutState,
        portal: AnnounceablePortal,
      ): void => {
        state.lastSentMs = session.world.gameTimeMs;
        context.log.info(`calling out ${portal.dungeonName}, object ${String(portal.objectId)}`);
        session.sendToServer(
          CALLOUT_PACKET,
          {
            calloutType: PORTAL_CALLOUT_TYPE,
            value: portal.objectId,
          },
          {
            // Named per portal rather than per plugin: two portals opening at
            // once are two different things to say, and one must not quietly
            // replace the other.
            key: `auto-callout:${String(portal.objectId)}`,
            expiresInMs: CALLOUT_EXPIRY_MS,
            // The spacing clock is already set above, from the decision rather
            // than the send: a callout that waits its turn is still a callout
            // about a portal that has just appeared, and the announcement below
            // has already told the player it was made.
          },
        );
        session.notify(`${portal.dungeonName} called out.`, 'Auto Callout');
      };

      context.packets.on('NEWTICK', (_packet, session) => {
        const state = stateFor(session);
        const nowMs = session.world.gameTimeMs;
        const settling = nowMs < state.settleUntilMs;

        for (const portal of announceablePortals(
          session.world,
          session.self,
          inputs.isDungeonPortal,
          dungeonName,
          REACH_TILES,
        )) {
          if (state.seen.has(portal.objectId)) continue;
          // Marked seen either way. A portal recorded while the map settles must
          // not become news a tick later, and one queued must not be queued
          // twice while it waits.
          state.seen.add(portal.objectId);
          if (settling) continue;
          state.pending.push(portal);
          // The oldest gives way: by the time a queue is this long it is behind
          // the room, and the newest is the portal still standing there.
          if (state.pending.length > MAX_PENDING) state.pending.shift();
        }

        const next = state.pending[0];
        if (next === undefined) return;
        if (state.lastSentMs !== undefined && nowMs - state.lastSentMs < ANNOUNCE_INTERVAL_MS) {
          return;
        }
        state.pending.shift();
        announce(session, state, next);
      });

      // An object id is unique only within a map, so nothing remembered here
      // means anything in the next one — and the portals standing in it have to
      // settle before any of them counts as having just dropped.
      context.packets.on('MAPINFO', (_packet, session) => {
        bySession.set(session.id, newState(session.world.gameTimeMs));
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
