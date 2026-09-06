/**
 * What shape the attack is, read off the volleys as they are announced.
 *
 * **A dodge that only looks at bullets is always one volley behind.** Everything
 * a boss does in this game is periodic: a ring every four hundred milliseconds,
 * eight arms turning six degrees a volley, a fan alternating half a gap either
 * side of the last one. The bullets in the air are the *consequence* of that,
 * and a planner that reads only them re-derives the same geometry from scratch
 * fifty times a second and still cannot say where the next wave will be — which
 * is the difference between threading a spiral and being caught by it.
 *
 * **`ENEMYSHOOT` is the whole input, and it is exactly the right one.** One
 * packet is one volley: an origin, a base angle, how many shots and the angle
 * between them. Three of those from the same monster describe the pattern
 * completely — the arm count and spacing come out of a single packet, and the
 * rotation, the period and the alternation come out of the differences between
 * consecutive ones. Reconstructing any of that from the shots in flight means
 * clustering a thousand points, which is both slower and worse.
 *
 * **What this is not is a decision.** Nothing here refuses a place or chooses a
 * step. It says "that is an eight-armed spiral turning anticlockwise at forty
 * degrees a second, and I am confident about it", and `PocketLock` turns that
 * into somewhere worth aiming for; the danger field still has the final word on
 * whether a step is safe. Recognition informs the sampling and never overrides
 * the geometry — which is what keeps a misread pattern a wasted candidate rather
 * than a hit.
 *
 * **Fixed capacity, no allocation.** A realm can have a hundred things shooting;
 * what a dodge can act on is the handful near the player, so the table holds a
 * bounded number of owners and evicts the one heard from longest ago. Every
 * reading is a slot in a typed array, and the one handed out is rewritten in
 * place.
 */

/** One `ENEMYSHOOT`, as this needs it. */
export interface Volley {
  readonly ownerId: number;
  /** On the world clock. */
  readonly atMs: number;
  readonly x: number;
  readonly y: number;
  /** The first shot's heading, in radians. */
  readonly angle: number;
  /** How many shots went out. */
  readonly count: number;
  /** Radians between consecutive shots of the volley. */
  readonly angleStep: number;
}

/** The shape of one monster's attack. */
export const PatternKind = {
  /** One shot, or too few volleys to say anything. Aimed fire, usually. */
  Single: 0,
  /** A narrow spread from one place: a shotgun. */
  Cone: 1,
  /** A wider arc that does not close: a fan, or a wall of fire. */
  Fan: 2,
  /** Shots all the way round. The only way out of one is between waves. */
  Ring: 3,
} as const;

export type PatternKind = (typeof PatternKind)[keyof typeof PatternKind];

/** What the recogniser has worked out about one monster. Rewritten in place. */
export interface PatternReading {
  readonly ownerId: number;
  readonly kind: PatternKind;
  /** Where the volleys are coming from, and how fast that is moving. */
  readonly originX: number;
  readonly originY: number;
  readonly originVelocityX: number;
  readonly originVelocityY: number;
  /** How many shots one volley has. */
  readonly arms: number;
  /**
   * Radians between neighbouring arms.
   *
   * For a ring this is the gap a player has to fit through; for a fan it is the
   * spacing the volley declares. Always positive.
   */
  readonly spacingRadians: number;
  /**
   * How fast the whole pattern turns, in radians a second. Signed.
   *
   * Nought for a pattern that fires in the same place every time. Its sign is
   * the direction: positive is the way angles increase, which on this map is
   * anticlockwise.
   */
  readonly omegaRadiansPerSecond: number;
  /** How long between volleys, in milliseconds. */
  readonly periodMs: number;
  /** The newest volley's base angle and when it went out. */
  readonly baseAngle: number;
  readonly baseAtMs: number;
  /**
   * Whether consecutive volleys land half a gap either side of each other.
   *
   * **The checkerboard, and it is worth naming separately from a rotation.** A
   * pattern that alternates has no net drift, so a planner that averaged the two
   * offsets would read it as standing still and stand in the second wave. What
   * it actually wants is a step of half a gap, every period, back and forth —
   * which is the smallest movement in the whole feature and the one this exists
   * to find.
   */
  readonly alternating: boolean;
  /**
   * How much of this to believe, from nought to one.
   *
   * Earned by consecutive volleys agreeing: one says nothing, two is a guess,
   * and four in a row that agree on the count, the spacing and the turn is a
   * pattern worth planning several volleys of.
   */
  readonly confidence: number;
}

