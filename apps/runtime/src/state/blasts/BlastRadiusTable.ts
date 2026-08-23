/**
 * How wide a blast turned out to be, remembered from the ones that landed.
 *
 * **The telegraph says where and when; it never says how wide.** `BlastStore`
 * therefore planned every announced blast at {@link DEFAULT_BLAST_RADIUS_TILES},
 * and the `AOE` that carries the real radius only ever updated the record of a
 * blast that had already gone off — too late for *that* bomb and, until this
 * existed, too late for the next one from the same enemy as well.
 *
 * The measurement is reusable because the ability is: an enemy that threw a
 * three-tile bomb throws three-tile bombs. So a detonation that confirms a
 * prediction teaches two numbers — the radius the `AOE` states, and the flight
 * time the pairing gives away for free — and the next telegraph from the same
 * key is planned around them instead of around a guess.
 *
 * **Keyed on the thrower's object type and the effect's colour**, which is
 * `rotmg-ascii`'s `AoeStore` key and its reasoning: the object type identifies
 * the *enemy*, not the ability, so an enemy with two different area attacks
 * would otherwise thrash one shared radius between them. Colour reduces that
 * collision; it does not eliminate it, which is why {@link BlastFacts.seen} is
 * kept and why the radius is the widest measured rather than the latest — under
 * a collision the table then behaves like the larger of the two abilities, which
 * is the side of the mistake that costs nothing but ground.
 *
 * **The key is taken from the telegraph, not from the detonation.** The `AOE`
 * carries `originType` and `color` of its own, and they are the obvious thing to
 * key on until you notice that nothing ever looks a blast up by them: the lookup
 * happens at `SHOWEFFECT` time, from the thrower's object type and the effect's
 * colour, and a table keyed on anything else is a table that can never be read.
 * Where the two disagree the table simply stays empty and the default stands.
 *
 * A cache and not state: everything here degrades to the previous behaviour when
 * it is missing, corrupt, or wrong.
 */

/** The version stamped into the serialised form. */
const FORMAT_VERSION = 1;

/**
 * The widest a measured radius is believed, in tiles.
 *
 * A sanity bound rather than a measurement: the field is a float off the wire,
 * and a decode that drifts after a patch should cost a rejected sample rather
 * than a planner that refuses half the map. Comfortably above the largest area
 * effect in the game.
 */
export const MAX_BLAST_RADIUS_TILES = 15;

/**
 * The longest a measured flight time is believed, in milliseconds.
 *
 * The same bound `BlastStore` applies to a telegraph's own duration, and for the
 * same reason — see `MAX_TELEGRAPH_MS`. Kept here as its own constant so this
 * file does not depend on the store that fills it.
 */
export const MAX_BLAST_FLIGHT_MS = 8000;

/**
 * The most keys kept.
 *
 * A realm's worth of throwing enemies is tens; this is a bound on a file that
 * would otherwise grow for the life of the process. Past it the least-confirmed
 * key makes way, so a patch that scrambles the encoding cannot freeze the table
 * on whatever it happened to see first.
 */
const MAX_KEYS = 512;

/** What a key's blasts have been measured at. */
export interface BlastFacts {
  /** The widest detonation seen for this key, in tiles. */
  readonly radiusTiles: number;
  /**
   * The mean gap between telegraph and detonation, in milliseconds, or nought
   * when none has been timed.
   *
   * **Counted apart from the radius, because they are two measurements and one
   * of them often is not there.** A detonation always states a radius; the gap
   * only exists when the telegraph that predicted it was seen, which is most of
   * the time and not all of it. Folding a missing gap into the mean as a nought
   * would drag every learned flight time towards zero, and rejecting the whole
   * sighting over it would throw away the radius — which is the number the
   * planner actually reads.
   */
  readonly flightMs: number;
  /** How many detonations the radius came from. */
  readonly seen: number;
  /** How many of those also gave a flight time. */
  readonly timed: number;
}

interface MeasuredBlast {
  radiusTiles: number;
  flightMs: number;
  seen: number;
  timed: number;
}

export class BlastRadiusTable {
  readonly #facts = new Map<string, MeasuredBlast>();

  get size(): number {
    return this.#facts.size;
  }

  /** What this key's blasts have been measured at, or nothing yet. */
  lookUp(originType: number, color: number): BlastFacts | undefined {
    return this.#facts.get(keyOf(originType, color));
  }

