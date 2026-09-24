/**
 * `Danger(x, y, t)` — a uniform space-time grid over everything in flight.
 *
 * **This is the query the whole optimizer is built on, so it decides what the
 * optimizer can afford.** A rollout asks "how much room does this short step
 * have" a few thousand times per plan; done by walking every shot in flight, a
 * screen with a thousand of them costs a thousand tests per step and there is no
 * plan at all. Done through this, it costs a handful of cells and the shots
 * actually near them.
 *
 * **One grid per slice, and that is what makes the buckets tight.** A shot
 * crossing the screen has a horizon-wide bounding box and no index can do
 * anything useful with it; the same shot over a single hundred-millisecond slice
 * occupies about a tile. So the field is a stack of grids — one per slice of the
 * horizon — over the segment each shot travels during that slice, and the whole
 * stack is rebuilt every plan because that is what "the shots in flight now"
 * means.
 *
 * **A uniform grid rather than a tree, and the reason is the thousand.** The
 * previous generation used a median-split box tree: `O(n log n)` to build with a
 * comparison sort inside every range, which is excellent at forty shots and
 * quadratic-tempered at a thousand. Bucketing into fixed cells is a counting
 * sort — two linear passes, no comparisons, no recursion, no pointer chasing —
 * and the cell size is a fact about the game rather than about the data: shots
 * are about a tile wide and travel about a tile per slice, so a tile-and-a-bit
 * cell holds a handful of them whatever else is on the screen.
 *
 * **Except the wide ones, which are kept apart.** A boss's shot five tiles from
 * middle to edge covers a hundred cells, and bucketing it into all of them costs
 * more than testing it against every query would. Anything spanning more than
 * {@link MAX_SPAN_CELLS} goes on a short per-slice list that every query checks
 * — a dozen at the very worst, against a screen where they are the shots that
 * matter most.
 *
 * **The narrow phase is exact and closed-form.** Between two samples both the
 * shot and a walking player move in straight lines, so their difference does
 * too, and the closest the two ever come is the minimum of `max(|x|, |y|)` along
 * one segment — see {@link minChebyshevOnSegment}. Testing overlap at each end
 * instead cannot see a shot that crosses the player *between* two samples: it
 * reports a hit as a miss, and the faster the shot the more often.
 *
 * **A distance, not a verdict** — and, when something does land, what it was.
 * "Was I hit" answers one question; "how much room did I have, and what would
 * have hit me" answers the ones that decide between two ways through. See
 * {@link DangerField.worstDamage}.
 */

import { minChebyshevOnSegment } from './hitbox.js';
import type { ShotField } from './ShotField.js';

/**
 * The least room still worth measuring, in tiles.
 *
 * **The query box has to be wider than the shot.** Cull to the hitbox alone and
 * every near miss reports the same infinite room, which collapses the comparison
 * the optimizer is built on. Past the margin the caller cares about, one step is
 * as roomy as another and the difference stops deciding anything — which is what
 * keeps the broad phase doing its job, and this is the floor under how small
 * that margin may be.
 */
export const MIN_CLEARANCE_INTEREST_TILES = 0.3;

/** What a step with nothing anywhere near it reports. */
export const NO_DANGER_TILES = Infinity;

/**
 * How wide one cell is, in tiles.
 *
 * A fact about the game rather than about the data: an ordinary shot is half a
 * tile from middle to edge and travels about a tile in one slice of the horizon,
 * so a cell this size holds a handful of segments however many are on the
 * screen. Larger wastes narrow-phase tests; smaller multiplies the insertions,
 * which is the half of the build that is not free.
 */
const CELL_TILES = 1.25;

/**
 * How many cells a segment may cover before it is kept aside instead.
 *
 * A boss's shot is ten times the standard multiplier and covers a hundred cells;
 * bucketing it into all of them costs more than every query testing it directly.
 * See the file note.
 */
const MAX_SPAN_CELLS = 12;

/** How many wide shots one slice may keep aside. Past it, the widest are kept. */
const MAX_LARGE_PER_SLICE = 32;

