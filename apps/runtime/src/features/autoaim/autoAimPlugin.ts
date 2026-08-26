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
import { MotionTracker } from '../../state/MotionTracker.js';
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
 * The module's switch for letting shots through walls.
 *
 * A pair of detours over the client's own projectile collision check — see
 * `apps/native/src/game/ProjectileNoclip.h`. It lives with auto-aim because it
 * is the other half of the same complaint: a shot pointed at the right enemy is
 * no use if the scenery in front of them eats it.
 */
const SHOT_NOCLIP_FEATURE_KEY = 'shots.noclip';

/**
 * How often a claim is restated.
 *
 * The module's lease is a few seconds, and this is comfortably inside it —
 * often enough that a late tick does not drop the reading mid-fight, rare
 * enough that it is one message a second rather than one per plan.
 */
const CLAIM_INTERVAL_MS = 1000;

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

/**
 * Which enemy an aim point leads, and where this side had it.
 *
 * **What lets the module correct a point this side could not.** Bullet
 * collision in this game is the client's own — it moves its bullets, tests them
 * against its own copy of the monsters and reports the hit it has already made
 * — so a shot lands against where the *client* has the enemy. Everything here
 * is a reconstruction of that: parsed from `NEWTICK`, carried forward between
 * ticks, and close rather than exact, because the client smooths an entity's
 * motion between two ticks and no arithmetic on this side can say how far along
 * that it is.
 *
 * Naming the enemy lets the module look it up in the game's own tables and
 * shift the point by however far the two disagree. **The position goes with the
 * name because the point alone cannot be corrected**: it is already a lead, and
 * how far ahead of the monster it sits is exactly what has to survive the
 * shift.
 */
export interface AimSubject {
  readonly objectId: number;
  /** Where this side had it when the point was worked out, in tiles. */
  readonly x: number;
  readonly y: number;
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
  aimAt(x: number, y: number, holdMs: number, subject: AimSubject): void;
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
   * arrives from the native module and a plugin is not given the link.
   *
   * **Asking for it is what keeps it coming.** The module measures the cursor
   * only while the runtime claims it, and the claim rides this call rather than
   * being made here: two plugins want the reading now, one switch carries it,
   * and a claim per plugin is one plugin turning the other's reading off. See
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
      bindable: true,
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
      // Nothing to do with choosing a target, and it changes nothing on the
      // wire: the client stops testing its own projectiles against the scenery,
      // so a shot that would have died on a wall carries on. Kept here because
      // it is the other half of "the shot did not reach the enemy it was
      // pointed at" — see {@link SHOT_NOCLIP_FEATURE_KEY}.
      const passWalls = context.settings.boolean('passWalls', {
        label: 'Shots pass walls',
        default: false,
      });

      const tracker = new MotionTracker();
      /**
       * Where the *player* is going, tracked exactly as the enemies are.
       *
       * **A shot is fired from the player, and the player is not where the
       * last packet put them.** The client states its position once a server
       * tick, so between two of those the world model holds a character that
       * has since run up to two tiles — and an intercept is a distance divided
       * by a shot's speed, so a shooter two tiles too far back is a flight a
       * hundred milliseconds too long and a lead that far past the enemy.
       *
       * It errs the same way every time, which is what makes it visible:
       * running *at* something is the common case, and a stale position is
       * always further from the target than the real one, so the aim is always
       * ahead of the monster rather than on it.
       */
      const walking = new MotionTracker();
      /**
       * What the last tick said it lasted, so the player's own sightings are
       * divided by the same interval the enemies' are. `MOVE` is the client's
       * reply to `NEWTICK`, so the two arrive at one cadence.
       */
      let tickLengthMs: number | undefined;

      // **The module keeps the detours in only while somebody is asking**, so
      // this has to ask — and keep asking. The claim expires on the far side,
      // which is what stops a plugin that was disabled or unloaded from leaving
      // them live under a player who switched them off. Restated an order of
      // magnitude more often than the lease is long, and dropped outright the
      // moment the switch goes off: waiting out a lease to walk through walls
      // again is a setting that did not take.
      let claimedAtMs = 0;
      let claiming = false;
      const claimPassWalls = (wanted: boolean, now: number): void => {
        if (!wanted && !claiming) return;
        if (wanted && claiming && now - claimedAtMs < CLAIM_INTERVAL_MS) return;
        claiming = wanted;
        claimedAtMs = now;
        context.native.setFeature(SHOT_NOCLIP_FEATURE_KEY, wanted);
      };

