/**
 * Auto-dodge, as a plugin.
 *
 * **Not a pipeline stage, and that is worth saying.** Everything it needs is
 * already on the public plugin surface: the shots in flight, the tile map, the
 * server's clock and the player's position. Building it as runtime internals
 * would have given it no capability it lacks here, and would have put its on/off
 * switch and its tuning somewhere the overlay does not look.
 *
 * It is built here rather than dropped in `plugins/` because it needs two things
 * a file on disk cannot have: a way to tell the module to walk, and the module's
 * reading of what the player is asking for. Both are the composition root's to
 * hand over, so the plugin is a factory taking them.
 *
 * **Three things decide who is driving, in this order.** The chord the player
 * holds to walk somewhere wins outright — a person pointing at a place has more
 * information than any planner. Otherwise the controller decides, and its first
 * answer is almost always "say nothing", which leaves the player's own walking
 * untouched. Only when their course is genuinely about to cost them does it
 * speak, and then it speaks continuously until it does not have to.
 *
 * **Taking the wheel means cancelling their input, not out-shouting it.** The
 * module's step is applied on top of whatever the game's own movement did that
 * frame, so a player holding a key into a shot and a dodge pulling sideways
 * produce the diagonal between them — which is neither. With the direction they
 * are steering known, the command can be the *difference* between where they
 * should end up and where they are taking themselves, and the sum is the dodge.
 * See {@link SteerInput} for where that direction comes from and why it expires.
 *
 * **It plans on its own clock, and again the moment a shot is announced.** What
 * makes a shot worth dodging is time passing, not a packet arriving: a bullet
 * 500 ms away is outside the window and the same bullet 300 ms later is inside
 * it, with nothing said on the wire in between. But a shot that has *just* been
 * announced is the one case where a packet does change the answer, and waiting
 * out the interval for it is up to a fifth of the warning spent idle — so
 * `ENEMYSHOOT` plans immediately. The reference implementation reached the same
 * conclusion and called it the hazard-spawn callback.
 *
 * **One question on the panel, and everything else under Advanced.** The planner
 * genuinely turns on all twenty-odd of its numbers and every one of them has a
 * reason, but a feature that asks twenty questions before it will switch on is a
 * feature nobody switches on. A preset answers the one question a person
 * actually has — how hard should it try — by writing the eleven numbers that
 * trade caution against interference; the rest belong to the machine and the
 * connection and are left alone. Moving one by hand is what turns the label into
 * Custom, so it never claims a preset the numbers are not. See `dodgePresets`.
 *
 * Walking is not the only way out of a hit, and the other one is not movement at
 * all: see {@link registerHitRedirect}, which answers for a shot that landed by
 * naming somebody else. It is off by default and it costs a bystander.
 */

import {
  PluginCategory,
  definePlugin,
  type BlastView,
  type EntityView,
  type Plugin,
  type Position,
  type SessionView,
  type WorldView,
} from '@brownie/plugin-api';
import { DodgeController, type DodgeSettings, type DodgeWorld } from './DodgeController.js';
import {
  DODGE_PRESETS,
  DodgePresetId,
  presetMatches,
  type DodgePresetChoice,
  type DodgeTuning,
} from './dodgePresets.js';
import { overDamagingGround } from './damagingGround.js';
import {
  ENEMY_CONTACT_HALF_TILES,
  EnemyBodies,
  OUT_OF_RANGE_CAP_TILES,
  type BodySighting,
} from './EnemyBodies.js';
import { isShootable, type ShootableRules } from '../autoaim/shootable.js';
import { MotionTracker, type Motion } from '../../state/MotionTracker.js';
import { registerHitRedirect } from './hitRedirect.js';
import { shotPaths, type ShotPath } from './ShotPaths.js';
import { dodgeMarks, type DodgeMark } from './DodgeMarks.js';

/**
 * How often a plan is made when nothing prompts one.
 *
 * Short enough that a shot entering the action window is acted on within a frame
 * or two of doing so. **Measured rather than assumed**: the worst case this
 * planner has — twenty-five shots arranged so that every part-speed tier has to
 * be scored, with twenty monsters in range for the standoff term to measure
 * against — costs about 1.5 ms, so fifty plans a second is a few per cent of one
 * core and the ordinary case is a fraction of that, because a plan with nothing
 * in reach does no sweeping at all.
 */
const PLAN_INTERVAL_MS = 20;

/**
 * The least time between two plans.
 *
 * A volley arrives as one packet, but a boss firing four of them in a tick would
 * otherwise plan four times for one situation. The floor is well under the
 * interval, so an announced shot is still acted on almost immediately.
 */
const MIN_PLAN_GAP_MS = 6;

/**
 * How far ahead the module is pointed at, at least.
 *
 * The module walks *towards* a target and stops when it is close enough, so a
 * target nearer than one frame's step is a command to stand still. This is the
 * floor under "walk this way", and it is deliberately larger than one frame of
 * the fastest character in the game.
 */
const MIN_TARGET_TILES = 0.3;

/** Below this the command is not a walk, it is jitter. */
const MIN_COMMAND_SPEED = 0.2;

/** How far past the player's own reach to look for bodies worth avoiding. */
const ENEMY_SEARCH_MARGIN_TILES = 2;

