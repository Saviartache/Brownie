import { debuffSeverityOf } from './conditions.js';
import { childText, elementText, hasChild, parseGameNumber, scanElementsIn } from './xml.js';

/**
 * How one kind of shot moves and what it does.
 *
 * Read from the `<Projectile>` children of an `<Object>`: an enemy declares its
 * shots by index, and `ENEMYSHOOT` names one by `bulletType`. Without this, a
 * shot's speed and lifetime are unknown and where it will be cannot be
 * predicted at all.
 *
 * **Every default below is the client's, not a guess.** The game reads these
 * elements into its own `ProjectileProperties`, and where an element is absent
 * it substitutes a value of its own — a parametric figure three tiles across, a
 * sine wave that completes one cycle, a turn that lasts the whole flight. A
 * reader that filled the gaps with nought described different shots from the
 * ones on the screen: a sine shot with no `<Frequency>` flew dead straight here
 * and wove in the game. The values were read out of the client's own loader;
 * `state/projectiles/ShotMotion.ts` says how each one is used.
 */
export interface ProjectileDefinition {
  /** Index within its owner, which is what `bulletType` names. */
  readonly bulletType: number;
  /** Tenths of a tile per second, as the file writes it. */
  readonly speed: number;
  readonly lifetimeMs: number;
  /**
   * What one of these takes off, when the file states a single figure.
   *
   * **Only a stand-in for an enemy's shot**, which announces the damage it
   * rolled in its own `ENEMYSHOOT`. A definition that states only a range is
   * given the middle of it, so a shot the packet did not describe is still
   * ranked roughly where it belongs.
   */
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
  /**
   * How long the beam is, in tiles, for a laser. Nought for everything else.
   *
   * **A laser is not a point.** `<Laser>` is how far the beam reaches from where
   * it was fired, and the shot itself never moves — `<Speed>0` — so a model that
   * drew it as a bullet put the whole beam at its emitter and let a player stand
   * in the middle of it. Only a few dozen projectiles declare one, and every one
   * of them is a wall of damage for a fifth of a second.
   */
  readonly laserTiles: number;
  /** Tiles of sideways swing. Nought for a shot that does not swing. */
  readonly amplitude: number;
  /** Whole swings per lifetime. **One when the file does not say**, as in the game. */
  readonly frequency: number;
  /** Tiles across a parametric figure. **Three when the file does not say.** */
  readonly magnitude: number;
  /** Tenths of a tile per second, gained each second once the delay is over. */
  readonly acceleration: number;
  readonly accelerationDelayMs: number;
  /** The speed acceleration stops at, in tenths of a tile per second. */
  readonly speedClamp: number;
  /**
   * How far the shot turns, in degrees.
   *
   * **A total over `turnStopTimeMs`, not a rate** — the game divides one by the
   * other. Nine hundred of the game's projectiles turn, and they are every
   * spiral that curls as it travels.
   */
  readonly turnRate: number;
  readonly turnRateDelayMs: number;
  /** In the file's own unit; the game uses it without converting it. */
  readonly turnAcceleration: number;
  readonly turnAccelerationDelayMs: number;
  /** Degrees. */
  readonly turnClamp: number;
  /**
   * How long the turn lasts, or nought when the file does not say — in which
   * case the game turns for the whole flight, or until the circling begins.
   */
  readonly turnStopTimeMs: number;
  /** Degrees swept per `turnStopTimeMs` once a circling shot starts circling. */
  readonly circleTurnAngle: number;
  /** When a circling shot stops flying outward and starts going round. */
  readonly circleTurnDelayMs: number;
  /**
   * How bad the worst condition this one applies is, from nought to one.
   *
   * **Read here rather than by whoever needs it**, because the names are in the
   * file and the severity is a judgement — see `conditions.ts` — and a second
   * reader of the same elements is a second table to keep in step. Nought for
   * the great majority of shots, including every one whose only effects are the
   * `In Combat` and `Invulnerable` a monster applies to itself.
   */
  readonly debuffSeverity: number;
}

/**
 * The figure the game gives a parametric shot that states no `<Magnitude>`.
 *
 * Read out of the client's loader. Filling the gap with nought, or with one,
 * drew a figure a third the size of the one the game flies.
 */
const DEFAULT_MAGNITUDE_TILES = 3;

/** And the sine shot that states no `<Frequency>`: one swing per flight. */
const DEFAULT_FREQUENCY = 1;

/**
 * How far one of these travels in a millisecond, before anything multiplies it.
 *
 * The file stores speed in tenths of a tile per second, which is the game's own
 * encoding and not a rounding of anything. Kept here rather than written out
 * wherever a shot is predicted, so the two places that predict one cannot
 * disagree about it.
 */