/**
 * How many numbers describe one shot's segment over one slice.
 *
 * `fromX, fromY, toX, toY, half, fraction, shot, lowX, lowY, highX, highY` — the
 * fraction being how much of the slice the shot is there for, which is one for
 * all but the slice it expires in, `shot` its row in the {@link ShotField} so a
 * hit can say what hit it, and the last four its own box with the half already
 * added.
 *
 * **Copied out of the field rather than read back through it.** The build
 * touches each of these once; the query touches them tens of thousands of times,
 * and every read through `ShotField` is a private-field load, a multiply for the
 * row stride and a bounds-checked index. Laying them side by side turns the
 * innermost loop into contiguous reads off one array.
 *
 * **The box is stored rather than derived, and it pays for itself twice over.**
 * A cell two segments share is not two segments that touch: the grid answers
 * "somewhere near", and four comparisons turn most of those into a rejection
 * before the exact test — which costs four divisions and is the single hottest
 * arithmetic in the feature. Measured on a screen with a thousand shots on it,
 * it is about a third of the time a plan takes.
 */
const SEGMENT_STRIDE = 11;

export interface DangerFieldOptions {
  /**
   * The middle of the region any trajectory could reach, and how far it reaches.
   *
   * **The grid covers exactly that and nothing else.** A segment outside it
   * cannot be walked into by any candidate this plan will consider, so it is not
   * indexed at all — which is what keeps the grid a fixed couple of hundred
   * cells whether there are ten shots on the screen or a thousand.
   */
  readonly centreX: number;
  readonly centreY: number;
  readonly reachTiles: number;
  /**
   * How much room the caller can still act on the difference in.
   *
   * Anything roomier reports {@link NO_DANGER_TILES}, which is what keeps a
   * query from dragging half a screen of shots through the narrow phase to
   * distinguish two steps that are both perfectly safe.
   */
  readonly interestTiles: number;
}

export class DangerField {
  /** One entry per shot per slice it lives in. See {@link SEGMENT_STRIDE}. */
  #segment = new Float64Array(0);
  #segments = 0;

  /** Where each slice's segments begin in {@link #segment}. */
  #sliceFrom = new Int32Array(0);
  #sliceTo = new Int32Array(0);

  /** The wide ones, kept out of the grid. `slice * MAX_LARGE_PER_SLICE + n`. */
  #large = new Int32Array(0);
  #largeCount = new Int32Array(0);

  /** The grid: `slice * cells + cell`, as a prefix over one shared item array. */
  #bucketStart = new Int32Array(0);
  #bucketItem = new Int32Array(0);
  /** A moving write cursor per bucket, so the fill pass is one linear sweep. */
  #cursor = new Int32Array(0);

  /** Which query last looked at each segment, so a wide one is tested once. */
  #stamp = new Int32Array(0);
  #queryId = 0;

  /** How many grids there are, one per slice of the horizon. */
  #built = 0;
  #cellsX = 0;
  #cellsY = 0;
  #cells = 0;
  #originX = 0;
  #originY = 0;
  #interest = MIN_CLEARANCE_INTEREST_TILES;

  /** What the last query found landing on it. See {@link worstDamage}. */
  #worstDamage = 0;
  #worstDebuff = 0;
  /** The segment that left the last query least room, or -1. */
  #closest = -1;

  /** How many slices of the horizon are indexed. */
  get slices(): number {
    return this.#built;
  }

  /**
   * The heaviest shot the last {@link clearanceOf} found actually landing.
   *
   * Nought when it found none, which is the answer for nearly every step of
   * nearly every plan. Read beside the clearance rather than returned with it,
   * because a record per query is an allocation per query and there are a few
   * thousand of them.
   */
  get worstDamage(): number {
    return this.#worstDamage;
  }

  /** And the worst condition any of them carries, from nought to one. */
  get worstDebuff(): number {
    return this.#worstDebuff;
  }

  /**
   * How far the shot that came nearest in the last {@link clearanceOf} travels
   * over that slice, along x and along y.
   *
   * **Which way the fire is going, rather than where it is.** The one thing
   * the room cannot say is whether a step crosses a shot's line or runs along
   * it, and running along it is the dodge that only postpones the hit. Both
   * nought when nothing came near enough to be measured, and for a shot that is
   * not moving — a beam that stands, or one that has stopped.
   */
  get closestTravelX(): number {
    return this.#closestTravel(0);
  }

