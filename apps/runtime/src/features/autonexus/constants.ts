/**
 * The numbers auto-nexus runs on, gathered in one place.
 *
 * Most came off the reference implementation, which took them from the game or
 * from MultiTool's `Class89`. Keeping them here rather than scattered as inline
 * literals is what makes them auditable against a future game build: a patch
 * that moves one of these is a one-line change with a name attached, not a hunt
 * through the plugin for a bare `0.1`.
 */

/**
 * A hit deals at least this share of its raw damage, whatever the defence.
 *
 * The client's own damage floor, as the reference carries it — it is what keeps
 * an armoured character killable, so auto-nexus must assume it too.
 */
export const MIN_DAMAGE_MULTIPLIER = 0.1;

/** Defence is multiplied by this while the Armored effect is active (+50%). */
export const ARMORED_DEFENSE_MULTIPLIER = 1.5;

/**
 * Upper bound on a volley's shot count before it is treated as one shot.
 *
 * `numShots` is a byte off the wire; 0 and 255 are its "unset" sentinels, and
 * anything absurdly large is a malformed packet, not a real fan of bullets.
 */
export const MAX_VOLLEY_SHOTS = 128;

/** Default escape threshold, as a percentage of maximum health. */
export const DEFAULT_THRESHOLD_PERCENT = 25;

/** Default radius within which a freshly spawned shot triggers an escape. */
export const DEFAULT_CLOSE_SPAWN_TILES = 0.15;

/** Assumed damage of a shot never announced by an `ENEMYSHOOT` we saw. */
export const UNKNOWN_SHOT_DAMAGE = 200;

/**
 * Assumed damage of a damaging tile.
 *
 * This layer sees that a tile *is* damaging, not by how much — the amount lives
 * in game data the plugin surface does not expose. Deliberately not small:
 * under-counting a tile is the unsafe direction.
 */
export const GROUND_DAMAGE_ESTIMATE = 50;

/** Area effects older than this are assumed to have already resolved. */
export const AOE_MAX_AGE_MS = 1500;

/** A tracked shot older than this is assumed gone, bounding the bullet log. */
export const BULLET_MAX_AGE_MS = 12_000;

/** Simulated health snaps to the server's value only past this much drift. */
export const HP_DRIFT_SNAP = 30;

/** Ticks to wait before allowing a snap, while the stat block settles. */
export const HP_SYNC_WARMUP_TICKS = 5;

/** Cap on pending area effects, so a burst cannot grow the list without limit. */
export const MAX_PENDING_AOES = 32;

/** Maps where a hit cannot land, so auto-nexus should never fire. */
export const SAFE_ZONE_MAPS: ReadonlySet<string> = new Set(
  [
    'Nexus',
    'Vault',
    'Guild Hall',
    'Cloth Bazaar',
    'Pet Yard',
    'Daily Quest Room',
    'Daily Login Room',
  ].map((name) => name.toLowerCase()),
);
