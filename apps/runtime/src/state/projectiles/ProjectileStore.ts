import type { Position, ProjectileView } from '@brownie/plugin-api';
import { projectileHalfTiles } from '../../features/dodge/hitbox.js';
import type { ProjectileDefinition } from '../../gamedata/projectiles.js';
import { flightEndMs, type StopsShots } from './flightEnd.js';
import { ShotMotion, type ShotLaunch } from './ShotMotion.js';

/** One shot as it is announced. */
export interface AnnouncedShot extends ShotLaunch {
  readonly ownerId: number;
  readonly bulletType: number;
  /** When it left the muzzle, on the world clock. */
  readonly firedAtMs: number;
  /**
   * What it takes off, when the announcement said.
   *
   * `ENEMYSHOOT` carries the damage the server rolled for this volley, which is
   * the number that will actually be charged — the definition's figure is a
   * stand-in for when it did not.
   */
  readonly damage?: number | undefined;
}

/**
 * What the client says about a shot it has made — see
 * {@link ProjectileStore.confirm}.
 */
export interface ClientLaunch {
  /** When the client started it, on the world clock. */
  readonly firedAtMs: number;
  readonly x: number;
  readonly y: number;
  /** Radians. */
  readonly angle: number;
  readonly speedMultiplier: number;
  /** How long it lives, the owner's multiplier already applied. */
  readonly lifetimeMs: number;
  /** Half the side of the square the client hits with, in tiles. */
  readonly halfTiles: number;
}

/**
 * The furthest a believable coordinate is from the origin, and the widest a
 * believable shot — the same bounds the module reads a shot against. A launch
 * past either is a reading of something that is not a shot.
 */
const MAX_COORDINATE_TILES = 100_000;
const MAX_HALF_TILES = 64;
const MAX_MULTIPLIER = 100;

function believable(launch: ClientLaunch, definition: ProjectileDefinition): boolean {
  return (
    Number.isFinite(launch.firedAtMs) &&
    Math.abs(launch.x) <= MAX_COORDINATE_TILES &&
    Math.abs(launch.y) <= MAX_COORDINATE_TILES &&
    Number.isFinite(launch.angle) &&
    launch.speedMultiplier > 0 &&
    launch.speedMultiplier <= MAX_MULTIPLIER &&
    launch.lifetimeMs > 0 &&
    launch.lifetimeMs <= definition.lifetimeMs * MAX_MULTIPLIER &&
    launch.halfTiles >= 0 &&
    launch.halfTiles <= MAX_HALF_TILES
  );
}

/** One shot in flight. */
class TrackedShot implements ProjectileView {
  readonly ownerId: number;
  readonly bulletId: number;
  readonly bulletType: number;
  readonly damage: number;
  readonly definition: ProjectileDefinition;
  readonly motion: ShotMotion;
  /** The game's own square: the client's word for it, or the data's. */
  readonly collisionHalfTiles: number;
  readonly #launch: ShotLaunch;
  /** When it left the muzzle, on the world clock. */
  readonly firedAtMs: number;
  /**
   * When it stops existing — its lifetime, or the wall it flies into.
   *
   * Settled once, when the shot is announced, because that is when the map it
   * is crossing is known and because every reader wants the same answer. See
   * {@link flightEndMs}.
   */
  readonly expiresAtMs: number;

  constructor(
    shot: AnnouncedShot,
    definition: ProjectileDefinition,
    stopsShots: StopsShots,
    halfTiles: number = projectileHalfTiles(definition.collisionMult),
  ) {
    this.ownerId = shot.ownerId;
    this.bulletId = shot.bulletId;
    this.bulletType = shot.bulletType;
    this.definition = definition;
    this.damage = shot.damage ?? definition.damage;
    this.collisionHalfTiles = halfTiles;
    this.#launch = shot;
    this.motion = new ShotMotion(definition, shot);
    this.firedAtMs = shot.firedAtMs;
    this.expiresAtMs = this.firedAtMs + flightEndMs(this.motion, definition, shot, stopsShots);
  }

