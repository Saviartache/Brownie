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
 * Walking is not the only way out of a hit, and the other one is not movement at
 * all: see {@link registerHitRedirect}, which answers for a shot that landed by
 * naming somebody else. It is off by default and it costs a bystander.
 */

import {
  PluginCategory,
  definePlugin,
  type BlastView,
  type Plugin,
  type Position,
  type SessionView,
  type WorldView,
} from '@brownie/plugin-api';
import { DodgeController, type DodgeSettings, type DodgeWorld } from './DodgeController.js';
import { EnemyBodies, OUT_OF_RANGE_CAP_TILES } from './EnemyBodies.js';
import { registerHitRedirect } from './hitRedirect.js';
import { shotPaths, type ShotPath } from './ShotPaths.js';

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
 * How long the walk-to-cursor chord has to have been up before holding it again
 * is worth another line.
 *
 * Comfortably longer than the gap between two plans, so one press is one line
 * however long it is held, and two presses are two.
 */
const CHORD_IDLE_MS = 400;

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
 * How often the drawn shot paths are refreshed.
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

/** A time the plan may report as "never", for the log. */
function describe(ms: number): string {
  return ms === Infinity ? 'never' : `${ms.toFixed(0)}ms`;
}

/** A session with the feature switched off, allocated once. */
const NO_BLASTS: readonly BlastView[] = [];

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
   * Replaces the shot paths the module is drawing over the map.
   *
   * Wholesale, because a set of curves half-replaced is a picture of two
   * different moments. Sent only while something is watching — see
   * {@link DodgeView} — and the module lets go of them on its own if they stop
   * arriving, so switching the feature off needs no message.
   */
  showShotPaths(paths: readonly ShotPath[]): void;
}

