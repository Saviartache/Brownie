/**
 * Auto-follow: walk after an ally, keeping station a set distance behind.
 *
 * **A walk, not the game's own `/follow`.** The character is steered toward the
 * ally every tick through the native mover — the same capability auto-portal and
 * the dodge use — so it works where the server-driven follow does not and keeps
 * the distance the player asked for rather than piling onto them.
 *
 * **Two ways to name the ally, and the hand wins.** Auto-teleport names one in
 * the shared {@link FollowTarget} after carrying the character to the boss;
 * Shift+left-click names one directly, by taking the ally standing under the
 * cursor — and clicking where no ally stands cancels the follow outright. A
 * manual pick takes precedence over the automatic one for as long as it holds,
 * so grabbing a specific ally is never overridden by the boss logic.
 *
 * **It lets go on its own.** Following stops when the ally is gone from the map
 * — dead, disconnected or left — and, so the character is not dragged past the
 * fight it was brought to, when the boss is within combat range. Both are the
 * stopping conditions chosen for it; steering by hand is deliberately *not* one
 * unless the advanced switch is set.
 */

import {
  PluginCategory,
  definePlugin,
  type Plugin,
  type Position,
  type SessionView,
} from '@brownie/plugin-api';
import { nearestBoss, type BossLookup } from '../autoteleport/bossApproach.js';
import { PICK_RADIUS_TILES, WALK_HOLD_MS } from './constants.js';
import { followPoint, nearestPlayerTo, tilesBetween } from './followMath.js';

/** Asks the native module to walk, or to stop — the one thing a plugin cannot do alone. */
export interface AutoFollowOutput {
  /** Walk towards a place on the map. See `AutoPortalOutput.moveTo`. */
  moveTo(x: number, y: number, speedTilesPerSecond: number, holdMs: number): void;
  /** Give the wheel back now, rather than waiting for the last target to lapse. */
  stop(speedTilesPerSecond: number): void;
}

/** What the composition root hands over — none of it is on the plugin surface. */
export interface AutoFollowInputs {
  readonly output: AutoFollowOutput;
  /** The ally auto-teleport named, if any. Read each tick, never held. */
  readonly followTarget: { current(): number | undefined; clear(): void };
  /** Whether an object type is a quest boss, from `objects.xml`. */
  readonly isBoss: BossLookup;
  /** Where the player is pointing, for the manual pick. */
  readonly cursorPoint: () => Position | undefined;
  /** Whether Shift+left-click was pressed since last asked — an edge, consumed on read. */
  readonly pick: { pending(): boolean };
  /** Which way the player is walking under their own power, if at all. */
  readonly steer: { direction(): Position | undefined };
}

/** What one session remembers between ticks. */
interface FollowState {
  /** The ally chosen by hand, which wins over the automatic one while it holds. */
  manualId: number | undefined;
  /** Whether a walk target is currently published, so it can be stood down. */
  commanding: boolean;
}

function newState(): FollowState {
  return { manualId: undefined, commanding: false };
}

export function createAutoFollowPlugin(inputs: AutoFollowInputs): Plugin {
  return definePlugin({
    meta: {
      id: 'auto-follow',
      name: 'Auto Follow',
      category: PluginCategory.Movement,
      description:
        'Walks after an ally. Shift+left-click an ally to follow them, or empty ground to stop.',
    },

    setup(context) {
      const keepDistanceSetting = context.settings.range('keepDistanceTiles', {
        label: 'Keep behind the ally by (tiles)',
        default: 1.5,
        min: 0,
        max: 6,
        step: 0.5,
      });
      const stopNearBossSetting = context.settings.boolean('stopNearBoss', {
        label: 'Stop following once at the boss',
        default: true,
      });
      const bossRangeSetting = context.settings.range('bossRangeTiles', {
        label: 'Count as at the boss within (tiles)',
        default: 6,
        min: 2,
        max: 20,
        step: 1,
        visibleWhen: { key: 'stopNearBoss', equals: [true] },
      });
      const respectSteerSetting = context.settings.boolean('respectSteer', {
        label: 'Stop while you are steering by hand',
        advanced: true,
        default: false,
      });

      const bySession = new Map<string, FollowState>();
      const stateFor = (session: SessionView): FollowState => {
        let state = bySession.get(session.id);
        if (state === undefined) {
          state = newState();
          bySession.set(session.id, state);
        }
        return state;
      };

      const standDown = (session: SessionView, state: FollowState): void => {
        if (!state.commanding) return;
        inputs.output.stop(session.self.walkSpeedTilesPerSecond);
        state.commanding = false;
      };

      /** The ally in force this tick — a manual pick outranks the automatic one. */
      const activeTarget = (state: FollowState): number | undefined =>
        state.manualId ?? inputs.followTarget.current();

      /** Drop whichever source named the ally that has just been lost. */
      const dropActive = (state: FollowState): void => {
        if (state.manualId !== undefined) state.manualId = undefined;
        else inputs.followTarget.clear();
      };

      /**
       * A Shift+left-click: take the ally under the cursor, or cancel.
       *
       * **A click on nothing is the cancel**, which is the only stop the player
       * has under their own hand, so it clears the automatic target as well —
       * leaving that one standing would simply hand the follow back to the boss
       * logic and the cancel would not read as one.
       */
      const applyPick = (
        session: SessionView,
        state: FollowState,
        cursor: Position | undefined,
      ): void => {
        const picked =
          cursor === undefined
            ? undefined
            : nearestPlayerTo(
                session.world.players(),
                cursor,
                session.self.objectId,
                PICK_RADIUS_TILES,
              );
        if (picked !== undefined) {
          state.manualId = picked.objectId;
          session.notify(`Following ${picked.name || 'player'}.`, 'Auto Follow');
          return;
        }
        if (activeTarget(state) !== undefined) session.notify('Follow cancelled.', 'Auto Follow');
        state.manualId = undefined;
        inputs.followTarget.clear();
      };

      context.packets.on('NEWTICK', (_packet, session) => {
        const state = stateFor(session);
        const self = session.self;

        // Keep the cursor reading warm even when no pick is pending, so a fresh
        // point exists the instant the player Shift-clicks. The lease is the
        // side effect; the value is only used on a pick.
        const cursor = inputs.cursorPoint();
        if (inputs.pick.pending()) applyPick(session, state, cursor);

        if (!self.alive) {
          standDown(session, state);
          return;
        }
        if (respectSteerSetting.get() && inputs.steer.direction() !== undefined) {
          standDown(session, state);
          return;
        }

        const targetId = activeTarget(state);
        if (targetId === undefined) {
          standDown(session, state);
          return;
        }

        const target = session.world.entity(targetId);
        if (target === undefined || !target.isPlayer) {
          dropActive(state);
          standDown(session, state);
          return;
        }

        if (stopNearBossSetting.get()) {
          const boss = nearestBoss(session.world.enemies(), inputs.isBoss, self);
          if (boss !== undefined && tilesBetween(self, boss) <= bossRangeSetting.get()) {
            standDown(session, state);
            return;
          }
        }

        const point = followPoint(self, target, keepDistanceSetting.get());
        if (point === undefined) {
          standDown(session, state);
          return;
        }

        inputs.output.moveTo(point.x, point.y, self.walkSpeedTilesPerSecond, WALK_HOLD_MS);
        state.commanding = true;
      });

      context.packets.on('MAPINFO', (_packet, session) => {
        bySession.set(session.id, newState());
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
