/**
 * The hop: one frame's worth of movement spent all at once.
 *
 * **What it is for is the case walking cannot answer.** A step of the search's
 * lattice is a tick of walking — about seven tenths of a tile in a tenth of a
 * second — so a shot arriving sooner than that has already settled the matter
 * before the character has gone anywhere, and the route is then only a choice
 * between hits. A hop covers the same ground on the frame it is issued, which is
 * the difference between being a tenth of a second late and being on time.
 *
 * **It is not a teleport, and the distinction is the whole reason it is safe.**
 * The module already carries a walk as a target the frame steps towards, capped
 * at what one frame of the character's own speed allows; the cap is there
 * because anything past it is a position the client never walked to, which the
 * server takes back. A hop asks for the whole of that cap on a single frame
 * instead of a fraction of it — the same call into the game's own movement, the
 * same clamp, the same packets. What it spends is a frame of speed, not a rule.
 *
 * So {@link MAX_HOP_TILES} is not a preference. It is the module's own
 * `kMaxStepTiles`, and asking for more does not carry the character further; it
 * makes the two sides disagree about what was asked for, which is how a landing
 * place gets chosen that nothing ever reaches.
 *
 * **Where it is decided, and where it is not.** This says *where* to land.
 * Whether a hop is warranted at all — the route is being hit sooner than walking
 * can answer, and one has not just been spent — belongs to the planner, which is
 * the thing holding the route and the clock.
 */

import type { BlastField, DodgeGround } from './DodgeSearch.js';
import type { ThreatIndex } from './ThreatIndex.js';

/**
 * The furthest a single hop may carry, in tiles.
 *
 * **The module's own per-frame limit, restated here because this side is the
 * one that has to respect it.** `app::kMaxStepTiles` bounds what one frame may
 * command whatever speed is asked for, so a hop longer than this is a hop the
 * module quietly shortens — and a planner believing its own number would be
 * choosing a landing place the character never arrives at.
 */
export const MAX_HOP_TILES = 0.7;

/**
 * The speed a hop is commanded at, in tiles per second.
 *
 * Sized so the module spends its whole per-frame allowance on the frame the
 * command lands, at any frame rate a person plays at: at a hundred and forty
 * frames a second a frame is seven milliseconds, and {@link MAX_HOP_TILES} over
 * that is a hundred tiles a second. The module clamps to its own cap regardless,
 * so this only has to be large enough to reach it.
 */
export const HOP_SPEED_TILES_PER_SECOND = 120;

/**
 * The radii a hop is offered at, as fractions of the distance asked for.
 *
 * **The full hop can overshoot.** Landing places are what a tight pattern is
 * short of, and a fixed radius can step clean over the only gap there was — so
 * the shorter offer is not caution, it is reach of a different kind.
 */
const HOP_FRACTIONS = [1, 0.5] as const;

export interface HopRequest {
  readonly x: number;
  readonly y: number;
  /** Where the character should be. A landing nearer it beats one further off. */
  readonly anchorX: number;
  readonly anchorY: number;
  /** How far to hop, before {@link MAX_HOP_TILES} has its say. */
  readonly tiles: number;
  /** How many directions to try, evenly spaced. The search's own ring. */
  readonly headings: number;
  /** How much room a landing place needs before more of it stops being better. */
  readonly safeClearanceTiles: number;
  readonly ground: DodgeGround;
  readonly threats: ThreatIndex;
  readonly blasts: BlastField | undefined;
  readonly leadMs: number;
  readonly tickMs: number;
}

/** Where to hop, measured from wherever the character actually is. */
export interface Hop {
  readonly offsetX: number;
  readonly offsetY: number;
  /** The least room the landing place has over the next two ticks. */
  readonly clearanceTiles: number;
  /** How far inside a monster's keep-away distance it lands. */
  readonly crowdingTiles: number;
}

/** Rewritten in place: a hop is chosen at worst once per plan. */
const CHOICE = { offsetX: 0, offsetY: 0, clearanceTiles: 0, crowdingTiles: 0 };

/**
 * Picks somewhere to land, or nothing when nowhere in reach beats standing
 * still.
 *
 * **Two ticks of room, not one.** A hop that clears the shot arriving now and
 * lands under the one behind it has spent the character's one instant reaction
 * moving the problem a tenth of a second. Holding the landing place still across
 * the next two steps of the lattice is the cheapest question that tells the two
 * apart, and it reuses the index the search was going to build anyway.
 *
 * **Among the ones with room to spare, the nearest to their own ground wins.** A
 * hop is an interruption; the smallest one that works is the one the player
 * notices least, which is the rule the whole feature is built on.
 *
 * @returns a hop valid until the next call, or `undefined` when there is nothing
 *   better to do than what the ordinary route already said.
 */
