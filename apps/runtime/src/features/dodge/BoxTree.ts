/**
 * A balanced binary tree over boxes, in flat arrays.
 *
 * **The broad phase of the whole planner.** A spacetime search asks one question
 * a few thousand times per plan — "which shots could this short step possibly
 * touch" — and done by walking every shot in flight, a screen with fifty of them
 * costs fifty tests per edge and the search budget disappears into the broad
 * phase. Done through a tree it costs a descent and a handful of tests, and the
 * budget goes where it belongs: into looking further ahead.
 *
 * **Two dimensions, and the second one is not optional.** An index that splits
 * on `x` alone is the textbook interval tree and it is excellent right up to the
 * shape this game actually produces: a rank of shots abreast, every one of them
 * at the same `x`. A query then matches the whole rank and rejects it one shot
 * at a time, which is the loop the tree existed to avoid. Splitting on whichever
 * axis the boxes are actually spread across separates a rank by `y` and a stream
 * by `x`, without having to know which it is looking at.
 *
 * **It is built rather than maintained, which is why it is not a red-black
 * tree.** Rebalancing exists to keep a tree balanced across inserts and deletes
 * spread over time. Nothing here lives that long: every plan discards the whole
 * index and builds a new one from the shots that are in flight *now*, so the
 * balance can simply be constructed — recursive median split, perfectly balanced
 * by construction, no colours, no rotations, no parent pointers. Same `O(log n)`
 * query, less machinery, and the nodes end up contiguous instead of scattered.
 *
 * **Nothing here allocates once it is warm.** Capacity grows to the busiest
 * screen the session has seen and is then reused: a plan happens fifty times a
 * second, and a tree per plan is the sort of garbage that shows up as a stutter
 * rather than as a slow function.
 */

/** Where a node's children are when it holds one box instead. */
const LEAF = -1;

/** Four numbers describe a box: two low, two high. */
const BOX_STRIDE = 4;

export class BoxTree {
  /** The boxes, in the order they were added. `BOX_STRIDE` apiece. */
  #box = new Float64Array(0);
  /** What the caller wants back, one per box. */
  #item = new Int32Array(0);
  #count = 0;

  /** The boxes in the order the build settled on, as indices into {@link #box}. */
  #order = new Int32Array(0);

  /** The tree: children, the box each subtree covers, and the leaf's own box. */
  #left = new Int32Array(0);
  #right = new Int32Array(0);
  #bounds = new Float64Array(0);
  /** The box index a leaf holds, or {@link LEAF} for a node with children. */
  #holds = new Int32Array(0);
  #nodes = 0;

  /** The traversal's own stack, so a query neither recurses nor allocates. */
  #stack = new Int32Array(0);

  /** What the last query found, as the items given to {@link add}. */
  #hits = new Int32Array(0);
  #hitCount = 0;

  /** How many boxes are in the tree. */
  get count(): number {
    return this.#count;
  }

  /** How many the last {@link query} matched. */
  get hitCount(): number {
    return this.#hitCount;
  }

  /** The `index`-th match of the last {@link query}. */
  hit(index: number): number {
    return this.#hits[index] ?? 0;
  }

  /** Empties the tree without giving up the memory it has grown into. */
  clear(): void {
    this.#count = 0;
    this.#nodes = 0;
    this.#hitCount = 0;
  }