/**
 * What a resolved weapon range is allowed to come out as, in tiles.
 *
 * The reference implementation's bounds, and its reason: the figure comes from
 * data somebody else maintains, and a weapon whose numbers say it reaches sixty
 * tiles would park the planner on the other side of the map. Melee weapons sit
 * at the bottom of it — a sword is three and a half tiles — and nothing in the
 * game reaches the top.
 */
const MIN_RANGE_TILES = 1;
const MAX_RANGE_TILES = 16;

/**
 * How often the drawn picture is refreshed.
 *
 * Slower than a plan on purpose: this is a picture for a person, and a person
 * cannot tell twenty a second from fifty. Each one is a few hundred numbers
 * across the pipe, so the difference is real.
 */
const SHOW_INTERVAL_MS = 50;

/**
 * The most shots drawn at once.
 *
 * A screen with more than this on it is unreadable whatever is drawn, and the
 * cap is what stops a debug view being the most expensive thing in a fight.
 */
const MAX_DRAWN_SHOTS = 48;

/** A session with the feature switched off, allocated once. */
const NO_BLASTS: readonly BlastView[] = [];

/** What a body nothing has been derived about is treated as doing. */
const STILL: Motion = { velocityX: 0, velocityY: 0 };

/**
 * The blasts still worth walking out of.
 *
 * A generator rather than an array: the planner iterates once, and a fight with
 * a boss throwing bombs would otherwise build a fresh array fifty times a
 * second to hold three of them.
 */
function* liveBlasts(map: WorldView): Iterable<BlastView> {
  for (const blast of map.blasts()) if (!blast.confirmed) yield blast;
}

