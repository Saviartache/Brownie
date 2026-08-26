/**
 * How much room one step of a walk has, asked a few thousand times a plan.
 *
 * **This is the query the whole search is built on, so it decides what the
 * search can afford.** A spacetime A* asks "could this step touch anything"
 * once per candidate edge; done by walking every shot in flight, a screen with
 * forty shots on it costs forty tests per edge and the search budget collapses
 * into the broad phase. Done through an index it costs a descent and a handful
 * of tests, and the budget goes where it belongs — into looking further ahead.
 *
 * **One tree per lattice step, and that is what makes the boxes tight.** A shot
 * crossing the screen has a horizon-wide bounding box and no index can do
 * anything useful with it; the same shot over a single hundred-millisecond step
 * occupies about a tile. So the index is built per step, over the segment each
 * shot travels during it, and the trees are rebuilt from scratch every plan
 * because that is what "the shots in flight now" means. See {@link BoxTree} for
 * why they are built rather than maintained.
 *
 * **The narrow phase is exact and closed-form.** Between two samples both the
 * shot and a walking player move in straight lines, so their difference does
 * too, and the closest the two ever come is the minimum of `max(|x|, |y|)` along
 * one segment — see {@link minChebyshevOnSegment}. Testing overlap at each step
 * instead cannot see a shot that crosses the player *between* two steps: it
 * reports a hit as a miss, and the faster the shot the more often.
 *
 * **A distance, not a verdict.** "Was I hit" answers one question; "how much
 * room did I have" answers the one that decides between two ways through, and it
 * is what lets the search prefer the wide gap to the needle.
 */

import { BoxTree } from './BoxTree.js';
import { minChebyshevOnSegment } from './hitbox.js';
import type { ShotTracks } from './ShotTracks.js';

/**
 * The least room still worth measuring, in tiles.
 *
 * **The box a shot is kept in has to be wider than the shot.** Cull to the
 * hitbox alone and every near miss reports the same infinite room, which
 * collapses the comparison the search is built on. Past the margin the caller
 * cares about, one step is as roomy as another and the difference stops
 * deciding anything — which is what keeps the broad phase doing its job, and
 * this is the floor under how small that margin may be.
 *
 * **It is what the query box is widened by, so it is quadratic in what a busy
 * screen costs.** A margin of a whole tile puts two and a half tiles of query
 * around every step and catches fifteen shots where the caller could only ever
 * act on five of them; measured, it was two thirds of the time a plan took.
 */
export const MIN_CLEARANCE_INTEREST_TILES = 0.3;

/** What a step with nothing anywhere near it reports. */
export const NO_THREAT_TILES = Infinity;

/**
 * How many numbers describe one shot's segment over one step.
 *
 * `fromX, fromY, toX, toY, half, fraction` — the last being how much of the
 * step the shot is there for, which is one for all but the step it expires in.
 *
 * **Copied out of the tracks rather than read back through them.** The build
 * touches each of these once; the query touches them a few thousand times, and
 * every read through `ShotTracks` is a private-field load, a multiply for the
 * row stride and a bounds-checked index. Laying them out side by side turns the
 * innermost loop into contiguous reads off one array, which is the difference
 * between a busy screen costing a fraction of a millisecond and costing several.
 */
const SEGMENT_STRIDE = 6;

export class ThreatIndex {
  /** One per lattice step. Grown to the deepest search the settings allow. */
  readonly #steps: BoxTree[] = [];
  /** How many of {@link #steps} the last build filled. */
  #built = 0;

  /** One entry per shot per step it lives in. See {@link SEGMENT_STRIDE}. */
  #segment = new Float64Array(0);
  #entries = 0;
  /** How far past a shot's own extent a query still looks. */
  #interest = MIN_CLEARANCE_INTEREST_TILES;

  /** How many lattice steps are indexed. Queries past this find nothing. */
  get steps(): number {
    return this.#built;
  }

