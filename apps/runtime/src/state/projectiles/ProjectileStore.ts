import type { Position, ProjectileView } from '@brownie/plugin-api';
import { projectileHalfTiles } from '../../features/dodge/hitbox.js';
import {
  maxSpeedTilesPerSecond,
  motionModelled,
  type ProjectileDefinition,
} from '../../gamedata/projectiles.js';
import { flightEndMs, type StopsShots } from './flightEnd.js';
import { positionAt, type ShotOrigin } from './positionAt.js';

/** One shot in flight. */
class TrackedShot implements ProjectileView {
  /**
   * When it stops existing — its lifetime, or the wall it flies into.
   *
   * Settled once, when the shot is announced, because that is when the map it
   * is crossing is known and because every reader wants the same answer. See
   * {@link flightEndMs}.
   */
  readonly expiresAtMs: number;

  constructor(
    readonly ownerId: number,
    readonly bulletId: number,
    readonly bulletType: number,
    readonly firedAtMs: number,
    readonly origin: ShotOrigin,
    readonly definition: ProjectileDefinition,
    stopsShots: StopsShots,
  ) {
    this.expiresAtMs = firedAtMs + flightEndMs(definition, origin, stopsShots);
  }

  get damage(): number {
    return this.definition.damage;
  }

  /** The game's own square, from the multiplier the shot's data declares. */
  get collisionHalfTiles(): number {
    return projectileHalfTiles(this.definition.collisionMult);
  }

  /** Whether `positionAt` describes this shot's whole path. */
  get motionModelled(): boolean {
    return motionModelled(this.definition);
  }

  get maxSpeedTilesPerSecond(): number {
    return maxSpeedTilesPerSecond(this.definition);
  }

  /** Where it started. `positionAt` is what says where it is now. */
  get x(): number {
    return this.origin.x;
  }

  get y(): number {
    return this.origin.y;
  }

  positionAt(gameTimeMs: number): Position | undefined {
    // Past the end of the flight there is no shot, whether the lifetime ran out
    // or a wall took it. Everything that predicts one reads this — the threat
    // field stops sampling here, and the drawn path ends here — so the wall is
    // answered in one place rather than by every caller learning about walls.
    if (gameTimeMs > this.expiresAtMs) return undefined;
    return positionAt(this.definition, this.origin, gameTimeMs - this.firedAtMs);
  }
}

/**
 * Enemy shots currently in flight.
 *
 * Shots are not entities: the server announces them once, they follow a curve
 * the game's data describes, and they are never mentioned again. Nothing tells
 * us when one ends — so the store works it out: a shot lives until its lifetime
 * runs out or until it flies into a wall, whichever comes first, and a shot
 * whose definition it does not have is not tracked at all rather than tracked
 * as a straight line. A dodge built on a wrong curve is worse than one that
 * knows it is blind. See {@link flightEndMs} for why the wall is settled here
 * rather than waited for.
 *
 * **"In flight" is the whole contract, and it is shorter than it looks.**
 * Lifetimes are 600–2000 ms, and `WorldStatusStage` prunes on every packet, so
 * a shot is gone almost the moment its flight ends. That serves what this is
 * for — drawing and dodging things still moving — and it is the wrong store for
 * "what *was* that bullet", which is what every client→server acknowledgement
 * asks: a `PLAYERHIT` is sent because the flight ended, and then has to travel
 * here. Anything reacting to one must remember what it needs from the
 * `ENEMYSHOOT` instead; `autonexus/BulletLog` is the worked example.
 */
export class ProjectileStore {
  readonly #shots = new Map<number, TrackedShot>();
  readonly #stopsShots: StopsShots;

  /**
   * @param stopsShots The map, as far as a bullet is concerned. Nothing stops
   *   anything by default, which is what a test asking about a curve wants and
   *   what the store did before it could be told about walls.
   */
  constructor(stopsShots: StopsShots = () => false) {
    this.#stopsShots = stopsShots;
  }

  get size(): number {
    return this.#shots.size;
  }

  /**
   * Records a shot.
   *
   * @returns false when there is no definition for it, which is what happens
   *   without the game's data files.
   */
  add(
    definition: ProjectileDefinition | undefined,
    shot: {
      ownerId: number;
      bulletId: number;
      bulletType: number;
      x: number;
      y: number;
      angle: number;
      firedAtMs: number;
    },
  ): boolean {
    if (definition === undefined || definition.lifetimeMs <= 0) return false;
    this.#shots.set(
      shotKey(shot.ownerId, shot.bulletId),
      new TrackedShot(
        shot.ownerId,
        shot.bulletId,
        shot.bulletType,
        shot.firedAtMs,
        { bulletId: shot.bulletId, x: shot.x, y: shot.y, angle: shot.angle },
        definition,
        this.#stopsShots,
      ),
    );
    return true;
  }

  /**
   * Drops a shot the client has just said hit something.
   *
   * **A lifetime is when a shot runs out, not when it stops existing.** Most
   * shots end early, by landing — and the client says so, because it is the
   * client that decides a bullet has hit: `PLAYERHIT`, `OTHERHIT` and
   * `SQUAREHIT` are all it telling the server about a projectile it has already
   * destroyed. Without this the store keeps a shot that is gone from the game
   * for the rest of its declared life, and everything reading it keeps dodging a
   * bullet nobody can see. Reported live, and it is the one failure of this
   * store that looks exactly like the planner being wrong.
   *
   * **Still taken, now that the walls are worked out in advance.** An
   * acknowledgement that arrives is a fact and arrives for reasons
   * {@link flightEndMs} cannot see: a shot landing on a character, a door that
   * closed after it was fired, and every shot whose curve the model declines to
   * predict. It is the late confirmation, not the mechanism.
   *
   * @param obstacle Whether it hit the map rather than a character. The two are
   *   survived by different shots — one passes through people, the other through
   *   walls — so which happened decides whether the shot is really over.
   * @returns whether a shot was actually forgotten.
   */
  retire(ownerId: number, bulletId: number, obstacle: boolean): boolean {
    const key = shotKey(ownerId, bulletId);
    const shot = this.#shots.get(key);
    if (shot === undefined) return false;
    // It went through. The acknowledgement says it hit; it does not say it
    // stopped, and forgetting it here would be the opposite mistake.
    if (obstacle ? shot.definition.passesCover : shot.definition.multiHit) return false;
    this.#shots.delete(key);
    return true;
  }

  /**
   * Drops shots that have expired.
   *
   * Called before every read rather than on a timer: the cost is proportional
   * to what is in flight, and a timer would either run when nothing is
   * happening or leave expired shots visible between ticks.
   */
  prune(gameTimeMs: number): void {
    for (const [key, shot] of this.#shots) {
      if (gameTimeMs > shot.expiresAtMs) this.#shots.delete(key);
    }
  }

  /** Live shots, expired ones already removed. */
  values(gameTimeMs: number): Iterable<ProjectileView> {
    this.prune(gameTimeMs);
    return this.#shots.values();
  }

  clear(): void {
    this.#shots.clear();
  }
}

/**
 * Bullet ids are only unique per shooter and wrap quickly, so a shot is
 * identified by both. Keyed as one number to keep lookups off the string path.
 */
function shotKey(ownerId: number, bulletId: number): number {
  return ownerId * 65536 + (bulletId & 0xffff);
}
