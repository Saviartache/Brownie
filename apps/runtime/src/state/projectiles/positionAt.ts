import type { Position } from '@brownie/plugin-api';
import { speedTilesPerMs, type ProjectileDefinition } from '../../gamedata/projectiles.js';

/** Everything about one shot in flight that its path depends on. */
export interface ShotOrigin {
  readonly bulletId: number;
  readonly x: number;
  readonly y: number;
  /** Radians. */
  readonly angle: number;
}

/**
 * Where a shot is, `elapsedMs` after it was fired.
 *
 * A port of the game's own `Projectile.positionAt`. This is protocol knowledge,
 * not code style: an approximation here is not "less accurate", it is a
 * different curve, and the shots it gets wrong are exactly the ones worth
 * dodging. Every constant below is the game's.
 *
 * `bulletId` parity is load-bearing. The game gives alternating shots opposite
 * phases so a volley fans out; dropping it collapses a spread into one line.
 *
 * @returns `undefined` once the shot has expired — it no longer exists, which
 *   is different from "it is at its last position".
 */
export function positionAt(
  definition: ProjectileDefinition,
  shot: ShotOrigin,
  elapsedMs: number,
): Position | undefined {
  const lifetime = definition.lifetimeMs;
  if (elapsedMs < 0 || elapsedMs > lifetime || lifetime <= 0) return undefined;

  const phase = shot.bulletId % 2 === 0 ? 0 : Math.PI;

  let x = shot.x;
  let y = shot.y;

  if (definition.wavy) {
    const period = 6 * Math.PI;
    const amplitude = Math.PI / 64;
    const angle = shot.angle + amplitude * Math.sin(phase + (period * elapsedMs) / 1000);
    const distance = distanceAt(definition, elapsedMs);
    x += distance * Math.cos(angle);
    y += distance * Math.sin(angle);
    return { x, y };
  }

  if (definition.parametric) {
    const t = (elapsedMs / lifetime) * 2 * Math.PI;
    const sin1 = Math.sin(t) * (shot.bulletId % 2 === 0 ? -1 : 1);
    const sin2 = Math.sin(2 * t) * (shot.bulletId % 4 < 2 ? 1 : -1);
    const sinAngle = Math.sin(shot.angle);
    const cosAngle = Math.cos(shot.angle);
    const magnitude = definition.magnitude === 0 ? 1 : definition.magnitude;
    x += (sin1 * cosAngle - sin2 * sinAngle) * magnitude;
    y += (sin1 * sinAngle + sin2 * cosAngle) * magnitude;
    return { x, y };
  }

  let distance = distanceAt(definition, elapsedMs);
  if (definition.boomerang) {
    // It turns around at the halfway point of its lifetime and retraces its
    // path, so the far end of the arc is reached at half the lifetime.
    const halfwayMs = lifetime / 2;
    if (elapsedMs > halfwayMs) {
      const halfway = distanceAt(definition, halfwayMs);
      distance = halfway - (distance - halfway);
    }
  }

  x += distance * Math.cos(shot.angle);
  y += distance * Math.sin(shot.angle);

  if (definition.amplitude !== 0) {
    const lateral =
      definition.amplitude *
      Math.sin(phase + (elapsedMs / lifetime) * definition.frequency * 2 * Math.PI);
    x += lateral * Math.cos(shot.angle + Math.PI / 2);
    y += lateral * Math.sin(shot.angle + Math.PI / 2);
  }

  return { x, y };
}

/** Integrates the projectile's speed, including delayed acceleration and its clamp. */
function distanceAt(definition: ProjectileDefinition, elapsedMs: number): number {
  const initialTilesPerMs = speedTilesPerMs(definition);
  if (definition.acceleration === 0) return elapsedMs * initialTilesPerMs;

  const delayMs = Math.max(0, definition.accelerationDelayMs);
  const acceleratingMs = Math.max(0, elapsedMs - delayMs);
  if (acceleratingMs === 0) return elapsedMs * initialTilesPerMs;

  const accelerationTilesPerMsSquared = definition.acceleration / 10_000_000;
  const clampTilesPerMs = definition.speedClamp / 10_000;
  const untilClampMs = (clampTilesPerMs - initialTilesPerMs) / accelerationTilesPerMsSquared;
  const changingMs = Math.max(0, Math.min(acceleratingMs, untilClampMs));
  const clampedMs = acceleratingMs - changingMs;

  return (
    delayMs * initialTilesPerMs +
    changingMs * initialTilesPerMs +
    0.5 * accelerationTilesPerMsSquared * changingMs ** 2 +
    clampedMs * clampTilesPerMs
  );
}