  get closestTravelY(): number {
    return this.#closestTravel(1);
  }

  /** Drops the index. */
  clear(): void {
    this.#built = 0;
    this.#segments = 0;
  }

  /**
   * Indexes every shot over every slice of the horizon.
   *
   * A shot enters a slice when it exists at the start of it, and leaves it where
   * it actually stops — at the far sample when it survives the whole slice, and
   * at the point it expires when it does not. What it never becomes is a shot
   * parked at its last sample: past its end there is no entry at all, which is
   * the difference between a wall and a memory.
   */
  build(shots: ShotField, options: DangerFieldOptions): void {
    const slices = Math.max(0, shots.slices - 1);
    this.#built = slices;
    this.#segments = 0;
    // **Never reset, and that is what makes the per-query stamp free.** A
    // counter that started again each plan would collide with the marks a
    // previous plan left on segment rows that have since been reused, and the
    // fix for that is clearing the whole stamp table every build. Monotonic, no
    // stale mark can ever equal the current query.
    this.#interest = Math.max(MIN_CLEARANCE_INTEREST_TILES, options.interestTiles);
    this.#weigh(shots);
    if (slices === 0) return;

    // The box any candidate could possibly touch, and therefore the whole of
    // what is worth indexing. The interest margin is in it because a query is
    // widened by exactly that much before it looks.
    const span = options.reachTiles + this.#interest + CELL_TILES;
    this.#originX = options.centreX - span;
    this.#originY = options.centreY - span;
    const side = Math.max(1, Math.ceil((span * 2) / CELL_TILES));
    this.#cellsX = side;
    this.#cellsY = side;
    this.#cells = side * side;

    this.#reserveGrid(this.#built);
    this.#reserveSegments(this.#built * shots.count);

    this.#collect(shots, slices);
    this.#bucket(this.#built);
  }

  /**
   * Copies every live segment out of the field, and files the wide ones aside.
   *
   * One pass, and it is the only place the shot rows are read: everything after
   * this works off {@link #segment}, which is contiguous and has no strides to
   * multiply out.
   */
  #collect(shots: ShotField, slices: number): void {
    const segment = this.#segment;
    const highX = this.#originX + this.#cellsX * CELL_TILES;
    const highY = this.#originY + this.#cellsY * CELL_TILES;

