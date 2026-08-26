/**
 * Auto-dodge, as a plugin.
 *
 * **Not a pipeline stage, and that is worth saying.** Everything it needs is
 * already on the public plugin surface: the shots in flight, the tile map, the
 * server's clock and the player's position. Building it as runtime internals
 * would have given it no capability it lacks here, and would have put its on/off
 * switch and its tuning somewhere the overlay does not look.
 *
 * It is built here rather than dropped in `plugins/` because it needs things a
 * file on disk cannot have: a way to tell the module to walk, the module's
 * reading of what the player is asking for, and the object catalog. All of them
 * are the composition root's to hand over, so the plugin is a factory taking
 * them — see `dodgeInputs.ts`.
 *
 * **This file is the wiring and the order of precedence, and nothing else.**
 * The panel is `dodgeControls`, the fight the planner is handed is `DodgeScene`,
 * the arithmetic that turns a plan into a step is `dodgeCommand`, the picture is
 * `DodgePictureFeed`, and the planner itself is `DodgePlanner`.
 *
 * **Three things decide who is driving, in this order.** The chord the player
 * holds to walk somewhere wins outright — a person pointing at a place has more
 * information than any planner. Otherwise the planner decides, and its first
 * answer is almost always "say nothing", which leaves the player's own walking
 * untouched. Only when their course is genuinely about to cost them does it
 * speak, and then it speaks continuously until it does not have to.
 *
 * **A key can name the ground it holds them to**, which is the one thing here
 * the planner cannot work out for itself: where a person means to be standing
 * is a decision about a fight, not about the shots in the air. The switch is a
 * setting so that a key and a click move the same thing; the *place* is held
 * here, because it is a point on a map and belongs to neither the panel nor the
 * file the panel persists to. See {@link DodgeSituation.anchor}.
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
  type Plugin,
  type Position,
  type SessionView,
} from '@brownie/plugin-api';
import { DodgePlanner } from './DodgePlanner.js';
import { DodgePictureFeed } from './DodgePictureFeed.js';
import { DodgeScene } from './DodgeScene.js';
import { declareDodgeControls, planningSettings, walkSpeedOf } from './dodgeControls.js';
import { walkCommand } from './dodgeCommand.js';
import type { DodgeInputs } from './dodgeInputs.js';
import { registerHitRedirect } from './hitRedirect.js';

/**
 * How often a plan is made when nothing prompts one.
 *
 * Short enough that a shot entering the action window is acted on within a frame
 * or two of doing so.
 *
 * **What makes fifty plans a second affordable is that most of them stop after
 * the probe.** A plan whose player is not about to be hit costs one walk down
 * the lattice — a handful of index queries — and never opens the search at all;
 * the budgeted search behind it is what the busy ones cost, and its worst case
 * is bounded by `maxExpansions` rather than by how much is on the screen. See
 * `DodgePlanner`, and the benchmark that holds both to a figure.
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

/** The shortest hold the module will accept, for a command that ends a walk. */
const RELEASE_HOLD_MS = 1;

/**
 * How long a hop stands before it lapses unspent.
 *
 * **A deadline, not a duration.** The record is spent by the first frame that
 * actually steps towards it, so this only bounds how long it may wait for one —
 * and a frame with nothing to measure the player's own walking against issues no
 * step at all, which is the ordinary case immediately after a quiet stretch. A
 * few frames of grace; past that the situation it was chosen for has moved on
 * and the next plan will choose again.
 */
const HOP_HOLD_MS = 60;

