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
 *
 * **A tick is the unit of time here, not a millisecond of ours.** The server
 * moves everything one tick's worth between two descriptions of the world; what
 * the network varies is when the packet carrying a description arrives. So a
 * velocity is a displacement per *tick*, and the local clock is used only for
 * the two questions it is the right clock for — how old a sighting is, and when
 * to forget one. Dividing by the local interval instead is what let a stalled
 * connection delivering three ticks in five milliseconds report a monster
 * walking at two hundred tiles a second, and an aim led by that number lands on
 * the far side of the room. That is why a sighting has no timestamp of its own:
 * it belongs to the tick it arrived on. See {@link MotionTracker.tick}.
 *
 * **What could not have been walked is not a velocity.** A teleport, a `GOTO`
 * and the server putting an entity back where it belongs all look like one
 * enormous step, and dividing any of them by the time it took produces a lead
 * measured in screens. Anything above {@link MAX_TILES_PER_MS} is taken as a
 * reposition: the position is believed, the motion is re-learned.
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

/**
 * Larger ones are a jink or a reversal, and not a circle to follow.
 *
 * The arc model answers a big heading change with a tight circle the entity is
 * held to keep going round, so a monster that simply turned about is predicted
 * onto the far side of that circle — which is a worse answer than the straight
 * blend it would otherwise have got. It is also what keeps `halfTurn` away from
 * `π`, where the chord-to-tangent correction below divides by a sine on its way
 * to zero and comes back out the other side negative.
 */
const MAX_TURN_RADIANS = 1.2;

/**
 * The game's own server tick, for a tick that did not state its own length.
 *
 * `NEWTICK` carries the figure and it has been 200 ms for the life of the game;
 * this is the fallback, not the number relied on.
 */
const SERVER_TICK_MS = 200;

/** What a stated tick length is believed within, before it is a bad reading. */
const MIN_TICK_MS = 20;
const MAX_TICK_MS = 1000;

/**
 * The fastest anything in this game is taken to travel under its own power, in
 * tiles per millisecond.
 *
 * Twenty tiles a second — over twice what the fastest possible character
 * manages, see `MAX_WALK_TILES_PER_SECOND`, and clear of the bosses that
 * charge. Nothing that walks is refused by it. What exceeds it did not walk,
 * and the two cases are told apart because only one of them can be led.
 */
const MAX_TILES_PER_MS = 0.02;

interface Track {
  x: number;
  y: number;
  /** Local, and only ever asked how old a sighting is and when to forget it. */
  atMs: number;
  /** On the tracker's own tick clock, which is what a velocity divides by. */
  serverAtMs: number;
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
  /**
   * The server's own clock, advanced one tick per tick.
   *
   * Never read off a packet's timestamp and never off ours: what a velocity
   * needs is how much *world* time separates two sightings, and that is one
   * tick per tick however late the packets carrying them turn up.
   */
  #serverNowMs = 0;
  /** When the tick being described arrived here. */
  #atMs = 0;
  #started = false;

  get size(): number {
    return this.#tracks.size;
  }

  /**
   * Opens a server tick. **Call once per `NEWTICK`, before its sightings.**
   *
   * Everything {@link observe} is told until the next call belongs to this
   * tick, which is what makes a velocity a displacement per tick rather than
   * per millisecond of network weather. Sweeping the stale tracks is folded in
   * because it is the same event — the world has just been described again, and
   * whatever went unmentioned for a while is gone.
   *
   * @param atMs When this tick reached us, on the world's own clock.
   * @param tickLengthMs What the tick said it lasted — `NEWTICK.tickTime`. A
   *   reading outside {@link MIN_TICK_MS}…{@link MAX_TICK_MS}, and a tick that
   *   stated nothing, fall back to {@link SERVER_TICK_MS}.
   */
  tick(atMs: number, tickLengthMs?: number): void {
    if (!Number.isFinite(atMs)) return;
    const stated = tickLengthMs ?? SERVER_TICK_MS;
    const believable =
      Number.isFinite(stated) && stated >= MIN_TICK_MS && stated <= MAX_TICK_MS
        ? stated
        : SERVER_TICK_MS;

    this.#serverNowMs += believable;
    this.#atMs = atMs;
    this.#started = true;
    this.#prune(atMs);
  }