    for (let slice = 0; slice < slices; slice += 1) {
      this.#sliceFrom[slice] = this.#segments;
      this.#largeCount[slice] = 0;

      for (let shot = 0; shot < shots.count; shot += 1) {
        const live = shots.liveToOf(shot);
        if (live < slice) continue;
        const fromX = shots.xOf(shot, slice);
        const fromY = shots.yOf(shot, slice);

        const whole = live > slice;
        // The slice it expires in is swept over the part of it the shot is there
        // for, ending where it actually stops rather than at a sample it never
        // reaches. Without it the last tick of every flight is a step nothing
        // looks at, which is the tile a monster's range ends on.
        const fraction = whole ? 1 : shots.endFractionOf(shot);
        if (fraction <= 0) continue;
        const toX = whole ? shots.xOf(shot, slice + 1) : shots.endXOf(shot);
        const toY = whole ? shots.yOf(shot, slice + 1) : shots.endYOf(shot);
        // The wider of the two ends, because a segment is swept against a single
        // half and rounding it down is the one direction that costs a hit.
        const farHalf = whole ? shots.halfOf(shot, slice + 1) : shots.endHalfOf(shot);
        const half = Math.max(shots.halfOf(shot, slice), farHalf);

        const lowX = (fromX < toX ? fromX : toX) - half;
        const lowY = (fromY < toY ? fromY : toY) - half;
        const boxHighX = (fromX > toX ? fromX : toX) + half;
        const boxHighY = (fromY > toY ? fromY : toY) + half;
        // Outside everywhere a candidate could reach. Not merely cheap to skip —
        // it is what bounds the grid to a fixed size on a saturated screen.
        if (boxHighX < this.#originX || lowX > highX) continue;
        if (boxHighY < this.#originY || lowY > highY) continue;

        const at = this.#segments * SEGMENT_STRIDE;
        segment[at] = fromX;
        segment[at + 1] = fromY;
        segment[at + 2] = toX;
        segment[at + 3] = toY;
        segment[at + 4] = half;
        segment[at + 5] = fraction;
        segment[at + 6] = shot;
        segment[at + 7] = lowX;
        segment[at + 8] = lowY;
        segment[at + 9] = boxHighX;
        segment[at + 10] = boxHighY;
        this.#segments += 1;
      }

      this.#sliceTo[slice] = this.#segments;
    }
  }

  /**
   * Counting-sorts the segments into cells: count, prefix, fill.
   *
   * Two linear passes and no comparisons. The wide ones are pulled out here
   * rather than in {@link #collect} because whether a segment is wide is a
   * question about the cell size, which is settled once the grid is.
   */
  #bucket(slices: number): void {
    const segment = this.#segment;
    const buckets = slices * this.#cells;
    const start = this.#bucketStart;
    start.fill(0, 0, buckets + 1);

    let pairs = 0;
    for (let slice = 0; slice < slices; slice += 1) {
      const base = slice * this.#cells;
      const end = this.#sliceTo[slice] ?? 0;
      for (let i = this.#sliceFrom[slice] ?? 0; i < end; i += 1) {
        const at = i * SEGMENT_STRIDE;
        const cells = this.#span(segment, at);
        if (cells > MAX_SPAN_CELLS) {
          this.#keepAside(slice, i, segment[at + 4] ?? 0);
          continue;
        }
        for (let cy = this.#lowCellY; cy <= this.#highCellY; cy += 1) {
          const row = base + cy * this.#cellsX;
          for (let cx = this.#lowCellX; cx <= this.#highCellX; cx += 1) {
            start[row + cx + 1] = (start[row + cx + 1] ?? 0) + 1;
            pairs += 1;
          }
        }
      }
    }

    for (let i = 0; i < buckets; i += 1) {
      start[i + 1] = (start[i + 1] ?? 0) + (start[i] ?? 0);
      this.#cursor[i] = start[i] ?? 0;
    }
    if (this.#bucketItem.length < pairs) {
      this.#bucketItem = new Int32Array(Math.max(1024, pairs * 2));
    }
    const item = this.#bucketItem;

    for (let slice = 0; slice < slices; slice += 1) {
      const base = slice * this.#cells;
      const end = this.#sliceTo[slice] ?? 0;
      for (let i = this.#sliceFrom[slice] ?? 0; i < end; i += 1) {
        const at = i * SEGMENT_STRIDE;
        if (this.#span(segment, at) > MAX_SPAN_CELLS) continue;
        for (let cy = this.#lowCellY; cy <= this.#highCellY; cy += 1) {
          const row = base + cy * this.#cellsX;
          for (let cx = this.#lowCellX; cx <= this.#highCellX; cx += 1) {
            const cursor = this.#cursor[row + cx] ?? 0;
            item[cursor] = i;
            this.#cursor[row + cx] = cursor + 1;
          }
        }
      }
    }
  }

  /** The cell range of the segment at `at`, left in the four fields below. */
  #lowCellX = 0;
  #lowCellY = 0;
  #highCellX = 0;
  #highCellY = 0;

  /**
   * Works out which cells one segment covers, and how many that is.
   *
   * The range is left in {@link #lowCellX} and its three companions rather than
   * returned, because both passes of the bucketing want all five numbers and a
   * record per segment is an allocation per segment.
   */
  #span(segment: Float64Array, at: number): number {
    const half = segment[at + 4] ?? 0;
    const fromX = segment[at] ?? 0;
    const fromY = segment[at + 1] ?? 0;
    const toX = segment[at + 2] ?? 0;
    const toY = segment[at + 3] ?? 0;
    this.#lowCellX = this.#clampX((fromX < toX ? fromX : toX) - half);
    this.#highCellX = this.#clampX((fromX > toX ? fromX : toX) + half);
    this.#lowCellY = this.#clampY((fromY < toY ? fromY : toY) - half);
    this.#highCellY = this.#clampY((fromY > toY ? fromY : toY) + half);
    return (this.#highCellX - this.#lowCellX + 1) * (this.#highCellY - this.#lowCellY + 1);
  }

  /**
   * Files one wide segment on its slice's short list.
   *
   * Full, the *narrowest* one already there gives way: the list exists for the
   * shots too big to bucket, and when there are more of those than room for them
   * the widest are the ones a query cannot afford to have missed.
   */
  #keepAside(slice: number, index: number, half: number): void {
    const base = slice * MAX_LARGE_PER_SLICE;
    const count = this.#largeCount[slice] ?? 0;
    if (count < MAX_LARGE_PER_SLICE) {
      this.#large[base + count] = index;
      this.#largeCount[slice] = count + 1;
      return;
    }
    let narrowest = 0;
    let narrowestHalf = Infinity;
    for (let i = 0; i < MAX_LARGE_PER_SLICE; i += 1) {
      const other = this.#segment[(this.#large[base + i] ?? 0) * SEGMENT_STRIDE + 4] ?? 0;
      if (other < narrowestHalf) {
        narrowestHalf = other;
        narrowest = i;
      }
    }
    if (half > narrowestHalf) this.#large[base + narrowest] = index;
  }

