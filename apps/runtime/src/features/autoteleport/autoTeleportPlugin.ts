/**
 * Auto-teleport: in a dungeon, when a teammate reaches the boss and we are not
 * there yet, teleport to them — then hand them to auto-follow.
 *
 * **The trigger is a teammate at the boss, not the boss itself.** The point is
 * to be carried into the fight the group is already having, so the module waits
 * for another player to stand close to a `<Quest/>` boss and teleports to *that
 * player* with the game's own `TELEPORT` packet. There is no party system to ask
 * — proximity to the boss is the whole of "a teammate is in the fight".
 *
 * **Whether a dungeon allows teleport is stated, then verified.** `MAPINFO`
 * carries `allowPlayerTeleport`, and a map that says no is not tried at all. The
 * flag is not the whole story — a full instance or a cooldown refuses a teleport
 * a map otherwise permits — so each attempt is still confirmed against where the
 * character actually ends up, and a map that refuses twice (a cooldown apart, so
 * the refusal is the map and not the clock) is given up on until it is left. See
 * `constants.ts`.
 *
 * **It teleports, it does not walk.** Teleport is a packet, so this is a pure
 * runtime plugin with no native mover; the walking that follows is auto-follow's
 * job, engaged by naming the teammate in the shared {@link FollowTarget}.
 */

import { PluginCategory, definePlugin, type Plugin, type SessionView } from '@brownie/plugin-api';
import { isSafeZone } from '../../constants/SafeZones.js';
import { ARRIVE_TILES, CONFIRM_MS, MAX_FAILURES, TELEPORT_INTERVAL_MS } from './constants.js';
import { nearestApproacher, nearestBoss, tilesBetween, type BossLookup } from './bossApproach.js';

/** What the composition root hands over — none of it is on the plugin surface. */
export interface AutoTeleportInputs {
  /** Whether an object type is a quest boss, from `objects.xml`. */
  readonly isBoss: BossLookup;
  /** Names the teammate to follow once we have arrived, engaging auto-follow. */
  readonly requestFollow: (objectId: number) => void;
}

/** A teleport that has been sent and is waiting to be confirmed. */
interface PendingTeleport {
  readonly targetId: number;
  readonly sentAtMs: number;
}

/** What one session remembers between ticks. */
interface TeleportState {
  pending: PendingTeleport | undefined;
  lastAttemptMs: number;
  failures: number;
  /** Whether this map has been found to refuse teleport. Reset on a new map. */
  blocked: boolean;
}

function newState(): TeleportState {
  return { pending: undefined, lastAttemptMs: 0, failures: 0, blocked: false };
}

export function createAutoTeleportPlugin(inputs: AutoTeleportInputs): Plugin {
  return definePlugin({
    meta: {
      id: 'auto-teleport',
      name: 'Auto Teleport',
      category: PluginCategory.Movement,
      description: 'Teleports to a teammate who has reached the boss, then follows them.',
    },

    setup(context) {
      const approachSetting = context.settings.range('approachTiles', {
        label: 'Count a teammate as at the boss within (tiles)',
        default: 8,
        min: 2,
        max: 20,
        step: 1,
      });
      const engageFollowSetting = context.settings.boolean('engageFollow', {
        label: 'Follow the teammate after teleporting',
        default: true,
      });
      const announceSetting = context.settings.boolean('announce', {
        label: 'Say when teleporting',
        default: true,
      });

      const bySession = new Map<string, TeleportState>();
      const stateFor = (session: SessionView): TeleportState => {
        let state = bySession.get(session.id);
        if (state === undefined) {
          state = newState();
          bySession.set(session.id, state);
        }
        return state;
      };

      const say = (session: SessionView, text: string): void => {
        if (announceSetting.get()) session.notify(text, 'Auto Teleport');
      };

      context.packets.on('NEWTICK', (_packet, session) => {
        const state = stateFor(session);
        const self = session.self;
        if (!self.alive || isSafeZone(session.world.mapName)) {
          state.pending = undefined;
          return;
        }

        const boss = nearestBoss(session.world.enemies(), inputs.isBoss, self);
        if (boss === undefined) {
          state.pending = undefined;
          return;
        }

        const nowMs = session.world.gameTimeMs;

        // Confirm a teleport already in flight before sending another. Arrival is
        // measured against where the target is now, not where they were when the
        // packet went out — a teleport lands us on them, wherever they have got to.
        if (state.pending !== undefined) {
          const target = session.world.entity(state.pending.targetId);
          if (target !== undefined && tilesBetween(self, target) <= ARRIVE_TILES) {
            state.pending = undefined;
            state.failures = 0;
            if (engageFollowSetting.get()) {
              inputs.requestFollow(target.objectId);
              say(session, `Teleported to ${target.name || 'teammate'} — following.`);
            } else {
              say(session, `Teleported to ${target.name || 'teammate'}.`);
            }
          } else if (nowMs - state.pending.sentAtMs > CONFIRM_MS) {
            state.pending = undefined;
            state.failures += 1;
            if (state.failures >= MAX_FAILURES) {
              state.blocked = true;
              say(session, 'Teleport is refused here — giving up on this map.');
            }
          } else {
            return; // still waiting on this one; do not stack another
          }
        }

        if (state.blocked) return;
        // Already in the fight: nothing to teleport toward.
        if (tilesBetween(self, boss) <= approachSetting.get()) return;

        const approacher = nearestApproacher(
          session.world.players(),
          boss,
          self.objectId,
          approachSetting.get(),
        );
        if (approacher === undefined) return;
        if (nowMs - state.lastAttemptMs < TELEPORT_INTERVAL_MS) return;

        session.sendToServer('TELEPORT', {
          objectId: approacher.objectId,
          playerName: approacher.name,
        });
        state.pending = { targetId: approacher.objectId, sentAtMs: nowMs };
        state.lastAttemptMs = nowMs;
      });

      // An object id is unique only within a map, and what a map refuses is a
      // fact about that map — so nothing remembered here outlives it. The map
      // also states here whether it permits teleport at all: a `false` blocks
      // the module up front, while an absent flag leaves it to be learned.
      context.packets.on('MAPINFO', (packet, session) => {
        const state = newState();
        state.blocked = packet.boolean('allowPlayerTeleport') === false;
        bySession.set(session.id, state);
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