  /**
   * Records where an entity is on the tick that is open.
   *
   * A sighting after a long gap, and one that has moved further than anything
   * walks, both restart the estimate rather than becoming a velocity: an entity
   * that was out of view has not been walking in a straight line the whole
   * time, and one that was picked up and put down did not walk at all.
   *
   * Silent until the first {@link tick}, because a sighting outside a tick has
   * no interval to be a velocity over.
   */
  observe(objectId: number, x: number, y: number): void {
    if (!this.#started || !Number.isFinite(x) || !Number.isFinite(y)) return;

    const track = this.#tracks.get(objectId);
    if (track === undefined) {
      this.#tracks.set(objectId, {
        x,
        y,
        atMs: this.#atMs,
        serverAtMs: this.#serverNowMs,
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

    // The same tick saying the same thing twice. Nothing new to derive, and no
    // reason to disturb what is already known.
    const elapsed = this.#serverNowMs - track.serverAtMs;
    if (elapsed <= 0) return;

    // Kept across a stale gap and across a stop, unlike the velocity: having
    // walked once is a fact about what the thing is, and the answer wanted is
    // "can this go anywhere", not "is it going somewhere this instant".
    const stepX = x - track.x;
    const stepY = y - track.y;
    if (Math.abs(stepX) > MOVED_TILES || Math.abs(stepY) > MOVED_TILES) {
      track.moved = true;
    }

    if (
      this.#atMs - track.atMs > STALE_MS ||
      Math.hypot(stepX, stepY) > MAX_TILES_PER_MS * elapsed
    ) {
      this.#restart(track, x, y);
      return;
    }

    const sampleX = stepX / elapsed;
    const sampleY = stepY / elapsed;
    const previousSpeed = Math.hypot(track.sampleVelocityX, track.sampleVelocityY);
    const sampleSpeed = Math.hypot(sampleX, sampleY);
    const hasTurn = track.hasVelocitySample && previousSpeed > 0 && sampleSpeed > 0;
    const turn = hasTurn
      ? Math.atan2(
          track.sampleVelocityX * sampleY - track.sampleVelocityY * sampleX,
          track.sampleVelocityX * sampleX + track.sampleVelocityY * sampleY,
        )
      : 0;

    if (Math.abs(turn) >= MIN_TURN_RADIANS && Math.abs(turn) <= MAX_TURN_RADIANS) {
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
    // Last, because the arc reconstruction above is the one step that can hand
    // back more speed than the sample it was built from.
    capSpeed(track);
    track.sampleVelocityX = sampleX;
    track.sampleVelocityY = sampleY;
    track.sampleElapsedMs = elapsed;
    track.hasVelocitySample = true;
    track.x = x;
    track.y = y;
    track.atMs = this.#atMs;
    track.serverAtMs = this.#serverNowMs;
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
    if (track === undefined || !track.moving || !Number.isFinite(nowMs)) return undefined;

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
   * Keeps where it is and forgets what it was doing.
   *
   * For the two cases nothing can be derived across: an entity that has been
   * out of view, and one that was moved rather than having walked. A restarted
   * track is in the same state as a freshly seen one — the position is known,
   * the motion is not — so {@link motionAt} says nothing about it until two
   * more ticks have described it.
   */
  #restart(track: Track, x: number, y: number): void {
    track.x = x;
    track.y = y;
    track.atMs = this.#atMs;
    track.serverAtMs = this.#serverNowMs;
    track.velocityX = 0;
    track.velocityY = 0;
    track.angularVelocityPerMs = 0;
    track.hasVelocitySample = false;
    track.moving = false;
  }

  /**
   * Forgets anything not seen for a while.
   *
   * **Runs on every tick, and it does not walk every tick.** Nothing can go
   * stale faster than {@link STALE_MS}, so sweeping more often than that cannot
   * find anything a later sweep would not — and the sweep is over every entity
   * being tracked, five times a second, for the length of a session.
   *
   * `forEach` rather than `for…of`: iterating a map's entries hands back a
   * fresh two-element array per entry, which for a realm's worth of monsters is
   * the largest thing this class would otherwise allocate. Deleting during it
   * is defined behaviour for a `Map`.
   */
  #prune(nowMs: number): void {
    if (nowMs - this.#lastSweepAtMs < STALE_MS) return;
    this.#lastSweepAtMs = nowMs;

    this.#tracks.forEach((track, objectId) => {
      if (nowMs - track.atMs > STALE_MS) this.#tracks.delete(objectId);
    });
  }

  clear(): void {
    this.#tracks.clear();
    this.#lastSweepAtMs = 0;
    this.#serverNowMs = 0;
    this.#atMs = 0;
    this.#started = false;
  }
}

/**
 * Holds a track's velocity to what could have been walked.
 *
 * The sample it was built from is already inside the bound — anything above it
 * restarted the track instead — but the arc reconstruction scales a chord up to
 * its tangent, and a blend of two believable samples is believable only because
 * this says so rather than because the arithmetic guarantees it.
 */
function capSpeed(track: Track): void {
  const speed = Math.hypot(track.velocityX, track.velocityY);
  if (speed <= MAX_TILES_PER_MS) return;
  const scale = MAX_TILES_PER_MS / speed;
  track.velocityX *= scale;
  track.velocityY *= scale;
}