export function chooseHop(request: HopRequest): Hop | undefined {
  const reach = Math.min(MAX_HOP_TILES, Math.max(0, request.tiles));
  if (reach <= 0) return undefined;

  const headings = Math.max(4, Math.round(request.headings));
  const safe = request.safeClearanceTiles;

  // What staying put is worth, so a hop has something to beat. A landing place
  // no better than the ground already underfoot is movement for its own sake.
  let bestRoom = roomAt(request, request.x, request.y);
  let bestCrowding = request.ground.crowdingAt(request.x, request.y, request.leadMs);
  let bestAnchor = Math.hypot(request.x - request.anchorX, request.y - request.anchorY);
  let found = false;

  for (const fraction of HOP_FRACTIONS) {
    const distance = reach * fraction;
    for (let i = 0; i < headings; i += 1) {
      const angle = (i * 2 * Math.PI) / headings;
      const toX = request.x + Math.cos(angle) * distance;
      const toY = request.y + Math.sin(angle) * distance;
      // The midpoint too: a hop is a frame of travel through the world, and a
      // pillar narrower than the hop would otherwise be jumped straight over.
      if (!request.ground.canStand(toX, toY)) continue;
      if (!request.ground.canStand((request.x + toX) / 2, (request.y + toY) / 2)) continue;
      // A hop out of a shot and into lava is not an escape, and unlike a walk
      // there is no next step to take back out of it before the ground bites.
      if (request.ground.isDamaging(toX, toY)) continue;
      // **Nor into a monster.** A hop is instant, so unlike a step there is no
      // moment in which the planner could change its mind about the landing —
      // and landing inside a body is contact damage and a shot fired from
      // nowhere, which is the thing this was reached for in the first place.
      if (request.ground.contactAt(toX, toY, request.leadMs) > 0) continue;

      const room = roomAt(request, toX, toY);
      const crowding = request.ground.crowdingAt(toX, toY, request.leadMs);
      const anchor = Math.hypot(toX - request.anchorX, toY - request.anchorY);
      if (!beats(room, crowding, anchor, bestRoom, bestCrowding, bestAnchor, safe)) continue;

      bestRoom = room;
      bestCrowding = crowding;
      bestAnchor = anchor;
      found = true;
      CHOICE.offsetX = toX - request.x;
      CHOICE.offsetY = toY - request.y;
      CHOICE.clearanceTiles = room;
      CHOICE.crowdingTiles = crowding;
    }
  }

  return found ? CHOICE : undefined;
}

/**
 * Whether one landing place is better than another.
 *
 * **Room settles it right up to the point where there is enough**, and then it
 * stops mattering at all: two places a shot misses by more than the margin are
 * equally survivable, and splitting them by room would send the character
 * sprinting away from a bullet that was already going to miss.
 *
 * **Then the room to dodge in, and only then their own ground.** A hop taken to
 * get out from under a monster is answering that monster, so among landing
 * places a shot misses equally, the one that is not inside a body wins — where
 * ranking on the anchor alone would hop the shortest distance, which is back
 * where the monster is.
 */
function beats(
  room: number,
  crowdingTiles: number,
  anchorTiles: number,
  bestRoom: number,
  bestCrowdingTiles: number,
  bestAnchorTiles: number,
  safeTiles: number,
): boolean {
  const enough = room >= safeTiles;
  const bestEnough = bestRoom >= safeTiles;
  if (enough !== bestEnough) return enough;
  if (!enough) return room > bestRoom;
  // Coarse, because two places a quarter of a tile apart in a three-tile bubble
  // are the same place to fight from, and splitting them here would spend the
  // term on a distinction nobody could see.
  if (Math.abs(crowdingTiles - bestCrowdingTiles) > CROWD_QUANTUM_TILES) {
    return crowdingTiles < bestCrowdingTiles;
  }
  return anchorTiles < bestAnchorTiles;
}

/** How finely two landing places are told apart by the room they leave. */
const CROWD_QUANTUM_TILES = 0.25;

/**
 * How much room a body standing at a place has over the next two ticks.
 *
 * Standing rather than walking, because that is what a hop leaves the character
 * doing: it arrives, and the next plan decides what happens after that.
 */
function roomAt(request: HopRequest, x: number, y: number): number {
  let room = Infinity;
  const steps = Math.min(2, request.threats.steps);
  for (let step = 0; step < steps; step += 1) {
    const here = request.threats.clearanceOf(step, x, y, x, y);
    if (here < room) room = here;
  }
  if (request.blasts !== undefined) {
    const until = request.leadMs + Math.max(1, steps) * request.tickMs;
    const blast = request.blasts.clearanceAt(x, y, request.leadMs, until);
    if (blast < room) room = blast;
  }
  return room;
}