export function speedTilesPerMs(definition: ProjectileDefinition): number {
  return definition.speed / 10_000;
}

/**
 * How far one of these gets before it expires, in tiles.
 *
 * Speed times life for an ordinary shot. **Parametric ones are the exception
 * and would otherwise read as zero**: swords, daggers and every other fixed-arc
 * weapon leave `Speed` unset and describe the arc with `Magnitude`, which is
 * the reach itself. The reference implementation's `WeaponProfile` checks the
 * flag first for exactly that reason, and says so.
 *
 * What it cannot see is the player's own multipliers — the game scales a shot's
 * speed, lifetime and range by buffs held in the client, and none of the three
 * is on the wire. So this is the item's own reach, which is the right figure for
 * an unbuffed character and an underestimate for a buffed one. Underestimating
 * range keeps a planner closer than it needs to be, which is the safe direction
 * for the thing that reads it.
 */
export function reachTiles(definition: ProjectileDefinition): number {
  if (definition.parametric) return definition.magnitude;
  return speedTilesPerMs(definition) * definition.lifetimeMs;
}

/** Reads the `<Projectile>` children of one `<Object>` element. */
export function readProjectiles(objectElement: string): ProjectileDefinition[] {
  const definitions: ProjectileDefinition[] = [];

  for (const element of scanElementsIn(objectElement, 'Projectile')) {
    const bulletType = parseGameNumber(attributeOf(element, 'id')) ?? definitions.length;
    const number = (name: string): number | undefined => parseGameNumber(childText(element, name));
    definitions.push({
      bulletType,
      speed: number('Speed') ?? 0,
      lifetimeMs: number('LifetimeMS') ?? 0,
      damage: damageOf(number('Damage'), number('MinDamage'), number('MaxDamage')),
      size: number('Size') ?? 100,
      // One is what the game assumes for a projectile that does not say.
      collisionMult: number('CollisionMult') ?? 1,
      wavy: hasChild(element, 'Wavy'),
      multiHit: hasChild(element, 'MultiHit'),
      passesCover: hasChild(element, 'PassesCover'),
      parametric: hasChild(element, 'Parametric'),
      boomerang: hasChild(element, 'Boomerang'),
      laserTiles: Math.max(0, number('Laser') ?? 0),
      amplitude: number('Amplitude') ?? 0,
      frequency: number('Frequency') ?? DEFAULT_FREQUENCY,
      magnitude: number('Magnitude') ?? DEFAULT_MAGNITUDE_TILES,
      acceleration: number('Acceleration') ?? 0,
      accelerationDelayMs: number('AccelerationDelay') ?? 0,
      speedClamp: number('SpeedClamp') ?? 0,
      turnRate: number('TurnRate') ?? 0,
      turnRateDelayMs: number('TurnRateDelay') ?? 0,
      turnAcceleration: number('TurnAcceleration') ?? 0,
      turnAccelerationDelayMs: number('TurnAccelerationDelay') ?? 0,
      turnClamp: number('TurnClamp') ?? 0,
      turnStopTimeMs: number('TurnStopTime') ?? 0,
      circleTurnAngle: number('CircleTurnAngle') ?? 0,
      circleTurnDelayMs: number('CircleTurnDelay') ?? 0,
      debuffSeverity: debuffSeverityOf(conditionsIn(element)),
    });
  }

  return definitions;
}

/**
 * What a definition says one of its shots takes off.
 *
 * `<Damage>` where it is stated. Two thousand of the game's projectiles state a
 * range instead, and ranking every one of those as harmless would have the
 * planner walk into a boss's shotgun to avoid a pellet.
 */
function damageOf(
  exact: number | undefined,
  least: number | undefined,
  most: number | undefined,
): number {
  if (exact !== undefined) return exact;
  if (least !== undefined && most !== undefined) return Math.round((least + most) / 2);
  return least ?? most ?? 0;
}

/**
 * The conditions one projectile declares, by the names the file writes.
 *
 * Every `<ConditionEffect>` child rather than the first, because a shot that
 * paralyses usually also declares the two housekeeping effects its owner applies
 * to itself, and which of the three comes first is not something to rely on.
 */
function conditionsIn(element: string): string[] {
  const names: string[] = [];
  for (const effect of scanElementsIn(element, 'ConditionEffect')) {
    const name = elementText(effect);
    if (name !== undefined && name !== '') names.push(name);
  }
  return names;
}

function attributeOf(element: string, name: string): string | undefined {
  const match = new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`).exec(element);
  return match?.[1];
}
