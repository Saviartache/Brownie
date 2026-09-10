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
   * The same, spent by the first frame that acts on it. See `Hop.ts`.
   *
   * **Why it needs to be a different record and not a shorter hold.** An offset
   * is resolved against wherever the player is on the frame it lands, which is
   * exactly what makes an ordinary walk work: the target stays a fixed distance
   * ahead and the character keeps walking towards it. A hop wants one frame's
   * worth of movement and no more, and leaving the same offset standing would
   * carry it again on the next frame, and the one after — as many times as fit
   * inside the hold. At a hundred and forty frames a second a hold of twenty
   * milliseconds is three of them, which is two tiles rather than the two thirds
   * of one the planner chose, and the server takes the difference back.
   *
   * The hold is still what bounds how long it may wait: a frame with nothing to
   * measure the player's own walking against issues no step, and the hop is
   * spent by the frame that steps rather than by the frame that sees it.
   */
  hopBy(offsetX: number, offsetY: number, speedTilesPerSecond: number, holdMs: number): void;
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
 * The Shift+left-click that names something under the cursor.
 *
 * **A stamp rather than an edge, because two features answer the same press.**
 * Auto-follow takes the ally under the cursor and this takes the enemy, and a
 * flag consumed on read would have whichever of them ticked first swallow the
 * press. A moment each of them can compare against the last one it acted on
 * lets both see it, and neither has to know the other exists.
 *
 * The composition root is what decides a press is still worth acting on: a
 * feature that has not planned for half a second has missed it, and a click
 * resolved against a cursor that has moved on since is not the click the player
 * made.
 */
export interface PickInput {
  /** When the last press worth acting on was, in wall-clock ms, or nought. */
  at(): number;
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
   * Whether one of these stands in the way rather than fighting.
   *
   * **A wall in this game is an object with hit points and the enemy flag**, so
   * to anything ranking enemies by distance it is simply the closest one — and
   * the spacing rule, which is exactly such a ranking, spent a dungeon measuring
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
   * invincible — so it passed every cull there was and got a no-go circle
   * drawn round it. It also never moves and never fires, which is the whole of
   * why it does not belong in a list of things to keep away from.
   *
   * Deliberately *not* part of auto-aim's rules: a lever is shot on purpose, so
   * auto-aim must go on seeing it. The two lists are the same list right up to
   * the things that are only ever targets.
   */
  readonly isScenery: (objectType: number) => boolean;
  /**
   * Whether one of these has any attack at all, from `objects.xml`.
   *
   * **The live report is a room full of circles around nothing.** A spawner is
   * `<Enemy />`, carries a health bar, is neither a wall nor scenery nor marked
   * invincible, and is drawn as nothing at all — so it passed every cull there
   * was and the planner spent the fight walking around empty floor. What it is
   * not is dangerous: it declares no `<Projectile>`, and it never moves. Either
   * one of those alone describes plenty of real monsters — a melee minion has
   * no shots, a boss between phases is not walking — so it is the pair that
   * says "there is nothing here", and this is the half the catalog knows. See
   * `DodgeScene` for the other.
   */
  readonly hasShots: (objectType: number) => boolean;
  /**
   * How wide one of these is, in tiles.
   *
   * **The distance that keeps a minion at arm's length puts you inside a boss**,
   * and nothing on the wire says how big anything is — `<Size>` is in
   * `objects.xml`, so the composition root hands it over exactly as it does the
   * two above. `undefined` for a type the catalog cannot describe, and for every
   * type while no data file has been read, in which case the ordinary body
   * stands in and the distance behaves as it did before it could tell.
   */
  readonly bodyTiles: (objectType: number) => number | undefined;
  /**
   * How far this weapon's shots get before they expire, in tiles.
   *
   * **The one number the engage ring is built on, and there is no setting for
   * it.** How far away a fight is fought is a property of the item in the
   * player's hand: eight tiles for one wand is four for another, and a slider
   * would be wrong for every weapon it was not set for. `undefined` for no
   * weapon and for one `objects.xml` does not describe, in which case there is
   * no ring to hold and the dodge behaves as it does with no target at all —
   * the same answer auto-aim gives to the same question.
   */
  readonly weaponReachTiles: (objectType: number) => number | undefined;
}

export interface DodgeInputs extends DodgeCatalog {
  readonly output: DodgeOutput;
  /**
   * The chord the cursor-walk plugin answers, read here only to stand down
   * while it drives.
   *
   * **A yield and not a walk, since the walk moved out.** The Ctrl+middle-click
   * chord has to work with the dodge switched off — it is the way out of being
   * wedged against geometry, which is not a thing the planner causes nor one it
   * can fix — so it lives in its own plugin with its own switch
   * (`cursorWalkPlugin`). The composition root hands this side a target only
   * while that plugin is driving, which keeps one writer of the module's move
   * target: two plugins both publishing walk targets would be two writers
   * arguing forty times a second, and this way there is a decision instead of a
   * race.
   */
  readonly cursorWalk: CursorWalkInput;
  readonly steer: SteerInput;
  readonly view: DodgeView;
  /**
   * Where the player is pointing, for resolving a pick.
   *
   * The same reading auto-aim ranks by and the same one auto-follow picks an
   * ally with — asking for it is what keeps the module measuring it, so a
   * feature that stops asking stops the cost. See `Application.#cursorPoint`.
   */
  readonly cursorPoint: () => Position | undefined;
  readonly pick: PickInput;
  /**
   * Where the enemy the player picked is announced.
   *
   * **A write and never a read**, because this plugin is the one that decides:
   * what auto-aim does with the answer is auto-aim's business, and a feature
   * that had to ask what it itself said last would be two owners of one fact.
   * See `EngagedTarget` for why the holder is the composition root's.
   */
  readonly engaged: { set(objectId: number | undefined): void };
}