      context.onDispose(() => {
        tracker.clear();
        walking.clear();
        claimPassWalls(false, Date.now());
      });

      // Object ids are unique within a map and re-used across one, so a
      // tracker carried over would derive a velocity from two positions of two
      // different monsters. The player's own is dropped for a plainer reason:
      // a map change is a character put somewhere else, and the step across is
      // not a direction they were walking in.
      context.packets.on('MAPINFO', () => {
        tracker.clear();
        walking.clear();
      });

      // **Sampling is packet work.** A position is only news when the server
      // sends one, so this is where sightings are taken — sampling on the
      // planning interval instead would derive a velocity of nought from two
      // readings of the same tick.
      //
      // Everything visible is sampled, not just what is in range: an enemy
      // walking into range has to arrive with a velocity already known, or the
      // first tick it can be shot at is a tick aimed at where it was.
      //
      // **The tick's own length goes with them.** A velocity is a displacement
      // per server tick, and the tick states how long it was — which is the one
      // figure a stalled connection cannot distort. Measuring the interval with
      // our own clock instead is what let three ticks delivered in five
      // milliseconds read as a monster at two hundred tiles a second, and an
      // aim led by that goes to the far side of the room. See `MotionTracker`.
      context.packets.on('NEWTICK', (packet, session) => {
        const world = session.world;
        tickLengthMs = packet.number('tickTime');
        tracker.tick(world.gameTimeMs, tickLengthMs);
        for (const enemy of world.enemies()) {
          if (enemy.hp > 0) tracker.observe(enemy.objectId, enemy.x, enemy.y);
        }
      });

      // **Where the player is, from the one packet that says so.** `MOVE` is
      // the character's own statement of where it has been this tick and it is
      // the only thing that moves the world model's copy of it, so this is the
      // moment that copy is worth a sighting. The state stage has already
      // applied it — the pipeline puts that first — so the position read here
      // is the reading the packet carried, before any plugin rewrites what
      // goes out on the wire.
      //
      // A packet whose body did not decode moved nothing, and sampling the
      // same position twice would blend the character to a standstill.
      context.packets.on('MOVE', (packet, session) => {
        if (packet.opaque) return;
        const self = session.self;
        walking.tick(session.world.gameTimeMs, tickLengthMs);
        walking.observe(self.objectId, self.x, self.y);
      });

