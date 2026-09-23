/**
 * Where a shot is, as the game itself works it out.
 *
 * **A port of the client, not a model of it.** Every branch below is the
 * client's own projectile code — the position function, the distance function
 * behind it, the turn helpers and the one-off correction a turn makes when it
 * stops — read out of `GameAssembly.dll` and checked against the build that is
 * installed. An approximation here is not "less accurate": it is a different
 * curve, and the shots it gets wrong are exactly the ones worth dodging. The
 * previous model was a port of the old Flash client; it had no turns, the wrong
 * acceleration at the edges, and no idea the owner could make a shot faster.
 *
 * **Two numbers come from the monster that fired, not from the shot's data.**
 * The game hands every enemy shot a speed multiplier and a lifetime multiplier
 * read off its owner at the moment it fires — stats 102 and 103, in thousandths
 * — and they scale the speed, the acceleration and its delay, the lifetime, and
 * therefore every figure that is measured in lifetimes. A dungeon that speeds a
 * boss's bullets up by a fifth was being dodged at the speed the file states.
 * See {@link ShotLaunch}.
 *
 * **Its own units, deliberately.** The client keeps speeds in tiles per second,
 * delays in seconds and angles in radians, converts the file's numbers once
 * when it loads them, and then mixes the converted ones with a few it never
 * converts. Reproducing that faithfully is the whole point, so the constructor
 * does the client's conversions and the methods use the client's formulas —
 * including the two places where they are inconsistent with each other.
 */

import type { Position } from '@brownie/plugin-api';
import type { ProjectileDefinition } from '../../gamedata/projectiles.js';

/** Everything about one shot's flight that is fixed the moment it is fired. */
export interface ShotLaunch {
  /**
   * The client's number for this shot, which is what its phase is read from.
   *
   * **Not the number on the wire.** A volley arrives as one bullet id and a
   * count; the client numbers the shots `(id + index) mod 32767`, and whether
   * that is odd decides which side a wave starts on. See {@link clientBulletId}.
   */
  readonly bulletId: number;
  readonly x: number;
  readonly y: number;
  /** Radians. */
  readonly angle: number;
  /** The owner's projectile speed multiplier when it fired. One when unstated. */
  readonly speedMultiplier: number;
  /** And its projectile lifetime multiplier. One when unstated. */
  readonly lifetimeMultiplier: number;
}

/**
 * How the client numbers the shots of a volley.
 *
 * `Convert.ToUInt32(id + index) % 32767`, in the game's own `ENEMYSHOOT`
 * handler. The wire field is sixteen bits and the client never sees a negative
 * one — the conversion would throw — so it is read as unsigned here rather than
 * reproducing an exception.
 */
export function clientBulletId(wireBulletId: number, index: number): number {
  const id = ((wireBulletId & 0xffff) + index) % 32767;
  return id < 0 ? id + 32767 : id;
}

/**
 * The multiplier an owner's stat describes, from the thousandths it is sent in.
 *
 * Unstated, nought or nonsense are all one: a multiplier of nought is a shot
 * that never moves and never expires, which is not a thing the server means.
 */
export function statMultiplier(thousandths: number | undefined): number {
  if (thousandths === undefined || !Number.isFinite(thousandths) || thousandths <= 0) return 1;
  return thousandths / 1000;
}

/**
 * Whether a shot of this kind sits where it was fired for its whole life.
 *
 * No speed, no acceleration that could give it one, and no figure or swing to
 * move it sideways. A laser is excluded even though it never moves: its reach
 * is the beam, not the square under its emitter.
 */
export function staysPut(definition: ProjectileDefinition): boolean {
  if (definition.speed !== 0 || definition.laserTiles > 0) return false;
  if (definition.parametric || definition.amplitude !== 0) return false;
  // From a standstill, acceleration only gets anywhere towards a clamp above it.
  return !(definition.acceleration > 0 && definition.speedClamp > 0);
}

/** How long the client lets a turning shot run on after its turn stops, to read its heading. */
const TURN_EXIT_CHORD_MS = 16;

const DEGREES = Math.PI / 180;

/** `π / 64`: how far either side of its heading a wavy shot swings. */
const WAVY_SWING_RADIANS = Math.PI / 64;

/** `6π` radians a second: three full swings. */
const WAVY_RADIANS_PER_MS = (6 * Math.PI) / 1000;

export class ShotMotion {
  /**
   * How long it flies, in milliseconds: the file's lifetime times the owner's
   * multiplier. The client removes it the moment this is exceeded.
   */
  readonly lifetimeMs: number;
  /**
   * The fastest it ever moves, or `Infinity` when its path curves.
   *
   * A bound rather than a speed: it is what lets a shot that cannot possibly
   * reach anybody be skipped without predicting it. A curving shot can move
   * across the ground faster than along its own path — an orbit's rim does —
   * so it is given no bound at all rather than a wrong one.
   */
  readonly maxSpeedTilesPerSecond: number;

