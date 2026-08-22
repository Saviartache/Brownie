/**
 * Auto-aim, as a plugin.
 *
 * **It does not shoot.** The player decides when to fire, and the client builds
 * the shot exactly as it always does — the one thing changed is the *angle* it
 * computes, and that is changed inside the client's own call to compute it. So
 * the projectile the player sees, the packet the server receives and the hits
 * the client reports all describe the same shot, and nothing on the wire is out
 * of step with anything else. The mouse is not touched either.
 *
 * That is the module's half — see `AimHook.h`. This half decides *where*, which
 * is arithmetic over state the runtime already holds: which enemy, and where it
 * will be when the shot gets there.
 *
 * **Rewriting the angle in an outgoing `PLAYERSHOOT` would not do.** The client
 * renders its own shot at the angle it chose and reports its own hits with
 * `ENEMYHIT`; changing the angle on the wire puts the server's copy of the
 * bullet somewhere the client's is not, so the hits the client reports are
 * about a bullet the server does not have.
 *
 * **The aim point travels, not the angle.** An angle computed here is stale by
 * the time it is used, while a point is not — the module turns it into an angle
 * from wherever the player actually is at that moment.
 *
 * **Sightings arrive on the server's tick; deciding does not wait for one.**
 * The server describes the world five times a second, so a feature that also
 * *decided* five times a second spent up to a whole tick — 200 ms — holding an
 * aim it already had the information to change. What arrives on a packet is the
 * sighting; where to point is arithmetic over it, and it is redone on
 * {@link PLAN_INTERVAL_MS} against positions carried forward to now. See
 * {@link MotionTracker.motionAt}.
 */

import {
  PluginCategory,
  definePlugin,
  type EntityView,
  type Plugin,
  type Position,
  type SessionView,
} from '@brownie/plugin-api';
import { solveIntercept } from './intercept.js';
import { MotionTracker } from './MotionTracker.js';
import { TargetPriority, selectTarget } from './selectTarget.js';
import { isShootable } from './shootable.js';

/**
 * How often the aim point is worked out again.
 *
 * Short enough that the module never acts on a decision more than a frame or
 * two old, and long enough that the arithmetic — a pass over the visible
 * enemies — is a rounding error in a session. The server's tick is not a
 * candidate: it is what makes the feature feel late.
 */
const PLAN_INTERVAL_MS = 25;

/**
 * The module's switch for measuring the cursor.
 *
 * Off by default and claimed only by the one priority that reads it: measuring
 * costs three calls into the game's camera every frame, and a session aiming at
 * the closest enemy has no use for the answer.
 */
const CURSOR_FEATURE_KEY = 'cursor.track';

/**
 * How often that claim is restated.
 *
 * The module's lease is a few seconds, and this is comfortably inside it —
 * often enough that a late tick does not drop the reading mid-fight, rare
 * enough that it is one message a second rather than one per plan.
 */
const CURSOR_CLAIM_INTERVAL_MS = 1000;

/**
 * How the player's own shots move, from the game's own data.
 *
 * Resolved once per weapon by `gamedata/EquippedWeapon` — the reach in
 * particular is worked out there rather than here, because it is not always the
 * product of the other two and two features want the same answer.
 */
export interface WeaponProjectile {
  /** Tiles per millisecond. */
  readonly speedTilesPerMs: number;
  readonly lifetimeMs: number;
  /** How far one gets before it expires, in tiles. */
  readonly reachTiles: number;
}

export interface AimOutput {
  /**
   * Asks the module to point the player's shots at a world position.
   *
   * A *standing* target, like a move: the module measures the angle from the
   * player's live position and holds it until `holdMs` runs out. Saying nothing
   * is how the runtime says stop, so there is no cancel — an aim that is not
   * renewed expires, and the player's own aim is theirs again.
   */
  aimAt(x: number, y: number, holdMs: number): void;
}

export interface AutoAimOptions {
  readonly output: AimOutput;
  /**
   * What the game's data says about a weapon.
   *
   * Supplied by the composition root rather than read through the session,
   * because a plugin is not given the object catalog — and this is the one
   * thing auto-aim needs from it. `undefined` is a weapon the catalog does not
   * describe, and the feature goes quiet rather than leading a shot whose speed
   * and reach nobody stated.
   */
  readonly weapon: (weaponType: number) => WeaponProjectile | undefined;
  /**
   * Whether an object type is a wall rather than a monster.
   *
   * Supplied for the same reason as {@link weapon} and from the same place: it
   * is in `objects.xml` and nowhere on the wire, and a plugin is not given the
   * object catalog. See {@link ShootableRules.isObstacle}.
   */
  readonly isObstacle: (objectType: number) => boolean;
  /**
   * Whether an object type is one of the things that can never be hurt.
   *
   * Supplied for the same reason and from the same place as {@link isObstacle}.
   * See {@link ShootableRules.isInvincible} for why this is not a setting.
   */
  readonly isInvincible: (objectType: number) => boolean;
  /**
   * Where the player is pointing, in tiles, or nothing when the module has not
   * said recently.
   *
   * Supplied by the composition root for the same reason the two above are: it
   * arrives from the native module and a plugin is not given the link. See
   * `native/CursorTracker.ts` for where the point comes from and why it
   * expires.
   */
  readonly cursorPoint: () => Position | undefined;
}

