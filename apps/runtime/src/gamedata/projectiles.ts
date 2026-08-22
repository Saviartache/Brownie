import { childText, hasChild, parseGameNumber, scanElementsIn } from './xml.js';

/**
 * How one kind of shot moves and what it does.
 *
 * Read from the `<Projectile>` children of an `<Object>`: an enemy declares its
 * shots by index, and `ENEMYSHOOT` names one by `bulletType`. Without this, a
 * shot's speed and lifetime are unknown and where it will be cannot be
 * predicted at all.
 */
export interface ProjectileDefinition {
  /** Index within its owner, which is what `bulletType` names. */
  readonly bulletType: number;
  readonly speed: number;
  readonly lifetimeMs: number;
  readonly damage: number;
  readonly size: number;
  /**
   * What the game scales this shot's collision square by.
   *
   * The game builds a projectile's hitbox as `collisionMult × 0.5` tiles, so
   * this is the difference between a dodge that knows a boss's shot is twice the
   * size of a rat's and one that assumes every shot in the game is the same.
   * Absent from most projectiles, which means one.
   */
  readonly collisionMult: number;
  readonly wavy: boolean;
  readonly parametric: boolean;
  readonly boomerang: boolean;
  /**
   * Whether the shot survives hitting a character.
   *
   * Most do not: a bullet that lands is gone, and the client says so with an
   * acknowledgement. A multi-hit shot passes through and keeps going, so the
   * same acknowledgement means nothing about whether it still exists — which is
   * the difference between a dodge that stops avoiding a spent bullet and one
   * that stops avoiding a live one.
   */
  readonly multiHit: boolean;
  /** Whether it survives hitting a wall, for the same reason. */
  readonly passesCover: boolean;
  readonly amplitude: number;
  readonly frequency: number;
  readonly magnitude: number;
  /**
   * Parsed but **not applied** by the motion model.
   *
   * The reference implementation's port of the game's `positionAt` ignores
   * acceleration too, so a prediction for an accelerating shot is wrong in the
   * same way theirs is. Kept here so that when the model learns about it the
   * data is already available, and stated so that nothing builds on a
   * prediction believing it is exact.
   */
  readonly acceleration: number;
  readonly accelerationDelayMs: number;
  readonly speedClamp: number;
  /**
   * Degrees a second the shot curves. Parsed, and **not applied** either.
   *
   * Nine hundred of the game's projectiles turn — every spiral that curls as it
   * travels — and predicting one as a straight line is not "slightly off", it is
   * a different path. Recorded so that {@link motionModelled} can say so, which
   * is what lets a planner leave room around what it cannot predict instead of
   * committing to a place the shot was never going to be.
   */
  readonly turnRate: number;
}

/**
 * Whether the motion model describes this kind of shot's whole path.
 *
 * False for the ones that accelerate or turn. `positionAt` covers wavy,
 * parametric, boomerang and the lateral amplitude exactly — those are the
 * game's own formulae — and has no term at all for the other two.
 */
export function motionModelled(definition: ProjectileDefinition): boolean {
  return definition.acceleration === 0 && definition.turnRate === 0;
}

/**
 * How far one of these travels in a millisecond.
 *
 * The file stores speed in units of a ten-thousandth of a tile per
 * millisecond, which is the game's own encoding and not a rounding of
 * anything. Kept here rather than written out wherever a shot is predicted, so
 * the two places that predict one cannot disagree about it.
 */
export function speedTilesPerMs(definition: ProjectileDefinition): number {
  return definition.speed / 10_000;
}

/** Reads the `<Projectile>` children of one `<Object>` element. */
export function readProjectiles(objectElement: string): ProjectileDefinition[] {
  const definitions: ProjectileDefinition[] = [];

  for (const element of scanElementsIn(objectElement, 'Projectile')) {
    const bulletType = parseGameNumber(attributeOf(element, 'id')) ?? definitions.length;
    definitions.push({
      bulletType,
      speed: parseGameNumber(childText(element, 'Speed')) ?? 0,
      lifetimeMs: parseGameNumber(childText(element, 'LifetimeMS')) ?? 0,
      damage: parseGameNumber(childText(element, 'Damage')) ?? 0,
      size: parseGameNumber(childText(element, 'Size')) ?? 100,
      // One is what the game assumes for a projectile that does not say.
      collisionMult: parseGameNumber(childText(element, 'CollisionMult')) ?? 1,
      wavy: hasChild(element, 'Wavy'),
      multiHit: hasChild(element, 'MultiHit'),
      passesCover: hasChild(element, 'PassesCover'),
      parametric: hasChild(element, 'Parametric'),
      boomerang: hasChild(element, 'Boomerang'),
      amplitude: parseGameNumber(childText(element, 'Amplitude')) ?? 0,
      frequency: parseGameNumber(childText(element, 'Frequency')) ?? 0,
      magnitude: parseGameNumber(childText(element, 'Magnitude')) ?? 0,
      acceleration: parseGameNumber(childText(element, 'Acceleration')) ?? 0,
      accelerationDelayMs: parseGameNumber(childText(element, 'AccelerationDelay')) ?? 0,
      speedClamp: parseGameNumber(childText(element, 'SpeedClamp')) ?? 0,
      turnRate: parseGameNumber(childText(element, 'TurnRate')) ?? 0,
    });
  }

  return definitions;
}

function attributeOf(element: string, name: string): string | undefined {
  const match = new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`).exec(element);
  return match?.[1];
}
