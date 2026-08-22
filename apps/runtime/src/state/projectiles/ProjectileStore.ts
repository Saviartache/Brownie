import type { Position, ProjectileView } from '@brownie/plugin-api';
import { projectileHalfTiles } from '../../features/dodge/hitbox.js';
import { motionModelled, type ProjectileDefinition } from '../../gamedata/projectiles.js';
import { positionAt, type ShotOrigin } from './positionAt.js';

/** One shot in flight. */
class TrackedShot implements ProjectileView {
  constructor(
    readonly ownerId: number,
    readonly bulletId: number,
    readonly bulletType: number,
    readonly firedAtMs: number,
    readonly origin: ShotOrigin,
    readonly definition: ProjectileDefinition,
  ) {}

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

  /** Where it started. `positionAt` is what says where it is now. */
  get x(): number {
    return this.origin.x;
  }

  get y(): number {
    return this.origin.y;
  }

  get expiresAtMs(): number {
    return this.firedAtMs + this.definition.lifetimeMs;
  }

  positionAt(gameTimeMs: number): Position | undefined {
    return positionAt(this.definition, this.origin, gameTimeMs - this.firedAtMs);
  }
}

/**
 * Enemy shots currently in flight.
 *
 * Shots are not entities: the server announces them once, they follow a curve
 * the game's data describes, and they are never mentioned again. Nothing tells
 * us when one ends — so the store expires them by their own lifetime, and a
 * shot whose definition it does not have is not tracked at all rather than
 * tracked as a straight line. A dodge built on a wrong curve is worse than one
 * that knows it is blind.
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
