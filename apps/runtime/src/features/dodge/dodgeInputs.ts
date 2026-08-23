/**
 * What the composition root has to hand the dodge, and what it hands back.
 *
 * **Everything here is something a plugin cannot reach on its own.** Window
 * input, the game's own camera, the object catalog and what auto-aim has
 * settled on are all outside the public plugin surface — so they arrive as
 * callbacks from the one place that has them, and the feature itself stays a
 * plugin. See `dodgePlugin.ts` for why the dodge is one at all.
 */

import type { Position } from '@brownie/plugin-api';
import type { DodgeMark } from './DodgeMarks.js';
import type { ShotPath } from './ShotPaths.js';

export interface DodgeOutput {
  /**
   * Asks the module to walk towards a place on the map.
   *
   * A *target*, not a jump. The module issues a small step towards it on every
   * frame, capped at what the speed allows — commanding further than that does
   * not make the player walk there, it makes them appear there and then be put
   * back. `holdMs` is how long the target stands if nothing replaces it, which
   * is what makes "no fresh plan" mean "stop".
   *
   * **The player's own walking is counted against that cap**, and by the module
   * rather than here: the step lands on top of the game's own movement, so the
   * two agreeing about a direction used to travel at both speeds at once. What
   * they actually covered is the ground that appeared under them, which only
   * the frame can see — see `PlayerControl::RoomToStep`. So a command is a
   * ceiling on the *sum*, and asking for more of it than they have left over
   * simply moves them less.
   *
   * **For the chord, and for nothing else.** A place is what the player names
   * when they point at one; see {@link moveBy} for why a plan is not a place.
   */
  moveTo(x: number, y: number, speedTilesPerSecond: number, holdMs: number): void;
  /**
   * Asks the module to walk *this way*, measured from wherever the player is.
   *
   * **The planner decides a heading, and the runtime is the wrong place to turn
   * one into a place.** Where the player is arrives here in `MOVE` and
   * `NEWTICK` — five times a second — while the character walks at the frame
   * rate, so the position a plan is built on is up to a whole server tick old
   * and up to a tile and a half behind. Adding the heading to *that* named a
   * place the player had already walked past: the module measured the distance
   * from where they actually were, found it pointing backwards, and hauled them
   * back — then jumped forwards again the moment the next packet landed. Five
   * times a second, which is exactly what it looked like.
   *
   * So the offset travels and the module resolves it against the position only
   * it can see, on the frame it acts. Nothing about the walk depends on how
   * fresh this side's idea of the player is any more.
   *
   * An offset of nothing is the honest way to say "stand still": the module
   * walks towards a place it has by definition already arrived at.
   */
  moveBy(offsetX: number, offsetY: number, speedTilesPerSecond: number, holdMs: number): void;
  /**
   * Replaces the picture the module is drawing over the map.
   *
   * Wholesale, and both halves together, because a set half-replaced is a
   * picture of two different moments — and because the paths and the circles
   * describe one plan and disagreeing about which plan would be worse than
   * showing neither. Sent only while something is watching — see
   * {@link DodgeView} — and the module lets go of it on its own if it stops
   * arriving, so switching the feature off needs no message.
   */
  showPicture(paths: readonly ShotPath[], marks: readonly DodgeMark[]): void;
}

/**
 * Whether anybody is looking at the dodge picture.
 *
 * **The one switch in this feature that lives on the other side.** What it turns
 * on is drawing, which only the module can do, so the module owns the checkbox
 * and says when it is down; the runtime owns the prediction and answers with
 * it. Nothing is sent while it is up, because a picture nobody is looking at is
 * a few hundred numbers a second across a pipe for no reason.
 */
export interface DodgeView {
  wanted(): boolean;
}

/**
 * The player taking the wheel.
 *
 * **A place, and it can only come from the module.** Whether Ctrl and the middle
 * button are down is window input, and turning the cursor into a point on the
 * map means asking the game's own camera where things are. The module does both
 * and sends tiles; `native/CursorTracker.ts` is what holds the answer and what
 * lets go of it.
 */
export interface CursorWalkInput {
  /** Where to walk, or nothing when nobody is asking. */
  target(): Position | undefined;
}

/**
 * Which way the player is walking under their own power.
 *
 * **A world direction, and only the module can work one out.** Which way `W`
 * points depends on where the camera is; see `SteerIntent.ts`.
 */
