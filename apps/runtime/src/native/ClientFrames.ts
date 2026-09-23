/**
 * What the client sees of the fight, kept for the session it belongs to.
 *
 * **The runtime's picture is built from packets; the client's is the one that
 * decides.** Three things about the packet picture are a moment behind or a
 * guess, and each of them was a dodge going wrong:
 *
 * - **Where the player is** arrives in `MOVE` and `NEWTICK`, five times a
 *   second, while the character walks every frame. A plan built on that thinks
 *   the step it just commanded has not happened, commands it again, and carries
 *   the character a tile and a half past the gap it chose — and then walks back
 *   into the shot it was avoiding.
 * - **When a shot started** is when the announcement passed through here. The
 *   client starts it on the frame it reads the packet, later by however long
 *   that took, and flies it with its own copy of the owner's multipliers.
 * - **That a shot has ended** is said by no packet at all when a wall or a
 *   pillar takes it.
 *
 * The module reads all three off the client every frame while the dodge asks —
 * see `DodgeTelemetry.h` — and this is where they land: the clock that puts the
 * client's moments on the session's, the player's position and velocity, and
 * the shots the client made or destroyed, applied to the session's own store.
 *
 * **One session at a time**, because the game has one connection at a time. A
 * frame is applied to the session that connected most recently, and to nothing
 * once it has closed.
 */

import type { ClientFrameMessage } from '@brownie/ipc';
import type { Position, SessionView } from '@brownie/plugin-api';
import type { WorldState } from '../state/WorldState.js';
import { ClientClock } from './ClientClock.js';

/**
 * How long a position stands without a newer frame, in milliseconds.
 *
 * A dozen frames at any rate somebody plays at. Past it the module has stopped
 * saying — unloaded, restarted, or no longer asked — and the packets are all
 * there is again.
 */
export const CLIENT_POSITION_FRESH_MS = 250;

/**
 * How far past its frame a position is carried along its own velocity.
 *
 * A plan is made between frames, a few milliseconds after the last one, and the
 * character has kept walking since. Bounded, because a velocity carried for long
 * is a guess about a turn that has not been reported yet.
 */
export const MAX_POSITION_LEAD_MS = 50;

/** Two frames further apart than this say nothing about how fast either was. */
const MAX_VELOCITY_GAP_MS = 100;

/**
 * Faster than any character walks, in tiles a second: a step this long between
 * two frames was a teleport, and carrying it forward would throw the position
 * across the map.
 */
const MAX_WALK_TILES_PER_SECOND = 30;

export class ClientFrames {
  #session: SessionView | undefined;
  #world: WorldState | undefined;
  readonly #clock = new ClientClock();

  #playerKnown = false;
  #x = 0;
  #y = 0;
  /** When it stood there, on the session's clock. */
  #atMs = 0;
  /** And on the client's, which is what a velocity is measured by. */
  #frameTimeMs: number | undefined;
  #vx = 0;
  #vy = 0;

  /** Starts applying frames to this session, which the game has just opened. */
  attach(session: SessionView, world: WorldState): void {
    this.#session = session;
    this.#world = world;
    this.#forget();
  }

  /** Stops applying frames to this session, if it is the one they go to. */
  detach(session: SessionView): void {
    if (this.#session !== session) return;
    this.#session = undefined;
    this.#world = undefined;
    this.#forget();
  }

  /**
   * Forgets what the module said, because a different one is talking now — a
   * restarted game starts its clock again from nought.
   */
  reset(): void {
    this.#forget();
  }

  /** One frame from the module. */
  accept(frame: ClientFrameMessage): void {
    const world = this.#world;
    // Before the server has answered, the session's clock is not running and
    // nothing can be placed on it.
    if (world === undefined || !world.connected) return;

    const arrivedAtMs = world.gameTimeMs;
    const frameTimeMs = frame.frameTimeMs;
    if (frameTimeMs !== undefined) this.#clock.observe(arrivedAtMs, frameTimeMs);

    if (frame.player !== undefined) {
      const atMs =
        frameTimeMs === undefined
          ? arrivedAtMs
          : (this.#clock.toSession(frameTimeMs) ?? arrivedAtMs);
      this.#observePlayer(frame.player.x, frame.player.y, atMs, frameTimeMs);
    }
    if (frame.scanned && frameTimeMs !== undefined) this.#applyShots(world, frame, frameTimeMs);
  }

  /**
   * Where the client has the player at this moment, or nothing when the module
   * has not said lately — or has only said it about another session.
   */
  playerAt(session: SessionView): Position | undefined {
    const world = this.#world;
    if (!this.#playerKnown || world === undefined || session !== this.#session) return undefined;
    const ageMs = world.gameTimeMs - this.#atMs;
    if (ageMs > CLIENT_POSITION_FRESH_MS) return undefined;
    const lead = Math.min(Math.max(ageMs, 0), MAX_POSITION_LEAD_MS) / 1000;
    return { x: this.#x + this.#vx * lead, y: this.#y + this.#vy * lead };
  }

  #observePlayer(x: number, y: number, atMs: number, frameTimeMs: number | undefined): void {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;

    // Measured on the client's own clock where both frames have one, because
    // that is the time the client actually moved the character by; the offset
    // between the two clocks can shift by a millisecond between frames, and a
    // millisecond is a sixth of a frame.
    const gapMs =
      frameTimeMs !== undefined && this.#frameTimeMs !== undefined
        ? frameTimeMs - this.#frameTimeMs
        : atMs - this.#atMs;
    if (this.#playerKnown && gapMs > 0 && gapMs <= MAX_VELOCITY_GAP_MS) {
      const vx = ((x - this.#x) * 1000) / gapMs;
      const vy = ((y - this.#y) * 1000) / gapMs;
      const jumped = Math.hypot(vx, vy) > MAX_WALK_TILES_PER_SECOND;
      this.#vx = jumped ? 0 : vx;
      this.#vy = jumped ? 0 : vy;
    } else if (gapMs > 0 || !this.#playerKnown) {
      // The first reading, or the first after a silence: where the player is,
      // and no opinion about where they are going.
      this.#vx = 0;
      this.#vy = 0;
    }

    this.#playerKnown = true;
    this.#x = x;
    this.#y = y;
    this.#atMs = atMs;
    this.#frameTimeMs = frameTimeMs;
  }

  #applyShots(world: WorldState, frame: ClientFrameMessage, frameTimeMs: number): void {
    const store = world.projectileStore;
    for (const shot of frame.born) {
      const firedAtMs = this.#clock.toSession(frameTimeMs - shot.ageMs);
      if (firedAtMs === undefined) return;
      const confirmed = store.confirm(shot.ownerId, shot.bulletId, {
        firedAtMs,
        x: shot.x,
        y: shot.y,
        angle: shot.angle,
        speedMultiplier: shot.speedMultiplier,
        lifetimeMs: shot.lifetimeMs,
        halfTiles: shot.halfTiles,
      });
      if (confirmed) world.shots.confirmed += 1;
    }
    // Forgotten outright, whatever the shot passes through: this is not an
    // acknowledgement to interpret but the client saying the bullet no longer
    // exists.
    for (const shot of frame.gone) {
      if (store.forget(shot.ownerId, shot.bulletId)) world.shots.ended += 1;
    }
  }

  #forget(): void {
    this.#clock.reset();
    this.#playerKnown = false;
    this.#frameTimeMs = undefined;
    this.#vx = 0;
    this.#vy = 0;
  }
}