/** How many monsters are tracked at once. */
const MAX_OWNERS = 24;

/** How many volleys of each are remembered. */
const HISTORY = 8;

/**
 * How long a monster is remembered after its last volley.
 *
 * A little over the longest period worth calling periodic. Past it the next
 * volley is a fresh start rather than the continuation of something.
 */
const FORGET_AFTER_MS = 2500;

/** Volleys further apart than this are not two volleys of one pattern. */
const MAX_PERIOD_MS = 1500;

/** And closer together than this are one volley split across two packets. */
const MIN_PERIOD_MS = 20;

/** How near the full circle a fan has to reach to be called a ring. */
const RING_SLACK_RADIANS = 0.35;

/** Wider than this and a spread is a fan rather than a shotgun. */
const CONE_SPAN_RADIANS = Math.PI / 2;

/**
 * How much two turns may differ and still be called the same turn, in radians.
 *
 * The server states angles to a hundredth of a radian at best and a monster's
 * own facing wobbles, so exact agreement is not on offer. About a degree and a
 * half, which is well inside the narrowest arm spacing the game uses.
 */
const TURN_SLACK_RADIANS = 0.026;

/** How far apart two origins can be and still be the same emitter, in tiles. */
const SAME_ORIGIN_TILES = 3;

/** How many agreeing gaps earn full confidence. */
const CONFIDENT_GAPS = 4;

export class AttackPatterns {
  /** One row per tracked owner. */
  readonly #ownerId = new Int32Array(MAX_OWNERS);
  readonly #seenAtMs = new Float64Array(MAX_OWNERS);
  readonly #live = new Uint8Array(MAX_OWNERS);
  /** Where the ring buffer's next volley goes, and how many are in it. */
  readonly #head = new Int32Array(MAX_OWNERS);
  readonly #filled = new Int32Array(MAX_OWNERS);

  /** The volleys themselves: `owner * HISTORY + slot`. */
  readonly #atMs = new Float64Array(MAX_OWNERS * HISTORY);
  readonly #x = new Float64Array(MAX_OWNERS * HISTORY);
  readonly #y = new Float64Array(MAX_OWNERS * HISTORY);
  readonly #angle = new Float64Array(MAX_OWNERS * HISTORY);
  readonly #count = new Int32Array(MAX_OWNERS * HISTORY);
  readonly #step = new Float64Array(MAX_OWNERS * HISTORY);