  /**
   * The least room a player walking `from` to `to` over `slice` ever has.
   *
   * Negative once something has landed, and `Infinity` when nothing comes near
   * enough for the difference to matter — see {@link DangerFieldOptions}.
   * {@link worstDamage} and {@link worstDebuff} say what landed, if anything.
   *
   * @param slice Which slice of the horizon this walk spans. The samples at its
   *   two ends are what the shots are read at, which is why the caller must be
   *   stepping on the same clock the field was sampled on.
   */
  clearanceOf(slice: number, fromX: number, fromY: number, toX: number, toY: number): number {
    this.#worstDamage = 0;
    this.#worstDebuff = 0;
    this.#closest = -1;
    if (slice < 0 || slice >= this.#built) return NO_DANGER_TILES;

    const interest = this.#interest;
    const lowX = (fromX < toX ? fromX : toX) - interest;
    const lowY = (fromY < toY ? fromY : toY) - interest;
    const highX = (fromX > toX ? fromX : toX) + interest;
    const highY = (fromY > toY ? fromY : toY) + interest;

    this.#queryId += 1;
    const query = this.#queryId;
    let room = NO_DANGER_TILES;
    const segment = this.#segment;

    const base = slice * this.#cells;
    const cellLowX = this.#clampX(lowX);
    const cellHighX = this.#clampX(highX);
    const cellLowY = this.#clampY(lowY);
    const cellHighY = this.#clampY(highY);
    const start = this.#bucketStart;
    const item = this.#bucketItem;
    for (let cy = cellLowY; cy <= cellHighY; cy += 1) {
      const row = base + cy * this.#cellsX;
      for (let cx = cellLowX; cx <= cellHighX; cx += 1) {
        const end = start[row + cx + 1] ?? 0;
        for (let i = start[row + cx] ?? 0; i < end; i += 1) {
          const index = item[i] ?? 0;
          // A segment reaches into several cells, and a query spans several
          // more; without this a wide-ish shot is put through the narrow phase
          // once per cell they share.
          if (this.#stamp[index] === query) continue;
          this.#stamp[index] = query;
          // **And sharing a cell is not touching.** The grid answers "somewhere
          // near"; four comparisons against the segment's own box turn most of
          // those into a rejection before the exact test, which is the most
          // expensive arithmetic in the feature.
          const at = index * SEGMENT_STRIDE;
          if ((segment[at + 9] ?? 0) < lowX || (segment[at + 7] ?? 0) > highX) continue;
          if ((segment[at + 10] ?? 0) < lowY || (segment[at + 8] ?? 0) > highY) continue;
          const here = this.#measure(index, fromX, fromY, toX, toY);
          if (here < room) {
            room = here;
            this.#closest = index;
          }
        }
      }
    }

    const largeBase = slice * MAX_LARGE_PER_SLICE;
    const large = this.#largeCount[slice] ?? 0;
    for (let i = 0; i < large; i += 1) {
      const index = this.#large[largeBase + i] ?? 0;
      const here = this.#measure(index, fromX, fromY, toX, toY);
      if (here < room) {
        room = here;
        this.#closest = index;
      }
    }
    return room;
  }

  /** One axis of the nearest segment's travel. See {@link closestTravelX}. */
  #closestTravel(axis: 0 | 1): number {
    if (this.#closest < 0) return 0;
    const at = this.#closest * SEGMENT_STRIDE;
    return (this.#segment[at + 2 + axis] ?? 0) - (this.#segment[at + axis] ?? 0);
  }

  /**
   * How much room one segment leaves the walk, recording it if it landed.
   *
   * The gap between the two as one segment: both travel in straight lines over
   * this slice, so their difference does too.
   */
  #measure(index: number, fromX: number, fromY: number, toX: number, toY: number): number {
    const segment = this.#segment;
    const at = index * SEGMENT_STRIDE;
    // A shot that expires part of the way through the slice is compared against
    // the part of the walk that happens before it does. Credit the walker with
    // the whole slice and the two are being measured at different moments, which
    // reads as room that nobody ever had.
    const part = segment[at + 5] ?? 1;
    const walkX = part < 1 ? fromX + (toX - fromX) * part : toX;
    const walkY = part < 1 ? fromY + (toY - fromY) * part : toY;
    const gap =
      minChebyshevOnSegment(
        (segment[at] ?? 0) - fromX,
        (segment[at + 1] ?? 0) - fromY,
        (segment[at + 2] ?? 0) - walkX,
        (segment[at + 3] ?? 0) - walkY,
      ) - (segment[at + 4] ?? 0);

    if (gap < 0) {
      const shot = segment[at + 6] ?? 0;
      const damage = this.#shotDamage[shot] ?? 0;
      const debuff = this.#shotDebuff[shot] ?? 0;
      if (damage > this.#worstDamage) this.#worstDamage = damage;
      if (debuff > this.#worstDebuff) this.#worstDebuff = debuff;
    }
    return gap;
  }

  /**
   * What each shot costs, copied flat for the same reason the segments are.
   *
   * The narrow phase reads these on every landing, and a landing is the case a
   * saturated screen is made of.
   */
  #shotDamage = new Float32Array(0);
  #shotDebuff = new Float32Array(0);

  /** Takes the per-shot costs the scorer reads back through a landing. */
  #weigh(shots: ShotField): void {
    if (this.#shotDamage.length < shots.count) {
      const length = Math.max(64, shots.count * 2);
      this.#shotDamage = new Float32Array(length);
      this.#shotDebuff = new Float32Array(length);
    }
    for (let shot = 0; shot < shots.count; shot += 1) {
      this.#shotDamage[shot] = shots.damageOf(shot);
      this.#shotDebuff[shot] = shots.debuffOf(shot);
    }
  }

  #clampX(x: number): number {
    const cell = Math.floor((x - this.#originX) / CELL_TILES);
    return cell < 0 ? 0 : cell >= this.#cellsX ? this.#cellsX - 1 : cell;
  }

  #clampY(y: number): number {
    const cell = Math.floor((y - this.#originY) / CELL_TILES);
    return cell < 0 ? 0 : cell >= this.#cellsY ? this.#cellsY - 1 : cell;
  }

  #reserveGrid(slices: number): void {
    const buckets = Math.max(1, slices) * this.#cells;
    if (this.#bucketStart.length < buckets + 1) {
      this.#bucketStart = new Int32Array(Math.max(256, (buckets + 1) * 2));
      this.#cursor = new Int32Array(this.#bucketStart.length);
    }
    if (this.#sliceFrom.length < slices) {
      this.#sliceFrom = new Int32Array(Math.max(8, slices * 2));
      this.#sliceTo = new Int32Array(this.#sliceFrom.length);
      this.#largeCount = new Int32Array(this.#sliceFrom.length);
      this.#large = new Int32Array(this.#sliceFrom.length * MAX_LARGE_PER_SLICE);
    }
  }

  #reserveSegments(segments: number): void {
    if (this.#segment.length >= segments * SEGMENT_STRIDE) return;
    const capacity = Math.max(512, segments * 2);
    this.#segment = new Float64Array(capacity * SEGMENT_STRIDE);
    this.#stamp = new Int32Array(capacity);
  }
}