  readonly #definition: ProjectileDefinition;
  readonly #x: number;
  readonly #y: number;
  readonly #angle: number;
  readonly #phase: number;
  readonly #odd: boolean;
  readonly #upper: boolean;

  /** Tiles a second at launch. */
  readonly #speed: number;
  readonly #speedMultiplier: number;
  readonly #accelerating: boolean;
  /** Seconds before the acceleration begins, already divided by the multiplier. */
  readonly #accelerationDelayS: number;
  /** Tiles a second a second, before the multiplier. */
  readonly #acceleration: number;
  readonly #accelerationInverse: number;
  /** Tiles a second. */
  readonly #speedClamp: number;

  readonly #turning: boolean;
  readonly #circling: boolean;
  readonly #turnDelayed: boolean;
  readonly #turnAccelerated: boolean;
  /** Radians. */
  readonly #turnRate: number;
  readonly #turnRateDelayS: number;
  readonly #turnAcceleration: number;
  readonly #turnAccelerationInverse: number;
  readonly #turnAccelerationDelayS: number;
  readonly #turnClamp: number;
  readonly #turnStopTimeMs: number;
  /** Whether the turn ends before the flight does, which is when the heading is re-read. */
  readonly #turnEnds: boolean;
  readonly #circleTurnAngle: number;
  readonly #circleTurnDelayMs: number;
  /** How far a circling shot is from its origin while it circles. */
  readonly #circleRadius: number;

  /**
   * Where a turning shot is when its turn ends, and which way it then goes.
   *
   * The client works these out once, the first time it asks about a moment past
   * the end of the turn, and writes them over the shot's own start and heading.
   * Worked out here once as well, so that asking about any moment — earlier or
   * later, in any order — gives the answer the client gave when it got there.
   */
  readonly #exitX: number;
  readonly #exitY: number;
  readonly #exitAngle: number;
  readonly #exitDistance: number;

  constructor(definition: ProjectileDefinition, launch: ShotLaunch) {
    this.#definition = definition;
    this.#x = launch.x;
    this.#y = launch.y;
    this.#angle = launch.angle;
    this.#odd = (launch.bulletId & 1) === 1;
    this.#upper = (launch.bulletId & 3) >= 2;
    this.#phase = this.#odd ? Math.PI : 0;

    const speedMultiplier = positive(launch.speedMultiplier);
    this.lifetimeMs = Math.max(0, definition.lifetimeMs) * positive(launch.lifetimeMultiplier);

    // The client's loader: speeds are stored in tenths of a tile per second and
    // held in tiles, the delay in milliseconds and held in seconds.
    this.#speedMultiplier = speedMultiplier;
    this.#speed = (definition.speed / 10) * speedMultiplier;
    this.#acceleration = definition.acceleration / 10;
    this.#accelerating = this.#acceleration !== 0;
    this.#accelerationInverse = this.#accelerating ? 1 / this.#acceleration : 0;
    this.#accelerationDelayS = definition.accelerationDelayMs / 1000 / speedMultiplier;
    this.#speedClamp = Math.max(0, definition.speedClamp) / 10;

    // And the turn: degrees become radians, delays become seconds — except the
    // circling delay, which the client keeps in milliseconds and compares with
    // milliseconds.
    this.#turnRate = definition.turnRate * DEGREES;
    this.#turning = this.#turnRate !== 0;
    this.#turnRateDelayS = definition.turnRateDelayMs / 1000;
    this.#turnDelayed = this.#turnRateDelayS !== 0;
    this.#circleTurnDelayMs = definition.circleTurnDelayMs;
    this.#circling = this.#circleTurnDelayMs !== 0;
    this.#circleTurnAngle =
      this.#turning && this.#circling ? this.#turnRate : definition.circleTurnAngle * DEGREES;
    this.#turnAccelerationDelayS = definition.turnAccelerationDelayMs / 1000;
    this.#turnAcceleration = definition.turnAcceleration;
    this.#turnAccelerated = this.#turnAcceleration !== 0;
    this.#turnAccelerationInverse = this.#turnAccelerated ? 1 / this.#turnAcceleration : 0;
    this.#turnClamp = definition.turnClamp * DEGREES;
    const turnUntil = this.#circling ? this.#circleTurnDelayMs : definition.lifetimeMs;
    this.#turnStopTimeMs = definition.turnStopTimeMs === 0 ? turnUntil : definition.turnStopTimeMs;
    this.#turnEnds = this.#turnStopTimeMs !== turnUntil;

    this.#circleRadius = this.#circling ? this.distanceAt(this.#circleTurnDelayMs) : 0;

    if (this.#turning && this.#turnEnds) {
      // The client's own arithmetic, in its own order: where the turn leaves
      // it, and a chord sixteen milliseconds on to read which way it is then
      // going.
      const stop = this.#turnStopTimeMs;
      const stopDistance = this.distanceAt(stop);
      const stopTurn = this.#turnAt(stop, true);
      const exitX = this.#x + Math.cos(this.#angle + stopTurn) * stopDistance;
      const exitY = this.#y + Math.sin(this.#angle + stopTurn) * stopDistance;
      const later = stop + TURN_EXIT_CHORD_MS;
      const laterDistance = this.distanceAt(later);
      const laterTurn = this.#turnAt(later, true);
      const laterX = this.#x + Math.cos(this.#angle + laterTurn) * laterDistance;
      const laterY = this.#y + Math.sin(this.#angle + laterTurn) * laterDistance;
      this.#exitX = exitX;
      this.#exitY = exitY;
      this.#exitAngle = Math.atan2(laterY - exitY, laterX - exitX);
      this.#exitDistance = stopDistance;
    } else {
      this.#exitX = this.#x;
      this.#exitY = this.#y;
      this.#exitAngle = this.#angle;
      this.#exitDistance = 0;
    }

    this.maxSpeedTilesPerSecond = this.#curves() ? Infinity : this.#straightTopSpeed();
  }

