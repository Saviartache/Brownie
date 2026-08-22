/**
 * How fast the things being shot at are moving.
 *
 * The packet stream says where an entity *is*, once per server tick, and never
 * says where it is going. Leading a shot needs the second of those, so it is
 * derived here — from consecutive sightings of the same object id.
 *
 * **Smoothed, because the input is a step function.** A server tick moves an
 * entity in one jump, and dividing that jump by the interval gives a velocity
 * that is right on average and wrong in every individual tick — worst of all
 * for an entity that stops, whose last sample says it is still walking. A
 * running blend of the last few ticks is what turns that into something a lead
 * can be built on.
 */

export interface Motion {
  /** Tiles per millisecond. */
  readonly velocityX: number;
  readonly velocityY: number;
}

/** A motion, and where it has carried the entity by the moment asked about. */
export interface Sighting extends Motion {
  readonly x: number;
  readonly y: number;
}

/**
 * How much of a new sample replaces the running estimate.
 *
 * Chosen to settle within about three server ticks — roughly half a second,
 * which is the same order as the flight time being predicted. Faster follows
 * the noise; slower keeps aiming at where a monster was before it turned.
 */
const BLEND = 0.5;

/** How long a sighting stays useful. Beyond it the entity is re-learned. */
const STALE_MS = 1000;

/**
 * How far past its last sighting a track may be carried.
 *
 * A little over one server tick: filling the gap between two sightings is what
 * this is for, and a velocity carried much further describes a monster that has
 * been free to turn, stop or die since anything was last said about it.
 */
const MAX_PREDICT_MS = 250;

interface Track {
  x: number;
  y: number;
  atMs: number;
  velocityX: number;
  velocityY: number;
  /** Whether a velocity has been derived at all, as against assumed to be nil. */
  moving: boolean;
}

/**
 * Velocities by object id.
 *
 * Bounded by pruning rather than by the caller remembering to remove entities:
 * an entity that walks out of view stops being sampled, and a tracker that only
 * ever grew would hold every monster of a whole session.
 */
export class MotionTracker {
  readonly #tracks = new Map<number, Track>();
  /** When the last sweep ran, so a tick that cannot find anything skips one. */
  #lastSweepAtMs = 0;

  get size(): number {
    return this.#tracks.size;
  }

  /**
   * Records where an entity is now.
   *
   * A sighting after a long gap restarts the estimate rather than dividing the
   * distance by the gap: an entity that was out of view has not been walking in
   * a straight line the whole time, and treating it as though it had produces a
   * velocity of several tiles a second pointing wherever it re-appeared.
   */
  observe(objectId: number, x: number, y: number, atMs: number): void {
    const track = this.#tracks.get(objectId);
    if (track === undefined) {
      this.#tracks.set(objectId, { x, y, atMs, velocityX: 0, velocityY: 0, moving: false });
      return;
    }

    const elapsed = atMs - track.atMs;
    if (elapsed <= 0) return;
    if (elapsed > STALE_MS) {
      track.x = x;
      track.y = y;
      track.atMs = atMs;
      track.velocityX = 0;
      track.velocityY = 0;
      track.moving = false;
      return;
    }

    const sampleX = (x - track.x) / elapsed;
    const sampleY = (y - track.y) / elapsed;
    if (track.moving) {
      track.velocityX += (sampleX - track.velocityX) * BLEND;
      track.velocityY += (sampleY - track.velocityY) * BLEND;
    } else {
      track.velocityX = sampleX;
      track.velocityY = sampleY;
      track.moving = true;
    }
    track.x = x;
    track.y = y;
    track.atMs = atMs;
  }

  /**
   * Where an entity is *now*, and what it is doing — or `undefined` if it has
   * been seen only once.
   *
   * The difference matters: "not moving" and "not known to be moving" lead to
   * the same aim point but not to the same confidence in it, and a caller that
   * wants to hold fire until it knows can only do so if the two are told apart.
   *
   * **The sighting is carried forward to `nowMs`.** Sightings arrive five times
   * a second and a decision is made far more often than that, so a caller
   * reading the raw sample aims at where the enemy was up to a whole tick ago —
   * which for anything walking is a tile of error that looks exactly like the
   * feature reacting late. Bounded by {@link MAX_PREDICT_MS}, because a
   * velocity carried further than that stops being evidence.
   */
  motionAt(objectId: number, nowMs: number): Sighting | undefined {
    const track = this.#tracks.get(objectId);
    if (track === undefined || !track.moving) return undefined;

    const ahead = Math.min(Math.max(nowMs - track.atMs, 0), MAX_PREDICT_MS);
    return {
      x: track.x + track.velocityX * ahead,
      y: track.y + track.velocityY * ahead,
      velocityX: track.velocityX,
      velocityY: track.velocityY,
    };
  }

  /**
   * Forgets anything not seen for a while.
   *
   * **Safe to call every tick, and it does not walk every tick.** Nothing can
   * go stale faster than {@link STALE_MS}, so sweeping more often than that
   * cannot find anything a later sweep would not — and the sweep is over every
   * entity being tracked, five times a second, for the length of a session.
   *
   * `forEach` rather than `for…of`: iterating a map's entries hands back a
   * fresh two-element array per entry, which for a realm's worth of monsters is
   * the largest thing this class would otherwise allocate. Deleting during it
   * is defined behaviour for a `Map`.
   */
  prune(nowMs: number): void {
    if (nowMs - this.#lastSweepAtMs < STALE_MS) return;
    this.#lastSweepAtMs = nowMs;

    this.#tracks.forEach((track, objectId) => {
      if (nowMs - track.atMs > STALE_MS) this.#tracks.delete(objectId);
    });
  }

  clear(): void {
    this.#tracks.clear();
    this.#lastSweepAtMs = 0;
  }
}
