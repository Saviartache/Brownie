/**
 * The planner's own idea of the fight, as circles somebody can draw.
 *
 * **A shot path answers "is the prediction right"; nothing answered "is the
 * *decision* right".** Every complaint this feature has ever had was about a
 * distance — it dodges shots that were never near, it lets monsters stand on
 * top of me, it ignored that bomb — and every one of those distances is a
 * number in a settings panel that nobody can check against a moving fight.
 * Drawn on the ground they check themselves: either the ring the planner reacts
 * inside is where the shots are being answered or it is not, and either the
 * circle it refuses to enter is around the monster or it is around a pillar.
 *
 * **Two shapes, because the model has two.** A ring the shots are answered
 * inside and a blast's footprint are radii and nothing else. A body is the
 * axis-aligned square the game collides with, and the room kept around one is
 * that square grown by a round gap — see `EnemyBodies`. Drawing all of them as
 * circles was drawing a claim the planner does not make: it put the corner of a
 * four-tile boss most of a tile inside a ring that said it was outside.
 *
 * **Built here rather than in the plugin** for the same reason `ShotPaths` is:
 * it is arithmetic over what the planner already holds, it is worth testing
 * without a session, and the plugin should be the thing that decides *whether*
 * to send a picture rather than the thing that draws one.
 */

import type { BlastView } from './Blasts.js';
import { nearEdgeOf, type EnemyBodies } from './EnemyBodies.js';
import { PLAYER_HALF_TILES } from './hitbox.js';

/** What one circle means. The drawing colours and shapes by it. */
export const DodgeMarkKind = {
  /** The character, as the planner measures it — half a tile of nothing. */
  Player: 0,
  /** How near a shot has to be before it is answered at all. */
  Engage: 1,
  /** One monster's own body, at the size the catalog gives it. */
  Body: 2,
  /** And the distance around it the planner refuses to be inside. */
  KeepAway: 3,
  /** An area effect on its way down, drawn where and as wide as it will land. */
  Blast: 4,
} as const;

export type DodgeMarkKind = (typeof DodgeMarkKind)[keyof typeof DodgeMarkKind];

/**
 * What a circle's centre is measured against.
 *
 * **Because the picture is drawn far more often than it is published.** A set
 * goes out twenty times a second and the game draws a hundred and more, so a
 * circle pinned to the place it was published at steps across the screen — and
 * the three centred on the character step worst of all, because where the player
 * is arrives here five times a second while they walk continuously. The module
 * knows exactly where the character is on the frame it draws; saying which
 * circles belong to it is all it needs to put them there.
 */
export const DodgeMarkAnchor = {
  /** Where the mark says, carried by its own velocity and nothing else. */
  Place: 0,
  /** The character, wherever the module can see it is right now. */
  Player: 1,
} as const;

export type DodgeMarkAnchor = (typeof DodgeMarkAnchor)[keyof typeof DodgeMarkAnchor];

/**
 * What outline to draw round a mark's centre.
 *
 * A box is stated by the same `radiusTiles` a circle is — its half-extent, the
 * distance from the middle to a flat side — plus how much of each corner is
 * rounded off. So an older drawing that knows only circles draws a circle
 * through the flat sides of the box, which is the nearest true thing it can say.
 */
export const DodgeMarkShape = {
  Circle: 0,
  Box: 1,
} as const;

export type DodgeMarkShape = (typeof DodgeMarkShape)[keyof typeof DodgeMarkShape];

/** One shape on the ground. */
export interface DodgeMark {
  readonly kind: DodgeMarkKind;
  readonly anchor: DodgeMarkAnchor;
  readonly shape: DodgeMarkShape;
  readonly x: number;
  readonly y: number;
  readonly radiusTiles: number;
  /**
   * How far in from a box's corners its rounding starts, in tiles.
   *
   * Nought for a plain square and for every circle. It is what draws the room
   * kept around a monster as what it is — the body's square grown by a gap that
   * is the same in every direction, so the corners are quarter-circles of the
   * gap rather than right angles.
   */
  readonly cornerTiles: number;
  /**
   * How fast the thing this describes is moving, in tiles per second.
   *
   * Nought for anything that is not going anywhere, and for everything anchored
   * to the player — which the module tracks exactly rather than predicting.
   * Carried so that a circle drawn between two publishes is drawn where the
   * monster is rather than where it was, using the same velocity the planner
   * scored the place with.
   */
  readonly velocityX: number;
  readonly velocityY: number;
  /**
   * How much of this one's wait is still ahead, from a thousand to nought.
   *
   * Only a blast has a wait; everything else is a fact about right now and
   * carries a thousand. It is what lets the drawing say *when* without a
   * number: a bomb announced a second out and one landing this instant are the
   * same circle in the same place, and only one of them is a reason to move.
   */
  readonly permille: number;
}

/** Nothing is drawn as further ahead than this, in milliseconds. */
const URGENCY_SPAN_MS = 1000;

/** What a mark that is not waiting for anything carries. */
const NOT_WAITING = 1000;

/**
 * The most circles described at once.
 *
 * A screen with more than this on it is unreadable whatever is drawn, and the
 * cap is what stops a debug view being the most expensive thing in a fight —
 * every one of these crosses a pipe fifty times a second. Bodies come in pairs,
 * so the bound is on the pairs as much as on the total.
 */
