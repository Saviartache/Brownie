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
 * the shot be in the same place", and that is a quadratic rather than an
 * `atan2`.
 */

export interface InterceptRequest {
  readonly shooterX: number;
  readonly shooterY: number;
  readonly targetX: number;
  readonly targetY: number;
  /** Tiles per millisecond. Zero is a target that is not known to be moving. */
  readonly targetVelocityX: number;
  readonly targetVelocityY: number;
  /** Tiles per millisecond, as the game's own projectile data states it. */
  readonly bulletSpeedTilesPerMs: number;
  /** The shot's lifetime. A solution beyond it is a shot that expires first. */
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
 * `undefined` rather than a best effort, in three cases that are genuinely
 * different from a bad answer: the shot has no speed to give, the target is
 * moving away faster than the shot travels, and the meeting happens after the
 * shot has expired. Each of those is "do not fire at this", and a plugin that
 * received a plausible angle instead would fire at nothing.
 */
export function solveIntercept(request: InterceptRequest): Intercept | undefined {
  const speed = request.bulletSpeedTilesPerMs;
  if (!(speed > 0) || !(request.maxFlightMs > 0)) return undefined;

  const dx = request.targetX - request.shooterX;
  const dy = request.targetY - request.shooterY;
  const vx = request.targetVelocityX;
  const vy = request.targetVelocityY;

  // |D + V·t| = speed·t, squared and collected: a·t² + 2b·t + c = 0.
  const a = vx * vx + vy * vy - speed * speed;
  const b = dx * vx + dy * vy;
  const c = dx * dx + dy * dy;

  const flightMs = solveFlightTime(a, b, c);
  if (flightMs === undefined || flightMs > request.maxFlightMs) return undefined;

  return {
    x: request.targetX + vx * flightMs,
    y: request.targetY + vy * flightMs,
    flightMs,
  };
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
