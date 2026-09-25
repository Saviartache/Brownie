/**
 * How far round a turret its own fire lands before a sidestep could clear it.
 *
 * **The hole this fills is the one the body list leaves on purpose.** A spawner,
 * an emitter, a turret and a trap are `<Enemy/>` that can never be hurt — marked
 * `<Invincible/>` in `objects.xml`, or sent with no health at all — so they are
 * not monsters to keep room from (see `EnemyBodies`), and most of them are drawn
 * as nothing. Seven hundred of those types fire. Every shot starts on the thing
 * that fired it, so a character standing on one is inside every shot it fires
 * the instant it fires it, and one standing beside it is inside the next shot
 * before any command can reach the character. The live report was the plain
 * one: the dodge walks right into them, and everything they spawn lands.
 *
 * **So the ground round one is refused rather than dodged**, the way the ground
 * round an enemy that blasts itself is — see `EnemyKeepouts`. How much is the one
 * question a dodge has to answer about a shot it has not seen yet: how far does
 * it get before the character could step out of its square? That is the command
 * lead plus the time the step aside takes, and how far the shot flies in that
 * long is the game's own motion code — `ShotMotion` — run once per kind of shot
 * rather than guessed from its speed. A fifth of the shots these things fire
 * accelerate, some from a standstill and some backwards, and a speed times a time
 * is the wrong answer for every one of them.
 *
 * **Point blank is not the whole of the danger and does not try to be.** Past it
 * a shot is in the air and in the shot field like any other, and threading it is
 * the planner's job; this is only the ground where there is nothing to thread.
 * The reference implementation drops these entities before its dodge ever sees
 * them, so it has no answer here. Its idea of a hard core round anything that
 * shoots — "a setpiece tower is not a target but is very much a hazard" — is the
 * one worth keeping, sized here by the shot instead of by a constant.
 */

import type { ProjectileDefinition } from '../../gamedata/projectiles.js';
import { ShotMotion } from '../../state/projectiles/ShotMotion.js';
import { effectiveHalf, projectileHalfTiles } from './hitbox.js';

/**
 * The most point blank is believed, in tiles.
 *
 * Past three tiles a fresh shot is one the planner can see coming, and a disc
 * any wider round every turret in a room is a wall rather than a margin. A shot
 * that really does cross more ground than this inside a step aside is a trick
 * shot or a beam, and the shot field is where those are answered.
 */
export const MAX_POINT_BLANK_TILES = 3;

/** How finely each shot's reach is tabulated, in milliseconds. */
const SAMPLE_MS = 10;

/**
 * The longest reaction a table covers, in milliseconds.
 *
 * The longest command lead the panel allows plus a step aside at the slowest a
 * character walks comes to about this. A reaction slower still is answered with
 * the table's last entry, which is further than the cap anyway for anything
 * that moves at all.
 */
const HORIZON_MS = 500;

const SAMPLES = HORIZON_MS / SAMPLE_MS + 1;

/**
 * The slowest a step aside is timed at, in tiles a second.
 *
 * A character that cannot walk — paralysed, or a stat not yet sent — is not one
 * whose step takes forever: it is one that cannot step, and the table's end is
 * the answer for that. The floor only keeps the arithmetic from dividing by
 * nothing on the way there.
 */
const MIN_WALK_TILES_PER_SECOND = 1;

/** How the shots are being judged this plan. Rewritten in place by the caller. */
export interface PointBlankTiming {
  /** How long a command takes to reach the character, in milliseconds. */
  readonly leadMs: number;
  /** How fast the character can be told to step aside, in tiles a second. */
  readonly walkTilesPerSecond: number;
  /** The planner's own view of a shot's square: its scale and its pad. */
  readonly hitScale: number;
  readonly padTiles: number;
}

/** One shot a type fires that can hurt somebody, as point blank needs it. */
interface ArmedShot {
  /** Half the side of its collision square, before the planner scales it. */
  readonly halfTiles: number;
  /**
   * How far from where it was fired it has got, one entry every
   * {@link SAMPLE_MS}. Never shrinking, because what is asked is how much ground
   * it has covered by then — a shot that turns back has still been out there.
   */
  readonly reachTiles: Float64Array;
}

export class PointBlankReach {
  readonly #shotsOf: (objectType: number) => Iterable<ProjectileDefinition>;
  /**
   * Keyed by object type, and bounded by how many kinds of shooter one session
   * meets. A type goes in only once the catalog has described it — see
   * {@link #armed}.
   */
  readonly #byType = new Map<number, readonly ArmedShot[]>();

  /**
   * @param shotsOf What a type declares, read through the catalog on every miss
   *   so a session that starts before the data files load picks them up when
   *   they do.
   */
  constructor(shotsOf: (objectType: number) => Iterable<ProjectileDefinition>) {
    this.#shotsOf = shotsOf;
  }