/**
 * Whether anybody is looking at the shot paths.
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
        default: 420,
        min: 100,
        max: 1200,
        step: 20,
      });
      // **The other half of the same question, and the half a clock cannot
      // answer.** A shot crossing the room at sixteen tiles a second is inside
      // a four-hundred-millisecond window from nearly seven tiles away — so a
      // window measured only in time still hands the wheel over for fire that
      // is plainly nowhere near, and still stops the player closing on whatever
      // is doing the firing. Past this, a shot is predicted and ranked exactly
      // as before; it simply cannot be the reason a dodge starts.
      const reactWithinTiles = context.settings.range('reactWithinTiles', {
        label: 'Only act on shots within (tiles)',
        group: 'Reaction',
        default: 6,
        min: 2,
        max: 16,
        step: 0.5,
      });
      // **Coarser than a stepped planner's step, and that is the point.** The
      // sweep between two samples is exact, so this bounds how far a *curve*
      // may bend between them rather than how far a shot may travel — a
      // straight shot is described perfectly by two samples however far apart.
      // It is the single biggest lever on what a plan costs.
      const sampleStepMs = context.settings.range('stepMs', {
        label: 'Prediction sample (ms)',
        group: 'Reaction',
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
        default: 16,
        min: 8,
        max: 48,
        step: 4,
      });
      const leadMs = context.settings.range('leadMs', {
        label: 'Command lead (ms)',
        group: 'Reaction',
        default: 60,
        min: 0,
        max: 200,
        step: 10,
      });
      const urgentWithinMs = context.settings.range('urgentWithinMs', {
        label: 'Trouble is urgent within (ms)',
        group: 'Reaction',
        default: 160,
        min: 50,
        max: 500,
        step: 10,
      });

      const hitScale = context.settings.range('hitScale', {
        label: 'Caution (hit size)',
        group: 'Safety',
        default: 1,
        min: 0.5,
        max: 2,
        step: 0.05,
      });
      const padTiles = context.settings.range('latencyPadTiles', {
        label: 'Extra margin (tiles)',
        group: 'Safety',
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
        default: 0.2,
        min: 0,
        max: 1,
        step: 0.05,
      });
      const safeClearanceTiles = context.settings.range('safeClearanceTiles', {
        label: 'Room that counts as safe (tiles)',
        group: 'Safety',
        default: 0.08,
        min: 0,
        max: 0.5,
        step: 0.01,
      });
      const avoidWalls = context.settings.boolean('avoidWalls', {
        label: 'Know where the walls are',
        group: 'Safety',
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
        default: 0.25,
        min: 0,
        max: 1.5,
        step: 0.05,
      });
      const avoidDamagingGround = context.settings.boolean('avoidDamagingGround', {
        label: 'Refuse to walk onto damaging ground',
        group: 'Safety',
        default: true,
      });
      // **Thrown bombs, novas and telegraphed circles.** A different shape of
      // danger from a bullet — a disc that goes off at a moment rather than a
      // point that travels — and it is read from the telegraph the game sends
      // before it lands, because the packet that reports the blast itself
      // arrives after the damage. Its own switch because it rests on a packet
      // body recovered from the game's metadata rather than one the game states,
      // so there is a way to turn it off if a patch moves it.
      const avoidBlasts = context.settings.boolean('avoidBlasts', {
        label: 'Dodge thrown bombs and area effects',
        group: 'Safety',
        default: true,
      });
      // **The master switch for the planner knowing where the monsters are.**
      // Off, it is a pure bullet-dodger: it will thread a perfect gap and finish
      // standing inside a boss, and it will back out of weapon range answering a
      // wave it had room to cross. Everything in this group is off with it.
      const mindMonsters = context.settings.boolean('avoidEnemyBodies', {
        label: 'Mind where the monsters are',
        group: 'Spacing',
        default: true,
      });
      // **Room to dodge in, and the reason it is a distance rather than a hit
      // test.** A monster pressed against the player has already taken the space
      // every escape needs, so by the time contact damage says so there is
      // nowhere left to go. Raised on its own to the distance at which the
      // bodies touch, so nought here still means "not inside it".
      const keepAway = context.settings.range('keepAwayTiles', {
        label: 'Keep monsters at least (tiles)',
        group: 'Spacing',
        default: 2,
        min: 0,
        max: 6,
        step: 0.25,
      });
      // **The far edge, and the point of the whole group.** A dodge is not the
      // objective; staying alive while shooting is. Every course that gives
      // ground survives a little longer than every course that does not, so a
      // planner with nothing to say about range walks itself out of the fight
      // one safe step at a time.
      const stayInRange = context.settings.boolean('stayInRange', {
        label: "Stay within your weapon's range",
        group: 'Spacing',
        default: true,
      });
      // Nine tenths of it, which is the reference implementation's figure and
      // its reasoning: parked exactly at maximum range, a shot that leads a
      // moving target expires before it arrives.
      const rangePercent = context.settings.range('rangePercent', {
        label: 'Keep within (% of weapon range)',
        group: 'Spacing',
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
        default: 5,
        min: MIN_RANGE_TILES,
        max: MAX_RANGE_TILES,
        step: 0.5,
      });

      const respectIntent = context.settings.boolean('respectIntent', {
        label: 'Leave your own walking alone while it is safe',
        group: 'Control',
        default: true,
      });
      const interceptControl = context.settings.boolean('interceptControl', {
        label: 'Cancel your input while it has the wheel',
        group: 'Control',
        default: true,
      });
      const speedPercent = context.settings.range('speedPercent', {
        label: 'Walk at (% of full speed)',
        group: 'Control',
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
        default: 120,
        min: 50,
        max: 500,
        step: 10,
      });
      const cursorWalkOn = context.settings.boolean('cursorWalk', {
        label: 'Ctrl+middle-click walks to your cursor',
        group: 'Control',
        default: true,
      });

      // What is left when a shot lands anyway — a separate switch, a separate
      // packet, and nothing the planner below reads. See `hitRedirect`.
      registerHitRedirect(context);

      const controller = new DodgeController();
      const bodies = new EnemyBodies();

      // The map, as the controller sees it. Built once and pointed at the
      // current session, so a plan does not allocate an adapter and three
      // closures every twentieth of a second.
      let mapView: WorldView | undefined;
      let clearance = 0;
      let damagingMatters = true;
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
        isDamaging: (x, y) => damagingMatters && (mapView?.tileAt(x, y)?.damaging ?? false),
        standoffAt: (x, y) => bodies.standoffAt(x, y, band),
      };

      let lastPlanAtMs = 0;
      let lastShownAtMs = 0;
      /** Whether anything is currently drawn, so it can be cleared exactly once. */
      let showing = false;
      let saidTargetAtMs = 0;
      /** Whether the last line said the planner had the wheel. */
      let saidDriving = false;
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
        mapView = undefined;
        commanding = false;
      });
      // A new connection is a new character in a new place; what the last one
      // had committed to says nothing about this one.
      context.sessions.onConnected(() => {
        controller.reset();
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
       * to leave a little in hand. **Never inverted**: a melee weapon reaches
       * three and a half tiles, so a keep-away larger than the range would leave
       * a band with nothing in it and every place equally wrong. Where they
       * cross, the near edge wins — being able to dodge outranks being able to
       * shoot, and the planner is a dodge.
       */
      const updateBand = (session: SessionView): void => {
        const keepAwayTiles = Math.max(0, keepAway.get());
        band.keepAwayTiles = keepAwayTiles;
        if (!stayInRange.get()) {
          band.stayWithinTiles = Infinity;
          return;
        }
        const reach = inputs.weaponRange(session.self.weaponType);
        const usable = Math.min(
          MAX_RANGE_TILES,
          Math.max(MIN_RANGE_TILES, reach ?? fallbackRangeTiles.get()),
        );
        band.stayWithinTiles = Math.max(keepAwayTiles, (usable * rangePercent.get()) / 100);
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

        // **The two numbers in this feature that nobody can see.** Where the
        // cursor points exists only inside the game, and it reaches this line
        // through a camera, two processes and a unit conversion — so a walk that
        // goes the wrong way has several possible causes and no way to tell them
        // apart from outside. Said once when the chord goes down rather than
        // five times a second while it is held: the question it answers is
        // "which way did that send me", and the first line answers it.
        const now = Date.now();
        if (now - saidTargetAtMs >= CHORD_IDLE_MS) {
          const self = session.self;
          context.log.debug(
            `cursor walk: ${self.x.toFixed(2)},${self.y.toFixed(2)}` +
              ` towards ${target.x.toFixed(2)},${target.y.toFixed(2)}`,
          );
        }
        saidTargetAtMs = now;

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

        const settings: DodgeSettings = {
          horizonMs: horizonMs.get(),
          reactWithinMs: reactWithinMs.get(),
          reactWithinTiles: reactWithinTiles.get(),
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
          bodies.collect(map.enemies(), self.x, self.y, searchTiles + ENEMY_SEARCH_MARGIN_TILES);
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
          },
          settings,
          world,
          map.projectiles(),
          // Only the ones still on their way down. A confirmed blast has landed
          // and is history — the ground it took is now the safest on the screen,
          // and walking out of it would be dodging a crater.
          avoidBlasts.get() ? liveBlasts(map) : NO_BLASTS,
        );

        // **Only when the wheel changes hands.** This used to speak on every
        // change of verdict, and a verdict changes several times a second in a
        // fight — guide to evade and back is the planner refining an answer, not
        // news, and a hundred lines of it a minute buries everything else in the
        // log. What is worth a line is the thing a person can see happening:
        // the dodge taking over, and giving back.
        if (plan.steer !== saidDriving) {
          saidDriving = plan.steer;
          context.log.debug(
            plan.steer
              ? `dodge took over (${plan.verdict}): ${String(plan.trackedShots)} shots,` +
                  ` room ${plan.clearanceTiles.toFixed(2)}t,` +
                  ` clear for ${describe(plan.unsafeAtMs)},` +
                  ` hit in ${describe(plan.impactMs)}`
              : `dodge gave the wheel back (${plan.verdict})`,
          );
        }

        // Standing still is a real answer, and the common one — as is "carry on
        // doing what you were doing". Either way the wheel goes back, and it
        // goes back now rather than when the last target lapses.
        if (!plan.steer) {
          letGo(session);
          return;
        }

        // At the speed the plan asked for, which is not always full: the safe
        // place in a wall of shots is often inside the ring rather than on it.
        let wantX = plan.dirX * speed * plan.speedScale;
        let wantY = plan.dirY * speed * plan.speedScale;

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
        const commanded = Math.min(magnitude, speed);
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
      const showPaths = (session: SessionView): void => {
        const now = Date.now();
        if (!inputs.view.wanted()) {
          if (!showing) return;
          showing = false;
          inputs.output.showShotPaths([]);
          return;
        }
        if (now - lastShownAtMs < SHOW_INTERVAL_MS) return;
        lastShownAtMs = now;
        showing = true;
        const world = session.world;
        inputs.output.showShotPaths(
          shotPaths(world.gameTimeMs, world.projectiles(), MAX_DRAWN_SHOTS),
        );
      };

      context.timers.setInterval(() => {
        const session = context.sessions.current();
        if (session === undefined) return;
        planNow(session);
        showPaths(session);
      }, PLAN_INTERVAL_MS);

      // The one packet that changes the answer by arriving. Everything else a
      // plan reads is a function of time, which the interval already covers.
      context.packets.on('ENEMYSHOOT', (_packet, session) => {
        planNow(session);
      });
    },
  });
}