  /**
   * Where it is `elapsedMs` after it was fired, or `undefined` outside its
   * flight — before it exists or after it is gone, which is different from "at
   * its last position".
   */
  positionAt(elapsedMs: number): Position | undefined {
    if (!(elapsedMs >= 0) || elapsedMs > this.lifetimeMs || !(this.lifetimeMs > 0)) {
      return undefined;
    }
    const t = elapsedMs;
    const definition = this.#definition;
    let distance = this.distanceAt(t);

    if (definition.wavy) {
      const heading =
        this.#angle + WAVY_SWING_RADIANS * Math.sin(this.#phase + t * WAVY_RADIANS_PER_MS);
      return this.#along(this.#x, this.#y, heading, distance);
    }

    if (definition.parametric) {
      const s = (t / this.lifetimeMs) * 2 * Math.PI;
      const first = Math.sin(s) * (this.#odd ? 1 : -1);
      const second = Math.sin(2 * s) * (this.#upper ? -1 : 1);
      const cos = Math.cos(this.#angle);
      const sin = Math.sin(this.#angle);
      return {
        x: this.#x + (cos * first - sin * second) * definition.magnitude,
        y: this.#y + (sin * first + cos * second) * definition.magnitude,
      };
    }

    if (this.#turning) {
      if (this.#circling && t >= this.#circleTurnDelayMs) {
        // Both a turn and a circle: the circling angle is the turn's own rate,
        // and it is swept from the moment of firing rather than from the delay.
        // A turn that ended before the circling began has already moved the
        // client's idea of where the shot started, and the circle is drawn
        // round that.
        const exited = this.#turnEnds && this.#turnStopTimeMs < this.#circleTurnDelayMs;
        const turn = this.#sweep(this.#circleTurnAngle, t);
        return this.#along(
          exited ? this.#exitX : this.#x,
          exited ? this.#exitY : this.#y,
          (exited ? this.#exitAngle : this.#angle) + turn,
          this.#circleRadius,
        );
      }
      if (this.#turnEnds && t >= this.#turnStopTimeMs) {
        distance -= this.#exitDistance;
        return this.#along(
          this.#exitX,
          this.#exitY,
          this.#exitAngle + this.#turnAt(t, false),
          distance,
        );
      }
      return this.#along(this.#x, this.#y, this.#angle + this.#turnAt(t, false), distance);
    }

    if (this.#circling) {
      let turn = 0;
      if (t >= this.#circleTurnDelayMs) {
        distance = this.#circleRadius;
        turn = this.#sweep(this.#circleTurnAngle, t - this.#circleTurnDelayMs);
      }
      return this.#along(this.#x, this.#y, this.#angle + turn, distance);
    }

    if (definition.boomerang) {
      // Where the client turns it round: half its flight at its launch speed,
      // whatever acceleration says — the client's own shortcut, kept.
      const halfway = (this.#speed * this.lifetimeMs) / 1000 / 2;
      if (distance > halfway) distance = halfway - (distance - halfway);
    }

    const cos = Math.cos(this.#angle);
    const sin = Math.sin(this.#angle);
    let x = this.#x + cos * distance;
    let y = this.#y + sin * distance;
    if (definition.amplitude !== 0) {
      const lateral =
        definition.amplitude *
        Math.sin(this.#phase + (t / this.lifetimeMs) * definition.frequency * 2 * Math.PI);
      x -= sin * lateral;
      y += cos * lateral;
    }
    return { x, y };
  }

  /**
   * How far along its path it has travelled, in tiles.
   *
   * Constant speed until the delay, then a constant acceleration until the speed
   * reaches its clamp, then constant again. **The clamp only ever lets a shot
   * reach it**: one accelerating towards a clamp below its speed, or braking
   * towards one above it, simply keeps its speed — which is not what a naive
   * integration does, and eighty of the game's projectiles are written that way.
   */
  distanceAt(elapsedMs: number): number {
    const t = elapsedMs / 1000;
    const speed = this.#speed;
    const cruise = t * speed;
    if (!this.#accelerating || t < this.#accelerationDelayS) return cruise;

    const accelerating = t - this.#accelerationDelayS;
    const m = this.#speedMultiplier;
    const gained = accelerating * this.#acceleration * m;
    const change =
      this.#accelerationInverse > 0
        ? (Math.max(this.#speedClamp, speed) - speed) * m
        : (Math.min(this.#speedClamp, speed) - speed) * m;
    const untilClamp = change * this.#accelerationInverse;
    if (accelerating <= untilClamp) return cruise + 0.5 * gained * accelerating;
    return cruise + 0.5 * untilClamp * change + (accelerating - untilClamp) * change;
  }

  /**
   * How far the heading has turned by `elapsedMs`, in radians.
   *
   * @param pastStop Whether a moment after the turn stops is being asked about
   *   on purpose — the client does so exactly once, to find where the turn left
   *   the shot. Otherwise the turn is over and contributes nothing.
   */
  #turnAt(elapsedMs: number, pastStop: boolean): number {
    if (!pastStop && elapsedMs > this.#turnStopTimeMs) return 0;
    let t = elapsedMs;
    const seconds = elapsedMs / 1000;
    if (this.#turnDelayed) {
      if (seconds < this.#turnRateDelayS) return 0;
      t -= this.#turnRateDelayS * 1000;
    }
    return this.#acceleratedTurn(this.#sweep(this.#turnRate, t), seconds);
  }

  /**
   * An angle spread evenly over the turn's duration, `elapsedMs` of the way in.
   *
   * The client divides by the duration unguarded; a definition that leaves it at
   * nought is one that also has no lifetime, and is never tracked — but a
   * division by it here would put `NaN` into every position after it.
   */
  #sweep(angle: number, elapsedMs: number): number {
    return this.#turnStopTimeMs > 0 ? (angle / this.#turnStopTimeMs) * elapsedMs : 0;
  }

  /**
   * A turn that speeds up, which the client shapes exactly as it shapes speed:
   * a delay, a steady change, and a clamp that is only ever approached.
   */
  #acceleratedTurn(turn: number, seconds: number): number {
    if (!this.#turnAccelerated || seconds < this.#turnAccelerationDelayS) return turn;
    const accelerating = seconds - this.#turnAccelerationDelayS;
    const gained = accelerating * this.#turnAcceleration;
    const rate = this.#turnRate;
    const change =
      this.#turnAccelerationInverse > 0
        ? Math.max(this.#turnClamp, rate) - rate
        : Math.min(this.#turnClamp, rate) - rate;
    const untilClamp = change * this.#turnAccelerationInverse;
    if (accelerating <= untilClamp) return turn + gained * accelerating * 0.5;
    return turn + untilClamp * change * 0.5 + (accelerating - untilClamp) * change;
  }

  #along(x: number, y: number, heading: number, distance: number): Position {
    return { x: x + Math.cos(heading) * distance, y: y + Math.sin(heading) * distance };
  }

  /**
   * Whether it can cross the ground faster than it travels along its path.
   *
   * A boomerang is not one of them: coming back along its own line is still no
   * faster than going out along it.
   */
  #curves(): boolean {
    const definition = this.#definition;
    return (
      definition.wavy ||
      definition.parametric ||
      definition.amplitude !== 0 ||
      this.#turning ||
      this.#circling
    );
  }

  /** The launch speed, or the clamp when acceleration can reach it. */
  #straightTopSpeed(): number {
    const launch = Math.abs(this.#speed);
    if (!this.#accelerating || this.#accelerationInverse <= 0) return launch;
    const change = (Math.max(this.#speedClamp, this.#speed) - this.#speed) * this.#speedMultiplier;
    return Math.max(launch, Math.abs(this.#speed + change));
  }
}

/** A multiplier the client would have used: positive and finite, or one. */
function positive(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 1;
}
