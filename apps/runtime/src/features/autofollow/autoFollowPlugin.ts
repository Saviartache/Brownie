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
 * **The same press means something to the dodge**, which takes the enemy under
 * the cursor and closes to weapon range of it. The two never negotiate: this one
 * answers for allies and that one for enemies, so a click on a teammate starts a
 * chase and ends an engagement, a click on a monster does the reverse, and a
 * click on bare ground stops both. See `dodge/engageRing`.
 *
 * **It walks the ally's own route, not the line to them.** Aiming straight at
 * somebody works until they round a corner, and then it holds the character
 * against the corner for as long as they stand behind it — the native mover
 * walks a heading and tests nothing on the way. So the ally's recent positions
 * are remembered and the follow walks the furthest one it can reach in a clear
 * line, which in open ground is the ally themselves and costs nothing. See
 * {@link FollowTrail}.
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
import { bareName } from '../../state/playerName.js';
import { nearestBoss, type BossLookup } from '../autoteleport/bossApproach.js';
import { GroundCache } from '../dodge/GroundCache.js';
import { PICK_RADIUS_TILES, WALK_HOLD_MS } from './constants.js';
import { FollowTrail } from './FollowTrail.js';
import { clearLineBetween, nearestPlayerTo, tilesBetween } from './followMath.js';

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
  /**
   * When the last Shift+left-click worth acting on was, in wall-clock ms.
   *
   * **A stamp rather than an edge, because the dodge answers the same press.**
   * It takes the *enemy* under the cursor to close on — see `dodge/engageRing`
   * — so a flag consumed on read would have whichever of the two ticked first
   * swallow the click. Each compares the stamp against the last one it acted on
   * instead, and neither has to know the other exists. Nought means there is
   * nothing to act on.
   */
  readonly pick: { at(): number };
  /** Which way the player is walking under their own power, if at all. */
  readonly steer: { direction(): Position | undefined };
}

/** What one session remembers between ticks. */
interface FollowState {
  /** The ally chosen by hand, which wins over the automatic one while it holds. */
  manualId: number | undefined;
  /** Whether a walk target is currently published, so it can be stood down. */
  commanding: boolean;
  /** Where the ally has been, for getting round what the straight line hits. */
  readonly trail: FollowTrail;
  /**
   * One walkability answer per tile, shared by every line test in a tick.
   *
   * **Per session rather than per plugin**, because the cache is keyed on the
   * map it was filled from: two connections looking at two maps through one
   * cache would throw each other's answers away every tick, which is the cost
   * of the feature paid twice over for nothing.
   */
  readonly ground: GroundCache;
}

function newState(): FollowState {
  return {
    manualId: undefined,
    commanding: false,
    trail: new FollowTrail(),
    ground: new GroundCache(),
  };
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

      /**
       * The press this feature has already answered.
       *
       * **In the plugin rather than in a session's state**, because a press is a
       * thing that happened to the window: a map change replaces the state below
       * and must not make a click from a moment ago look unanswered.
       */
      let answeredPickAtMs = 0;

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
          session.notify(`Following ${bareName(picked.name) || 'player'}.`, 'Auto Follow');
          return;
        }
        if (activeTarget(state) !== undefined) session.notify('Follow cancelled.', 'Auto Follow');
        state.manualId = undefined;
        inputs.followTarget.clear();
        state.trail.clear();
      };

      context.packets.on('NEWTICK', (_packet, session) => {
        const state = stateFor(session);
        const self = session.self;

        // Keep the cursor reading warm even when no pick is pending, so a fresh
        // point exists the instant the player Shift-clicks. The lease is the
        // side effect; the value is only used on a pick.
        const cursor = inputs.cursorPoint();
        const pressedAtMs = inputs.pick.at();
        if (pressedAtMs !== 0 && pressedAtMs !== answeredPickAtMs) {
          answeredPickAtMs = pressedAtMs;
          applyPick(session, state, cursor);
        }

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
          state.trail.clear();
          standDown(session, state);
          return;
        }

        // Recorded before any of the reasons to stand still, so a follow parked
        // at the boss or yielding to the player's own hand still knows where
        // the ally went while it was waiting.
        state.trail.aim(targetId);
        state.trail.record(target);

        if (stopNearBossSetting.get()) {
          const boss = nearestBoss(session.world.enemies(), inputs.isBoss, self);
          if (boss !== undefined && tilesBetween(self, boss) <= bossRangeSetting.get()) {
            standDown(session, state);
            return;
          }
        }

        // Aimed once per tick and keyed on the tile the character stands in, so
        // the dozens of samples the line tests below take between them cost a
        // few map lookups rather than one apiece.
        state.ground.aim(session.world, self.x, self.y, session.world.gameTimeMs);
        const point = state.trail.steer(self, target, keepDistanceSetting.get(), (from, to) =>
          clearLineBetween(from, to, (x, y) => state.ground.canStand(x, y, 0)),
        );
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