      /** Points the shots at whatever is worth shooting, or at nothing. */
      const aim = (session: SessionView): void => {
        const self = session.self;
        if (!self.alive) return;
        // What the shot is measured from falls back to this, so a position that
        // is not a number is a whole plan's worth of `NaN` — ending at a point
        // handed to the module that points the shots.
        if (!Number.isFinite(self.x) || !Number.isFinite(self.y)) return;

        const world = session.world;
        const now = world.gameTimeMs;

        // **Where the shot leaves from, which is where the player is now.**
        // The client says where it is once a server tick and this is asked
        // eight times in one, so the position on the packet is a character
        // standing where they were up to two tiles ago. Everything below is
        // measured from this point: which enemies are in reach, how long a shot
        // takes to cross to one, and therefore how far ahead of it to aim.
        //
        // **A tick of that error does not average out, it accumulates in one
        // direction.** A player running at something is always further from it
        // in the world model than in the game, so the flight is always
        // over-estimated and the lead is always past the enemy — which is the
        // aim sitting in the empty floor ahead of a monster being charged.
        // Running away is the same error mirrored, and under-leads.
        //
        // Nothing to fall back to on the first tick of a session, which is
        // exactly when the player has not been seen to move yet — and standing
        // still is what the last packet says.
        const stride = walking.motionAt(self.objectId, now);
        const shooterX = stride?.x ?? self.x;
        const shooterY = stride?.y ?? self.y;

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
        if (!(range > 0)) return;
        const lead = leadPercent.get() / 100;

        // **How long a shot has to hit something with, which is not its
        // lifetime.** The two agree for an ordinary weapon and do not for one
        // whose reach the data states outright, and the difference is the whole
        // guard on how far this can aim: a solution is a point exactly
        // `speed × flight` from the player, so bounding the flight by the reach
        // is what makes every aim point somewhere the shot actually arrives.
        // Without it a target with a mistaken velocity is answered with a
        // meeting a screen away, which is the shot going nowhere near anything.
        const maxFlightMs = Math.min(projectile.lifetimeMs, range / projectile.speedTilesPerMs);

        /**
         * Where to point, and the enemy that answer was measured against.
         *
         * The second half is not decoration: the module corrects the point by
         * however far the client disagrees about *this* position, so a point
         * without it is one that cannot be corrected. See {@link AimSubject}.
         */
        const aimPointFor = (
          enemy: EntityView,
        ): { x: number; y: number; subject: AimSubject } | undefined => {
          // Where it is *now*, not where the last tick put it: between two
          // sightings the enemy keeps walking, and aiming at the sample is
          // aiming a tile behind anything that moves.
          const motion = tracker.motionAt(enemy.objectId, now);
          if (motion === undefined) {
            // Seen once, so there is no lead to apply. Aiming where it is now
            // is still aiming, and it is right for anything standing still —
            // which is most of what a shot connects with anyway. The only
            // branch that publishes a number straight off the wire, so it is
            // also the only one that has to ask whether it is one.
            if (!Number.isFinite(enemy.x) || !Number.isFinite(enemy.y)) return undefined;
            return {
              x: enemy.x,
              y: enemy.y,
              subject: { objectId: enemy.objectId, x: enemy.x, y: enemy.y },
            };
          }
          const intercept = solveIntercept({
            shooterX,
            shooterY,
            targetX: motion.x,
            targetY: motion.y,
            targetVelocityX: motion.velocityX,
            targetVelocityY: motion.velocityY,
            targetAngularVelocityPerMs: motion.angularVelocityPerMs ?? 0,
            bulletSpeedTilesPerMs: projectile.speedTilesPerMs,
            maxFlightMs,
          });
          if (intercept === undefined) return undefined;

          // **A share of the offset the solution names, not of the speed fed
          // into it.** Scaling the velocity changes the question being asked:
          // at 150% a target moving at three quarters of the shot's speed
          // becomes one moving faster than it, which has no meeting point at
          // all — so the setting meant to lead harder made the feature go
          // silent against exactly the targets it was turned up for. Scaling
          // the answer instead is monotone, always defined, and is what the
          // words on the slider say.
          return {
            x: motion.x + (intercept.x - motion.x) * lead,
            y: motion.y + (intercept.y - motion.y) * lead,
            // Where the enemy is *now* by this side's reckoning, which is what
            // the lead above was measured from — not the sample the last tick
            // carried, which is a tile behind it.
            subject: { objectId: enemy.objectId, x: motion.x, y: motion.y },
          };
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
        // Asked for only by the one priority that reads it, and asking is what
        // has the module measure at all — so a session aiming at the closest
        // enemy leaves the game's camera alone. A reading it does not get is a
        // target it does not pick, and the player's own shot then goes exactly
        // where they pointed, which is the right answer to "we do not know
        // where you are pointing".
        const chosen = priority.get();
        const cursor =
          chosen === TargetPriority.ClosestToCursor ? options.cursorPoint() : undefined;

        // Ranked and reached from the same place the shot leaves from, so an
        // enemy the player has just run into reach of is one this can see.
        const target = selectTarget(world.enemies(), {
          shooterX,
          shooterY,
          maxRangeTiles: range,
          priority: chosen,
          cursorPoint: cursor,
          cursorRadiusTiles: cursorRadius.get(),
          accept: (enemy) => isShootable(enemy, rules) && aimPointFor(enemy) !== undefined,
        });
        if (target === undefined) return;

        const point = aimPointFor(target);
        if (point === undefined) return;
        options.output.aimAt(point.x, point.y, holdMs.get(), point.subject);
      };

      // **Deciding is not packet work, so it does not wait for a packet.** The
      // inputs — where the enemies are heading, where the player stands — are
      // known continuously; what the server's tick supplies is a correction to
      // them. Waiting for one before pointing anywhere is what put up to a tick
      // between an enemy being worth shooting at and the shots going its way.
      context.timers.setInterval(() => {
        // Outside the session check below it, unlike the cursor's: what this
        // one claims is a pair of detours in the client, and it is as true
        // between maps as it is in one.
        claimPassWalls(passWalls.get(), Date.now());

        const session = context.sessions.current();
        if (session !== undefined) aim(session);
      }, PLAN_INTERVAL_MS);
    },
  });
}
