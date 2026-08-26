/**
 * The fight, assembled once per plan and handed to the controller.
 *
 * **The controller is arithmetic over positions and knows nothing about
 * sessions.** What it needs of the world is three questions — can a body stand
 * here, is this ground hurting, how much room to dodge in does this place leave
 * — and a list of monsters to answer the third with. Building those from a
 * session is a job of its own: it involves the object catalog, two clearance
 * margins that are dropped when the player is already inside them, and a motion
 * tracker that turns five sightings a second into a velocity.
 *
 * **Everything here is allocated once.** The adapter and the record a body is
 * read back through are rewritten in place: a plan happens fifty times a
 * second, and a fresh closure per question was the single largest thing this
 * feature allocated.
 */

import type { BlastView, EntityView, SessionView, WorldView } from '@brownie/plugin-api';
import { StatType } from '../../constants/StatType.js';
import { bodyTilesFromPercent } from '../../gamedata/GameCatalogs.js';
import { isShootable, type ShootableRules } from '../autoaim/shootable.js';
import { MotionTracker } from '../../state/MotionTracker.js';
import type { DodgeSettings } from './DodgePlanner.js';
import type { DodgeGround } from './DodgeSearch.js';
import { walkSpeedOf, type DodgeControls } from './dodgeControls.js';
import type { DodgeCatalog } from './dodgeInputs.js';
import { GroundCache } from './GroundCache.js';
import { ENEMY_CONTACT_HALF_TILES, EnemyBodies, type BodySighting } from './EnemyBodies.js';

/** How far past the player's own reach to look for bodies worth avoiding. */
const ENEMY_SEARCH_MARGIN_TILES = 2;

/**
 * How fast a body's position stops being believed, in tiles per second.
 *
 * **The same admission the shots make**, and for a worse reason: a shot's path
 * is decided when it is fired, and a monster's is decided several times a second
 * by something nobody here can see. The velocity carried between sightings is
 * only right while it goes on doing what it was doing, so what this prices is
 * the turn, the stop and the knockback — not the walking, which is already
 * modelled.
 *
 * Modest on purpose: at a server tick of doubt it comes to about a third of a
 * tile, which is enough to keep a step out of a place that is merely *believed*
 * to be empty and far short of drawing a monster as a room-sized blob.
 */
const BODY_DOUBT_TILES_PER_SECOND = 1.6;

/**
 * How long that doubt is allowed to grow for.
 *
 * A little over one server tick. Past that the reading is not stale, it is
 * absent — and a body nothing has been said about for that long is one the
 * tracker is about to forget rather than one to draw a wider circle around.
 */
const MAX_BODY_DOUBT_MS = 250;

