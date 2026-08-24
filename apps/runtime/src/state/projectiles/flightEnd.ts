/**
 * Where a shot's flight ends, from the map rather than from its lifetime.
 *
 * **A lifetime is when a shot runs out; a wall is where most of them actually
 * stop.** Nothing on the wire says a bullet has landed — the server announces
 * it once and never mentions it again — so the store expired shots by the only
 * number it had, and every bullet that buried itself in a pillar went on
 * existing for the rest of its declared life: drawn as a path through solid
 * rock, and dodged as though it were still coming. That is the failure that
 * looks exactly like the planner being wrong, because from the outside it is a
 * dodge away from nothing.
 *
 * **The client's own acknowledgements are not enough, and cannot be.**
 * `SQUAREHIT` is the client saying "I destroyed this one against the map", and
 * it is the truth — but it is only ever sent about the shots that client
 * bothered to resolve, it arrives a round trip late, and a proxy that waits for
 * it is a proxy that has already planned two dozen times against a bullet that
 * no longer exists. See `ProjectileStore.retire`, which still takes them: an
 * acknowledgement that arrives is a fact, and this is what covers the ones that
 * never come.
 *
 * **So it is computed instead, once, when the shot is announced.** Where the
 * walls are is known — it is the same tile map the walking is planned on — and
 * where the shot will be is `positionAt`, which is the game's own formula.
 * Walking the two together says which square the bullet dies in, and capping
 * the shot's life there means every reader is fixed at once: `positionAt`
 * answers `undefined` past it, the drawn path ends at the wall, the threat
 * field stops sampling, and the store prunes it. Nothing downstream had to
 * learn a new concept.
 *
 * **Once, and not per read.** A flight is 600–2000 ms and the planner runs
 * fifty times a second, so re-deciding this on every read would answer the same
 * question a hundred times per shot. The cost of being decided at announcement
 * is that it is a snapshot: a door that opens mid-flight is not noticed. Walls
 * that appear or vanish inside the second a bullet is airborne are rare enough
 * to be worth that trade, and the direction of the error is a shot believed for
 * slightly too long, which is the safe one.
 */

import {
  maxSpeedTilesPerSecond,
  motionModelled,
  type ProjectileDefinition,
} from '../../gamedata/projectiles.js';
import { positionAt, type ShotOrigin } from './positionAt.js';

/**
 * Whether a shot entering this square is stopped by it.
 *
 * Whole-tile coordinates, and the caller's own idea of a wall — see
 * `WorldState`, which answers it from the tile map and the objects standing on
 * it. Ground nobody has described must answer false: the server sends the
 * tiles around the player and no further, and treating the edge of what is
 * known as a wall would delete every shot fired from off screen.
 */
export type StopsShots = (tileX: number, tileY: number) => boolean;

/**
 * How far a shot may travel between two collision samples, in tiles.
 *
 * A quarter tile, so nothing thinner than the game builds walls out of can be
 * stepped over: two consecutive samples straddling a one-tile wall would leave
 * the bullet flying through it. Small enough for a corner clip, and the cost of
 * it is bounded below.
 */
const STEP_TILES = 0.25;

/**
 * The most samples one shot's flight is worth.
 *
 * **A bound on how far along the path is looked at, never on how finely.**
 * Coarsening the step to fit a long flight into a fixed budget is what lets a
 * bullet step straight over a one-tile wall, so the step stays put and this
 * ends the walk instead: sixteen tiles of travel are checked, and a shot still
 * going after that is handed the rest of its life. Nothing reads a shot that
 * far off — the threat field drops one long before it — so the only thing lost
 * is an answer nobody asked for.
 */
const MAX_STEPS = 64;

/**
 * The fewest, for a path that speed says nothing about.
 *
 * A parametric shot has no forward speed at all: it sweeps a closed figure the
 * size of its magnitude, and a magnitude of nothing would otherwise ask for a
 * single sample.
 */
const MIN_STEPS = 8;

/** How many times its own width a parametric figure's curve runs. */
const PARAMETRIC_PATH_MULTIPLE = 6;

/**
 * How long this shot is really in the air, in milliseconds since it was fired.
 *
 * Its declared lifetime, or the moment it meets something that stops it,
 * whichever comes first.
 *
 * Two kinds of shot are handed back their full lifetime without being walked at
 * all. One passes through cover, which is what `PassesCover` means and the
 * whole reason `retire` asks which sort of hit it heard about. The other is the
 * shot whose curve is not modelled — the ones that turn — where
 * the path this would walk is not the path the bullet takes, so a wall found
 * along it is a wall the shot was never going to reach. Believing a shot for
 * too long costs a dodge; deleting a live one costs the run.
 */
export function flightEndMs(
  definition: ProjectileDefinition,
  origin: ShotOrigin,
  stopsShots: StopsShots,
): number {
  const lifetime = definition.lifetimeMs;
  if (lifetime <= 0) return 0;
  if (definition.passesCover || !motionModelled(definition)) return lifetime;

  const stepMs = lifetime / sampleCount(definition);
  // The square it was fired from never stops it. Monsters stand in doorways,
  // on the far side of destructibles and inside the objects they guard, and a
  // shot deleted at its own muzzle is a shot nothing ever dodges.
  const muzzleX = Math.floor(origin.x);
  const muzzleY = Math.floor(origin.y);

  let clearMs = 0;
  for (let step = 1; step <= MAX_STEPS; step += 1) {
    // Multiplied rather than accumulated, so the last sample lands exactly on
    // the end of the life instead of a rounding short of it.
    const at = step * stepMs;
    if (at > lifetime) break;
    const point = positionAt(definition, origin, at);
    if (point === undefined) break;
    const tileX = Math.floor(point.x);
    const tileY = Math.floor(point.y);
    if ((tileX !== muzzleX || tileY !== muzzleY) && stopsShots(tileX, tileY)) {
      // The last moment it was still in open ground, so nothing draws or
      // predicts the bullet inside the wall it died against.
      return clearMs;
    }
    clearMs = at;
  }

  return lifetime;
}

/** How many samples this shot's path is worth, from how long that path is. */
function sampleCount(definition: ProjectileDefinition): number {
  return Math.max(MIN_STEPS, Math.ceil(pathTiles(definition) / STEP_TILES));
}

/**
 * Roughly how far the shot's path runs, in tiles.
 *
 * How *long the curve is*, which is not the same as how far away it gets: a
 * boomerang covers its whole distance twice, and a parametric shot has no
 * forward speed at all — it sweeps a closed figure the size of its magnitude.
 * Only ever used to pick a sampling rate, so being a little generous costs a
 * few samples and being short would cost a wall.
 */
function pathTiles(definition: ProjectileDefinition): number {
  if (definition.parametric) return PARAMETRIC_PATH_MULTIPLE * definition.magnitude;
  return (maxSpeedTilesPerSecond(definition) * definition.lifetimeMs) / 1000;
}