export interface SteerInput {
  /** A unit direction, or nothing when the player is not steering. */
  direction(): Position | undefined;
}

/**
 * What the planner needs to know that is nowhere on the wire.
 *
 * Every one of these is a question about `objects.xml` or about another
 * feature's decision, and a plugin is handed neither. Kept apart from the rest
 * of {@link DodgeInputs} because it is all the scene needs — see `DodgeScene`.
 */
export interface DodgeCatalog {
  /**
   * How far the equipped weapon's own shot reaches, in tiles.
   *
   * **The distance the planner is trying not to drift past**, because a dodge
   * that ends out of range is a dodge that turned the damage off. It is in
   * `objects.xml` and nowhere on the wire, and a plugin is not given the object
   * catalog — so the composition root hands it over, exactly as it does for
   * auto-aim. `undefined` for a weapon the catalog does not describe, or for no
   * weapon at all, and the setting's own figure stands in.
   *
   * Asked once a plan and answered from `gamedata/EquippedWeapon`, which
   * resolves a weapon once and remembers it.
   */
  readonly weaponRange: (weaponType: number) => number | undefined;
  /**
   * Whether one of these stands in the way rather than fighting.
   *
   * **A wall in this game is an object with hit points and the enemy flag**, so
   * to anything ranking enemies by distance it is simply the closest one — and
   * the spacing band, which is exactly such a ranking, spent a dungeon measuring
   * the corridor instead of the monster in it. `OccupySquare` and `FullOccupy`
   * in `objects.xml`, which is not on the plugin surface; the same lookup
   * auto-aim is handed, for the same reason.
   */
  readonly isObstacle: (objectType: number) => boolean;
  /**
   * Whether one of these can never be hurt, and never hurts anybody.
   *
   * Spawners, emitters and room controllers answer to `<Enemy/>` and carry
   * health, and a quarter of the catalog's enemies are one. Again as auto-aim
   * has it, and again nothing on the wire tells them apart.
   */
  readonly isInvincible: (objectType: number) => boolean;
  /**
   * Whether one of these is part of the room rather than something that fights.
   *
   * **The live report is a Shatters lever.** It is `<Enemy/>`, it carries five
   * thousand hit points until somebody pulls it, and it is neither a wall nor
   * invincible — so it passed every cull the band had and got a no-go circle
   * drawn round it. It also never moves and never fires, which is the whole of
   * why it does not belong in a list of things to keep away from.
   *
   * Deliberately *not* part of auto-aim's rules: a lever is shot on purpose, so
   * auto-aim must go on seeing it. The two lists are the same list right up to
   * the things that are only ever targets.
   */
  readonly isScenery: (objectType: number) => boolean;
  /**
   * How wide one of these is, in tiles.
   *
   * **The distance that keeps a minion at arm's length puts you inside a boss**,
   * and nothing on the wire says how big anything is — `<Size>` is in
   * `objects.xml`, so the composition root hands it over exactly as it does the
   * two above. `undefined` for a type the catalog cannot describe, and for every
   * type while no data file has been read, in which case the ordinary body
   * stands in and the band behaves as it did before it could tell.
   */
  readonly bodyTiles: (objectType: number) => number | undefined;
  /**
   * Which enemy auto-aim is pointing the shots at, when it is pointing at one.
   *
   * **"Stay within your weapon's range" has to mean range of *something*.**
   * Measured against the nearest monster it kept the player in reach of
   * whatever happened to be closest — a minion, a summon, whatever wandered
   * past — while the thing they were actually shooting walked out of range and
   * the damage stopped. What they are shooting is a question only auto-aim can
   * answer, and it answers it here; see `AimOutput.lockedOn`.
   *
   * `undefined` while nothing is being aimed at, or while auto-aim is off, and
   * the band falls back to the nearest body — which is the best guess available
   * and is what it always did.
   */
  readonly aimTarget: () => number | undefined;
}

export interface DodgeInputs extends DodgeCatalog {
  readonly output: DodgeOutput;
  /**
   * The manual override, which lives in *this* plugin rather than beside it. Two
   * plugins both publishing move targets would be two writers of one snapshot,
   * arguing about it forty times a second; one tick deciding between the planner
   * and the player is a decision instead of a race.
   */
  readonly cursorWalk: CursorWalkInput;
  readonly steer: SteerInput;
  readonly view: DodgeView;
}
