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
 * **One thing here is state rather than wiring, and it is here because it is fed
 * by packets.** What geometry each monster is firing is the difference between
 * consecutive `ENEMYSHOOT`s — see `AttackPatterns` — and a plan is not a packet:
 * sampled on the planning interval it would see the same volley ten times and
 * none of the gaps between them. So the table is filled where the packets
 * arrive and handed to the planner, which asks it questions and owns none of it.
 *
 * **Three things decide who is driving, in this order.** The chord the player
 * holds to walk somewhere wins outright — a person pointing at a place has more
 * information than any planner — and it is another plugin's now, so that it
 * works with the dodge switched off; this feature only stands down while it is
 * held (see `cursorWalkPlugin` and the wiring in `dodgeInputs`). Otherwise the
 * planner decides, and its first answer is almost always "say nothing", which
 * leaves the player's own walking untouched. Only when their course is
 * genuinely about to cost them does it speak, and then it speaks continuously
 * until it does not have to.
 *
 * **A key can name the ground it holds them to**, which is the one thing here
 * the planner cannot work out for itself: where a person means to be standing
 * is a decision about a fight, not about the shots in the air. The switch is a
 * setting so that a key and a click move the same thing; the *place* is held
 * here, because it is a point on a map and belongs to neither the panel nor the
 * file the panel persists to. See {@link DodgeSituation.anchor}.
 *
 * **And a click can name an enemy instead, which is the same thing about
 * something that moves.** Shift+left-click an enemy and the ground being held
 * stops being a place at all: it becomes a *distance* — a share of the weapon's
 * own reach — handed to the planner as a ring around whatever was clicked. What
 * that buys is the whole point. Against a place, a step around the monster costs
 * exactly as much as a step away from it; against a ring, only the distance is
 * charged, so the dodge goes sideways for free and pays for every tick it spends
 * backing off. Sidestep rather than retreat, as one term rather than a rule.
 *
 * **And the pick is said out loud**, because holding a distance from a monster
 * and shooting at it are two halves of one decision: auto-aim reads the same id
 * and stays on it while it can be hurt. See `EngagedTarget`. Clicking an ally
 * instead is auto-follow's business, and clicking bare ground lets go of both.
 * See `engageRing` for which enemy a click lands on.
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
import { isShootable, type ShootableRules } from '../autoaim/shootable.js';
import { AttackPatterns } from './AttackPatterns.js';
import { DodgePlanner } from './DodgePlanner.js';
import { DodgePictureFeed } from './DodgePictureFeed.js';
import { DodgeScene } from './DodgeScene.js';
import { declareDodgeControls, planningSettings, walkSpeedOf } from './dodgeControls.js';
import { walkCommand } from './dodgeCommand.js';
import type { DodgeInputs } from './dodgeInputs.js';
import { ENEMY_CONTACT_HALF_TILES } from './EnemyBodies.js';
import { enemyUnderCursor, type EnemyPickRules } from './engageRing.js';
import { registerHitRedirect } from './hitRedirect.js';

/**
 * How often a plan is made when nothing prompts one.
 *
 * Short enough that a shot entering the action window is acted on within a frame
 * or two of doing so.
 *
 * **What makes fifty plans a second affordable is that most of them stop after
 * the probe.** A plan whose player is not about to be hit costs one walk down
 * the horizon — a handful of field queries — and never rolls a single future;
 * the budgeted optimizer behind it is what the busy ones cost, and its worst
 * case is bounded by the plan budget rather than by how much is on the screen.
 * See `DodgePlanner`, and the benchmark that holds both to a figure.
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
 * Whether a packet field is the pair of numbers a volley's origin has to be.
 *
 * Checked rather than asserted: a field that came through as something else
 * would otherwise become a pattern centred on `NaN`, and every gap worked out
 * from it would be a place nothing can walk to.
 */
function isPoint(value: unknown): value is { readonly x: number; readonly y: number } {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.x === 'number' && typeof record.y === 'number';
}