  /**
   * The same shot, launched the way the client says it was.
   *
   * Built again rather than patched, because every figure the flight is made
   * of — the multipliers, the turn's exit, where the first wall is — follows
   * from the launch, and a shot half-updated is a curve nobody fired.
   */
  relaunched(launch: ClientLaunch, stopsShots: StopsShots): TrackedShot {
    return new TrackedShot(
      {
        ownerId: this.ownerId,
        bulletId: this.bulletId,
        bulletType: this.bulletType,
        damage: this.damage,
        firedAtMs: launch.firedAtMs,
        x: launch.x,
        y: launch.y,
        angle: launch.angle,
        speedMultiplier: launch.speedMultiplier,
        lifetimeMultiplier: launch.lifetimeMs / this.definition.lifetimeMs,
      },
      this.definition,
      stopsShots,
      launch.halfTiles,
    );
  }

  /** How long the beam is, for a laser; nought for anything that is a point. */
  get beamTiles(): number {
    return this.definition.laserTiles;
  }

  /** Which way it was fired, in radians — the way a laser's beam points. */
  get angle(): number {
    return this.#launch.angle;
  }

  /** How bad the worst condition it applies is. See `gamedata/conditions.ts`. */
  get debuffSeverity(): number {
    return this.definition.debuffSeverity;
  }

  get maxSpeedTilesPerSecond(): number {
    return this.motion.maxSpeedTilesPerSecond;
  }

  /** Where it started. `positionAt` is what says where it is now. */
  get x(): number {
    return this.#launch.x;
  }

  get y(): number {
    return this.#launch.y;
  }

  positionAt(gameTimeMs: number): Position | undefined {
    // Past the end of the flight there is no shot, whether the lifetime ran out
    // or a wall took it. Everything that predicts one reads this — the threat
    // field stops sampling here, and the drawn path ends here — so the wall is
    // answered in one place rather than by every caller learning about walls.
    if (gameTimeMs > this.expiresAtMs) return undefined;
    return this.motion.positionAt(gameTimeMs - this.firedAtMs);
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
  add(definition: ProjectileDefinition | undefined, shot: AnnouncedShot): boolean {
    if (definition === undefined || definition.lifetimeMs <= 0) return false;
    this.#shots.set(
      shotKey(shot.ownerId, shot.bulletId),
      new TrackedShot(shot, definition, this.#stopsShots),
    );
    return true;
  }

  /**
   * Takes the client's word for a shot it has made.
   *
   * **The client's shot is the one that hits, and this was only ever a
   * reconstruction of it.** The announcement says where a volley starts and
   * which way; the client then starts each bullet on the frame it reads the
   * packet — later than it passed through here, by however long it took to get
   * round to it — scales it by what its own copy of the owner's stats says, and
   * hits with the square it was given. Where the client has said all of that,
   * its answer replaces the estimate, and the shot is flown exactly as the
   * client flies it from then on.
   *
   * A launch that does not make sense is refused rather than half-believed:
   * the estimate is still a good one.
   *
   * @returns whether a shot was found and taken.
   */
  confirm(ownerId: number, bulletId: number, launch: ClientLaunch): boolean {
    const key = shotKey(ownerId, bulletId);
    const shot = this.#shots.get(key);
    if (shot === undefined || !believable(launch, shot.definition)) return false;
    this.#shots.set(key, shot.relaunched(launch, this.#stopsShots));
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
   * closed after it was fired, and a wall the store never heard about.
   * It is the late confirmation, not the mechanism.
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
   * Forgets a shot outright, whatever it passes through.
   *
   * For when the client says it no longer has the shot at all — which is a
   * fact about the shot, not an acknowledgement to interpret.
   */
  forget(ownerId: number, bulletId: number): boolean {
    return this.#shots.delete(shotKey(ownerId, bulletId));
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