export class DodgeScene {
  readonly #catalog: DodgeCatalog;
  readonly #bodies = new EnemyBodies();
  /**
   * What the ground is, one tile at a time.
   *
   * **The planner asks about places, not tiles**, a few hundred of them per
   * plan — so the map is asked about each *tile* once and the body geometry is
   * redone exactly from wherever the character is. See {@link GroundCache} for
   * why the tile is the thing worth remembering and the reach is not.
   */
  readonly #ground = new GroundCache();
  /**
   * How fast the monsters near the player are moving.
   *
   * **What tells a monster the player walked up to from one that walked up to
   * the player**, and the two want opposite answers: the first is where they
   * meant to be, the second is the thing the keep-away distance exists to hold
   * off them. Nothing on the wire says it, so it is derived from consecutive
   * sightings — the same tracker, and the same reason, as auto-aim's lead.
   */
  readonly #motion = new MotionTracker();
  /**
   * What counts as a monster worth keeping away from.
   *
   * **The same question auto-aim asks, and the same answer**, because the two
   * lists are the same list: a thing not worth shooting at is a thing not worth
   * walking around. A wall in this game is an object with hit points and the
   * enemy flag; a brazier, a torch and a spawn anchor are `<Enemy/>` with no
   * health bar at all. Ranking those as monsters put a three-tile no-go circle
   * around every decoration in the room, and the live report was the plain one:
   * "I cannot get through there."
   *
   * **Except where the two questions come apart, which is both ways.** A boss in
   * an invulnerable phase cannot be shot and can still walk over somebody, so
   * `skipUntouchable` is off here where auto-aim offers it as a setting: what
   * this is about is contact and room, not damage. And a lever is the mirror of
   * it — worth every shot and worth no distance at all — which is why the
   * scenery is dropped outside these rules rather than inside them.
   */
  readonly #shootable: ShootableRules;
  /**
   * What is read back about one enemy, rewritten in place.
   *
   * The collection loop consumes it before asking again, so one record serves
   * every body rather than one per body per plan — twenty of them, fifty times a
   * second, for a position, a velocity and a size.
   */
  readonly #sighting = {
    x: 0,
    y: 0,
    velocityX: 0,
    velocityY: 0,
    halfTiles: ENEMY_CONTACT_HALF_TILES,
  };

  /** How far off a wall a *route* is planned, this plan. */
  #clearance = 0;
  /** How far off damaging ground a *route* is planned, this plan. */
  #hazardClearance = 0;
  #damagingMatters = true;
  /**
   * Whether geometry is allowed to refuse a step at all.
   *
   * Off, the search plans as though the room were empty and the game's own
   * collision is the only thing between the character and a wall — which is what
   * somebody wants when the map data is wrong, and nothing else.
   */
  #wallsMatter = true;
  #minding = false;
  /** How much room to insist on, from the middle of an ordinary monster. */
  #keepAwayTiles = 0;
  #onDamagingGround = false;
  /** The moment the plan is being made for, on the tracker's own clock. */
  #planAtMs = 0;
  /** When the last server tick was read, which is when any of this was true. */
  #sightedAtMs = 0;
  /** How much wider a body is drawn and avoided for the age of its sighting. */
  #bodyDoubtTiles = 0;

  /**
   * The map, as the search sees it.
   *
   * Built once and pointed at the current session, so a plan does not allocate
   * an adapter and three closures every twentieth of a second — and the search
   * asks these a few thousand times per plan, not a few hundred.
   */
  readonly world: DodgeGround;

  constructor(catalog: DodgeCatalog) {
    this.#catalog = catalog;
    this.#shootable = {
      skipUntouchable: false,
      skipObstacles: true,
      isObstacle: catalog.isObstacle,
      isInvincible: catalog.isInvincible,
    };
    this.world = {
      canStand: (x, y) => !this.#wallsMatter || this.#ground.canStand(x, y, this.#clearance),
      hazardGapTiles: (x, y) =>
        this.#damagingMatters ? this.#ground.hazardGap(x, y, this.#hazardClearance) : Infinity,
      crowdingAt: (x, y, aheadMs) => this.#bodies.crowdingAt(x, y, this.#keepAwayTiles, aheadMs),
      contactAt: (x, y, aheadMs) => this.#bodies.contactAt(x, y, aheadMs),
    };
  }

  /** The bodies the last plan collected, in the order it collected them. */
  get bodies(): EnemyBodies {
    return this.#bodies;
  }

  /** The room the last plan insisted on, or nothing while unminded. */
  get keepAwayTiles(): number | undefined {
    return this.#minding ? this.#keepAwayTiles : undefined;
  }

  /**
   * Whether the player is standing on ground that is costing them health.
   *
   * **The one tile the game charges for**, with no body and no margin around it.
   * Whether to *walk* somewhere is the wider question and is `world.isDamaging`;
   * answering this one with that wider test had the planner escaping ground
   * nobody was being hurt by.
   */
  get onDamagingGround(): boolean {
    return this.#onDamagingGround;
  }

  /**
   * Takes a sighting of everything in view. **Once per server tick.**
   *
   * **Sampling is packet work.** A position is only news when the server sends
   * one, so this is where sightings are taken: sampling on the planning
   * interval instead derives a velocity of nought from two readings of the same
   * tick, and then blends that nought into the estimate ten times before the
   * next tick arrives — which is a monster charging the player scored as one
   * standing still. Auto-aim reached the same conclusion first, and this is its
   * rule.
   */
  sight(session: SessionView, tickLengthMs?: number): void {
    const world = session.world;
    const now = world.gameTimeMs;
    // The tick's own length, because a velocity is a displacement per tick and
    // our clock only says when the packet carrying one turned up. See
    // `MotionTracker.tick`.
    this.#motion.tick(now, tickLengthMs);
    // Everything visible, not just what is in reach: a monster walking into
    // reach has to arrive with a velocity already known, or the first plan that
    // can see it is a plan that thinks it is standing still.
    for (const enemy of world.enemies()) {
      if (enemy.hp > 0) this.#motion.observe(enemy.objectId, enemy.x, enemy.y);
    }
    this.#sightedAtMs = now;
  }

  /** Looks at the fight the planner is about to search through. */
  observe(session: SessionView, controls: DodgeControls, planning: DodgeSettings): void {
    const self = session.self;
    const map = session.world;
    this.#ground.aim(map, self.x, self.y, map.gameTimeMs);

    this.#wallsMatter = controls.walls.avoid.get();
    // **The margin is dropped when the player is already inside it.** Demanding
    // clearance the current position does not have makes every step out of it
    // un-walkable too — including the ones that lead away — so the planner would
    // pin the player against the wall with the very setting meant to keep them
    // off it. The margin decides where not to go; it never decides where not to
    // leave.
    const wallClearance = controls.walls.clearanceTiles.get();
    this.#clearance =
      wallClearance > 0 && this.#ground.canStand(self.x, self.y, wallClearance) ? wallClearance : 0;

    this.#damagingMatters = controls.hazards.avoid.get();
    // **The margin around lava is not dropped, and that is what changed.** It
    // used to be, for the reason the wall's is: a margin that refuses every
    // square a player at the edge of a pool could step to is a margin holding
    // them there. But the answer is no longer a refusal — how far off the pool a
    // place is is a *distance* now, priced and preferred rather than demanded
    // (see `StepCost`), and only the pool itself is refused. A preference cannot
    // pin anybody, so the margin can say what it means at every distance, which
    // is the whole of what stops a dodge finishing with a heel in the lava.
    //
    // How far to look, therefore, rather than how far to insist on: past this
    // the answer is "nothing near", and it is what one query costs.
    this.#hazardClearance = Math.max(0, controls.hazards.clearanceTiles.get());
    this.#onDamagingGround =
      this.#damagingMatters && (map.tileAt(self.x, self.y)?.damaging ?? false);

    this.#minding = controls.spacing.mindMonsters.get();
    if (!this.#minding) {
      this.#bodies.clear();
      return;
    }

    this.#keepAwayTiles = Math.max(0, controls.tuning.keepAwayTiles.get());
    // Far enough to see the edge of the bubble as well as the edge of the walk:
    // a body the far end of a course would step into is one this has to have
    // collected, and one culled for being far away is one the planner walks
    // straight at.
    const reach = (planning.leadMs + planning.horizonMs) / 1000;
    const searchTiles = walkSpeedOf(session, controls) * reach + this.#keepAwayTiles;
    this.#planAtMs = map.gameTimeMs;
    // **Where a monster is, is not known — it is inferred, and the inference
    // ages.** Positions arrive five times a second and a plan is made fifty, so
    // between two ticks the only thing holding a body in place is a velocity
    // derived from the last two sightings — which is wrong the moment it turns,
    // stops or is knocked back. Widening the body by the age of the reading is
    // the same admission the shots make with their drift term, and it is what
    // stops the planner routing a step through a place it merely believes is
    // empty. It also widens the drawn circle, so the picture shows the body the
    // planner is actually avoiding rather than a claim it does not have.
    this.#bodyDoubtTiles =
      (BODY_DOUBT_TILES_PER_SECOND *
        Math.min(Math.max(map.gameTimeMs - this.#sightedAtMs, 0), MAX_BODY_DOUBT_MS)) /
      1000;
    this.#bodies.collect(
      map.enemies(),
      self.x,
      self.y,
      searchTiles + ENEMY_SEARCH_MARGIN_TILES,
      this.#read,
    );
  }

  /**
   * The area effects still worth walking out of.
   *
   * A generator rather than an array: the caller iterates once, and a fight with
   * a boss throwing bombs would otherwise build a fresh array fifty times a
   * second to hold three of them. Only the ones still on their way down — a
   * confirmed blast has landed and is history, and the ground it took is now the
   * safest on the screen.
   */
  *blastsIn(map: WorldView, controls: DodgeControls): Iterable<BlastView> {
    if (!controls.avoidBlasts.get()) return;
    for (const blast of map.blasts()) if (!blast.confirmed) yield blast;
  }

  /** Forgets the fight. A new connection is a new map full of strangers. */
  reset(): void {
    this.#bodies.clear();
    this.#motion.clear();
    this.#ground.clear();
    this.#minding = false;
  }

  /**
   * What one enemy is doing and how big it is, or nothing when it is not a body
   * to avoid.
   *
   * Bound once rather than built per plan: it closes over nothing that changes,
   * and the collection loop asks it of every enemy in reach.
   */
  readonly #read = (enemy: EntityView): BodySighting | undefined => {
    if (this.#catalog.isScenery(enemy.objectType)) return undefined;
    if (!isShootable(enemy, this.#shootable)) return undefined;
    // **A spawner passes every one of the culls above, and there is nothing
    // there.** It answers to `<Enemy/>`, it carries a health bar, it is neither
    // a wall nor a structure kill nor marked invincible, and the game draws it
    // as empty floor — so the live report was a room full of no-go circles
    // around nothing, in the middle of the fight the player was trying to walk
    // through. What gives it away is the pair: it declares no shot in the
    // game's own data, and it has never gone anywhere. Either alone is an
    // ordinary monster — a melee minion has no shots, and anything standing
    // still has not moved yet — so a body has to fail both before it is
    // dropped, and a fixture that ever takes a step becomes one from then on.
    if (!this.#catalog.hasShots(enemy.objectType) && !this.#motion.hasMoved(enemy.objectId)) {
      return undefined;
    }

    // **Where it is now, not where the last tick put it.** Sightings arrive five
    // times a second and a plan is made fifty, so the raw sample is a body
    // frozen up to a whole tick behind whatever is actually walking at the
    // player — which is the keep-away distance measuring the wrong place, and
    // the drawn circle sitting a tile behind the monster it belongs to. The same
    // reading, and the same reason, as auto-aim's lead.
    const seen = this.#motion.motionAt(enemy.objectId, this.#planAtMs);
    // Seen only once, which every monster is on the plan it comes into reach. A
    // body that is not known to be moving is treated as still, where it is.
    this.#sighting.x = seen?.x ?? enemy.x;
    this.#sighting.y = seen?.y ?? enemy.y;
    this.#sighting.velocityX = seen?.velocityX ?? 0;
    this.#sighting.velocityY = seen?.velocityY ?? 0;
    // Halved, because both sources state a width and the distance works in
    // half-extents. The ordinary body for anything neither can describe, widened
    // by however old the reading behind it is — see {@link BODY_DOUBT_TILES_PER_SECOND}.
    //
    // **The size the server sent for this one, ahead of the size of its kind.**
    // `<Size>` in the file is a default: three hundred and eighty of the game's
    // monsters roll their size per instance between a minimum and a maximum, and
    // a boss that grows mid-fight says so with this stat and nothing else. The
    // file's figure is the right answer only until the wire disagrees with it —
    // and against a randomised type it is the *largest* roll, so every ordinary
    // one of them carried a bubble sized for a monster it is not.
    const width =
      bodyTilesFromPercent(enemy.stat(StatType.Size)) ?? this.#catalog.bodyTiles(enemy.objectType);
    this.#sighting.halfTiles =
      (width === undefined ? ENEMY_CONTACT_HALF_TILES : width / 2) + this.#bodyDoubtTiles;
    return this.#sighting;
  };
}
