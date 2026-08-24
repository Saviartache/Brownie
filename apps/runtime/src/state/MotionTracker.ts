/**
 * How fast the things in the world are moving.
 *
 * The packet stream says where an entity *is*, once per server tick, and never
 * says where it is going. Two features need the second of those and neither can
 * get it anywhere else: auto-aim leads its shots with it, and the dodge tells a
 * monster the player has walked up to from one that has walked up to the player
 * — which is the difference between a knight standing where they meant to and a
 * melee minion closing in. So it lives beside the world model rather than
 * inside either of them.
 *
 * **Smoothed, because the input is a step function.** A server tick moves an
 * entity in one jump, and dividing that jump by the interval gives a velocity
 * that is right on average and wrong in every individual tick — worst of all
 * for an entity that stops, whose last sample says it is still walking. A
 * running blend of the last few ticks is what turns that into something a lead
 * can be built on. A sustained heading change is treated separately as an arc:
 * averaging its axes would lag behind every turn and project the target along a
 * tangent it has already left.
 */

export interface Motion {
  /** Tiles per millisecond. */
  readonly velocityX: number;
  readonly velocityY: number;
  /** Radians per millisecond. Positive turns counter-clockwise. */
  readonly angularVelocityPerMs?: number;
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
 * How far an entity has to shift before it counts as having moved, in tiles.
 *
 * Positions arrive as the server's own floats and a thing standing still
 * reports the same pair every tick, so this is not noise filtering — it is the
 * guard against a rounding or a server correction of a hundredth of a tile
 * reading as "this thing walks".
 */
const MOVED_TILES = 0.05;

/**
 * How far past its last sighting a track may be carried.
 *
 * A little over one server tick: filling the gap between two sightings is what
 * this is for, and a velocity carried much further describes a monster that has
 * been free to turn, stop or die since anything was last said about it.
 */
const MAX_PREDICT_MS = 250;

/** Smaller heading changes are more likely packet noise than a real turn. */
const MIN_TURN_RADIANS = 0.05;

interface Track {
  x: number;
  y: number;
  atMs: number;
  velocityX: number;
  velocityY: number;
  angularVelocityPerMs: number;
  sampleVelocityX: number;
  sampleVelocityY: number;
  sampleElapsedMs: number;
  hasVelocitySample: boolean;
  /** Whether a velocity has been derived at all, as against assumed to be nil. */
  moving: boolean;
  /**
   * Whether it has ever actually gone anywhere.
   *
   * Not the same claim as {@link moving}, which is true the moment two
   * sightings can be subtracted and stays true of something that has never
   * shifted a tile. This one is what tells a monster from a fixture — see
   * {@link MotionTracker.hasMoved}.
   */
  moved: boolean;
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
      this.#tracks.set(objectId, {
        x,
        y,
        atMs,
        velocityX: 0,
        velocityY: 0,
        angularVelocityPerMs: 0,
        sampleVelocityX: 0,
        sampleVelocityY: 0,
        sampleElapsedMs: 0,
        hasVelocitySample: false,
        moving: false,
        moved: false,
      });
      return;
    }

    const elapsed = atMs - track.atMs;
    if (elapsed <= 0) return;
    // Kept across a stale gap and across a stop, unlike the velocity: having
    // walked once is a fact about what the thing is, and the answer wanted is
    // "can this go anywhere", not "is it going somewhere this instant".
    if (Math.abs(x - track.x) > MOVED_TILES || Math.abs(y - track.y) > MOVED_TILES) {
      track.moved = true;
    }
    if (elapsed > STALE_MS) {
      track.x = x;
      track.y = y;
      track.atMs = atMs;
      track.velocityX = 0;
      track.velocityY = 0;
      track.angularVelocityPerMs = 0;
      track.hasVelocitySample = false;
      track.moving = false;
      return;
    }

    const sampleX = (x - track.x) / elapsed;
    const sampleY = (y - track.y) / elapsed;
    const previousSpeed = Math.hypot(track.sampleVelocityX, track.sampleVelocityY);
    const sampleSpeed = Math.hypot(sampleX, sampleY);
    const hasTurn = track.hasVelocitySample && previousSpeed > 0 && sampleSpeed > 0;
    const turn = hasTurn
      ? Math.atan2(
          track.sampleVelocityX * sampleY - track.sampleVelocityY * sampleX,
          track.sampleVelocityX * sampleX + track.sampleVelocityY * sampleY,
        )
      : 0;

    if (Math.abs(turn) >= MIN_TURN_RADIANS) {
      const betweenSamplesMs = (track.sampleElapsedMs + elapsed) / 2;
      track.angularVelocityPerMs = turn / betweenSamplesMs;

      // A displacement is a chord whose direction belongs at its midpoint.
      // Rotate it to the endpoint tangent and restore the arc speed.
      const halfTurn = (track.angularVelocityPerMs * elapsed) / 2;
      const speedScale = halfTurn / Math.sin(halfTurn);
      const cos = Math.cos(halfTurn);
      const sin = Math.sin(halfTurn);
      track.velocityX = (sampleX * cos - sampleY * sin) * speedScale;
      track.velocityY = (sampleX * sin + sampleY * cos) * speedScale;
    } else if (track.moving) {
      track.velocityX += (sampleX - track.velocityX) * BLEND;
      track.velocityY += (sampleY - track.velocityY) * BLEND;
      track.angularVelocityPerMs = 0;
    } else {
      track.velocityX = sampleX;
      track.velocityY = sampleY;
      track.angularVelocityPerMs = 0;
      track.moving = true;
    }
    track.sampleVelocityX = sampleX;
    track.sampleVelocityY = sampleY;
    track.sampleElapsedMs = elapsed;
    track.hasVelocitySample = true;
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
    const turn = track.angularVelocityPerMs * ahead;
    const sin = Math.sin(turn);
    const cos = Math.cos(turn);
    const displacementX =
      track.angularVelocityPerMs === 0
        ? track.velocityX * ahead
        : (track.velocityX * sin - track.velocityY * (1 - cos)) / track.angularVelocityPerMs;
    const displacementY =
      track.angularVelocityPerMs === 0
        ? track.velocityY * ahead
        : (track.velocityY * sin + track.velocityX * (1 - cos)) / track.angularVelocityPerMs;
    return {
      x: track.x + displacementX,
      y: track.y + displacementY,
      velocityX: track.velocityX * cos - track.velocityY * sin,
      velocityY: track.velocityX * sin + track.velocityY * cos,
      angularVelocityPerMs: track.angularVelocityPerMs,
    };
  }

  /**
   * Whether this one has ever been seen to go anywhere.
   *
   * **The one thing that tells a monster from a fixture without asking the
   * catalog**, and the catalog cannot answer it: a spawn anchor, an emitter and
   * a room controller are `<Enemy />` with a health bar, exactly as the thing
   * chasing the player is, and better than a quarter of the file's enemies are
   * one. What separates them is that they stand still forever, and that is
   * visible from two sightings.
   *
   * False for something seen only once, which every entity is on the tick it
   * comes into view. Reading it as "harmless" would be wrong; reading it as "no
   * evidence yet" is what it means, and a caller acting on it should want the
   * evidence rather than its absence.
   */
  hasMoved(objectId: number): boolean {
    return this.#tracks.get(objectId)?.moved ?? false;
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