  /** Drops the index. */
  clear(): void {
    for (let i = 0; i < this.#built; i += 1) this.#steps[i]?.clear();
    this.#built = 0;
    this.#entries = 0;
  }

  /**
   * Indexes every shot over every step of the lattice.
   *
   * A shot enters a step's tree when it exists at the start of it, and leaves it
   * where it actually stops — at the far sample when it survives the whole step,
   * and at the point it expires when it does not. What it never becomes is a
   * shot parked at its last sample: past its end there is no entry at all, which
   * is the difference between a wall and a memory.
   */
  /**
   * @param interestTiles How much room the caller can still act on the
   *   difference in. Anything roomier reports {@link NO_THREAT_TILES}, which is
   *   what keeps a query from dragging half a screen of shots through the narrow
   *   phase to distinguish two steps that are both perfectly safe.
   */
  build(tracks: ShotTracks, interestTiles = MIN_CLEARANCE_INTEREST_TILES): void {
    const steps = Math.max(0, tracks.slices - 1);
    this.#built = steps;
    this.#entries = 0;
    this.#interest = Math.max(MIN_CLEARANCE_INTEREST_TILES, interestTiles);
    this.#reserve(steps * tracks.count);

    const segment = this.#segment;
    for (let step = 0; step < steps; step += 1) {
      let tree = this.#steps[step];
      if (tree === undefined) {
        tree = new BoxTree();
        this.#steps[step] = tree;
      }
      tree.clear();

      for (let shot = 0; shot < tracks.count; shot += 1) {
        const live = tracks.liveToOf(shot);
        if (live < step) continue;
        const fromX = tracks.xOf(shot, step);
        const fromY = tracks.yOf(shot, step);

        const whole = live > step;
        // The step it expires in is swept over the part of it the shot is there
        // for, ending where it actually stops rather than at a sample it never
        // reaches. Without it the last tick of every flight is a step nothing
        // looks at, which is the tile a monster's range ends on.
        const fraction = whole ? 1 : tracks.endFractionOf(shot);
        if (fraction <= 0) continue;
        const toX = whole ? tracks.xOf(shot, step + 1) : tracks.endXOf(shot);
        const toY = whole ? tracks.yOf(shot, step + 1) : tracks.endYOf(shot);
        // The wider of the two ends, because a segment is swept against a single
        // half and rounding it down is the one direction that costs a hit.
        const farHalf = whole ? tracks.halfOf(shot, step + 1) : tracks.endHalfOf(shot);
        const half = Math.max(tracks.halfOf(shot, step), farHalf);

        const at = this.#entries * SEGMENT_STRIDE;
        segment[at] = fromX;
        segment[at + 1] = fromY;
        segment[at + 2] = toX;
        segment[at + 3] = toY;
        segment[at + 4] = half;
        segment[at + 5] = fraction;
        tree.add(
          (fromX < toX ? fromX : toX) - half,
          (fromY < toY ? fromY : toY) - half,
          (fromX > toX ? fromX : toX) + half,
          (fromY > toY ? fromY : toY) + half,
          this.#entries,
        );
        this.#entries += 1;
      }

      tree.build();
    }
  }

  /**
   * The least room a player walking `from` to `to` over `step` ever has.
   *
   * Negative once something has landed, and `Infinity` when nothing comes near
   * enough for the difference to matter — see {@link build}'s `interestTiles`.
   *
   * @param step Which lattice step this walk spans. The samples at its two ends
   *   are what the shots are read at, which is why the caller must be stepping
   *   on the same clock the tracks were sampled on.
   */
  clearanceOf(step: number, fromX: number, fromY: number, toX: number, toY: number): number {
    if (step < 0 || step >= this.#built) return NO_THREAT_TILES;
    const tree = this.#steps[step];
    if (tree === undefined || tree.count === 0) return NO_THREAT_TILES;

    const interest = this.#interest;
    tree.query(
      (fromX < toX ? fromX : toX) - interest,
      (fromY < toY ? fromY : toY) - interest,
      (fromX > toX ? fromX : toX) + interest,
      (fromY > toY ? fromY : toY) + interest,
    );
    const hits = tree.hitCount;
    if (hits === 0) return NO_THREAT_TILES;

    const segment = this.#segment;
    let room = NO_THREAT_TILES;
    for (let i = 0; i < hits; i += 1) {
      const at = tree.hit(i) * SEGMENT_STRIDE;
      // A shot that expires part of the way through the step is compared
      // against the part of the walk that happens before it does. Credit the
      // walker with the whole step and the two are being measured at different
      // moments, which reads as room that nobody ever had.
      const part = segment[at + 5] ?? 1;
      const walkX = part < 1 ? fromX + (toX - fromX) * part : toX;
      const walkY = part < 1 ? fromY + (toY - fromY) * part : toY;
      // The gap between the two, as one segment: both travel in straight lines
      // over this step, so their difference does too.
      const here = minChebyshevOnSegment(
        (segment[at] ?? 0) - fromX,
        (segment[at + 1] ?? 0) - fromY,
        (segment[at + 2] ?? 0) - walkX,
        (segment[at + 3] ?? 0) - walkY,
      );
      const gap = here - (segment[at + 4] ?? 0);
      if (gap < room) room = gap;
    }
    return room;
  }

  #reserve(entries: number): void {
    const needed = entries * SEGMENT_STRIDE;
    if (this.#segment.length >= needed) return;
    this.#segment = new Float64Array(Math.max(256, needed * 2));
  }
}
