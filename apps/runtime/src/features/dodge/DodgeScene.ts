/**
 * The fight, assembled once per plan and handed to the controller.
 *
 * **The controller is arithmetic over positions and knows nothing about
 * sessions.** What it needs of the world is three questions — can a body stand
 * here, is this ground hurting, how far out of position is this place — and a
 * list of monsters to answer the third with. Building those from a session is a
 * job of its own: it involves the object catalog, the equipped weapon, two
 * clearance margins that are dropped when the player is already inside them, and
 * a motion tracker that turns five sightings a second into a velocity.
 *
 * **Everything here is allocated once.** The adapter, the band and the record a
 * body is read back through are all rewritten in place: a plan happens fifty
 * times a second, and a fresh closure per question was the single largest thing
 * this feature allocated.
 */

import type { BlastView, EntityView, SessionView, WorldView } from '@brownie/plugin-api';
import { isShootable, type ShootableRules } from '../autoaim/shootable.js';
import { MotionTracker } from '../../state/MotionTracker.js';
import type { DodgeSettings, DodgeWorld } from './DodgeController.js';
import {
  MAX_RANGE_TILES,
  MIN_RANGE_TILES,
  walkSpeedOf,
  type DodgeControls,
} from './dodgeControls.js';
import type { DodgeCatalog } from './dodgeInputs.js';
import { overDamagingGround } from './damagingGround.js';
import {
  ENEMY_CONTACT_HALF_TILES,
  EnemyBodies,
  OUT_OF_RANGE_CAP_TILES,
  type BodySighting,
  type StandoffBand,
} from './EnemyBodies.js';

/** How far past the player's own reach to look for bodies worth avoiding. */
const ENEMY_SEARCH_MARGIN_TILES = 2;

export class DodgeScene {
  readonly #catalog: DodgeCatalog;
  readonly #bodies = new EnemyBodies();
  /**
   * How fast the monsters near the player are moving.
   *
   * **What tells a monster the player walked up to from one that walked up to
   * the player**, and the two want opposite answers: the first is where they
   * meant to be, the second is the thing the near edge of the band exists to
   * keep off them. Nothing on the wire says it, so it is derived from
   * consecutive sightings — the same tracker, and the same reason, as auto-aim's
   * lead.
   */
  readonly #motion = new MotionTracker();
  /**
   * The distances to fight between, rewritten in place each plan.
   *
   * One object for the life of the plugin rather than one per plan: it is read a
   * hundred times a plan and fifty plans a second, and the two numbers in it
   * change only when the player swaps a weapon or drags a slider.
   */
  readonly #band = { keepAwayTiles: 0, stayWithinTiles: Infinity };
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
   * the band is about is contact and room, not damage. And a lever is the mirror
   * of it — worth every shot and worth no distance at all — which is why the
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

  /** The map the adapter below is currently pointed at. */
  #map: WorldView | undefined;
  #clearance = 0;
  /** How far off damaging ground a *course* is planned, this plan. */
  #hazardClearance = 0;
  #damagingMatters = true;
  #minding = false;
  #onDamagingGround = false;
  /** The moment the plan is being made for, on the tracker's own clock. */
  #planAtMs = 0;

  /**
   * The map, as the controller sees it.
   *
   * Built once and pointed at the current session, so a plan does not allocate
   * an adapter and three closures every twentieth of a second.
   */
  readonly world: DodgeWorld;

  constructor(catalog: DodgeCatalog) {
    this.#catalog = catalog;
    this.#shootable = {
      skipUntouchable: false,
      skipObstacles: true,
      isObstacle: catalog.isObstacle,
      isInvincible: catalog.isInvincible,
    };
    this.world = {
      canStand: (x, y) => this.#map?.canStandAt(x, y, this.#clearance) ?? false,
      isDamaging: (x, y) =>
        this.#damagingMatters &&
        this.#map !== undefined &&
        overDamagingGround(this.#map, x, y, this.#hazardClearance),
      standoffAt: (x, y, aheadMs) => this.#bodies.standoffAt(x, y, this.#band, aheadMs),
    };
  }

  /** The bodies the last plan collected, in the order it collected them. */
  get bodies(): EnemyBodies {
    return this.#bodies;
  }