export function createDodgePlugin(inputs: DodgeInputs): Plugin {
  return definePlugin({
    meta: {
      id: 'auto-dodge',
      name: 'Auto Dodge',
      category: PluginCategory.Movement,
      description: 'Keeps your own walking, and takes the wheel when it would cost you.',
      // **Two keys, because switching it on and telling it something are two
      // different presses.** The switch is set once for a run; the anchor is a
      // thing a person says a dozen times inside one fight — stand here, hold
      // this doorway — and it is worth a key of its own for exactly the reason
      // the switch is: reaching for a panel mid-fight is not an option.
      bindable: [{ label: 'Hotkey' }, { setting: 'anchor', label: 'Anchor here' }],
    },

    setup(context) {
      const controls = declareDodgeControls(context);
      // What is left when a shot lands anyway — a separate switch, a separate
      // packet, and nothing the planner below reads. See `hitRedirect`.
      registerHitRedirect(context);

      const planner = new DodgePlanner();
      const scene = new DodgeScene(inputs);
      const picture = new DodgePictureFeed(inputs.output, inputs.view);

      let lastPlanAtMs = 0;
      /**
       * The place the player is holding, or nothing while they are not.
       *
       * **Here rather than in a setting, and it is a place rather than a
       * distance.** A setting survives a restart and travels to a panel, and
       * neither is true of a point on a map: the coordinates mean something
       * else in the next dungeon and nothing at all after a reconnect. What
       * *is* a setting is the switch — see `dodgeControls.anchor` — and this is
       * where it points.
       *
       * **Captured on the first plan after the switch goes up rather than the
       * moment it does**, because that is where the character is known to be: a
       * key can be pressed while nothing is connected, and a place taken from a
       * session that does not exist is not a place.
       */
      let anchor: Position | undefined;

      // **A switch that outlived its place, which is what every restart leaves
      // behind.** The setting persists as every setting does and the place
      // cannot, so a run that starts armed is a panel claiming the character is
      // being held somewhere nobody chose. Cleared rather than honoured: the
      // only other reading is pinning them wherever they happen to log in.
      controls.anchor.set(false);

      /**
       * Lets go of the place, and of the switch that named it.
       *
       * Both, because the switch is what a person reads: an armed switch
       * pointing at nothing is a panel saying the character is being held
       * somewhere they are not. Called wherever the coordinates stop meaning
       * anything — a new map, a new session — and when the feature stops.
       */
      const dropAnchor = (): void => {
        anchor = undefined;
        controls.anchor.set(false);
      };

      // Cleared on both edges: switched off there is nothing to hold, and
      // switched on the place is wherever the character turns out to be on the
      // next plan. Pressing the key twice is therefore how a held place is
      // moved, which is the only other thing anybody wants to do with one.
      context.onDispose(
        controls.anchor.onChange(() => {
          anchor = undefined;
        }),
      );

      /**
       * Whether the module is currently being told where to walk.
       *
       * **What makes handing the wheel back immediate.** A target the module
       * holds keeps being walked towards until it expires, so a plan that simply
       * stops speaking leaves the player walking somewhere the planner has
       * already stopped choosing — for the whole of the hold, and against
       * whatever they are pressing. One command of no distance at all ends it
       * now.
       */
      let commanding = false;

      context.onDispose(() => {
        planner.reset();
        scene.reset();
        picture.reset();
        commanding = false;
        dropAnchor();
      });
      // A new connection is a new character in a new place; what the last one
      // had committed to says nothing about this one — and an object id from the
      // last map names something else in this one, so a track kept across the
      // join is a velocity attributed to a stranger. The place the player was
      // holding is the same kind of stranger: the same two numbers name
      // somewhere else entirely.
      context.sessions.onConnected(() => {
        planner.reset();
        scene.reset();
        dropAnchor();
      });
      // And a map changes underneath a session that never disconnected, which
      // is what a portal is. Coordinates do not survive one.
      context.packets.on('MAPINFO', () => {
        dropAnchor();
      });

      /**
       * The player naming a place, which beats everything else here.
       *
       * **The way out of the one failure the planner cannot fix for itself.** A
       * character wedged against geometry has no course that goes anywhere —
       * every candidate is stopped at the first step — so the best plan
       * available is to stand there, which is where they already are.
       * Ctrl+middle-click names somewhere to go instead.
       *
       * **A place rather than an offset, and the only command here that is.**
       * The cursor is measured against the game's own camera, so it already
       * names a point on the map that owes nothing to this side's idea of where
       * the player is. **And no wall test on this path, deliberately**: the
       * check is the thing refusing to leave, and the game's own collision is
       * still between the player and anything worse.
       *
       * @returns whether the player is steering by hand, in which case the
       *   planner does not get a say this plan.
       */
      const walkToCursor = (session: SessionView): boolean => {
        if (!controls.driving.cursorWalk.get()) return false;
        const target = inputs.cursorWalk.target();
        if (target === undefined) return false;

        planner.reset();
        commanding = true;
        inputs.output.moveTo(
          target.x,
          target.y,
          walkSpeedOf(session, controls),
          controls.driving.holdMs.get(),
        );
        return true;
      };

      /**
       * Gives the wheel back, now rather than when the last command lapses.
       *
       * An offset of nothing: the module walks *towards* a place and stops when
       * it is close enough, so one it has already arrived at issues no step at
       * all. The shortest hold the record allows, because it is not a walk — it
       * is the end of one.
       */
      const letGo = (session: SessionView): void => {
        if (!commanding) return;
        commanding = false;
        inputs.output.moveBy(0, 0, walkSpeedOf(session, controls), RELEASE_HOLD_MS);
      };

      const dodge = (session: SessionView, nowMs: number): void => {
        // **Before the chord, so that a key pressed during one still names the
        // place it was pressed at.** The switch is armed and there is nowhere
        // held yet, which happens once per press and never again until the next
        // one.
        if (anchor === undefined && controls.anchor.get()) {
          anchor = { x: session.self.x, y: session.self.y };
        }

        // Before anything else, including the check for shots: being stuck is
        // not a thing that happens only under fire, and a player asking to be
        // moved is answered whether or not the planner had an opinion.
        if (walkToCursor(session)) return;

        const planning = planningSettings(controls);
        scene.observe(session, controls, planning);

        const self = session.self;
        const map = session.world;
        const speed = walkSpeedOf(session, controls);
        const intent = controls.driving.respectIntent.get() ? inputs.steer.direction() : undefined;

        const plan = planner.plan(
          {
            x: self.x,
            y: self.y,
            intentX: intent?.x ?? 0,
            intentY: intent?.y ?? 0,
            speedTilesPerSecond: speed,
            gameTimeMs: map.gameTimeMs,
            nowMs,
            onDamagingGround: scene.onDamagingGround,
            anchor,
          },
          planning,
          scene.world,
          map.projectiles(),
          scene.blastsIn(map, controls),
        );

        // **Nothing is logged here, and that is deliberate.** The wheel changes
        // hands several times a second in a fight, so even one line per change
        // was a hundred a minute that buried everything else and answered
        // nothing — a verdict and four numbers describe a moment that has
        // already passed. What answers the questions people actually ask is the
        // picture over the map, where the same numbers are circles on the ground
        // and the shots are beside them: see `DodgeMarks`. Live report: "delete
        // all the dodge logs, there are a lot of them and they give me nothing."

        const hold = controls.driving.holdMs.get();
        const command = walkCommand({
          plan,
          intent,
          speedTilesPerSecond: speed,
          fullSpeedTilesPerSecond: self.walkSpeedTilesPerSecond,
          cancelIntent: controls.driving.interceptControl.get(),
          holdMs: hold,
        });

        // Standing still is a real answer, and the common one — as is "carry on
        // doing what you were doing". Either way the wheel goes back, and it
        // goes back now rather than when the last command lapses.
        if (command === undefined) {
          letGo(session);
          return;
        }

        commanding = true;
        // **A hop is the same offset with a different lifetime**, and the module
        // is the only side that can spend it correctly: an offset is resolved
        // from wherever the character is on the frame it lands, so one left
        // standing would be carried again on every frame of the hold. See
        // `DodgeOutput.hopBy`.
        if (command.hop) {
          inputs.output.hopBy(
            command.offsetX,
            command.offsetY,
            command.speedTilesPerSecond,
            HOP_HOLD_MS,
          );
          return;
        }
        inputs.output.moveBy(command.offsetX, command.offsetY, command.speedTilesPerSecond, hold);
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
        dodge(session, now);
      };

      context.timers.setInterval(() => {
        const session = context.sessions.current();
        if (session === undefined) return;
        planNow(session);
        picture.publish(session, scene, controls, Date.now(), anchor);
      }, PLAN_INTERVAL_MS);

      // The one packet that changes the answer by arriving. Everything else a
      // plan reads is a function of time, which the interval already covers.
      context.packets.on('ENEMYSHOOT', (_packet, session) => {
        planNow(session);
      });

      // Where the monsters are is only news when the server says so, and a
      // velocity derived on any other schedule is a velocity of nought. See
      // `DodgeScene.sight`.
      context.packets.on('NEWTICK', (packet, session) => {
        scene.sight(session, packet.number('tickTime'));
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