export function createDodgePlugin(inputs: DodgeInputs): Plugin {
  return definePlugin({
    meta: {
      id: 'auto-dodge',
      name: 'Auto Dodge',
      category: PluginCategory.Movement,
      description:
        'Keeps your own walking, and takes the wheel when it would cost you. ' +
        'Shift+left-click an enemy to dodge at your weapon range of it.',
      // **Two keys, because switching it on and telling it something are two
      // different presses.** The switch is set once for a run; the anchor is a
      // thing a person says a dozen times inside one fight — stand here, hold
      // this doorway — and it is worth a key of its own for exactly the reason
      // the switch is: reaching for a panel mid-fight is not an option.
      bindable: [
        { label: 'Hotkey' },
        {
          setting: 'anchor',
          label: 'Anchor here',
          // The one switch here whose states are not on and off. `Anchor: On`
          // is a sentence about a feature; what the key does is take a place or
          // let go of one, and which of the two just happened is the whole
          // question somebody presses it asking.
          announce: { name: 'Anchor', on: 'set', off: 'unset' },
        },
      ],
    },

    setup(context) {
      const controls = declareDodgeControls(context);
      // What is left when a shot lands anyway — a separate switch, a separate
      // packet, and nothing the planner below reads. See `hitRedirect`.
      registerHitRedirect(context);

      const planner = new DodgePlanner();
      const scene = new DodgeScene(inputs);
      /**
       * What geometry each monster is firing, read off the volleys themselves.
       *
       * **Here rather than inside the planner, because it is fed by packets and
       * a plan is not.** A pattern is the difference between consecutive
       * `ENEMYSHOOT`s; sampling it on the planning interval would see the same
       * volley ten times and none of the gaps. The planner is handed the table
       * and asks it questions — see `AttackPatterns` and `PocketLock`.
       */
      const patterns = new AttackPatterns();
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

      /**
       * The enemy the player picked to fight, or nothing while they have not.
       *
       * **An id rather than a place, unlike the anchor**, because the whole
       * point of naming a monster is that it moves: where it *is* is a question
       * for the world on the plan that acts, and the id is what stays meaningful
       * while it walks. It dies with the map for the same reason a place does —
       * the same number names something else in the next one.
       */
      let engagedId: number | undefined;

      /**
       * The press this feature has already answered.
       *
       * **Because the press is not this feature's to consume.** Auto-follow
       * answers the same Shift+left-click by taking the ally under the cursor,
       * and a flag cleared on read would have whichever of the two ticked first
       * swallow it. Held in the plugin rather than per session: a press is a
       * thing that happened to the window, and a session changing underneath it
       * does not make it a new one.
       */
      let answeredPickAtMs = 0;

      /**
       * The enemy being fought and how far off it to stand, this plan.
       *
       * **Rewritten in place rather than built**, because a plan happens fifty
       * times a second and this is one object per plan for two numbers and a
       * radius that mostly have not moved. Read only while {@link orbiting}.
       */
      const orbit = { x: 0, y: 0, radiusTiles: 0 };
      /**
       * Whether that ring is in force this plan.
       *
       * Settled once, where the precedence between a place and a ring lives —
       * so the planner and the picture never have to agree about it separately.
       */
      let orbiting = false;

      /** What separates an enemy worth picking from the rest of the room. */
      const shootable: ShootableRules = {
        // A boss between phases is still the thing the player means to fight,
        // and the ring is about where to stand rather than about damage.
        skipUntouchable: false,
        skipObstacles: true,
        isObstacle: inputs.isObstacle,
        isInvincible: inputs.isInvincible,
      };
      const pickRules: EnemyPickRules = {
        halfTiles: (enemy) =>
          (inputs.bodyTiles(enemy.objectType) ?? ENEMY_CONTACT_HALF_TILES * 2) / 2,
        worthFighting: (enemy) =>
          enemy.hp > 0 && !inputs.isScenery(enemy.objectType) && isShootable(enemy, shootable),
      };

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

      /**
       * Lets go of the enemy, and of the station worked out from it.
       *
       * Called wherever an object id stops naming what it named — a new map, a
       * new session — and when the feature stops. Nothing is announced: every
       * caller is a moment where the fight itself has ended.
       */
      const dropEngage = (): void => {
        engagedId = undefined;
        orbiting = false;
        inputs.engaged.set(undefined);
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

      // Switching the chord off has to let go of what it took, or the ring goes
      // on being held by a feature the panel says is not running.
      context.onDispose(controls.engage.enabled.onChange(dropEngage));

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
        patterns.clear();
        picture.reset();
        commanding = false;
        dropAnchor();
        dropEngage();
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
        // An object id from the last map names something else in this one, so a
        // pattern kept across the join is a spiral attributed to a stranger.
        patterns.clear();
        dropAnchor();
        dropEngage();
      });
      // And a map changes underneath a session that never disconnected, which
      // is what a portal is. Coordinates do not survive one.
      context.packets.on('MAPINFO', () => {
        patterns.clear();
        dropAnchor();
        dropEngage();
      });

      /**
       * Whether the player is walking somewhere by the chord, which beats
       * everything else here.
       *
       * **Another plugin's wheel now, and this is only the standing aside.**
       * The chord used to be this feature's own override — the way out of the
       * one failure the planner cannot fix for itself, a character wedged
       * against geometry with no course that goes anywhere — and it left for
       * exactly that reason: it is worth as much with the dodge switched off
       * as on. See `cursorWalkPlugin`. The composition root reports a target
       * here only while that plugin is driving, so there is still one writer
       * of the module's move target and never a race for it.
       *
       * @returns whether the player is steering by hand, in which case the
       *   planner does not get a say this plan.
       */
      const walkingToCursor = (): boolean => inputs.cursorWalk.target() !== undefined;

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

      /**
       * A Shift+left-click: take the enemy under the cursor, or let go.
       *
       * **A click on no enemy is the let-go**, and it is the same press that
       * hands an ally to auto-follow — so clicking a teammate stops the chase
       * here as well, which is what somebody switching from one to the other
       * means. There is nothing to arbitrate: each feature answers the press for
       * the kind of thing it knows about, and a press that names neither means
       * both stand down.
       */
      const applyPick = (session: SessionView): void => {
        const cursor = inputs.cursorPoint();
        const picked =
          cursor === undefined
            ? undefined
            : enemyUnderCursor(session.world.enemies(), cursor, pickRules);
        if (picked !== undefined) {
          engagedId = picked.objectId;
          // **Said out loud to the rest of the runtime**, because holding a
          // distance from something and shooting at it are the same decision
          // made once: auto-aim reads this and stays on it while it can be hurt.
          // See `EngagedTarget`.
          inputs.engaged.set(picked.objectId);
          session.notify(`Closing on ${picked.name || 'enemy'}.`, 'Auto Dodge');
          return;
        }
        if (engagedId !== undefined) session.notify('Target let go.', 'Auto Dodge');
        dropEngage();
      };

      /**
       * Settles the ring this plan, and lets go of an enemy that is no longer
       * one.
       *
       * **A place the hand named outranks an enemy it named.** Both are the
       * player saying where they want to be, and the place is the more specific
       * of the two: somebody holding a doorway while a boss walks about has
       * already answered the question the ring would ask. Settled here rather
       * than in the planner, so that the panel, the picture and the plan all
       * read one answer.
       *
       * **A target that cannot be turned into a distance is not a lost target.**
       * No weapon in hand, or one `objects.xml` has not been read for yet, means
       * there is no ring to hold *this plan* — the enemy stays picked, because a
       * weapon swap and a data file that finishes loading both end that.
       */
      const aimRing = (session: SessionView): void => {
        orbiting = false;
        if (anchor !== undefined || engagedId === undefined) return;

        const target = session.world.entity(engagedId);
        if (target === undefined || !target.isEnemy || target.hp <= 0) {
          dropEngage();
          session.notify('Target gone.', 'Auto Dodge');
          return;
        }

        const reachTiles = inputs.weaponReachTiles(session.self.weaponType);
        if (reachTiles === undefined || !(reachTiles > 0)) return;
        orbit.x = target.x;
        orbit.y = target.y;
        orbit.radiusTiles = (reachTiles * controls.engage.rangePercent.get()) / 100;
        orbiting = orbit.radiusTiles > 0;
      };

      const dodge = (session: SessionView, nowMs: number): void => {
        // **Before the chord, so that a key pressed during one still names the
        // place it was pressed at.** The switch is armed and there is nowhere
        // held yet, which happens once per press and never again until the next
        // one.
        if (anchor === undefined && controls.anchor.get()) {
          anchor = { x: session.self.x, y: session.self.y };
        }

        // **A stamp compared, not a flag consumed**, because auto-follow answers
        // the same press for allies. Anything older than the last one answered
        // has been dealt with, and the composition root has already dropped one
        // too old to be about the cursor's current reading.
        if (controls.engage.enabled.get()) {
          const pressedAtMs = inputs.pick.at();
          if (pressedAtMs !== 0 && pressedAtMs !== answeredPickAtMs) {
            answeredPickAtMs = pressedAtMs;
            applyPick(session);
          }
        }

        // Worked out once a plan, because working it out is what lets go of an
        // enemy that has died — and the picture below draws the same answer the
        // planner was given rather than a second opinion.
        aimRing(session);

        // Before anything else, including the check for shots: a player asking
        // to be moved is answered whether or not the planner had an opinion.
        if (walkingToCursor()) {
          // The wheel changed hands, so the fight the planner was tracking
          // moved by a command it did not issue: start again from what is true
          // now rather than from a future built before the player spoke.
          planner.reset();
          return;
        }

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
            orbit: orbiting ? orbit : undefined,
          },
          planning,
          scene.world,
          map.projectiles(),
          scene.blastsIn(map, controls),
          patterns,
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
        //
        // **The hold comes from the command rather than from the setting**, and
        // that is what makes a small dodge small: the module keeps walking
        // towards an offset for as long as the record stands, so how long it
        // stands *is* how far the character goes. The setting is the ceiling; the
        // plan's own distance is what is actually asked for. See `dodgeCommand`.
        if (command.hop) {
          inputs.output.hopBy(
            command.offsetX,
            command.offsetY,
            command.speedTilesPerSecond,
            command.holdMs,
          );
          return;
        }
        inputs.output.moveBy(
          command.offsetX,
          command.offsetY,
          command.speedTilesPerSecond,
          command.holdMs,
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
        dodge(session, now);
      };

      context.timers.setInterval(() => {
        const session = context.sessions.current();
        if (session === undefined) return;
        planNow(session);
        picture.publish(session, scene, controls, Date.now(), anchor, orbiting ? orbit : undefined);
      }, PLAN_INTERVAL_MS);

      // **The one packet that changes the answer by arriving**, and it changes it
      // twice over. Everything else a plan reads is a function of time, which the
      // interval already covers — but a shot that has *just* been announced is
      // outside the window a moment ago and inside it now, and waiting out the
      // interval for it is up to a fifth of the warning spent idle.
      //
      // And it is the whole input to the pattern recogniser: one packet is one
      // volley, with the origin, the base angle, the arm count and the spacing
      // all stated. Three of those describe a spiral completely, which is why
      // nothing here has to cluster a thousand bullets to find one.
      context.packets.on('ENEMYSHOOT', (packet, session) => {
        const ownerId = packet.number('ownerId');
        const angle = packet.number('angle');
        const position = packet.get('position');
        if (ownerId !== undefined && angle !== undefined && isPoint(position)) {
          patterns.observe({
            ownerId,
            atMs: session.world.gameTimeMs,
            x: position.x,
            y: position.y,
            angle,
            count: packet.number('numShots') ?? 1,
            angleStep: packet.number('angleInc') ?? 0,
          });
        }
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