export interface DodgeOutput {
  /**
   * Asks the module to walk towards a world position.
   *
   * A *target*, not a jump. The module issues a small step towards it on every
   * frame, capped at what the speed allows — commanding further than that does
   * not make the player walk there, it makes them appear there and then be put
   * back. `holdMs` is how long the target stands if nothing replaces it, which
   * is what makes "no fresh plan" mean "stop".
   */
  moveTo(x: number, y: number, speedTilesPerSecond: number, holdMs: number): void;
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

export interface DodgeInputs {
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

export function createDodgePlugin(inputs: DodgeInputs): Plugin {
  return definePlugin({
    meta: {
      id: 'auto-dodge',
      name: 'Auto Dodge',
      category: PluginCategory.Movement,
      description: 'Keeps your own walking, and takes the wheel when it would cost you.',
    },

    setup(context) {
      // **The only control most people should ever touch.** Everything below it
      // is real and every one of the numbers earns its place, but a feature that
      // asks twenty questions before it will switch on is a feature nobody
      // switches on. This answers the only question a person actually has, and
      // the rest is filed under Advanced for whoever wants it.
      //
      // Registered first because that is the order the overlay draws in.
      const preset = context.settings.select<DodgePresetChoice>('preset', {
        group: 'Preset',
        label: 'How hard it tries',
        default: DodgePresetId.Balanced,
        options: [
          [DodgePresetId.Relaxed, 'Relaxed — steps in late, leaves your walking alone'],
          [DodgePresetId.Balanced, 'Balanced — what it was tuned at'],
          [DodgePresetId.Cautious, 'Cautious — wide margins, takes the wheel sooner'],
          ['custom', 'Custom (your own numbers)'],
        ],
      });

      // ── What the preset writes ────────────────────────────────────────────
      //
      // The eleven below are a preset's whole assignment: how soon and how near
      // trouble has to be, how much margin to leave around it, and how hard to
      // think about the answer. Moving any of them by hand is what turns the
      // label above into Custom — see `applyPreset` and `onTuningChanged`.

      // **Long enough that running away stops looking clever.** A shot travels
      // faster than a character, so fleeing along its own line always survives a
      // *short* window — and a planner whose window is short therefore prefers
      // the backpedal that gets it cornered over the sidestep that ends the
      // problem. The reference implementation answered this with a bias term
      // against moving along the incoming flow; the horizon is the same answer
      // without a weight to tune, because at a second the arithmetic already
      // shows the flight failing. Everything past it is somebody else's problem.
      const horizonMs = context.settings.range('horizonMs', {
        label: 'Look ahead (ms)',
        group: 'Reaction',
        advanced: true,
        default: 1000,
        min: 300,
        max: 2000,
        step: 50,
      });
      // **The knob that decides whether this is help or a leash.** Looking a
      // second ahead is what tells a real escape from a postponement; *acting*
      // on everything a second away is what stops the player walking up to
      // anything that is shooting, because a shot across the room will reach
      // them eventually and "eventually" was being treated as "now". This is
      // how soon trouble has to be to be this moment's problem.
      const reactWithinMs = context.settings.range('reactWithinMs', {
        label: 'Only act on trouble within (ms)',
        group: 'Reaction',
        advanced: true,
        default: 420,
        min: 100,
        max: 1200,
        step: 20,
      });
      // **How close a shot gets before the character is moved, and the setting
      // that decides how the whole feature reads.** Shots in this game live for
      // a second or two, so a planner that acts on anything that will *reach*
      // the player eventually is acting on nearly everything on the screen: the
      // character shuffles from the moment a monster fires and is out of
      // position by the time the shot is anywhere near. Live report: "we catch
      // half the shots we should not, because you start dodging them at the
      // spawn." Measured where the shot is right now, so it means what it says.
      //
      // **It never changes what is predicted.** Everything in the air is still
      // swept and still ranks the courses, which is what stops a dodge of the
      // near shot from walking into the far one. This decides only when to
      // speak.
      //
      // Safe to keep tight because it is not the only trigger: a shot too fast,
      // or a pattern too wide, to be answered from this distance raises its hand
      // on the escape deadline instead — see `ThreatField.escapeTiles` — which
      // asks whether there is still *time*, not how far away anything is. Blasts
      // are not gated by it at all: an area effect is a place, not an approach.
      const engageWithinTiles = context.settings.range('engageWithinTiles', {
        label: 'Start dodging a shot within (tiles)',
        group: 'Reaction',
        advanced: true,
        default: 2.5,
        min: 1,
        max: 8,
        step: 0.25,
      });
      // **Coarser than a stepped planner's step, and that is the point.** The
      // sweep between two samples is exact, so this bounds how far a *curve*
      // may bend between them rather than how far a shot may travel — a
      // straight shot is described perfectly by two samples however far apart.
      // It is the single biggest lever on what a plan costs.
      const sampleStepMs = context.settings.range('stepMs', {
        label: 'Prediction sample (ms)',
        group: 'Reaction',
        advanced: true,
        default: 60,
        min: 20,
        max: 120,
        step: 10,
      });
      // Each one is swept, and in a dense pattern each is swept at three
      // speeds — so this is the other big lever on cost. Sixteen is what the
      // reference's own rollout planner settled on.
      const headings = context.settings.range('headings', {
        label: 'Directions considered',
        group: 'Reaction',
        advanced: true,
        default: 16,
        min: 8,
        max: 48,
        step: 4,
      });
      const urgentWithinMs = context.settings.range('urgentWithinMs', {
        label: 'Trouble is urgent within (ms)',
        group: 'Reaction',
        advanced: true,
        default: 160,
        min: 50,
        max: 500,
        step: 10,
      });

      const hitScale = context.settings.range('hitScale', {
        label: 'Caution (hit size)',
        group: 'Safety',
        advanced: true,
        default: 1,
        min: 0.5,
        max: 2,
        step: 0.05,
      });
      const padTiles = context.settings.range('latencyPadTiles', {
        label: 'Extra margin (tiles)',
        group: 'Safety',
        advanced: true,
        default: 0.1,
        min: 0,
        max: 1,
        step: 0.05,
      });
      // What `positionAt` does not model — acceleration, turn rate, the client's
      // own clock — grows with how far ahead it is asked. This is the price of
      // that, and it is why the planner can be trusted tightly up close.
      const driftTilesPerSecond = context.settings.range('driftTilesPerSecond', {
        label: 'Distrust far predictions (tiles/s)',
        group: 'Safety',
        advanced: true,
        default: 0.2,
        min: 0,
        max: 1,
        step: 0.05,
      });
      const safeClearanceTiles = context.settings.range('safeClearanceTiles', {
        label: 'Room that counts as safe (tiles)',
        group: 'Safety',
        advanced: true,
        default: 0.08,
        min: 0,
        max: 0.5,
        step: 0.01,
      });

      // ── What is yours whatever the preset says ────────────────────────────
      //
      // Latency, the character's own speed, how far off a wall to plan, and
      // every switch below: properties of a machine, a connection or a
      // preference rather than of how cautious the planner should be. A preset
      // that rewrote these would undo somebody's setup every time they tried
      // another one.

      const leadMs = context.settings.range('leadMs', {
        label: 'Command lead (ms)',
        group: 'Reaction',
        advanced: true,
        default: 60,
        min: 0,
        max: 200,
        step: 10,
      });
      const avoidWalls = context.settings.boolean('avoidWalls', {
        label: 'Know where the walls are',
        group: 'Safety',
        advanced: true,
        default: true,
      });
      // **Room to spare, not room to fit.** A position where the body exactly
      // fits is legal and is where the game's own collision starts holding a
      // character against the geometry — so a dodge that plans to the last
      // millimetre plans to be stuck. This is how far off a wall the planner
      // keeps; see where it is applied for why it is dropped once the player is
      // already inside it.
      const wallClearanceTiles = context.settings.range('wallClearanceTiles', {
        label: 'Keep clear of walls by (tiles)',
        group: 'Safety',
        advanced: true,
        default: 0.25,
        min: 0,
        max: 1.5,
        step: 0.05,
      });
      const avoidDamagingGround = context.settings.boolean('avoidDamagingGround', {
        label: 'Refuse to walk onto damaging ground',
        group: 'Safety',
        advanced: true,
        default: true,
      });
      // **Wider than the wall margin, and for a reason walls do not have.**
      // Walking into a wall costs a step; standing in lava costs health every
      // tick, and there is nothing to dodge once you are in it. The planner also
      // has no way to be sure where the character will actually end up — the
      // server has its own opinion, the command lands a frame late — so a course
      // planned to stop exactly at the edge is a course that gets a toe in it.
      // Dropped when the player is already standing that close, exactly as the
      // wall margin is, so it can never be the thing holding them there.
      const hazardClearanceTiles = context.settings.range('hazardClearanceTiles', {
        label: 'Keep clear of lava and damaging ground by (tiles)',
        group: 'Safety',
        advanced: true,
        default: 0.5,
        min: 0,
        max: 2,
        step: 0.05,
        visibleWhen: { key: 'avoidDamagingGround', equals: [true] },
      });
      // **Thrown bombs, novas and telegraphed circles.** A different shape of
      // danger from a bullet — a disc that goes off at a moment rather than a
      // point that travels — and it is read from the telegraph the game sends
      // before it lands, because the packet that reports the blast itself
      // arrives after the damage. Its own switch because it rests on a packet
      // body worked out rather than stated — a mask byte and nine conditional
      // fields, see `docs/protocol.md` — so there is a way to turn it off if a
      // patch moves it.
      const avoidBlasts = context.settings.boolean('avoidBlasts', {
        label: 'Dodge thrown bombs and area effects',
        group: 'Safety',
        advanced: true,
        default: true,
      });
      // **The master switch for the planner knowing where the monsters are.**
      // Off, it is a pure bullet-dodger: it will thread a perfect gap and finish
      // standing inside a boss, and it will back out of weapon range answering a
      // wave it had room to cross. Everything in this group is off with it.
      const mindMonsters = context.settings.boolean('avoidEnemyBodies', {
        label: 'Mind where the monsters are',
        group: 'Spacing',
        advanced: true,
        default: true,
      });
      // **Room to dodge in, and the reason it is a distance rather than a hit
      // test.** A monster pressed against the player has already taken the space
      // every escape needs, so by the time contact damage says so there is
      // nowhere left to go. Raised on its own to the distance at which the
      // bodies touch, so nought here still means "not inside it".
      //
      // Stated from the middle of an ordinary, one-tile monster; what actually
      // holds is the gap it works out to, so a boss four tiles across is kept
      // four times as far off its centre and exactly as far off its edge. See
      // `EnemyBodies.standoffAt`.
      //
      // Owned by the preset, unlike the rest of this group: how much room to
      // insist on is exactly the trade the preset is about.
      const keepAway = context.settings.range('keepAwayTiles', {
        label: 'Keep monsters at least (tiles)',
        group: 'Spacing',
        advanced: true,
        default: 2.5,
        min: 0,
        max: 6,
        step: 0.25,
      });
      // **The far edge, and the point of the whole group.** A dodge is not the
      // objective; staying alive while shooting is. Every course that gives
      // ground survives a little longer than every course that does not, so a
      // planner with nothing to say about range walks itself out of the fight
      // one safe step at a time — and, having drifted, has nothing to dodge and
      // no reason to come back. Off, the planner will neither prefer to stay in
      // range nor step back into it.
      const stayInRange = context.settings.boolean('stayInRange', {
        label: "Stay within your weapon's range",
        group: 'Spacing',
        advanced: true,
        default: true,
      });
      // Nine tenths of it, which is the reference implementation's figure and
      // its reasoning: parked exactly at maximum range, a shot that leads a
      // moving target expires before it arrives.
      const rangePercent = context.settings.range('rangePercent', {
        label: 'Keep within (% of weapon range)',
        group: 'Spacing',
        advanced: true,
        default: 90,
        min: 50,
        max: 100,
        step: 5,
      });
      // What stands in when the weapon is unknown — no data files, or an item
      // the catalog does not describe. The reference implementation's default.
      const fallbackRangeTiles = context.settings.range('fallbackRangeTiles', {
        label: 'Assume a range of (tiles)',
        group: 'Spacing',
        advanced: true,
        default: 5,
        min: MIN_RANGE_TILES,
        max: MAX_RANGE_TILES,
        step: 0.5,
      });

      const respectIntent = context.settings.boolean('respectIntent', {
        label: 'Leave your own walking alone while it is safe',
        group: 'Control',
        advanced: true,
        default: true,
      });
      const interceptControl = context.settings.boolean('interceptControl', {
        label: 'Cancel your input while it has the wheel',
        group: 'Control',
        advanced: true,
        default: true,
      });
      const speedPercent = context.settings.range('speedPercent', {
        label: 'Walk at (% of full speed)',
        group: 'Control',
        advanced: true,
        default: 92,
        min: 50,
        max: 100,
        step: 2,
      });
      // How long a step stands if nothing replaces it. A few planning intervals,
      // not a server tick: everything past the next plan is time the player
      // keeps walking towards a decision already withdrawn.
      const holdMs = context.settings.range('holdMs', {
        label: 'Keep walking for (ms)',
        group: 'Control',
        advanced: true,
        default: 120,
        min: 50,
        max: 500,
        step: 10,
      });
      const cursorWalkOn = context.settings.boolean('cursorWalk', {
        label: 'Ctrl+middle-click walks to your cursor',
        group: 'Control',
        advanced: true,
        default: true,
      });

      // What is left when a shot lands anyway — a separate switch, a separate
      // packet, and nothing the planner below reads. See `hitRedirect`.
      registerHitRedirect(context);

      // ── Presets ───────────────────────────────────────────────────────────

      /** The eleven the preset owns, as they stand right now. */
      const readTuning = (): DodgeTuning => ({
        horizonMs: horizonMs.get(),
        reactWithinMs: reactWithinMs.get(),
        engageWithinTiles: engageWithinTiles.get(),
        sampleStepMs: sampleStepMs.get(),
        headings: headings.get(),
        urgentWithinMs: urgentWithinMs.get(),
        hitScale: hitScale.get(),
        padTiles: padTiles.get(),
        driftTilesPerSecond: driftTilesPerSecond.get(),
        safeClearanceTiles: safeClearanceTiles.get(),
        keepAwayTiles: keepAway.get(),
      });

      /**
       * Whether a write is the preset's own.
       *
       * Each `set` below notifies, and every notification runs the check that
       * asks "does this still match the preset" — which, half-way through
       * applying one, it does not. Without this the first slider written would
       * flip the label to Custom and the remaining ten would be applied to a
       * preset nobody had chosen.
       */
      let applyingPreset = false;

      const applyPreset = (choice: DodgePresetChoice): void => {
        if (choice === 'custom') return; // their own numbers — nothing to apply
        const values = DODGE_PRESETS[choice];
        applyingPreset = true;
        try {
          horizonMs.set(values.horizonMs);
          reactWithinMs.set(values.reactWithinMs);
          engageWithinTiles.set(values.engageWithinTiles);
          sampleStepMs.set(values.sampleStepMs);
          headings.set(values.headings);
          urgentWithinMs.set(values.urgentWithinMs);
          hitScale.set(values.hitScale);
          padTiles.set(values.padTiles);
          driftTilesPerSecond.set(values.driftTilesPerSecond);
          safeClearanceTiles.set(values.safeClearanceTiles);
          keepAway.set(values.keepAwayTiles);
        } finally {
          applyingPreset = false;
        }
      };

      /** Every setting the preset owns runs this. */
      const onTuningChanged = (): void => {
        if (applyingPreset) return;
        const current = preset.get();
        // The numbers no longer are the ones the preset names, so stop claiming
        // they are rather than showing a label that lies.
        if (current !== 'custom' && !presetMatches(readTuning(), DODGE_PRESETS[current])) {
          preset.set('custom');
        }
      };

      context.onDispose(preset.onChange(applyPreset));
      for (const handle of [
        horizonMs,
        reactWithinMs,
        engageWithinTiles,
        sampleStepMs,
        headings,
        urgentWithinMs,
        hitScale,
        padTiles,
        driftTilesPerSecond,
        safeClearanceTiles,
        keepAway,
      ]) {
        context.onDispose(handle.onChange(onTuningChanged));
      }
      // A build that adds a number to a preset, or changes one, would otherwise
      // leave a persisted mix labelled with a preset it no longer matches.
      onTuningChanged();

      const controller = new DodgeController();
      const bodies = new EnemyBodies();
      /**
       * What counts as a monster worth keeping away from.
       *
       * **The same question auto-aim asks, and the same answer**, because the
       * two lists are the same list: a thing not worth shooting at is a thing
       * not worth walking around. A wall in this game is an object with hit
       * points and the enemy flag; a brazier, a torch and a spawn anchor are
       * `<Enemy/>` with no health bar at all. Ranking those as monsters put a
       * three-tile no-go circle around every decoration in the room, and the
       * live report was the plain one: "I cannot get through there."
       *
       * **Except for the one rule that does not carry over.** A boss in an
       * invulnerable phase cannot be shot and can still walk over somebody, so
       * `skipUntouchable` is off here where auto-aim offers it as a setting:
       * what the band is about is contact and room, not damage.
       */
      const shootable: ShootableRules = {
        skipUntouchable: false,
        skipObstacles: true,
        isObstacle: inputs.isObstacle,
        isInvincible: inputs.isInvincible,
      };
      /**
       * How fast the monsters near the player are moving.
       *
       * **What tells a monster the player walked up to from one that walked up
       * to the player**, and the two want opposite answers: the first is where
       * they meant to be, the second is the thing the near edge of the band
       * exists to keep off them. Nothing on the wire says it, so it is derived
       * from consecutive sightings — the same tracker, and the same reason, as
       * auto-aim's lead.
       */
      const motion = new MotionTracker();
      /** Wall time of the plan being made, for the tracker's own clock. */
      let sightedAtMs = 0;
      /**
       * What is read back about one enemy, rewritten in place.
       *
       * The collection loop consumes it before asking again, so one record
       * serves every body rather than one per body per plan — twenty of them,
       * fifty times a second, for two numbers and a size.
       */
      const sighting = { velocityX: 0, velocityY: 0, halfTiles: ENEMY_CONTACT_HALF_TILES };
      /**
       * What one enemy is doing and how big it is, or nothing when it is not a
       * body to avoid.
       *
       * Held once rather than built per plan: it closes over nothing that
       * changes, and the collection loop asks it of every enemy in reach.
       */
      const bodySighting = (enemy: EntityView): BodySighting | undefined => {
        if (!isShootable(enemy, shootable)) return undefined;
        motion.observe(enemy.objectId, enemy.x, enemy.y, sightedAtMs);
        // Seen only once, which every monster is on the plan it comes into
        // reach. A body that is not known to be moving is treated as still,
        // which is what this did for all of them before it could tell.
        const moving: Motion = motion.motionAt(enemy.objectId, sightedAtMs) ?? STILL;
        sighting.velocityX = moving.velocityX;
        sighting.velocityY = moving.velocityY;
        // Halved, because the catalog states a width and the band works in
        // half-extents. The ordinary body for anything it cannot describe.
        const width = inputs.bodyTiles(enemy.objectType);
        sighting.halfTiles = width === undefined ? ENEMY_CONTACT_HALF_TILES : width / 2;
        return sighting;
      };

      // The map, as the controller sees it. Built once and pointed at the
      // current session, so a plan does not allocate an adapter and three
      // closures every twentieth of a second.
      let mapView: WorldView | undefined;
      let clearance = 0;
      let damagingMatters = true;
      /** How far off damaging ground a *course* is planned, this plan. */
      let hazardClearance = 0;
      /**
       * The distances to fight between, rewritten in place each plan.
       *
       * One object for the life of the plugin rather than one per plan: it is
       * read a hundred times a plan and fifty plans a second, and the two
       * numbers in it change only when the player swaps a weapon or drags a
       * slider.
       */
      const band = { keepAwayTiles: 0, stayWithinTiles: Infinity };
      const world: DodgeWorld = {
        canStand: (x, y) => mapView?.canStandAt(x, y, clearance) ?? false,
        isDamaging: (x, y) =>
          damagingMatters &&
          mapView !== undefined &&
          overDamagingGround(mapView, x, y, hazardClearance),
        standoffAt: (x, y, aheadMs) => bodies.standoffAt(x, y, band, aheadMs),
      };

      let lastPlanAtMs = 0;
      let lastShownAtMs = 0;
      /** Whether anything is currently drawn, so it can be cleared exactly once. */
      let showing = false;
      /**
       * Whether the module is currently being told where to walk.
       *
       * **What makes handing the wheel back immediate.** A target the module
       * holds keeps being walked towards until it expires, so a plan that simply
       * stops speaking leaves the player walking somewhere the planner has
       * already stopped choosing — for the whole of `holdMs`, and against
       * whatever they are pressing. One target at their own feet ends it now.
       */
      let commanding = false;

      context.onDispose(() => {
        controller.reset();
        bodies.clear();
        motion.clear();
        mapView = undefined;
        commanding = false;
      });
      // A new connection is a new character in a new place; what the last one
      // had committed to says nothing about this one — and an object id from
      // the last map names something else in this one, so a track kept across
      // the join is a velocity attributed to a stranger.
      context.sessions.onConnected(() => {
        controller.reset();
        motion.clear();
      });

      /**
       * How fast this character may be told to walk.
       *
       * **Derived from the speed stat the server sent, not measured.** Measuring
       * it from ground covered feeds this system's own output back into its
       * input: an overestimate lengthens the next step, which covers more
       * ground, which raises the estimate. Two attempts at damping that ended
       * with a character outside the map. A stat is a number nothing here
       * influences, which is the property that fixes it.
       *
       * Held a little under the full figure, because what the formula gives is
       * the *limit* the server will accept, with nothing left over for latency
       * or for the rounding in every step along the way.
       */
      const walkSpeedOf = (session: SessionView): number =>
        (session.self.walkSpeedTilesPerSecond * speedPercent.get()) / 100;

      /**
       * The distances this character should be fighting between.
       *
       * The near edge is a setting; the far edge is the weapon's own reach, cut
       * to leave a little in hand. Where the two cross — a melee weapon against
       * something enormous — the near edge wins, but that is settled where the
       * bodies are known rather than here: how near is too near depends on how
       * big the thing is, and this end of it knows only the weapon. See
       * `EnemyBodies.standoffAt`.
       */
      const updateBand = (session: SessionView): void => {
        band.keepAwayTiles = Math.max(0, keepAway.get());
        if (!stayInRange.get()) {
          band.stayWithinTiles = Infinity;
          return;
        }
        const reach = inputs.weaponRange(session.self.weaponType);
        const usable = Math.min(
          MAX_RANGE_TILES,
          Math.max(MIN_RANGE_TILES, reach ?? fallbackRangeTiles.get()),
        );
        band.stayWithinTiles = (usable * rangePercent.get()) / 100;
      };

      /**
       * The player naming a place, which beats everything else here.
       *
       * **The way out of the one failure the planner cannot fix for itself.** A
       * character wedged against geometry has no course that goes anywhere —
       * every candidate is stopped at the first step — so the best plan
       * available is to stand there, which is where they already are.
       * Ctrl+middle-click names somewhere to go instead.
       *
       * **No wall test on this path, deliberately.** The check is the thing
       * refusing to leave, and the game's own collision is still between the
       * player and anything worse. A person holding a chord to get unstuck has
       * more information than the simulation does.
       *
       * @returns whether the player is steering by hand, in which case the
       *   planner does not get a say this plan.
       */
      const walkToCursor = (session: SessionView): boolean => {
        if (!cursorWalkOn.get()) return false;
        const target = inputs.cursorWalk.target();
        if (target === undefined) return false;

        controller.reset();
        commanding = true;
        inputs.output.moveTo(target.x, target.y, walkSpeedOf(session), holdMs.get());
        return true;
      };

      /**
       * Gives the wheel back, now rather than when the last target lapses.
       *
       * A target at the player's own feet: the module walks *towards* a target
       * and stops when it is close enough, so one it has already arrived at
       * issues no step at all. The shortest hold the record allows, because it
       * is not a walk — it is the end of one.
       */
      const letGo = (session: SessionView): void => {
        if (!commanding) return;
        commanding = false;
        inputs.output.moveTo(session.self.x, session.self.y, walkSpeedOf(session), 1);
      };

      const dodge = (session: SessionView): void => {
        // Before anything else, including the check for shots: being stuck is
        // not a thing that happens only under fire, and a player asking to be
        // moved is answered whether or not the planner had an opinion.
        if (walkToCursor(session)) return;

        const self = session.self;
        const map = session.world;
        const speed = walkSpeedOf(session);
        const intent = respectIntent.get() ? inputs.steer.direction() : undefined;

        // **The margin is dropped when the player is already inside it.**
        // Demanding clearance the current position does not have makes every
        // step out of it un-walkable too — including the ones that lead away —
        // so the planner would pin the player against the wall with the very
        // setting meant to keep them off it. The margin decides where not to go;
        // it never decides where not to leave.
        const wanted = wallClearanceTiles.get();
        mapView = map;
        clearance = wanted > 0 && map.canStandAt(self.x, self.y, wanted) ? wanted : 0;
        damagingMatters = avoidDamagingGround.get();

        // **And the same rule for the margin around lava**, for the same
        // reason: a player who has chosen to fight at the edge of a pool is
        // inside it, and a margin that refuses every square they could step to
        // is a margin that holds them there. Measured against the body alone,
        // so being inside the *margin* drops it and being inside the *pool* is
        // a different question — see `onDamagingGround` below.
        const wantedFromHazards = hazardClearanceTiles.get();
        hazardClearance =
          wantedFromHazards > 0 && !overDamagingGround(map, self.x, self.y, wantedFromHazards)
            ? wantedFromHazards
            : 0;

        const settings: DodgeSettings = {
          horizonMs: horizonMs.get(),
          reactWithinMs: reactWithinMs.get(),
          engageWithinTiles: engageWithinTiles.get(),
          sampleStepMs: sampleStepMs.get(),
          headings: headings.get(),
          hitScale: hitScale.get(),
          padTiles: padTiles.get(),
          leadMs: leadMs.get(),
          driftTilesPerSecond: driftTilesPerSecond.get(),
          safeClearanceTiles: safeClearanceTiles.get(),
          urgentWithinMs: urgentWithinMs.get(),
          avoidWalls: avoidWalls.get(),
          avoidDamagingGround: damagingMatters,
        };

        if (mindMonsters.get()) {
          updateBand(session);
          // Far enough to see the edge of the band as well as the edge of the
          // walk: a monster just outside weapon range is the one thing this is
          // meant to notice, and one culled for being far away is one the
          // planner reads as "nobody here" and drifts away from.
          const searchTiles = Math.max(
            (speed * (settings.leadMs + settings.horizonMs)) / 1000,
            band.stayWithinTiles === Infinity ? 0 : band.stayWithinTiles + OUT_OF_RANGE_CAP_TILES,
          );
          sightedAtMs = Date.now();
          motion.prune(sightedAtMs);
          bodies.collect(
            map.enemies(),
            self.x,
            self.y,
            searchTiles + ENEMY_SEARCH_MARGIN_TILES,
            bodySighting,
            inputs.aimTarget(),
          );
        } else {
          bodies.clear();
        }

        const plan = controller.plan(
          {
            x: self.x,
            y: self.y,
            intentX: intent?.x ?? 0,
            intentY: intent?.y ?? 0,
            speedTilesPerSecond: speed,
            gameTimeMs: map.gameTimeMs,
            nowMs: Date.now(),
            // The one tile the game charges for, with no body and no margin
            // around it. Whether to *walk* somewhere is the wider question and
            // is `world.isDamaging`; whether health is going down right now is
            // this one, and answering it with the wider test had the planner
            // escaping ground nobody was being hurt by.
            onDamagingGround: damagingMatters && (map.tileAt(self.x, self.y)?.damaging ?? false),
          },
          settings,
          world,
          map.projectiles(),
          // Only the ones still on their way down. A confirmed blast has landed
          // and is history — the ground it took is now the safest on the screen,
          // and walking out of it would be dodging a crater.
          avoidBlasts.get() ? liveBlasts(map) : NO_BLASTS,
        );

        // **Nothing is logged here, and that is deliberate.** The wheel changes
        // hands several times a second in a fight, so even one line per change
        // was a hundred a minute that buried everything else and answered
        // nothing — a verdict and four numbers describe a moment that has
        // already passed. What answers the questions people actually ask is the
        // picture over the map, where the same numbers are circles on the ground
        // and the shots are beside them: see `DodgeMarks`. Live report: "delete
        // all the dodge logs, there are a lot of them and they give me nothing."

        // Standing still is a real answer, and the common one — as is "carry on
        // doing what you were doing". Either way the wheel goes back, and it
        // goes back now rather than when the last target lapses.
        if (!plan.steer) {
          letGo(session);
          return;
        }

        // At the speed the plan asked for, which is not always full: the safe
        // place in a wall of shots is often inside the ring rather than on it.
        //
        // **Except when something is standing on the player**, which is a shove
        // rather than a sidestep and is worth the margin the ordinary speed
        // keeps in hand — the whole complaint is that monsters get close anyway.
        // The margin exists because a command past the server's own limit is
        // what makes it pull the character back; the *limit* is what this
        // spends, and no more.
        const urgency = plan.crowded ? session.self.walkSpeedTilesPerSecond : speed;
        let wantX = plan.dirX * urgency * plan.speedScale;
        let wantY = plan.dirY * urgency * plan.speedScale;

        // **Cancelling their input rather than adding to it.** The module's step
        // lands on top of whatever the game's own movement did this frame, so
        // commanding the direction we want while the player pulls another way
        // produces the sum of the two. Subtracting what they are contributing
        // makes that sum the plan.
        if (interceptControl.get() && intent !== undefined) {
          const cancelX = wantX - intent.x * speed;
          const cancelY = wantY - intent.y * speed;
          // Never past a right angle from the plan. If the direction they are
          // steering is not the one they are actually moving — a hand on the
          // keys while a chat box has them — the correction can otherwise point
          // somewhere the plan never asked for. This bounds that to "less help",
          // never "the wrong way".
          if (cancelX * plan.dirX + cancelY * plan.dirY > 0) {
            wantX = cancelX;
            wantY = cancelY;
          }
        }

        const magnitude = Math.hypot(wantX, wantY);
        if (magnitude < MIN_COMMAND_SPEED) {
          // The correction cancelled out: what they are doing already *is* the
          // plan, which is a reason to say nothing rather than to nudge.
          letGo(session);
          return;
        }
        // Capped at what the character can walk. A cancellation can ask for more
        // than that, and a command past the character's own speed is what makes
        // the server pull them back — so the correction is allowed to be partial
        // and is never allowed to be a snap-back.
        const commanded = Math.min(magnitude, urgency);
        const hold = holdMs.get();
        // Far enough that the module's per-frame step is never the thing that
        // truncates the walk. It is a direction, expressed as a place.
        const distance = Math.max(MIN_TARGET_TILES, (commanded * hold) / 1000);
        commanding = true;
        inputs.output.moveTo(
          self.x + (wantX / magnitude) * distance,
          self.y + (wantY / magnitude) * distance,
          commanded,
          hold,
        );
      };

      /**
       * Plans, unless one has only just been made.
       *
       * Both triggers come through here so that a shot announced a millisecond
       * after the interval fired does not plan twice for one situation.
       */
      const planNow = (session: SessionView): void => {
        const now = Date.now();
        if (now - lastPlanAtMs < MIN_PLAN_GAP_MS) return;
        lastPlanAtMs = now;
        dodge(session);
      };

      /**
       * Answers the module's "show me what you are dodging".
       *
       * On its own cadence rather than the planner's, because it is a picture
       * and a picture does not need fifty a second. The empty set is sent once
       * when the switch goes up, so what is on the screen goes with it rather
       * than waiting out its own freshness.
       */
      const showPicture = (session: SessionView): void => {
        const now = Date.now();
        if (!inputs.view.wanted()) {
          if (!showing) return;
          showing = false;
          inputs.output.showPicture([], []);
          return;
        }
        if (now - lastShownAtMs < SHOW_INTERVAL_MS) return;
        lastShownAtMs = now;
        showing = true;
        const world = session.world;
        const self = session.self;
        // **The state the last plan actually used, not a second guess at it.**
        // `bodies` and `band` are whatever the planner filled in a moment ago —
        // so a body missing from the picture is a body missing from the
        // decision, which is the one thing a debug view has to be able to say.
        // Empty when the spacing group is switched off, which is honest: it is
        // then not minding the monsters at all.
        inputs.output.showPicture(
          shotPaths(world.gameTimeMs, world.projectiles(), MAX_DRAWN_SHOTS),
          dodgeMarks({
            selfX: self.x,
            selfY: self.y,
            gameTimeMs: world.gameTimeMs,
            engageTiles: engageWithinTiles.get(),
            band: mindMonsters.get() ? band : undefined,
            bodies,
            blasts: avoidBlasts.get() ? liveBlasts(world) : NO_BLASTS,
          }),
        );
      };

      context.timers.setInterval(() => {
        const session = context.sessions.current();
        if (session === undefined) return;
        planNow(session);
        showPicture(session);
      }, PLAN_INTERVAL_MS);

      // The one packet that changes the answer by arriving. Everything else a
      // plan reads is a function of time, which the interval already covers.
      context.packets.on('ENEMYSHOOT', (_packet, session) => {
        planNow(session);
      });

      // **Which `SHOWEFFECT` types are a telegraph was a question for a log**,
      // and it is not one any more: the packet's body is described now — a mask
      // byte and nine conditional fields, see `docs/protocol.md` — so a type
      // that carries a position, a thrower and a duration is one this can place
      // on the map and watch the `AOE` land on. The World tab counts
      // confirmations and unmatched detonations, which answers the same question
      // continuously instead of one line per type per session.
    },
  });
}
