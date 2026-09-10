/**
 * The Ctrl+middle-click walk to the cursor, as a plugin of its own.
 *
 * **A plugin, and not a setting inside the dodge.** The chord is the player
 * taking the wheel — a *place*, pointed at — and none of that is about
 * dodging. It is the way out of exactly the failure a planner cannot fix for
 * itself: a character wedged against geometry has no course that goes
 * anywhere, so the best plan available is to stand where they already are.
 * Naming somewhere to go is worth as much with the dodge switched off as on,
 * and living inside it meant the chord shared the dodge's switch — switching
 * the planner off took the player's own escape hatch with it. Its own plugin,
 * its own switch, on until somebody says otherwise.
 *
 * **And still one writer of the module's move target.** While the chord is
 * held this plugin walks and the dodge stands down — the composition root
 * reports the target to the dodge only while this plugin is driving, so the
 * two never publish a target in the same moment. The precedence is the one
 * the dodge always had: a person pointing at a place has more information
 * than any planner.
 *
 * **The place is the cursor reading, held or not.** The chord is an edge and
 * the place it names travels as the cursor reading, so walking needs both: a
 * module that stops talking mid-hold stops the walk on the point's freshness
 * alone. See `native/CursorTracker.ts`.
 */

import { PluginCategory, definePlugin, type Plugin, type Position } from '@brownie/plugin-api';

/** How often the walk target is restated while the chord is held. */
const WALK_REFRESH_MS = 20;

/**
 * Asks the native module to walk, or to stop — the one thing a plugin cannot
 * do alone. The same shape auto-portal's and auto-follow's movers take.
 */
export interface CursorWalkOutput {
  /**
   * Asks the module to walk towards a place on the map.
   *
   * A *target*, not a jump. The module issues a small step towards it on every
   * frame, capped at what the speed allows — commanding further than that does
   * not make the player walk there, it makes them appear there and then be put
   * back. `holdMs` is how long the target stands if nothing replaces it, which
   * is what makes "no fresh reading" mean "stop".
   *
   * **The player's own walking is counted against that cap**, and by the module
   * rather than here: the step lands on top of the game's own movement, so the
   * two agreeing about a direction used to travel at both speeds at once. What
   * they actually covered is the ground that appeared under them, which only
   * the frame can see — see `PlayerControl::RoomToStep`. So a command is a
   * ceiling on the *sum*, and asking for more of it than they have left over
   * simply moves them less.
   *
   * **And no wall test on this path, deliberately**: the chord exists to leave
   * somewhere the geometry is refusing to let go of, and the game's own
   * collision is still between the player and anything worse.
   */
  moveTo(x: number, y: number, speedTilesPerSecond: number, holdMs: number): void;
  /** Give the wheel back now, rather than waiting for the last target to lapse. */
  stop(speedTilesPerSecond: number): void;
}

/** What the composition root hands over — none of it is on the plugin surface. */
export interface CursorWalkInputs {
  readonly output: CursorWalkOutput;
  /**
   * Where the chord is pointing, or nothing while nobody is holding it.
   *
   * Both halves come from the module: whether the chord is down is window
   * input, and the place it names is measured against the game's own camera.
   * Nothing means the player is not asking — or that the reading has gone
   * stale, which for a walk is the same thing.
   */
  readonly target: () => Position | undefined;
}

export function createCursorWalkPlugin(inputs: CursorWalkInputs): Plugin {
  return definePlugin({
    meta: {
      id: 'cursor-walk',
      name: 'Cursor Walk',
      category: PluginCategory.Movement,
      description: 'Ctrl+middle-click walks to your cursor. Works with Auto Dodge on or off.',
      // On until somebody says otherwise: this is the player's own escape
      // hatch rather than a feature anybody arms before they need it, and a
      // chord that does nothing until a panel is opened is one that fails the
      // first time it is wanted.
      enabledByDefault: true,
    },

    setup(context) {
      // **A little under the full stat, for the same reason the dodge holds
      // back.** What the server's speed figure gives is the *limit* it will
      // accept, with nothing left over for latency or for the rounding in
      // every step along the way; asking for the whole of it is a walk the
      // server keeps correcting.
      const speedPercent = context.settings.range('speedPercent', {
        label: 'Walk at (% of full speed)',
        default: 92,
        min: 50,
        max: 100,
        step: 2,
      });
      // How long the target stands if nothing replaces it. The walk stops on
      // its own this long after the last refresh, which is what makes "no
      // fresh reading" mean "stop" rather than "carry on to somewhere old".
      const holdMs = context.settings.range('holdMs', {
        label: 'Keep walking for (ms)',
        default: 120,
        min: 50,
        max: 500,
        step: 10,
      });

      /** Whether a walk target of ours is standing, so it can be stood down. */
      let commanding = false;

      context.timers.setInterval(() => {
        const session = context.sessions.current();
        if (session === undefined) return;
        const speed = (session.self.walkSpeedTilesPerSecond * speedPercent.get()) / 100;

        const target = inputs.target();
        if (target === undefined) {
          // The release, or a reading gone stale: the same stop either way,
          // because the last target would otherwise stand for the whole of
          // its hold and carry the character past the place the player meant.
          if (!commanding) return;
          commanding = false;
          inputs.output.stop(speed);
          return;
        }

        commanding = true;
        inputs.output.moveTo(target.x, target.y, speed, holdMs.get());
      }, WALK_REFRESH_MS);

      // Nothing to clean up on dispose. The last target lapses with its hold
      // and the module lets go of a walk on its own when nothing restates it —
      // the same lease the cursor reading lives on.
    },
  });
}
