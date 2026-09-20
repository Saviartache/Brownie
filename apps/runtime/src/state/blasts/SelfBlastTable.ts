/**
 * Enemy types that blast themselves, learned from the game's own data.
 *
 * **Some attacks give a dodge nothing to work with.** A bomb is telegraphed
 * where it will land; a bullet is visible the whole way; a blast that starts
 * *on the enemy* with no throw and no landing circle becomes dangerous the
 * same instant it becomes visible, and by then the damage is already decided.
 * No planner can react to that, and the reference implementation's answer is
 * the only one there is: do not stand there in the first place. What that takes
 * is a radius per enemy type — every living enemy of a learned type carries a
 * disc around it the dodge treats as ground that hurts.
 *
 * **Learned, not named.** The reference shipped one hard-coded entry for the
 * Mushroom Brawler and then replaced the list with the idea: an `AOE` whose
 * centre sits on a living enemy of the packet's own `originType`, with no
 * telegraph near it, is a self blast — and any enemy that attacks that way
 * teaches its radius the first time it is seen doing so. Naming each one does
 * not scale past the monsters somebody happened to meet.
 *
 * A cache and not state, like `BlastRadiusTable`: everything here degrades to
 * "no keep-out" when it is missing, corrupt, or wrong.
 */

/** The version stamped into the serialised form. */
const FORMAT_VERSION = 1;

/**
 * How far beyond the observed blast edge to stay, in tiles.
 *
 * The same figure `Blasts` holds blasts to (`BLAST_MARGIN_TILES`), kept here so
 * the state layer does not depend on the feature. Where the player *is* is only
 * as good as the latency the whole dodge already prices, and a blast is
 * all-or-nothing in a way a bullet is not.
 */
export const SELF_BLAST_MARGIN_TILES = 0.35;

/** The least radius worth a keep-out. Below this the body already covers it. */
export const MIN_SELF_BLAST_TILES = 0.3;

/**
 * The most a learned radius is believed, in tiles.
 *
 * A sanity bound rather than a measurement: the radius is a float off the wire,
 * and a decode that drifts after a patch must not be able to wall off a room.
 */
export const MAX_SELF_BLAST_TILES = 6;

/**
 * How near the blast's centre has to be to the enemy for the enemy to be the
 * one who set it off, in tiles.
 *
 * A full tile rather than a point-match, because the enemy and the packet are
 * seen on different ticks and a walking enemy is a tile off its own last
 * sighting at server speed.
 */
export const SELF_BLAST_CENTRE_TILES = 1;

/**
 * How near a telegraph has to be to a landing for the landing to count as
 * warned, beyond the blast's own reach, in tiles.
 */
export const TELEGRAPH_REACH_TILES = 1;

/** The most types kept. A bound on a file that would otherwise grow forever. */
const MAX_TYPES = 256;

/** What one enemy type has been seen doing to itself. */
export interface SelfBlastFacts {
  /** The widest blast observed centred on this type, in tiles. */
  readonly radiusTiles: number;
  /** How many blasts the radius came from. */
  readonly seen: number;
}

/** What the classifier needs to know about one enemy on the field. */
export interface SelfBlastEnemy {
  readonly objectType: number;
  readonly x: number;
  readonly y: number;
  /** Only a living enemy can be the one who set its own blast off. */
  readonly hp: number;
}

/**
 * Whether a detonation is a self blast: centred on a living enemy of its own
 * origin type.
 *
 * **The enemy match throws away bombs aimed *at* somebody** — a blast centred
 * on the player or on another monster is aimed fire, not a self blast, and
 * learning it would put a keep-out on an enemy that never hurt anybody standing
 * next to it. Fire that was warned about is the caller's half of the question:
 * only `BlastStore` holds the telegraphs, so it answers that there — see
 * `BlastStore.announcedNear` — and this stays a pure question about enemies.
 */
export function isSelfBlast(
  x: number,
  y: number,
  originType: number,
  enemies: Iterable<SelfBlastEnemy>,
): boolean {
  if (!(originType > 0)) return false;
  for (const enemy of enemies) {
    if (enemy.objectType !== originType || !(enemy.hp > 0)) continue;
    if (Math.hypot(enemy.x - x, enemy.y - y) <= SELF_BLAST_CENTRE_TILES) return true;
  }
  return false;
}

export class SelfBlastTable {
  readonly #facts = new Map<number, { radiusTiles: number; seen: number }>();

  get size(): number {
    return this.#facts.size;
  }

  /** What this type has been seen blasting itself with, or nothing yet. */
  lookUp(objectType: number): SelfBlastFacts | undefined {
    return this.#facts.get(objectType);
  }

  /**
   * Records a self blast's observed radius.
   *
   * **Widened, never narrowed.** Under a key collision — or a boss with two
   * area attacks — the table then behaves like the larger of the two, which is
   * the side of the mistake that costs ground and never health. Nonsense is
   * refused rather than clamped in: a radius off the wire has to read as one.
   *
   * @returns whether the table changed, so the caller can say so once.
   */
  learn(objectType: number, radiusTiles: number): boolean {
    if (!(objectType > 0)) return false;
    if (!(radiusTiles > 0) || radiusTiles > MAX_SELF_BLAST_TILES) return false;

    const known = this.#facts.get(objectType);
    if (known === undefined) {
      if (this.#facts.size >= MAX_TYPES) return false;
      this.#facts.set(objectType, {
        radiusTiles: Math.max(radiusTiles, MIN_SELF_BLAST_TILES),
        seen: 1,
      });
      return true;
    }
    known.seen += 1;
    if (radiusTiles <= known.radiusTiles) return false;
    known.radiusTiles = radiusTiles;
    return true;
  }

  /** What to write to disk. Plain data, so the file is readable by a person. */
  serialise(): unknown {
    return {
      version: FORMAT_VERSION,
      types: [...this.#facts].map(([objectType, facts]) => ({
        objectType,
        radiusTiles: facts.radiusTiles,
        seen: facts.seen,
      })),
    };
  }

  /**
   * Reads a serialised table, replacing whatever this one held.
   *
   * Every field is checked, because the file is data this process wrote *last*
   * time and may have been hand-edited since. An entry that does not read as a
   * measurement is skipped rather than refusing the file.
   *
   * @returns how many entries were taken.
   */
  restore(raw: unknown): number {
    this.#facts.clear();
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return 0;
    const document = raw as Record<string, unknown>;
    if (document['version'] !== FORMAT_VERSION) return 0;
    const types = document['types'];
    if (!Array.isArray(types)) return 0;

    for (const entry of types) {
      if (typeof entry !== 'object' || entry === null) continue;
      const record = entry as Record<string, unknown>;
      const objectType = numberOf(record, 'objectType');
      const radiusTiles = numberOf(record, 'radiusTiles');
      if (objectType === undefined || !(objectType > 0)) continue;
      if (radiusTiles === undefined || !(radiusTiles > 0)) continue;
      if (radiusTiles > MAX_SELF_BLAST_TILES) continue;
      if (this.#facts.size >= MAX_TYPES) break;
      const seen = numberOf(record, 'seen');
      this.#facts.set(objectType, {
        radiusTiles: Math.max(radiusTiles, MIN_SELF_BLAST_TILES),
        seen: seen !== undefined && seen > 0 ? Math.floor(seen) : 1,
      });
    }
    return this.#facts.size;
  }

  clear(): void {
    this.#facts.clear();
  }
}

function numberOf(record: Readonly<Record<string, unknown>>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