  /**
   * Records one box. Call {@link build} before querying.
   *
   * @param item What to report when this box matches. An index into whatever
   *   the caller is really storing — this tree carries no payload of its own,
   *   because the thing it indexes is always somewhere flatter.
   */
  add(lowX: number, lowY: number, highX: number, highY: number, item: number): void {
    if (this.#count >= this.#item.length) this.#grow();
    const at = this.#count * BOX_STRIDE;
    this.#box[at] = lowX;
    this.#box[at + 1] = lowY;
    this.#box[at + 2] = highX;
    this.#box[at + 3] = highY;
    this.#item[this.#count] = item;
    this.#count += 1;
  }

  /**
   * Turns what has been added into a tree.
   *
   * Each range is split at its median along whichever axis its boxes are most
   * spread across, which is what makes the depth exactly `ceil(log2 n)` and what
   * makes a rank of shots abreast separate as readily as a stream of them
   * head-on.
   */
  build(): void {
    this.#nodes = 0;
    if (this.#count === 0) return;
    for (let i = 0; i < this.#count; i += 1) this.#order[i] = i;
    this.#link(0, this.#count);
  }

  /**
   * Finds every box overlapping the one given, into {@link hit}.
   *
   * Overlap is inclusive at every edge: the caller's ranges already carry a
   * margin, and excluding a touch would be a distinction smaller than the margin
   * it is measured with.
   */
  query(lowX: number, lowY: number, highX: number, highY: number): void {
    this.#hitCount = 0;
    if (this.#nodes === 0) return;

    const bounds = this.#bounds;
    const stack = this.#stack;
    let depth = 0;
    stack[depth] = 0;
    depth += 1;

    while (depth > 0) {
      depth -= 1;
      const node = stack[depth] ?? 0;
      const at = node * BOX_STRIDE;
      if ((bounds[at] ?? 0) > highX) continue;
      if ((bounds[at + 2] ?? 0) < lowX) continue;
      if ((bounds[at + 1] ?? 0) > highY) continue;
      if ((bounds[at + 3] ?? 0) < lowY) continue;

      const holds = this.#holds[node] ?? LEAF;
      if (holds !== LEAF) {
        if (this.#hitCount >= this.#hits.length) this.#growHits();
        this.#hits[this.#hitCount] = this.#item[holds] ?? 0;
        this.#hitCount += 1;
        continue;
      }

      stack[depth] = this.#left[node] ?? 0;
      depth += 1;
      stack[depth] = this.#right[node] ?? 0;
      depth += 1;
    }
  }

  /**
   * Builds the subtree over `[begin, end)` of {@link #order} and returns it.
   *
   * The bounds are computed on the way down — they are what the split axis is
   * chosen from — and the children are filed after the parent has taken its own
   * index, which is what keeps the whole tree in one flat run.
   */
  #link(begin: number, end: number): number {
    const node = this.#nodes;
    this.#nodes += 1;

    const box = this.#box;
    const order = this.#order;
    let lowX = Infinity;
    let lowY = Infinity;
    let highX = -Infinity;
    let highY = -Infinity;
    for (let i = begin; i < end; i += 1) {
      const at = (order[i] ?? 0) * BOX_STRIDE;
      const boxLowX = box[at] ?? 0;
      const boxLowY = box[at + 1] ?? 0;
      const boxHighX = box[at + 2] ?? 0;
      const boxHighY = box[at + 3] ?? 0;
      if (boxLowX < lowX) lowX = boxLowX;
      if (boxLowY < lowY) lowY = boxLowY;
      if (boxHighX > highX) highX = boxHighX;
      if (boxHighY > highY) highY = boxHighY;
    }

    const at = node * BOX_STRIDE;
    this.#bounds[at] = lowX;
    this.#bounds[at + 1] = lowY;
    this.#bounds[at + 2] = highX;
    this.#bounds[at + 3] = highY;

    if (end - begin === 1) {
      this.#holds[node] = order[begin] ?? 0;
      this.#left[node] = LEAF;
      this.#right[node] = LEAF;
      return node;
    }

    // Whichever way the boxes are actually spread. A rank of shots abreast is
    // wide in `y` and a hand's breadth in `x`; a stream head-on is the other way
    // about, and neither has to be recognised for this to separate it.
    const axis = highX - lowX >= highY - lowY ? 0 : 1;
    this.#sortBy(begin, end, axis);
    const mid = (begin + end) >> 1;

    this.#holds[node] = LEAF;
    this.#left[node] = this.#link(begin, mid);
    this.#right[node] = this.#link(mid, end);
    return node;
  }

  /**
   * Orders one range by where its boxes sit along an axis.
   *
   * An insertion sort: the ranges are short — the whole tree is built over at
   * most a screenful of shots — and they are very often nearly in order already,
   * because the caller adds them in the order the world reports them and that
   * barely changes between two plans.
   */
  #sortBy(begin: number, end: number, axis: number): void {
    const box = this.#box;
    const order = this.#order;
    for (let i = begin + 1; i < end; i += 1) {
      const value = order[i] ?? 0;
      const at = value * BOX_STRIDE + axis;
      const key = (box[at] ?? 0) + (box[at + 2] ?? 0);
      let j = i - 1;
      for (;;) {
        if (j < begin) break;
        const other = (order[j] ?? 0) * BOX_STRIDE + axis;
        if ((box[other] ?? 0) + (box[other + 2] ?? 0) <= key) break;
        order[j + 1] = order[j] ?? 0;
        j -= 1;
      }
      order[j + 1] = value;
    }
  }

  #grow(): void {
    const length = Math.max(16, this.#item.length * 2);
    const box = new Float64Array(length * BOX_STRIDE);
    const item = new Int32Array(length);
    box.set(this.#box);
    item.set(this.#item);
    this.#box = box;
    this.#item = item;

    // A binary tree over `n` leaves has at most `2n - 1` nodes, and the stack
    // holds one path plus a sibling per level — but a length that matches the
    // leaf count cannot be the thing that overflows, and costs nothing.
    const nodes = length * 2;
    this.#order = new Int32Array(length);
    this.#left = new Int32Array(nodes);
    this.#right = new Int32Array(nodes);
    this.#holds = new Int32Array(nodes);
    this.#bounds = new Float64Array(nodes * BOX_STRIDE);
    this.#stack = new Int32Array(nodes + 2);
    if (this.#hits.length < length) this.#hits = new Int32Array(length);
  }

  #growHits(): void {
    const hits = new Int32Array(Math.max(16, this.#hits.length * 2));
    hits.set(this.#hits);
    this.#hits = hits;
  }
}