  /** Handed out by {@link readingOf}, rewritten on every call. */
  readonly #reading = {
    ownerId: 0,
    kind: PatternKind.Single as PatternKind,
    originX: 0,
    originY: 0,
    originVelocityX: 0,
    originVelocityY: 0,
    arms: 1,
    spacingRadians: 0,
    omegaRadiansPerSecond: 0,
    periodMs: 0,
    baseAngle: 0,
    baseAtMs: 0,
    alternating: false,
    confidence: 0,
  };

  /** Forgets everything. A new map is a room full of strangers. */
  clear(): void {
    this.#live.fill(0);
  }

  /**
   * Records one volley.
   *
   * **Called from the packet handler, not from a plan.** A volley is an event
   * and the whole recogniser is built on the differences between consecutive
   * ones; sampling on the planning interval instead would see the same volley
   * ten times and none of the gaps.
   */
  observe(volley: Volley): void {
    if (!Number.isFinite(volley.angle) || !Number.isFinite(volley.atMs)) return;
    const owner = this.#slotFor(volley.ownerId, volley.atMs);
    const previous = this.#latest(owner);
    // **A volley from somewhere else is a new pattern, not the next step of the
    // old one.** A monster that walks across the room while it fires would
    // otherwise read as a spiral whose origin is wherever it happened to be,
    // and a monster that teleports would read as one turning very fast indeed.
    // Its own movement is carried in the reading instead.
    if (previous >= 0) {
      const gap = volley.atMs - (this.#atMs[previous] ?? 0);
      const moved = Math.hypot(
        volley.x - (this.#x[previous] ?? 0),
        volley.y - (this.#y[previous] ?? 0),
      );
      if (gap > MAX_PERIOD_MS || gap < 0 || moved > SAME_ORIGIN_TILES) {
        this.#filled[owner] = 0;
        this.#head[owner] = 0;
      } else if (gap < MIN_PERIOD_MS && (this.#count[previous] ?? 0) === volley.count) {
        // One volley the server split across two packets — same instant, same
        // shape. Counting it as a second volley makes the period nought and the
        // turn infinite.
        return;
      }
    }

    const slot = owner * HISTORY + (this.#head[owner] ?? 0);
    this.#atMs[slot] = volley.atMs;
    this.#x[slot] = volley.x;
    this.#y[slot] = volley.y;
    this.#angle[slot] = volley.angle;
    this.#count[slot] = Math.max(1, volley.count);
    this.#step[slot] = volley.angleStep;
    this.#head[owner] = ((this.#head[owner] ?? 0) + 1) % HISTORY;
    this.#filled[owner] = Math.min(HISTORY, (this.#filled[owner] ?? 0) + 1);
    this.#seenAtMs[owner] = volley.atMs;
  }

  /**
   * What is known about one monster's attack, or nothing when it is silent.
   *
   * @returns a reading valid until the next call. Never held on to.
   */
  readingOf(ownerId: number, gameTimeMs: number): PatternReading | undefined {
    const owner = this.#find(ownerId);
    if (owner < 0) return undefined;
    if (gameTimeMs - (this.#seenAtMs[owner] ?? 0) > FORGET_AFTER_MS) return undefined;
    return this.#read(owner);
  }

  /**
   * The pattern most worth planning around, of everything near a place.
   *
   * **One, rather than all of them, and that is a decision about stability.**
   * Two patterns overlapping is the ordinary case in a boss fight, and every
   * shot of both is already in the danger field — so nothing is lost by
   * recognising only the strongest. What would be lost by recognising several is
   * the lock: a planner aiming at the pockets of whichever pattern happened to
   * score highest this tick is a planner changing its mind every tick, which is
   * exactly the behaviour the recogniser exists to replace.
   *
   * Ranked by confidence and then by nearness, because a pattern the player is
   * standing inside is the one whose pockets are worth riding.
   */
  strongestNear(
    x: number,
    y: number,
    withinTiles: number,
    gameTimeMs: number,
  ): PatternReading | undefined {
    let best = -1;
    let bestScore = 0;
    let bestNear = Infinity;
    for (let owner = 0; owner < MAX_OWNERS; owner += 1) {
      if (this.#live[owner] !== 1) continue;
      if (gameTimeMs - (this.#seenAtMs[owner] ?? 0) > FORGET_AFTER_MS) continue;
      const latest = this.#latest(owner);
      if (latest < 0) continue;
      const near = Math.hypot((this.#x[latest] ?? 0) - x, (this.#y[latest] ?? 0) - y);
      if (near > withinTiles) continue;

      const reading = this.#read(owner);
      if (reading.confidence <= 0) continue;
      if (reading.confidence < bestScore) continue;
      if (reading.confidence === bestScore && near >= bestNear) continue;
      bestScore = reading.confidence;
      bestNear = near;
      best = owner;
    }
    return best < 0 ? undefined : this.#read(best);
  }

  /**
   * Works one owner's history into a reading.
   *
   * **Everything here is a difference between consecutive volleys**, which is
   * what makes it cheap enough to redo per plan rather than cached: eight
   * volleys is seven gaps, and there is no state to invalidate.
   */
  #read(owner: number): PatternReading {
    const reading = this.#reading;
    const latest = this.#latest(owner);
    reading.ownerId = this.#ownerId[owner] ?? 0;
    reading.originX = this.#x[latest] ?? 0;
    reading.originY = this.#y[latest] ?? 0;
    reading.baseAngle = this.#angle[latest] ?? 0;
    reading.baseAtMs = this.#atMs[latest] ?? 0;
    reading.arms = this.#count[latest] ?? 1;
    reading.originVelocityX = 0;
    reading.originVelocityY = 0;
    reading.omegaRadiansPerSecond = 0;
    reading.periodMs = 0;
    reading.alternating = false;
    reading.confidence = 0;

    const step = Math.abs(this.#step[latest] ?? 0);
    const span = step * reading.arms;
    reading.spacingRadians = reading.arms > 1 && step > 0 ? step : 2 * Math.PI;
    reading.kind =
      reading.arms <= 1 || step === 0
        ? PatternKind.Single
        : span >= 2 * Math.PI - RING_SLACK_RADIANS
          ? PatternKind.Ring
          : span - step <= CONE_SPAN_RADIANS
            ? PatternKind.Cone
            : PatternKind.Fan;
    // A ring's arms are evenly spread whatever the volley declared, and the gap
    // a player fits through is the one between neighbours.
    if (reading.kind === PatternKind.Ring) reading.spacingRadians = (2 * Math.PI) / reading.arms;

    const filled = this.#filled[owner] ?? 0;
    if (filled < 2) return reading;

    // **Only volleys the same shape as the newest.** A monster that switches
    // from a ring to a shotgun has two patterns in its history, and averaging
    // the turn across the change describes neither.
    let gaps = 0;
    let turnTotal = 0;
    let periodTotal = 0;
    let agree = 0;
    let firstTurn = 0;
    // Where the pattern was two volleys ago, which is the only thing that tells
    // an alternation from a turn. See below.
    let twoBackAngle = Number.NaN;
    let originDX = 0;
    let originDY = 0;
    let originMs = 0;

    let newer = latest;
    for (let back = 1; back < filled; back += 1) {
      const older = this.#at(owner, back);
      if ((this.#count[older] ?? 0) !== reading.arms) break;
      if (Math.abs((this.#step[older] ?? 0) - (this.#step[latest] ?? 0)) > TURN_SLACK_RADIANS)
        break;
      const periodMs = (this.#atMs[newer] ?? 0) - (this.#atMs[older] ?? 0);
      if (!(periodMs >= MIN_PERIOD_MS) || periodMs > MAX_PERIOD_MS) break;

      // **Wrapped into one arm spacing, because the arms are interchangeable.**
      // A ring of eight turned by a full gap is the same ring; what a planner
      // has to know is where the ring sits *between* its arms, and that only
      // ever means the remainder.
      const turn = wrapInto(
        (this.#angle[newer] ?? 0) - (this.#angle[older] ?? 0),
        reading.spacingRadians,
      );
      if (gaps === 0) firstTurn = turn;
      if (back === 2) twoBackAngle = this.#angle[older] ?? 0;
      turnTotal += turn;
      periodTotal += periodMs;
      if (Math.abs(turn - firstTurn) <= TURN_SLACK_RADIANS) agree += 1;
      gaps += 1;

      originDX = (this.#x[latest] ?? 0) - (this.#x[older] ?? 0);
      originDY = (this.#y[latest] ?? 0) - (this.#y[older] ?? 0);
      originMs = (this.#atMs[latest] ?? 0) - (this.#atMs[older] ?? 0);
      newer = older;
    }

    if (gaps === 0) return reading;
    reading.periodMs = periodTotal / gaps;
    if (originMs > 0) {
      // Tiles a second. A turret's is nought; a walking emitter's is what keeps
      // its pockets attached to it rather than to the ground it left.
      reading.originVelocityX = (originDX / originMs) * 1000;
      reading.originVelocityY = (originDY / originMs) * 1000;
    }

    reading.confidence = Math.min(1, agree / CONFIDENT_GAPS);

    // **Two volleys back, because one cannot tell the two apart.** A pattern
    // that shifts half a gap and back again shifts by *exactly* the fold —
    // wrapped into one arm spacing, half a gap forward and half a gap back are
    // the same number, so consecutive volleys say nothing at all about which is
    // happening. Where the pattern is two volleys later does say: a turn has
    // gone twice as far, and an alternation has come back to where it started.
    //
    // **A rotation of exactly half a gap a volley reads as an alternation, and
    // should.** The two are indistinguishable in the shots as well as in the
    // arithmetic, and treating it as an alternation is the safe reading — the
    // other one has a planner leaning into a wave that is coming back.
    if (gaps >= 2 && Number.isFinite(twoBackAngle)) {
      const overTwo = wrapInto((this.#angle[latest] ?? 0) - twoBackAngle, reading.spacingRadians);
      if (Math.abs(firstTurn) > TURN_SLACK_RADIANS && Math.abs(overTwo) <= TURN_SLACK_RADIANS) {
        reading.alternating = true;
        reading.omegaRadiansPerSecond = 0;
        return reading;
      }
    }

    reading.omegaRadiansPerSecond = (turnTotal / gaps / (periodTotal / gaps)) * 1000;
    return reading;
  }

  /** The slot of the `back`-th most recent volley, `back` of 0 being the newest. */
  #at(owner: number, back: number): number {
    const head = this.#head[owner] ?? 0;
    return owner * HISTORY + ((head - 1 - back + HISTORY * 2) % HISTORY);
  }

  /** The newest volley's slot, or `-1` when there is none. */
  #latest(owner: number): number {
    return (this.#filled[owner] ?? 0) === 0 ? -1 : this.#at(owner, 0);
  }

  #find(ownerId: number): number {
    for (let i = 0; i < MAX_OWNERS; i += 1) {
      if (this.#live[i] === 1 && this.#ownerId[i] === ownerId) return i;
    }
    return -1;
  }

  /**
   * The row for one monster, taking one from whoever has been quiet longest.
   *
   * Fixed capacity rather than a map, because the table is walked linearly on
   * every plan and a realm's worth of turrets would otherwise make that walk the
   * expensive part of a feature that only ever acts on what is near.
   */
  #slotFor(ownerId: number, atMs: number): number {
    const found = this.#find(ownerId);
    if (found >= 0) return found;

    let victim = 0;
    let oldest = Infinity;
    for (let i = 0; i < MAX_OWNERS; i += 1) {
      if (this.#live[i] !== 1) {
        victim = i;
        break;
      }
      const seen = this.#seenAtMs[i] ?? 0;
      if (seen < oldest) {
        oldest = seen;
        victim = i;
      }
    }
    this.#live[victim] = 1;
    this.#ownerId[victim] = ownerId;
    this.#seenAtMs[victim] = atMs;
    this.#head[victim] = 0;
    this.#filled[victim] = 0;
    return victim;
  }
}

/**
 * An angle folded into one spacing, centred on nought.
 *
 * The result is in `(-spacing/2, spacing/2]`, which is what "how far the pattern
 * moved" means when its arms are interchangeable: a ring of eight turned by
 * forty-six degrees has moved one degree, not forty-six.
 */
function wrapInto(angle: number, spacing: number): number {
  if (!(spacing > 0)) return 0;
  const folded = angle - spacing * Math.round(angle / spacing);
  return folded;
}