  /**
   * Records what a detonation actually was.
   *
   * Nonsense is refused rather than averaged in: a radius or a flight time
   * outside the bounds above is a field this build read wrongly, and one of
   * those must not be able to teach the planner to walk into bombs. A radius
   * that does not read as one costs the whole sighting; a flight time that does
   * not costs only itself.
   *
   * @param flightMs The gap between the telegraph and this detonation. Nought
   *   or nonsense for a landing no telegraph was timed against.
   */
  learn(originType: number, color: number, radiusTiles: number, flightMs: number): void {
    if (!(radiusTiles > 0) || radiusTiles > MAX_BLAST_RADIUS_TILES) return;
    const timed = flightMs > 0 && flightMs <= MAX_BLAST_FLIGHT_MS;

    const key = keyOf(originType, color);
    const known = this.#facts.get(key);
    if (known === undefined) {
      if (this.#facts.size >= MAX_KEYS) this.#evictLeastSeen();
      this.#facts.set(key, {
        radiusTiles,
        flightMs: timed ? flightMs : 0,
        seen: 1,
        timed: timed ? 1 : 0,
      });
      return;
    }

    known.seen += 1;
    if (radiusTiles > known.radiusTiles) known.radiusTiles = radiusTiles;
    if (!timed) return;
    known.timed += 1;
    // A running mean, so one long-delayed packet cannot rewrite a figure a
    // dozen clean sightings agreed on.
    known.flightMs += (flightMs - known.flightMs) / known.timed;
  }

  /** What to write to disk. Plain data, so the file is readable by a person. */
  serialise(): unknown {
    return {
      version: FORMAT_VERSION,
      blasts: [...this.#facts].map(([key, facts]) => {
        const [originType, color] = splitKey(key);
        return {
          originType,
          color,
          radiusTiles: facts.radiusTiles,
          flightMs: facts.flightMs,
          seen: facts.seen,
          timed: facts.timed,
        };
      }),
    };
  }

  /**
   * Reads a serialised table, replacing whatever this one held.
   *
   * Every field is checked, because the file is data this process wrote *last*
   * time and may have been hand-edited since. Anything that does not read as a
   * measurement is skipped rather than refused wholesale: half a usable cache is
   * still better than a guess, and what is dropped costs one default.
   *
   * @returns how many entries were taken, so the caller can say so in one line.
   */
  restore(raw: unknown): number {
    this.#facts.clear();
    const document = asRecord(raw);
    if (document['version'] !== FORMAT_VERSION) return 0;
    const blasts = document['blasts'];
    if (!Array.isArray(blasts)) return 0;

    for (const entry of blasts) {
      const record = asRecord(entry);
      const originType = numberOf(record, 'originType');
      const color = numberOf(record, 'color');
      const radiusTiles = numberOf(record, 'radiusTiles');
      const flightMs = numberOf(record, 'flightMs') ?? 0;
      const seen = numberOf(record, 'seen');
      const timed = numberOf(record, 'timed');
      if (originType === undefined || color === undefined) continue;
      if (radiusTiles === undefined) continue;
      if (!(radiusTiles > 0) || radiusTiles > MAX_BLAST_RADIUS_TILES) continue;
      if (flightMs < 0 || flightMs > MAX_BLAST_FLIGHT_MS) continue;
      if (this.#facts.size >= MAX_KEYS) break;

      this.#facts.set(keyOf(originType, color), {
        radiusTiles,
        flightMs,
        seen: seen !== undefined && seen > 0 ? Math.floor(seen) : 1,
        timed: timed !== undefined && timed > 0 ? Math.floor(timed) : flightMs > 0 ? 1 : 0,
      });
    }
    return this.#facts.size;
  }

  clear(): void {
    this.#facts.clear();
  }

  /** Makes room by dropping whatever the fewest detonations agreed on. */
  #evictLeastSeen(): void {
    let victim: string | undefined;
    let fewest = Infinity;
    for (const [key, facts] of this.#facts) {
      if (facts.seen >= fewest) continue;
      victim = key;
      fewest = facts.seen;
    }
    if (victim !== undefined) this.#facts.delete(victim);
  }
}

/**
 * The two halves as one key.
 *
 * A string rather than a packed number: the colour is a full 32-bit field and
 * the object type is sixteen bits, so there is no exact numeric packing, and
 * this is asked once per telegraph rather than in any loop.
 */
function keyOf(originType: number, color: number): string {
  return `${String(originType)}:${String(color)}`;
}

function splitKey(key: string): [number, number] {
  const separator = key.indexOf(':');
  return [Number(key.slice(0, separator)), Number(key.slice(separator + 1))];
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function numberOf(record: Readonly<Record<string, unknown>>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