export function createAutoAimPlugin(options: AutoAimOptions): Plugin {
  return definePlugin({
    meta: {
      id: 'auto-aim',
      name: 'Auto Aim',
      category: PluginCategory.Combat,
      description: 'Points the shots you fire at the enemy they are most likely to hit.',
    },

    setup(context) {
      const priority = context.settings.select<TargetPriority>('priority', {
        label: 'Aim at',
        default: TargetPriority.Closest,
        options: [
          [TargetPriority.Closest, 'The closest enemy'],
          [TargetPriority.LowestHp, 'The weakest enemy'],
          [TargetPriority.HighestHp, 'The toughest enemy'],
          [TargetPriority.ClosestToCursor, 'The enemy nearest your cursor'],
        ],
      });
      // How far from the cursor an enemy may be and still count. Wide enough by
      // default that pointing roughly at a monster picks it, narrow enough that
      // a monster on the far side of the screen is not "at the cursor" for
      // being the least bad thing in range.
      const cursorRadius = context.settings.range('cursorRadiusTiles', {
        label: 'Cursor radius (tiles)',
        default: 4,
        min: 0.5,
        max: 15,
        step: 0.5,
        visibleWhen: { key: 'priority', equals: [TargetPriority.ClosestToCursor] },
      });
      const skipUntouchable = context.settings.boolean('skipUntouchable', {
        label: 'Skip enemies that cannot be hurt',
        default: true,
      });
      const skipObstacles = context.settings.boolean('skipObstacles', {
        label: 'Skip walls and scenery',
        default: true,
      });
      const leadPercent = context.settings.range('leadPercent', {
        label: 'Lead the target by (%)',
        default: 100,
        min: 0,
        max: 150,
        step: 5,
      });
      // How long one decision stands if nothing replaces it. A few planning
      // intervals, not a server tick: the aim is renewed far more often than
      // that now, so a longer hold only delays the moment the player's own aim
      // comes back after the last enemy dies.
      const holdMs = context.settings.range('holdMs', {
        label: 'Keep aiming for (ms)',
        default: 150,
        min: 50,
        max: 1000,
        step: 50,
      });

      const tracker = new MotionTracker();

      // **Said once, and only because silence is otherwise ambiguous.** The
      // cursor is measured against a camera this build has to find in an
      // obfuscated game; if it is never found, the mode picks nothing and looks
      // exactly like a mode with no enemies to pick. One line in the log is the
      // difference between those two, and it is the only thing that is.
      let cursorSeen = false;

      // **The module measures the cursor only while somebody is reading it**,
      // so the mode that reads it has to ask — and keep asking. The claim
      // expires on the far side, which is what stops a plugin that was disabled
      // or unloaded from leaving the camera being queried for nobody. Restated
      // an order of magnitude more often than the lease is long.
      let claimedAtMs = 0;
      let claiming = false;
      const claimCursor = (wanted: boolean, now: number): void => {
        if (!wanted && !claiming) return;
        if (wanted && claiming && now - claimedAtMs < CURSOR_CLAIM_INTERVAL_MS) return;
        claiming = wanted;
        claimedAtMs = now;
        context.native.setFeature(CURSOR_FEATURE_KEY, wanted);
      };

      context.onDispose(() => {
        tracker.clear();
        claimCursor(false, Date.now());
      });

      // Object ids are unique within a map and re-used across one, so a
      // tracker carried over would derive a velocity from two positions of two
      // different monsters.
      context.packets.on('MAPINFO', () => {
        tracker.clear();
      });

      // **Sampling is packet work.** A position is only news when the server
      // sends one, so this is where sightings are taken — sampling on the
      // planning interval instead would derive a velocity of nought from two
      // readings of the same tick.
      //
      // Everything visible is sampled, not just what is in range: an enemy
      // walking into range has to arrive with a velocity already known, or the
      // first tick it can be shot at is a tick aimed at where it was.
      context.packets.on('NEWTICK', (_packet, session) => {
        const world = session.world;
        const now = world.gameTimeMs;
        for (const enemy of world.enemies()) {
          if (enemy.hp > 0) tracker.observe(enemy.objectId, enemy.x, enemy.y, now);
        }
        tracker.prune(now);
      });

      const aim = (session: SessionView): void => {
        // Before every early return below it: whether the module should be
        // measuring the cursor depends on the setting and on nothing else, and
        // a claim that lapsed because the player put a weapon away would come
        // back a second late with the weapon.
        claimCursor(priority.get() === TargetPriority.ClosestToCursor, Date.now());

        const self = session.self;
        if (!self.alive) return;

        const world = session.world;
        const now = world.gameTimeMs;

        // **No weapon, no aim.** How fast a shot travels and how long it lives
        // are properties of the item in the first slot, and both are needed to
        // say where a shot can reach and where to lead it to. An unfamiliar
        // weapon makes the feature go quiet rather than lead by a guess.
        const projectile = self.weaponType < 0 ? undefined : options.weapon(self.weaponType);
        if (projectile === undefined) return;

        // **The weapon's own reach, and there is no setting.** How far to aim is
        // not a preference: a target further off than the shot travels is one
        // the shot expires before reaching, and a target nearer than that is one
        // there was never a reason to skip. There was a slider here, defaulting
        // to eight tiles, which was simply wrong for every weapon in the game
        // that is not eight tiles — short for a wand, long for a sword, and
        // silently either way. The figure comes from `objects.xml` and can be
        // read off the World tab beside the name of the weapon it came from.
        const range = projectile.reachTiles;
        const lead = leadPercent.get() / 100;

        const aimPointFor = (enemy: EntityView): { x: number; y: number } | undefined => {
          // Where it is *now*, not where the last tick put it: between two
          // sightings the enemy keeps walking, and aiming at the sample is
          // aiming a tile behind anything that moves.
          const motion = tracker.motionAt(enemy.objectId, now);
          if (motion === undefined) {
            // Seen once, so there is no lead to apply. Aiming where it is now
            // is still aiming, and it is right for anything standing still —
            // which is most of what a shot connects with anyway.
            return { x: enemy.x, y: enemy.y };
          }
          const intercept = solveIntercept({
            shooterX: self.x,
            shooterY: self.y,
            targetX: motion.x,
            targetY: motion.y,
            targetVelocityX: motion.velocityX * lead,
            targetVelocityY: motion.velocityY * lead,
            bulletSpeedTilesPerMs: projectile.speedTilesPerMs,
            maxFlightMs: projectile.lifetimeMs,
          });
          return intercept === undefined ? undefined : { x: intercept.x, y: intercept.y };
        };

        const rules = {
          skipUntouchable: skipUntouchable.get(),
          skipObstacles: skipObstacles.get(),
          isObstacle: options.isObstacle,
          isInvincible: options.isInvincible,
        };

        // Solvability is part of the choice, not a test applied after it: the
        // closest enemy may be the one thing on the screen a shot cannot catch,
        // and picking it and then giving up would leave the second-closest —
        // which was hittable — unshot. Being worth shooting at is the same kind
        // of question and belongs in the same place, which is why both are
        // asked here rather than filtered before or checked after.
        // Asked for only by the one priority that reads it, so a session aiming
        // at the closest enemy never touches the clock. A reading it does not
        // get is a target it does not pick — and the player's own shot then
        // goes exactly where they pointed, which is the right answer to "we do
        // not know where you are pointing".
        const chosen = priority.get();
        const cursor =
          chosen === TargetPriority.ClosestToCursor ? options.cursorPoint() : undefined;
        if (cursor !== undefined && !cursorSeen) {
          cursorSeen = true;
          context.log.info('the module is reporting where you point; cursor aim can follow it');
        }

        const target = selectTarget(world.enemies(), {
          shooterX: self.x,
          shooterY: self.y,
          maxRangeTiles: range,
          priority: chosen,
          cursorPoint: cursor,
          cursorRadiusTiles: cursorRadius.get(),
          accept: (enemy) => isShootable(enemy, rules) && aimPointFor(enemy) !== undefined,
        });
        if (target === undefined) return;

        const point = aimPointFor(target);
        if (point === undefined) return;
        options.output.aimAt(point.x, point.y, holdMs.get());
      };

      // **Deciding is not packet work, so it does not wait for a packet.** The
      // inputs — where the enemies are heading, where the player stands — are
      // known continuously; what the server's tick supplies is a correction to
      // them. Waiting for one before pointing anywhere is what put up to a tick
      // between an enemy being worth shooting at and the shots going its way.
      context.timers.setInterval(() => {
        const session = context.sessions.current();
        if (session !== undefined) aim(session);
      }, PLAN_INTERVAL_MS);
    },
  });
}