  /**
   * How far round one of these its own fire lands before the character could
   * step out of the way, in tiles from its centre — or nought for a type that
   * fires nothing that hurts.
   *
   * The widest of its shots decides it, each as `half + reach`: the square the
   * planner tests the shot with, carried as far as the shot flies in a command
   * lead and the step aside that clears that square. Never less than the square
   * itself circumscribed, which is the ground a shot covers the instant it
   * appears — standing there is a hit whatever anybody does.
   *
   * @param speedMultiplier The owner's own projectile speed multiplier, which the
   *   game applies to every shot it fires. A shot sped up by it covers in a given
   *   time what the plain one covers in that time scaled by it — exactly, until
   *   an acceleration reaches its clamp.
   */
  radiusOf(objectType: number, speedMultiplier: number, timing: PointBlankTiming): number {
    const shots = this.#armed(objectType);
    if (shots === undefined || shots.length === 0) return 0;

    const walk = Math.max(MIN_WALK_TILES_PER_SECOND, timing.walkTilesPerSecond);
    const pace = Number.isFinite(speedMultiplier) && speedMultiplier > 0 ? speedMultiplier : 1;
    const leadMs = Math.max(0, timing.leadMs);
    let widest = 0;
    for (const shot of shots) {
      const half = effectiveHalf(shot.halfTiles, timing.hitScale, timing.padTiles);
      if (!(half > 0)) continue;
      // Out of its square sideways: the shot's own half, at walking pace.
      const reactMs = leadMs + (half / walk) * 1000;
      const radius = Math.max(half * Math.SQRT2, half + reachAt(shot.reachTiles, reactMs * pace));
      if (radius > widest) widest = radius;
    }
    return Math.min(widest, MAX_POINT_BLANK_TILES);
  }

  /**
   * The shots a type fires that can hurt, worked out once.
   *
   * **A miss is not cached**, for the reason `EquippedWeapon` gives: the catalog
   * is read from disk while sessions are already running, and a type it has not
   * described yet is one it will describe a moment later. A type it *has*
   * described is settled for good — including one that fires nothing that hurts,
   * which is an empty list rather than a miss.
   */
  #armed(objectType: number): readonly ArmedShot[] | undefined {
    const known = this.#byType.get(objectType);
    if (known !== undefined) return known;

    let described = false;
    const armed: ArmedShot[] = [];
    for (const definition of this.#shotsOf(objectType)) {
      described = true;
      const shot = armedShot(definition);
      if (shot !== undefined) armed.push(shot);
    }
    if (!described) return undefined;
    this.#byType.set(objectType, armed);
    return armed;
  }
}

/**
 * One definition as point blank needs it, or nothing for a shot that cannot hurt.
 *
 * **Two kinds of shot are left out, and both are the game's own word.** A
 * collision multiplier of nought is a square nothing can overlap — the warning
 * telegraphs and the markers a boss fires at itself. A shot that declares no
 * damage and no condition is the same thing drawn differently: the arrow
 * indicators and chain visuals these helpers fire ahead of the real attack.
 * Keeping out of either would be keeping out of a picture. The shot field still
 * sees both in flight; this only decides what ground is refused before one is.
 *
 * A shot with no lifetime is never tracked by the client at all, and is left out
 * for that reason.
 */
function armedShot(definition: ProjectileDefinition): ArmedShot | undefined {
  const halfTiles = projectileHalfTiles(definition.collisionMult);
  if (!(halfTiles > 0) || !(definition.lifetimeMs > 0)) return undefined;
  if (!(definition.damage > 0) && !(definition.debuffSeverity > 0)) return undefined;

  // Fired from nowhere in particular: what is asked is how far from its own
  // origin it gets, which no launch changes. The bullet id only picks which way
  // a wave or a figure starts, and the distance is the same either way.
  const motion = new ShotMotion(definition, {
    bulletId: 0,
    x: 0,
    y: 0,
    angle: 0,
    speedMultiplier: 1,
    lifetimeMultiplier: 1,
  });
  const reachTiles = new Float64Array(SAMPLES);
  let furthest = 0;
  for (let sample = 0; sample < SAMPLES; sample += 1) {
    const at = motion.positionAt(sample * SAMPLE_MS);
    // Past its lifetime it is gone, and the ground it covered is what it was.
    if (at !== undefined) {
      const out = Math.hypot(at.x, at.y);
      if (out > furthest) furthest = out;
    }
    reachTiles[sample] = furthest;
  }
  return { halfTiles, reachTiles };
}

/** How much ground a shot has covered by a moment, between the tabulated ones. */
function reachAt(table: Float64Array, elapsedMs: number): number {
  const at = Math.max(0, elapsedMs) / SAMPLE_MS;
  const below = Math.floor(at);
  if (below >= SAMPLES - 1) return table[SAMPLES - 1] ?? 0;
  const lower = table[below] ?? 0;
  const upper = table[below + 1] ?? lower;
  return lower + (upper - lower) * (at - below);
}