export const MAX_DRAWN_MARKS = 64;

/** What the picture is of. Every field is what the planner used this plan. */
export interface PictureScene {
  readonly selfX: number;
  readonly selfY: number;
  /** The clock the blasts' arming times are on. */
  readonly gameTimeMs: number;
  /** The ring, or nought while shots are not being minded at all. */
  readonly engageTiles: number;
  /** The room kept around a monster, or `undefined` while they are unminded. */
  readonly keepAwayTiles: number | undefined;
  /** The bodies the planner collected, in the order it collected them. */
  readonly bodies: EnemyBodies;
  /** The area effects still on their way down. */
  readonly blasts: Iterable<BlastView>;
}

/**
 * Every circle the planner is currently reasoning about.
 *
 * Ordered by how much it matters that it is visible: the character first, then
 * what is landing, then the monsters. A cap reached in a crowd therefore drops
 * the least interesting rather than whatever happened to be last.
 */
export function dodgeMarks(scene: PictureScene): DodgeMark[] {
  const marks: DodgeMark[] = [];

  // The character's own square, at the size a shot is tested against — which is
  // the one number in this picture that decides every hit.
  marks.push(
    onPlayer(DodgeMarkKind.Player, scene.selfX, scene.selfY, PLAYER_HALF_TILES, DodgeMarkShape.Box),
  );
  if (scene.engageTiles > 0) {
    marks.push(onPlayer(DodgeMarkKind.Engage, scene.selfX, scene.selfY, scene.engageTiles));
  }
  const keepAwayTiles = scene.keepAwayTiles;

  for (const blast of scene.blasts) {
    if (marks.length >= MAX_DRAWN_MARKS) return marks;
    const armsIn = blast.armsAtMs - scene.gameTimeMs;
    // One already down is history, and the ground it took is now the safest on
    // the screen. Drawing it would be drawing a crater.
    if (!(armsIn >= 0)) continue;
    // A place, and it stays there: what a blast is, is ground that will be
    // dangerous at a moment. Nothing about it moves.
    marks.push(atPlace(DodgeMarkKind.Blast, blast.x, blast.y, blast.radiusTiles, waiting(armsIn)));
  }

  if (keepAwayTiles === undefined) return marks;
  for (let i = 0; i < scene.bodies.count; i += 1) {
    // Two apiece, so a body that fits only half a pair is not drawn at all —
    // a keep-away circle with nothing in the middle of it reads as a mistake.
    if (marks.length + 2 > MAX_DRAWN_MARKS) return marks;
    const x = scene.bodies.xOf(i);
    const y = scene.bodies.yOf(i);
    const half = scene.bodies.halfOf(i);
    // Tiles per second, because that is the unit everything outside this
    // feature counts speed in; the bodies hold it per millisecond because that
    // is what a sweep multiplies by.
    const velocityX = scene.bodies.velocityXOf(i) * A_SECOND_MS;
    const velocityY = scene.bodies.velocityYOf(i) * A_SECOND_MS;
    // The body as the square it collides as, and the room as that square grown
    // by the gap the setting asks for — which is the shape the planner scores,
    // corners and all. See `EnemyBodies.crowdingAt`.
    const outer = nearEdgeOf(half, keepAwayTiles);
    marks.push(onBody(DodgeMarkKind.Body, x, y, half, velocityX, velocityY, 0));
    marks.push(onBody(DodgeMarkKind.KeepAway, x, y, outer, velocityX, velocityY, outer - half));
  }

  return marks;
}

/** Milliseconds in the second the wire counts velocities in. */
const A_SECOND_MS = 1000;

function onPlayer(
  kind: DodgeMarkKind,
  x: number,
  y: number,
  radiusTiles: number,
  shape: DodgeMarkShape = DodgeMarkShape.Circle,
): DodgeMark {
  return {
    kind,
    anchor: DodgeMarkAnchor.Player,
    shape,
    x,
    y,
    radiusTiles,
    cornerTiles: 0,
    velocityX: 0,
    velocityY: 0,
    permille: NOT_WAITING,
  };
}

function atPlace(
  kind: DodgeMarkKind,
  x: number,
  y: number,
  radiusTiles: number,
  permille = NOT_WAITING,
): DodgeMark {
  return {
    kind,
    anchor: DodgeMarkAnchor.Place,
    shape: DodgeMarkShape.Circle,
    x,
    y,
    radiusTiles,
    cornerTiles: 0,
    velocityX: 0,
    velocityY: 0,
    permille,
  };
}

function onBody(
  kind: DodgeMarkKind,
  x: number,
  y: number,
  radiusTiles: number,
  velocityX: number,
  velocityY: number,
  cornerTiles: number,
): DodgeMark {
  return {
    kind,
    anchor: DodgeMarkAnchor.Place,
    shape: DodgeMarkShape.Box,
    x,
    y,
    radiusTiles,
    cornerTiles,
    velocityX,
    velocityY,
    permille: NOT_WAITING,
  };
}

/** A wait, as the fraction of it that is left. */
function waiting(armsInMs: number): number {
  return Math.max(0, Math.min(NOT_WAITING, Math.round((armsInMs / URGENCY_SPAN_MS) * NOT_WAITING)));
}
