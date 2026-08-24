/**
 * Auto-portal: stand in the Nexus and walk into a dungeon the moment someone
 * opens one.
 *
 * **A dungeon portal in the Nexus is a popped key.** The Nexus carries none of
 * its own — only realm, guild and quest portals live there permanently — so a
 * `<DungeonPortal/>` being present at all is the whole of "somebody opened one".
 * The feature reacts to the ones the player has chosen: it walks to the nearest
 * and sends `USEPORTAL`, and the server answers with a `RECONNECT` that carries
 * the character in. That is what lets a player stand AFK and be taken along.
 *
 * **Walking is the module's job, not this one's.** Movement lives inside the
 * game process — the runtime cannot step the character itself — so, exactly as
 * the dodge does, the composition root hands over a `moveTo` that publishes a
 * walk target to the native mover. The Nexus is open ground, so a straight walk
 * toward the portal is enough; the game's own collision handles anything in the
 * way.
 *
 * **It yields to the player.** The feature never acts unless the map is the
 * Nexus and the character is not being steered by hand — so a player who grabs
 * the wheel to go somewhere else is not fought for it.
 */

import {
  PluginCategory,
  definePlugin,
  type Plugin,
  type Position,
  type SessionView,
} from '@brownie/plugin-api';
import type { DungeonPortal } from '../../state/ObjectCatalog.js';
import { ENTER_INTERVAL_MS, ENTER_RADIUS_TILES, WALK_HOLD_MS } from './constants.js';
import { findChosenPortals, isNexus, withinReach } from './portals.js';

/** Asks the native module to walk, or to stop — the one thing a plugin cannot do alone. */
export interface AutoPortalOutput {
  /** Walk towards a place on the map. See the dodge's `DodgeOutput.moveTo`. */
  moveTo(x: number, y: number, speedTilesPerSecond: number, holdMs: number): void;
  /** Give the wheel back now, rather than waiting for the last target to lapse. */
  stop(speedTilesPerSecond: number): void;
}

/** What the composition root hands over — none of it is on the plugin surface. */
export interface AutoPortalInputs {
  readonly output: AutoPortalOutput;
  readonly isDungeonPortal: (objectType: number) => boolean;
  readonly displayName: (objectType: number) => string | undefined;
  /** Every dungeon portal the game data describes, for the chooser. */
  readonly dungeonPortals: () => readonly DungeonPortal[];
  /** Which way the player is walking under their own power, if at all. */
  readonly steer: { direction(): Position | undefined };
}

/** What one session remembers between ticks. */
interface PortalState {
  /** Whether a walk target is currently published, so it can be stood down. */
  commanding: boolean;
  /** When the last `USEPORTAL` went out, on the world clock. */
  lastEnterAtMs: number;
  /** Portal object ids already announced, so a standing portal is named once. */
  readonly announced: Set<number>;
}

function newState(): PortalState {
  return { commanding: false, lastEnterAtMs: 0, announced: new Set() };
}

export function createAutoPortalPlugin(inputs: AutoPortalInputs): Plugin {
  // The option list is a fixed catalog fact, so it is built once here rather
  // than per tick: value is the object type as a string, label is its name,
  // ordered by name so the chooser reads alphabetically.
  const options = inputs
    .dungeonPortals()
    .map((portal): readonly [string, string] => [String(portal.type), portal.name])
    .sort((a, b) => a[1].localeCompare(b[1]));

  return definePlugin({
    meta: {
      id: 'auto-portal',
      name: 'Auto Portal',
      category: PluginCategory.Movement,
      description: 'Walks into a chosen dungeon portal when one is opened in the Nexus.',
    },

    setup(context) {
      const chosenSetting = context.settings.multiSelect('portals', {
        label: 'Dungeons to enter',
        default: [],
        options,
      });
      const announceSetting = context.settings.boolean('announce', {
        label: 'Say when walking to a portal',
        default: true,
      });
      const respectSteerSetting = context.settings.boolean('respectSteer', {
        label: 'Stop while you are steering by hand',
        advanced: true,
        default: true,
      });

      /** The chosen types as numbers, rebuilt only when the choice changes. */
      const readChosen = (): Set<number> =>
        new Set(chosenSetting.get().map((value) => Number(value)));
      let chosen = readChosen();
      context.onDispose(
        chosenSetting.onChange(() => {
          chosen = readChosen();
        }),
      );

      const bySession = new Map<string, PortalState>();
      const stateFor = (session: SessionView): PortalState => {
        let state = bySession.get(session.id);
        if (state === undefined) {
          state = newState();
          bySession.set(session.id, state);
        }
        return state;
      };

      const standDown = (session: SessionView, state: PortalState): void => {
        if (!state.commanding) return;
        inputs.output.stop(session.self.walkSpeedTilesPerSecond);
        state.commanding = false;
      };

      context.packets.on('NEWTICK', (_packet, session) => {
        const state = stateFor(session);
        const self = session.self;

        if (!self.alive || !isNexus(session.world.mapName)) {
          standDown(session, state);
          return;
        }
        // The player's own hands win: a walk of theirs is a better statement of
        // where they want to be than any portal we picked for them.
        if (respectSteerSetting.get() && inputs.steer.direction() !== undefined) {
          standDown(session, state);
          return;
        }

        const nearest = findChosenPortals(session.world, self, inputs.isDungeonPortal, chosen)[0];
        if (nearest === undefined) {
          standDown(session, state);
          return;
        }

        if (announceSetting.get() && !state.announced.has(nearest.entity.objectId)) {
          state.announced.add(nearest.entity.objectId);
          const name = inputs.displayName(nearest.entity.objectType) ?? nearest.entity.name;
          session.notify(`Heading for ${name}.`, 'Auto Portal');
        }

        const speed = self.walkSpeedTilesPerSecond;
        if (withinReach(nearest, ENTER_RADIUS_TILES)) {
          standDown(session, state);
          const nowMs = session.world.gameTimeMs;
          if (nowMs - state.lastEnterAtMs >= ENTER_INTERVAL_MS) {
            session.sendToServer('USEPORTAL', { objectId: nearest.entity.objectId });
            state.lastEnterAtMs = nowMs;
          }
          return;
        }

        inputs.output.moveTo(nearest.entity.x, nearest.entity.y, speed, WALK_HOLD_MS);
        state.commanding = true;
      });

      // An object id is unique only within a map, and a reconnect into the
      // dungeon is a new map — so nothing remembered here outlives it.
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
