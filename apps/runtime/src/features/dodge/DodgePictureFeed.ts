/**
 * Publishing what the planner is thinking, on a cadence of its own.
 *
 * **A picture for a person, not a plan for a machine.** It goes out slower than
 * a plan on purpose — nobody can tell twenty a second from fifty, and each one
 * is a few hundred numbers across a pipe. What keeps it looking continuous at
 * that rate is that the circles say how they *move*: the player's own three are
 * declared as being centred on the character, which only the module knows the
 * live position of, and a monster's carry the velocity the planner derived. See
 * `DodgeMarks` for the shapes and `overlay/DodgePicture.h` for the other end.
 *
 * The empty set is sent once when the switch goes up, so what is on the screen
 * goes with it rather than waiting out its own freshness.
 */

import type { SessionView } from '@brownie/plugin-api';
import { dodgeMarks } from './DodgeMarks.js';
import type { DodgeControls } from './dodgeControls.js';
import type { DodgeOutput, DodgeView } from './dodgeInputs.js';
import type { DodgeScene } from './DodgeScene.js';
import { shotPaths } from './ShotPaths.js';

/**
 * How often the drawn picture is refreshed.
 *
 * Slower than a plan on purpose: this is a picture for a person, and a person
 * cannot tell twenty a second from fifty. Each one is a few hundred numbers
 * across the pipe, so the difference is real.
 */
const SHOW_INTERVAL_MS = 50;

/**
 * The most shots drawn at once.
 *
 * A screen with more than this on it is unreadable whatever is drawn, and the
 * cap is what stops a debug view being the most expensive thing in a fight.
 */
const MAX_DRAWN_SHOTS = 48;

export class DodgePictureFeed {
  readonly #output: DodgeOutput;
  readonly #view: DodgeView;
  #lastShownAtMs = 0;
  /** Whether anything is currently drawn, so it can be cleared exactly once. */
  #showing = false;

  constructor(output: DodgeOutput, view: DodgeView) {
    this.#output = output;
    this.#view = view;
  }

  /**
   * Answers the module's "show me what you are dodging".
   *
   * **The state the last plan actually used, not a second guess at it.** The
   * scene is whatever the planner filled in a moment ago — so a body missing
   * from the picture is a body missing from the decision, which is the one thing
   * a debug view has to be able to say. Empty when the spacing group is switched
   * off, which is honest: it is then not minding the monsters at all.
   */
  publish(session: SessionView, scene: DodgeScene, controls: DodgeControls, nowMs: number): void {
    if (!this.#view.wanted()) {
      if (!this.#showing) return;
      this.#showing = false;
      this.#output.showPicture([], []);
      return;
    }
    if (nowMs - this.#lastShownAtMs < SHOW_INTERVAL_MS) return;
    this.#lastShownAtMs = nowMs;
    this.#showing = true;

    const world = session.world;
    const self = session.self;
    this.#output.showPicture(
      shotPaths(world.gameTimeMs, world.projectiles(), MAX_DRAWN_SHOTS),
      dodgeMarks({
        selfX: self.x,
        selfY: self.y,
        gameTimeMs: world.gameTimeMs,
        engageTiles: controls.tuning.engageWithinTiles.get(),
        band: scene.band,
        bodies: scene.bodies,
        blasts: scene.blastsIn(world, controls),
      }),
    );
  }

  /** Forgets that anything is drawn. The module lets go of it on its own. */
  reset(): void {
    this.#showing = false;
    this.#lastShownAtMs = 0;
  }
}
