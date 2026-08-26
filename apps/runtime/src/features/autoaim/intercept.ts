/**
 * Where to aim so that a shot and a moving target arrive at the same place.
 *
 * The whole of auto-aim's arithmetic, kept apart from the plugin so it can be
 * tested against numbers rather than against a session. Nothing here knows
 * about packets, settings or the native module.
 *
 * **Aiming at where the target is now is not aiming.** A shot takes time to
 * cross the distance, and everything in this game moves while it does. So the
 * question is not "which way is the enemy" but "which way will the enemy and
 * the shot be in the same place". Straight motion has an exact quadratic
 * answer; turning motion is followed along its measured arc.
 */

export interface InterceptRequest {
  readonly shooterX: number;
  readonly shooterY: number;
  readonly targetX: number;
  readonly targetY: number;
  /** Tiles per millisecond. Zero is a target that is not known to be moving. */
  readonly targetVelocityX: number;
  readonly targetVelocityY: number;
  /** Radians per millisecond. Zero keeps the target on a straight line. */
  readonly targetAngularVelocityPerMs: number;
  /** Tiles per millisecond, as the game's own projectile data states it. */
  readonly bulletSpeedTilesPerMs: number;
  /**
   * How long the shot has to hit something with. A solution beyond it is a shot
   * that stops mattering first.
   *
   * **Not simply the lifetime**, and the caller is the one that knows the
   * difference: a shot that stops at a stated range gets there before it
   * expires. Whatever the figure is, it is also what bounds the aim point —
   * `|aim − shooter|` is `speed × flight` by construction, so a meeting the
   * shot could not reach is refused rather than aimed at.
   */
  readonly maxFlightMs: number;
}

export interface Intercept {
  /** Where to aim: where the target will be when the shot gets there. */
  readonly x: number;
  readonly y: number;
  /** How long the shot spends in the air to reach it. */
  readonly flightMs: number;
}

/**
 * Solves for the meeting point, or reports that there is not one.
 *
 * `undefined` rather than a best effort, in four cases that are genuinely
 * different from a bad answer: the shot has no speed to give, the target has no
 * reachable meeting point, the meeting happens after the shot has stopped
 * mattering, and one of the numbers describing the problem is not a number.
 * Each of those is "do not fire at this", and a plugin that received a
 * plausible angle instead would fire at nothing — or, for the last of them,
 * hand a `NaN` straight to the module that points the shots.
 */
export function solveIntercept(request: InterceptRequest): Intercept | undefined {
  const speed = request.bulletSpeedTilesPerMs;
  if (!(speed > 0) || !(request.maxFlightMs > 0) || !Number.isFinite(request.maxFlightMs)) {
    return undefined;
  }
  if (
    !Number.isFinite(request.shooterX) ||
    !Number.isFinite(request.shooterY) ||
    !Number.isFinite(request.targetX) ||
    !Number.isFinite(request.targetY) ||
    !Number.isFinite(request.targetVelocityX) ||
    !Number.isFinite(request.targetVelocityY) ||
    !Number.isFinite(request.targetAngularVelocityPerMs)
  ) {
    return undefined;
  }

  const dx = request.targetX - request.shooterX;
  const dy = request.targetY - request.shooterY;
  const vx = request.targetVelocityX;
  const vy = request.targetVelocityY;

  // |D + V·t| = speed·t, squared and collected: a·t² + 2b·t + c = 0.
  const a = vx * vx + vy * vy - speed * speed;
  const b = dx * vx + dy * vy;
  const c = dx * dx + dy * dy;

  const flightMs =
    request.targetAngularVelocityPerMs === 0
      ? solveFlightTime(a, b, c)
      : solveTurningFlightTime(request, dx, dy);
  if (flightMs === undefined || !(flightMs >= 0) || flightMs > request.maxFlightMs) {
    return undefined;
  }

  const target = targetAt(request, flightMs);

  return {
    x: target.x,
    y: target.y,
    flightMs,
  };
}

function targetAt(request: InterceptRequest, flightMs: number): { x: number; y: number } {
  const angular = request.targetAngularVelocityPerMs;
  if (angular === 0) {
    return {
      x: request.targetX + request.targetVelocityX * flightMs,
      y: request.targetY + request.targetVelocityY * flightMs,
    };
  }

  const turn = angular * flightMs;
  const sin = Math.sin(turn);
  const cos = Math.cos(turn);
  return {
    x:
      request.targetX +
      (request.targetVelocityX * sin - request.targetVelocityY * (1 - cos)) / angular,
    y:
      request.targetY +
      (request.targetVelocityY * sin + request.targetVelocityX * (1 - cos)) / angular,
  };
}

/** Finds the first meeting with a target following a constant-turn arc. */
function solveTurningFlightTime(
  request: InterceptRequest,
  initialDx: number,
  initialDy: number,
): number | undefined {
  if (initialDx === 0 && initialDy === 0) return 0;

  const residual = (flightMs: number): number => {
    const target = targetAt(request, flightMs);
    return (
      Math.hypot(target.x - request.shooterX, target.y - request.shooterY) -
      request.bulletSpeedTilesPerMs * flightMs
    );
  };

  // Sample densely enough that even a fast turn advances by at most 11.25°.
  const turnSteps = Math.ceil(
    (Math.abs(request.targetAngularVelocityPerMs) * request.maxFlightMs * 16) / Math.PI,
  );
  const steps = Math.min(Math.max(turnSteps, 32), 512);
  let low = 0;
  for (let step = 1; step <= steps; step += 1) {
    const high = (request.maxFlightMs * step) / steps;
    if (residual(high) <= 0) {
      let left = low;
      let right = high;
      for (let iteration = 0; iteration < 24; iteration += 1) {
        const middle = (left + right) / 2;
        if (residual(middle) <= 0) right = middle;
        else left = middle;
      }
      return right;
    }
    low = high;
  }
  return undefined;
}

/**
 * The smallest non-negative root, or nothing.
 *
 * The degenerate case is not an edge case here: a stationary target — which is
 * most of them — makes `a` exactly `-speed²`, and a target moving at precisely
 * the shot's speed makes it zero, at which point the quadratic formula divides
 * by nought. Both are handled rather than guarded against, because "the enemy
 * is standing still" must not be the case that fails.
 */
function solveFlightTime(a: number, b: number, c: number): number | undefined {
  if (c === 0) return 0;

  if (Math.abs(a) < 1e-12) {
    // Linear: 2b·t + c = 0. Only closing motion has a solution; `b >= 0` is a
    // target retreating at exactly the shot's speed, which never catches up.
    if (b >= 0) return undefined;
    return c / (-2 * b);
  }

  const discriminant = b * b - a * c;
  if (discriminant < 0) return undefined;

  const root = Math.sqrt(discriminant);
  // Both roots, in the form that stays accurate when one of them is small.
  const first = (-b - root) / a;
  const second = (-b + root) / a;

  const low = Math.min(first, second);
  const high = Math.max(first, second);
  if (low >= 0) return low;
  if (high >= 0) return high;
  return undefined;
}