  /** The distances the last plan fought between, or nothing while unminded. */
  get band(): StandoffBand | undefined {
    return this.#minding ? this.#band : undefined;
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
  sight(session: SessionView): void {
    const world = session.world;
    const now = world.gameTimeMs;
    // Everything visible, not just what is in reach: a monster walking into
    // reach has to arrive with a velocity already known, or the first plan that
    // can see it is a plan that thinks it is standing still.
    for (const enemy of world.enemies()) {
      if (enemy.hp > 0) this.#motion.observe(enemy.objectId, enemy.x, enemy.y, now);
    }
    this.#motion.prune(now);
  }

  /** Looks at the fight the controller is about to plan against. */
  observe(session: SessionView, controls: DodgeControls, planning: DodgeSettings): void {
    const self = session.self;
    const map = session.world;
    this.#map = map;

    // **The margin is dropped when the player is already inside it.** Demanding
    // clearance the current position does not have makes every step out of it
    // un-walkable too — including the ones that lead away — so the planner would
    // pin the player against the wall with the very setting meant to keep them
    // off it. The margin decides where not to go; it never decides where not to
    // leave.
    const wallClearance = controls.walls.clearanceTiles.get();
    this.#clearance =
      wallClearance > 0 && map.canStandAt(self.x, self.y, wallClearance) ? wallClearance : 0;

    this.#damagingMatters = controls.hazards.avoid.get();
    // **And the same rule for the margin around lava**, for the same reason: a
    // player who has chosen to fight at the edge of a pool is inside it, and a
    // margin that refuses every square they could step to is a margin that holds
    // them there. Measured against the body alone, so being inside the *margin*
    // drops it and being inside the *pool* is a different question.
    const hazardClearance = controls.hazards.clearanceTiles.get();
    this.#hazardClearance =
      hazardClearance > 0 && !overDamagingGround(map, self.x, self.y, hazardClearance)
        ? hazardClearance
        : 0;
    this.#onDamagingGround =
      this.#damagingMatters && (map.tileAt(self.x, self.y)?.damaging ?? false);

    this.#minding = controls.spacing.mindMonsters.get();
    if (!this.#minding) {
      this.#bodies.clear();
      return;
    }

    this.#updateBand(session, controls);
    // Far enough to see the edge of the band as well as the edge of the walk: a
    // monster just outside weapon range is the one thing this is meant to
    // notice, and one culled for being far away is one the planner reads as
    // "nobody here" and drifts away from.
    const reach = (planning.leadMs + planning.horizonMs) / 1000;
    const searchTiles = Math.max(
      walkSpeedOf(session, controls) * reach,
      this.#band.stayWithinTiles === Infinity
        ? 0
        : this.#band.stayWithinTiles + OUT_OF_RANGE_CAP_TILES,
    );
    this.#planAtMs = map.gameTimeMs;
    this.#bodies.collect(
      map.enemies(),
      self.x,
      self.y,
      searchTiles + ENEMY_SEARCH_MARGIN_TILES,
      this.#read,
      this.#catalog.aimTarget(),
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
    this.#map = undefined;
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

    // **Where it is now, not where the last tick put it.** Sightings arrive five
    // times a second and a plan is made fifty, so the raw sample is a body
    // frozen up to a whole tick behind whatever is actually walking at the
    // player — which is the near edge of the band measuring the wrong place, and
    // the drawn circle sitting a tile behind the monster it belongs to. The same
    // reading, and the same reason, as auto-aim's lead.
    const seen = this.#motion.motionAt(enemy.objectId, this.#planAtMs);
    // Seen only once, which every monster is on the plan it comes into reach. A
    // body that is not known to be moving is treated as still, where it is.
    this.#sighting.x = seen?.x ?? enemy.x;
    this.#sighting.y = seen?.y ?? enemy.y;
    this.#sighting.velocityX = seen?.velocityX ?? 0;
    this.#sighting.velocityY = seen?.velocityY ?? 0;
    // Halved, because the catalog states a width and the band works in
    // half-extents. The ordinary body for anything it cannot describe.
    const width = this.#catalog.bodyTiles(enemy.objectType);
    this.#sighting.halfTiles = width === undefined ? ENEMY_CONTACT_HALF_TILES : width / 2;
    return this.#sighting;
  };

  /**
   * The distances this character should be fighting between.
   *
   * The near edge is a setting; the far edge is the weapon's own reach, cut to
   * leave a little in hand. Where the two cross — a melee weapon against
   * something enormous — the near edge wins, but that is settled where the
   * bodies are known rather than here: how near is too near depends on how big
   * the thing is, and this end of it knows only the weapon. See
   * `EnemyBodies.standoffAt`.
   */
  #updateBand(session: SessionView, controls: DodgeControls): void {
    this.#band.keepAwayTiles = Math.max(0, controls.tuning.keepAwayTiles.get());
    if (!controls.spacing.stayInRange.get()) {
      this.#band.stayWithinTiles = Infinity;
      return;
    }
    const reach = this.#catalog.weaponRange(session.self.weaponType);
    const usable = Math.min(
      MAX_RANGE_TILES,
      Math.max(MIN_RANGE_TILES, reach ?? controls.spacing.fallbackRangeTiles.get()),
    );
    this.#band.stayWithinTiles = (usable * controls.spacing.rangePercent.get()) / 100;
  }
}
