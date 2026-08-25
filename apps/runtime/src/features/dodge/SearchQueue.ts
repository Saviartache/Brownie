/**
 * The search's open list: a binary heap over flat arrays.
 *
 * **Kept apart from the search because it is the one part of it with no
 * opinions.** Everything in `DodgeSearch` is a claim about dodging; this is a
 * claim about ordering, it is where a mistake would be invisible from the
 * outside, and it is worth checking on its own.
 *
 * **Duplicates are allowed rather than repaired.** The textbook A* lowers a
 * key in place when a better route to a node turns up, which needs every node's
 * position in the heap tracked and fixed on every sift. Pushing the better entry
 * and ignoring whichever copy comes out second is the same answer for less: the
 * search already keeps a closed set, so a stale copy is one comparison on the
 * way out. The heap stays a heap and nothing has to know where anything is.
 *
 * Two typed arrays and no objects, because a fight can put a few thousand
 * entries through here fifty times a second and an entry per push would be a
 * few hundred thousand short-lived objects a second.
 */

export class SearchQueue {
  #key = new Float64Array(0);
  #node = new Int32Array(0);
  #size = 0;

  /** How many entries are waiting. Not how many distinct nodes. */
  get size(): number {
    return this.#size;
  }

  /** Empties it without giving up the memory it has grown into. */
  clear(): void {
    this.#size = 0;
  }

  /** Adds a node under a key. Lower comes out first. */
  push(node: number, key: number): void {
    if (this.#size >= this.#key.length) this.#grow();

    let child = this.#size;
    this.#size += 1;
    while (child > 0) {
      const parent = (child - 1) >> 1;
      if ((this.#key[parent] ?? 0) <= key) break;
      this.#key[child] = this.#key[parent] ?? 0;
      this.#node[child] = this.#node[parent] ?? 0;
      child = parent;
    }
    this.#key[child] = key;
    this.#node[child] = node;
  }

  /** The node with the lowest key, or `-1` when there is nothing left. */
  pop(): number {
    if (this.#size === 0) return -1;
    const best = this.#node[0] ?? -1;

    this.#size -= 1;
    if (this.#size === 0) return best;

    const key = this.#key[this.#size] ?? 0;
    const node = this.#node[this.#size] ?? 0;

    let parent = 0;
    for (;;) {
      let child = parent * 2 + 1;
      if (child >= this.#size) break;
      const right = child + 1;
      if (right < this.#size && (this.#key[right] ?? 0) < (this.#key[child] ?? 0)) child = right;
      if ((this.#key[child] ?? 0) >= key) break;
      this.#key[parent] = this.#key[child] ?? 0;
      this.#node[parent] = this.#node[child] ?? 0;
      parent = child;
    }
    this.#key[parent] = key;
    this.#node[parent] = node;
    return best;
  }

  #grow(): void {
    const length = Math.max(64, this.#key.length * 2);
    const key = new Float64Array(length);
    const node = new Int32Array(length);
    key.set(this.#key);
    node.set(this.#node);
    this.#key = key;
    this.#node = node;
  }
}
