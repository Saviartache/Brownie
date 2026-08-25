/**
 * The dodge's machinery: the index it asks, the queue it orders, the arithmetic
 * it ranks by, and the search that puts the three together.
 *
 * **Apart from `dodge.test.ts` because these are different questions.** That
 * file asks what the planner should *do* — leave me alone, step aside, come
 * back — and answers it through the planner and the plugin. This one asks
 * whether the parts underneath are correct on their own, which is where a
 * mistake is invisible from the outside: a tree that misses an overlap, a heap
 * that pops the wrong entry, an estimate that is not a lower bound. The last of
 * those is the one that matters most, because an estimate that over-shoots does
 * not crash — it quietly returns a route that was never the best one.
 */

import { describe, expect, it } from 'vitest';
import type { Position } from '@brownie/plugin-api';

import { BoxTree } from '../src/features/dodge/BoxTree.js';
import { SearchQueue } from '../src/features/dodge/SearchQueue.js';
import { remainingAnchorCost, stepCost, type StepWeights } from '../src/features/dodge/StepCost.js';
import {
  ShotTracks,
  type DodgeShot,
  type ShotTrackOptions,
} from '../src/features/dodge/ShotTracks.js';
import { NO_THREAT_TILES, ThreatIndex } from '../src/features/dodge/ThreatIndex.js';
import {
  DodgeSearch,
  type DodgeGround,
  type SearchRequest,
} from '../src/features/dodge/DodgeSearch.js';
import { MAX_HOP_TILES, chooseHop, type HopRequest } from '../src/features/dodge/Hop.js';
import { Blasts } from '../src/features/dodge/Blasts.js';
import { DodgePlanner, type DodgeSettings } from '../src/features/dodge/DodgePlanner.js';
import { DODGE_PRESETS, DodgePresetId } from '../src/features/dodge/dodgePresets.js';
import { ENEMY_CONTACT_HALF_TILES, EnemyBodies } from '../src/features/dodge/EnemyBodies.js';
import type { EntityView } from '@brownie/plugin-api';

/** A shot travelling in a straight line, which is what most of them do. */
function straightShot(
  from: Position,
  headingRadians: number,
  tilesPerSecond: number,
  firedAtMs: number,
  lifetimeMs: number,
  extra: Partial<DodgeShot> = {},
): DodgeShot {
  return {
    ...extra,
    positionAt(gameTimeMs: number): Position | undefined {
      const elapsed = gameTimeMs - firedAtMs;
      if (elapsed < 0 || elapsed > lifetimeMs) return undefined;
      const distance = (tilesPerSecond * elapsed) / 1000;
      return {
        x: from.x + distance * Math.cos(headingRadians),
        y: from.y + distance * Math.sin(headingRadians),
      };
    },
  };
}

/** The lattice the tests below step on, unless one says otherwise. */
const LATTICE = {
  gameTimeMs: 0,
  leadMs: 0,
  tickMs: 100,
  ticks: 8,
  selfX: 10,
  selfY: 10,
  reachTiles: 6,
  hitScale: 1,
  padTiles: 0,
  driftTilesPerSecond: 0,
} as const satisfies ShotTrackOptions;

/** Tracks and an index over them, which is how the search always sees shots. */
function fieldOf(
  shots: readonly DodgeShot[],
  overrides: Partial<ShotTrackOptions> = {},
): { tracks: ShotTracks; threats: ThreatIndex } {
  const tracks = new ShotTracks();
  tracks.build(shots, { ...LATTICE, ...overrides });
  const threats = new ThreatIndex();
  threats.build(tracks);
  return { tracks, threats };
}

/** Nothing in the way, nothing that hurts, nobody to bump into. */
const OPEN_GROUND: DodgeGround = {
  canStand: () => true,
  isDamaging: () => false,
  crowdingAt: () => 0,
  contactAt: () => 0,
};

const WEIGHTS: StepWeights = {
  anchorPerTile: 1,
  travelPerTile: 0.4,
  riskPerTile: 10,
  safeClearanceTiles: 0.25,
  crowdPerTile: 2.5,
  hazard: 8,
  hitPerStep: 400,
};

function searchFor(overrides: Partial<SearchRequest> = {}): SearchRequest {
  const empty = fieldOf([]);
  return {
    startX: 10,
    startY: 10,
    anchorX: 10,
    anchorY: 10,
    anchorStepX: 0,
    anchorStepY: 0,
    stepTiles: 0.6,
    ticks: 8,
    tickMs: 100,
    leadMs: 0,
    headings: 12,
    weights: WEIGHTS,
    greed: 1.6,
    maxExpansions: 600,
    holdDirX: 0,
    holdDirY: 0,
    holdBias: 0,
    ground: OPEN_GROUND,
    threats: empty.threats,
    blasts: undefined,
    ...overrides,
  };
}

describe('the box index', () => {
  type Box = readonly [number, number, number, number];

  /** What the tree ought to have said, worked out the slow and obvious way. */
  function brute(boxes: readonly Box[], query: Box): number[] {
    const found: number[] = [];
    boxes.forEach(([lowX, lowY, highX, highY], index) => {
      if (highX >= query[0] && lowX <= query[2] && highY >= query[1] && lowY <= query[3]) {
        found.push(index);
      }
    });
    return found;
  }

  function found(tree: BoxTree): number[] {
    return Array.from({ length: tree.hitCount }, (_unused, i) => tree.hit(i)).sort((a, b) => a - b);
  }

  /** A repeatable spread, so a failure is the same failure twice. */
  function spread(count: number, wide: boolean): Box[] {
    const boxes: Box[] = [];
    let seed = 12345;
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let i = 0; i < count; i += 1) {
      const x = next() * 100;
      const y = next() * 100;
      const size = wide && i % 7 === 0 ? 20 : 2;
      boxes.push([x, y, x + next() * size, y + next() * size]);
    }
    return boxes;
  }

  function treeOver(boxes: readonly Box[]): BoxTree {
    const tree = new BoxTree();
    boxes.forEach(([lowX, lowY, highX, highY], index) => tree.add(lowX, lowY, highX, highY, index));
    tree.build();
    return tree;
  }

  it('finds nothing in an empty tree', () => {
    const tree = new BoxTree();
    tree.build();
    tree.query(0, 0, 100, 100);
    expect(tree.hitCount).toBe(0);
  });

  it('finds an overlap and refuses a miss, touching edges included', () => {
    const tree = treeOver([[2, 2, 4, 4]]);

    tree.query(3, 3, 3.5, 3.5);
    expect(found(tree)).toEqual([0]);
    // Touching at an edge is an overlap: the caller's ranges already carry a
    // margin, and excluding a touch is a distinction smaller than the margin.
    tree.query(4, 4, 9, 9);
    expect(found(tree)).toEqual([0]);
    tree.query(4.001, 4, 9, 9);
    expect(found(tree)).toEqual([]);
    // And the second axis genuinely rejects, which a one-dimensional index
    // could not: same `x`, nowhere near in `y`.
    tree.query(3, 40, 3.5, 41);
    expect(found(tree)).toEqual([]);
  });

  // The bounds on each subtree are the whole structure: without them a query
  // has to walk everything. Getting that pruning wrong shows up as *missing*
  // overlaps, never as slowness.
  it('agrees with the obvious answer over a scattered run', () => {
    const boxes = spread(64, true);
    const tree = treeOver(boxes);

    for (let probe = 0; probe < 40; probe += 1) {
      const query: Box = [probe * 2.5, (probe % 8) * 12, probe * 2.5 + 4, (probe % 8) * 12 + 4];
      tree.query(...query);
      expect(found(tree)).toEqual(brute(boxes, query));
    }
  });

  // **The shape this game actually produces**, and the one an index split on
  // `x` alone cannot do anything with: a rank of shots abreast, every one of
  // them at the same `x` and a tile apart in `y`.
  it('separates a rank abreast as readily as a stream head-on', () => {
    const rank: Box[] = [];
    for (let y = 0; y < 32; y += 1) rank.push([9.5, y - 0.5, 10.5, y + 0.5]);
    const tree = treeOver(rank);

    tree.query(9, 15, 11, 17);
    expect(found(tree)).toEqual(brute(rank, [9, 15, 11, 17]));
    expect(tree.hitCount).toBeLessThanOrEqual(4);
  });

  it('can be emptied and rebuilt without carrying the last run over', () => {
    const tree = new BoxTree();
    tree.add(0, 0, 10, 10, 1);
    tree.build();
    tree.clear();
    tree.add(50, 50, 60, 60, 2);
    tree.build();

    tree.query(0, 0, 10, 10);
    expect(tree.hitCount).toBe(0);
    tree.query(50, 50, 60, 60);
    expect(found(tree)).toEqual([2]);
  });
});

describe('the open list', () => {
  function drain(queue: SearchQueue): number[] {
    const order: number[] = [];
    for (;;) {
      const node = queue.pop();
      if (node < 0) break;
      order.push(node);
    }
    return order;
  }

  it('gives back the lowest key first, whatever order they arrived in', () => {
    const queue = new SearchQueue();
    for (const [node, key] of [
      [1, 5],
      [2, 1],
      [3, 9],
      [4, 3],
      [5, 0.5],
    ] as const) {
      queue.push(node, key);
    }
    expect(drain(queue)).toEqual([5, 2, 4, 1, 3]);
  });

  // The search never lowers a key in place; it pushes the better entry and
  // ignores whichever copy comes out second. That only works if both copies are
  // actually kept and ordered.
  it('keeps duplicates and orders them among everything else', () => {
    const queue = new SearchQueue();
    queue.push(7, 10);
    queue.push(7, 2);
    queue.push(8, 5);

    expect(queue.size).toBe(3);
    expect(drain(queue)).toEqual([7, 8, 7]);
  });

  it('answers with nothing when it is empty', () => {
    const queue = new SearchQueue();
    expect(queue.pop()).toBe(-1);
    queue.push(1, 1);
    queue.clear();
    expect(queue.pop()).toBe(-1);
  });
});

describe('what a step is worth', () => {
  it('charges for standing away from where the player meant to be', () => {
    const near = stepCost(WEIGHTS, 1, 0, Infinity, 0, false, 5);
    const far = stepCost(WEIGHTS, 3, 0, Infinity, 0, false, 5);
    expect(far - near).toBeCloseTo(2 * WEIGHTS.anchorPerTile, 6);
  });

  // Without it the anchor term is indifferent between standing at the anchor
  // and orbiting it, and an indifferent planner picks whichever way the
  // arithmetic rounded.
  it('charges for walking at all, so standing still is the default', () => {
    expect(stepCost(WEIGHTS, 0, 0.6, Infinity, 0, false, 5)).toBeGreaterThan(
      stepCost(WEIGHTS, 0, 0, Infinity, 0, false, 5),
    );
  });

  // **The cost of being near a monster is nothing like linear in the
  // distance**: the outer half of the bubble is where an ordinary fight
  // happens, and the last half tile is contact damage and a shot fired point
  // blank. Flat, a route straight through a body was outvoted by a tile of
  // anchor.
  it('charges for being deep inside a monster far more than twice as much', () => {
    const edge = stepCost(WEIGHTS, 0, 0, Infinity, 0.5, false, 5);
    const deep = stepCost(WEIGHTS, 0, 0, Infinity, 1, false, 5);

    expect(deep).toBeGreaterThan(edge * 2);
  });

  it('pays for room right up to the point where there is enough of it', () => {
    const roomy = stepCost(WEIGHTS, 0, 0, WEIGHTS.safeClearanceTiles, 0, false, 5);
    const ample = stepCost(WEIGHTS, 0, 0, 5, 0, false, 5);
    const tight = stepCost(WEIGHTS, 0, 0, 0.05, 0, false, 5);

    expect(roomy).toBe(ample);
    expect(tight).toBeGreaterThan(roomy);
  });

  // **Priced out of reach rather than forbidden**, which is what leaves a best
  // answer when there is no good one. And later is better than sooner, because
  // that is the only thing still worth saying.
  it('puts a hit beyond anything the other terms can buy, and prefers a late one', () => {
    const soon = stepCost(WEIGHTS, 0, 0, -0.1, 0, false, 7);
    const late = stepCost(WEIGHTS, 0, 0, -0.1, 0, false, 1);
    // The worst the rest of the model can charge for one step: several tiles
    // off the anchor, in lava, inside a boss, having walked the whole way.
    const worstOtherwise = stepCost(WEIGHTS, 8, 0.6, Infinity, 3, true, 7);

    expect(late).toBeLessThan(soon);
    expect(late).toBeGreaterThan(worstOtherwise);
  });
});

describe('the estimate the search leans on', () => {
  const W = 1;

  it('is nothing at the anchor, and nothing with no time left', () => {
    expect(remainingAnchorCost(W, 0, 0.6, 8)).toBe(0);
    expect(remainingAnchorCost(W, 4, 0.6, 0)).toBe(0);
  });

  it('charges only for the ground a perfect run home has not closed yet', () => {
    // Two steps to close a tile and a bit at six tenths a step: the first step
    // still ends 0.6 away and the second arrives, so one step is charged.
    expect(remainingAnchorCost(W, 1.2, 0.6, 8)).toBeCloseTo(0.6, 6);
    // And nothing at all once the gap is inside a single step.
    expect(remainingAnchorCost(W, 0.5, 0.6, 8)).toBe(0);
  });

  // **The property the whole search rests on.** A* only promises a bounded
  // answer while the estimate never exceeds what the way home actually costs,
  // and the cheapest possible way home is closing the gap flat out and paying
  // the anchor term at every step on the way.
  it('never exceeds the cheapest run home it could possibly be', () => {
    const close = 0.6;
    for (const distance of [0.1, 0.55, 1, 2.4, 5, 9]) {
      for (const steps of [1, 2, 3, 5, 8, 13]) {
        let actual = 0;
        let gap = distance;
        for (let i = 0; i < steps; i += 1) {
          gap = Math.max(0, gap - close);
          actual += W * gap;
        }
        expect(remainingAnchorCost(W, distance, close, steps)).toBeLessThanOrEqual(actual + 1e-9);
      }
    }
  });

  // Consistency, which is the stronger property and the one that lets the
  // search close a node for good instead of revisiting it.
  it('never grows by more than one step of the walk it estimates', () => {
    const close = 0.6;
    for (const distance of [0.3, 1.1, 2.7, 6]) {
      for (const steps of [2, 4, 9]) {
        const here = remainingAnchorCost(W, distance, close, steps);
        const nearer = remainingAnchorCost(W, Math.max(0, distance - close), close, steps - 1);
        const paid = W * Math.max(0, distance - close);
        expect(here).toBeLessThanOrEqual(paid + nearer + 1e-9);
      }
    }
  });
});

describe('where the shots will be', () => {
  it('samples on the instants the lattice steps between', () => {
    // Eastwards at ten tiles a second, so a tenth of a second is a whole tile.
    const { tracks } = fieldOf([straightShot({ x: 4, y: 10 }, 0, 10, 0, 3000)]);

    expect(tracks.count).toBe(1);
    expect(tracks.slices).toBe(LATTICE.ticks + 1);
    expect(tracks.xOf(0, 0)).toBeCloseTo(4, 6);
    expect(tracks.xOf(0, 3)).toBeCloseTo(7, 6);
    expect(tracks.timeOf(3)).toBe(300);
  });

  // The prediction models neither turn rate nor the client's own clock, so it is
  // worth less the further ahead it is asked — and the honest shape of that is a
  // shot that gets wider, not one that is trusted exactly and then missed.
  it('widens a shot in proportion to how far ahead it is asked about', () => {
    const { tracks } = fieldOf([straightShot({ x: 4, y: 10 }, 0, 5, 0, 3000)], {
      driftTilesPerSecond: 0.4,
    });

    expect(tracks.halfOf(0, 8) - tracks.halfOf(0, 0)).toBeCloseTo(0.4 * 0.8, 6);
  });

  it('distrusts a shot the model does not claim to describe several times as fast', () => {
    const believed = fieldOf([straightShot({ x: 4, y: 10 }, 0, 5, 0, 3000)], {
      driftTilesPerSecond: 0.2,
    }).tracks;
    const spiral = fieldOf(
      [straightShot({ x: 4, y: 10 }, 0, 5, 0, 3000, { motionModelled: false })],
      { driftTilesPerSecond: 0.2 },
    ).tracks;

    const grewBy = (t: ShotTracks): number => t.halfOf(0, 8) - t.halfOf(0, 0);
    expect(grewBy(spiral)).toBeCloseTo(grewBy(believed) * 3, 6);
  });

  // Gone is gone. A shot parked at its last sample is a wall that was never
  // there, and the planner would walk around it for the rest of the horizon.
  it('stops where the shot stops existing', () => {
    const { tracks } = fieldOf([straightShot({ x: 8, y: 10 }, 0, 5, 0, 350)]);

    expect(tracks.count).toBe(1);
    expect(tracks.liveToOf(0)).toBe(3);
  });

  it('drops what could never come near, and counts what it looked at', () => {
    const { tracks } = fieldOf([
      // Straight at the player.
      straightShot({ x: 2, y: 10 }, 0, 8, 0, 3000),
      // Across the far side of the room, going away.
      straightShot({ x: 40, y: 40 }, 0, 8, 0, 3000),
    ]);

    expect(tracks.considered).toBe(2);
    expect(tracks.count).toBe(1);
  });

  // The cheap cull, and it is a bound rather than a guess: past this distance no
  // arrangement of turns brings the shot into reach inside the horizon.
  it('drops a distant shot on its own top speed without predicting it', () => {
    let asked = 0;
    const slow: DodgeShot = {
      maxSpeedTilesPerSecond: 1,
      positionAt: (at: number) => {
        asked += 1;
        return { x: 40, y: 10 + at * 0 };
      },
    };

    const { tracks } = fieldOf([slow]);
    expect(tracks.count).toBe(0);
    // Once, for where it is now — and never for the eight samples after it.
    expect(asked).toBe(1);
  });
});

describe('how much room a step has', () => {
  it('says nothing is near when nothing is', () => {
    const { threats } = fieldOf([]);
    expect(threats.clearanceOf(0, 10, 10, 10.5, 10)).toBe(NO_THREAT_TILES);
  });

  // **The hole every stepped planner has.** A shot fast enough to cross the
  // player between two samples is reported as a miss by anything that tests
  // overlap at the samples; the closed form over the segment cannot miss it.
  it('catches a shot that crosses the player between two samples', () => {
    // Forty tiles a second: in one tick it covers four tiles, passing clean
    // through the player and out the other side.
    const { threats } = fieldOf([straightShot({ x: 8, y: 10 }, 0, 40, 0, 3000)]);

    expect(threats.clearanceOf(0, 10, 10, 10, 10)).toBeLessThan(0);
  });

  it('reports a distance, so a wide miss and a graze are different answers', () => {
    const graze = fieldOf([straightShot({ x: 10, y: 9.2 }, 0, 8, 0, 3000)]).threats;
    const wide = fieldOf([straightShot({ x: 10, y: 8.4 }, 0, 8, 0, 3000)]).threats;

    const near = graze.clearanceOf(0, 10, 10, 10, 10);
    const far = wide.clearanceOf(0, 10, 10, 10, 10);
    expect(near).toBeGreaterThan(0);
    expect(far).toBeGreaterThan(near);
  });

  it('does not sweep a step a shot no longer exists for', () => {
    // Alive for a tick and a half, so it is gone by the third step.
    const { threats } = fieldOf([straightShot({ x: 10, y: 10 }, 0, 0.1, 0, 150)]);

    expect(threats.clearanceOf(0, 10, 10, 10, 10)).toBeLessThan(0);
    expect(threats.clearanceOf(3, 10, 10, 10, 10)).toBe(NO_THREAT_TILES);
  });

  // **Room the caller cannot act on is room not worth measuring**, and this is
  // what stops a query dragging half a screen of shots through the exact test to
  // distinguish two steps that are both perfectly safe. Measured, the margin
  // this saturates at was two thirds of what a busy plan cost.
  it('stops measuring past the room the caller asked about', () => {
    const shots = [straightShot({ x: 10, y: 8.4 }, 0, 8, 0, 3000)];
    const tracks = new ShotTracks();
    tracks.build(shots, LATTICE);

    const wide = new ThreatIndex();
    wide.build(tracks, 2);
    const narrow = new ThreatIndex();
    narrow.build(tracks, 0.3);

    expect(wide.clearanceOf(0, 10, 10, 10, 10)).toBeGreaterThan(0.3);
    expect(narrow.clearanceOf(0, 10, 10, 10, 10)).toBe(NO_THREAT_TILES);
  });

  it('takes the worst of everything in reach, not the first of them', () => {
    const { threats } = fieldOf([
      straightShot({ x: 10, y: 8.6 }, 0, 4, 0, 3000),
      straightShot({ x: 10, y: 9.3 }, 0, 4, 0, 3000),
    ]);

    const both = threats.clearanceOf(0, 10, 10, 10, 10);
    const nearer = fieldOf([straightShot({ x: 10, y: 9.3 }, 0, 4, 0, 3000)]).threats.clearanceOf(
      0,
      10,
      10,
      10,
      10,
    );
    expect(both).toBeCloseTo(nearer, 6);
  });
});

describe('the search', () => {
  /** Where a route ends up after walking every step of it. */
  function endOf(request: SearchRequest, dirX: number, dirY: number, steps: number): Position {
    return { x: request.startX + dirX * request.stepTiles * steps, y: request.startY + dirY * 0 };
  }

  it('stands still when there is nothing to answer', () => {
    const route = new DodgeSearch().run(searchFor());

    expect(route.stepTiles).toBe(0);
    expect(route.dirX).toBe(0);
    expect(route.impactMs).toBe(Infinity);
    expect(route.depth).toBe(8);
  });

  it('steps out of the way of a shot that would land on them', () => {
    // Straight at the player from the west, arriving inside two ticks.
    const { threats } = fieldOf([straightShot({ x: 8.5, y: 10 }, 0, 8, 0, 3000)]);
    const route = new DodgeSearch().run(searchFor({ threats }));

    expect(route.stepTiles).toBeGreaterThan(0);
    expect(route.impactMs).toBe(Infinity);
    // Across the line rather than along it: getting out of the way of a bullet
    // is a sidestep, and outrunning one is not possible.
    expect(Math.abs(route.dirY)).toBeGreaterThan(Math.abs(route.dirX));
  });

  // **The whole point of the cost function.** Over any finite horizon retreating
  // survives at least as long as standing your ground, so a planner ranking on
  // survival walks away from everything, forever.
  it('comes back rather than carrying on away', () => {
    const { threats } = fieldOf([straightShot({ x: 8.5, y: 10 }, 0, 8, 0, 3000)]);
    const route = new DodgeSearch().run(searchFor({ threats }));

    // A run for the horizon would end four or five tiles out. Getting out of
    // the way of one bullet is worth about one.
    expect(route.driftTiles).toBeLessThan(2);
  });

  // **A harder rule than the one geometry gets.** Walking into a wall costs a
  // step; walking into a pool costs health every tick you are in it, with
  // nothing left to dodge — so there is no arrangement of shots for which it is
  // the answer, and the step is refused rather than charged for.
  it('refuses to walk into ground that hurts, and walks out once it is in it', () => {
    const { threats } = fieldOf([straightShot({ x: 8.5, y: 10 }, 0, 8, 0, 3000)]);
    const lavaNorth: DodgeGround = {
      canStand: () => true,
      isDamaging: (_x, y) => y < 10,
      crowdingAt: () => 0,
      contactAt: () => 0,
    };

    const refused = new DodgeSearch().run(searchFor({ threats, ground: lavaNorth }));
    expect(refused.dirY).toBeGreaterThanOrEqual(0);

    // And the other half: every step out of a pool starts inside one, so a
    // character already standing in it has to be able to walk.
    const lavaWest: DodgeGround = {
      canStand: () => true,
      isDamaging: (x) => x <= 10,
      crowdingAt: () => 0,
      contactAt: () => 0,
    };
    const leaving = new DodgeSearch().run(searchFor({ ground: lavaWest }));
    expect(leaving.stepTiles).toBeGreaterThan(0);
    expect(leaving.dirX).toBeGreaterThan(0);
  });

  it('stops a straight run at the edge of a pool rather than pricing it through', () => {
    const lavaNorth: DodgeGround = {
      canStand: () => true,
      isDamaging: (_x, y) => y < 9.5,
      crowdingAt: () => 0,
      contactAt: () => 0,
    };
    // A wall of fire that leaves running north as the only way out, which the
    // pool then takes away.
    const { threats } = fieldOf(wallOfFire(), { reachTiles: 10 });

    const route = new DodgeSearch().run(
      searchFor({ threats, ground: lavaNorth, maxExpansions: 16 }),
    );

    expect(route.dirY).toBeGreaterThanOrEqual(0);
  });

  it('refuses a step into a wall and finds the way that is open', () => {
    const wallNorth: DodgeGround = {
      canStand: (_x, y) => y > 9.6,
      isDamaging: () => false,
      crowdingAt: () => 0,
      contactAt: () => 0,
    };
    const { threats } = fieldOf([straightShot({ x: 8.5, y: 10 }, 0, 8, 0, 3000)]);
    const route = new DodgeSearch().run(searchFor({ threats, ground: wallNorth }));

    expect(route.impactMs).toBe(Infinity);
    // South is the only side left, and `y` counts downwards on this map.
    expect(route.dirY).toBeGreaterThan(0);
  });

  // **The pattern a straight course cannot describe, and the reason this is a
  // search at all.** Two ranks with their gaps offset have no straight line
  // through them; the way out is a step into the first gap and a step across
  // into the second.
  it('threads two ranks whose gaps do not line up', () => {
    const shots: DodgeShot[] = [];
    // A rank arriving at about 250 ms with a gap at y = 11, and one behind it
    // arriving at about 600 ms with a gap at y = 9.
    for (let y = 6; y <= 14; y += 1) {
      if (y !== 11) shots.push(straightShot({ x: 8, y }, 0, 8, 0, 3000));
      if (y !== 9) shots.push(straightShot({ x: 5.2, y }, 0, 8, 0, 3000));
    }
    const { threats } = fieldOf(shots, { reachTiles: 8 });

    const route = new DodgeSearch().run(searchFor({ threats, maxExpansions: 1500 }));

    expect(route.impactMs).toBe(Infinity);
    expect(route.depth).toBe(8);
  });

  // Their own ground is the line they are walking, not the place they started —
  // otherwise the planner spends a fight pulling a walking player backwards.
  it('follows the line the player is walking when they are steering', () => {
    const request = searchFor({ anchorStepX: 0.6, anchorStepY: 0 });
    const route = new DodgeSearch().run(request);

    // Nothing in the air, so the cheapest thing to do is keep up with the
    // anchor, which is walking east.
    expect(route.dirX).toBeCloseTo(1, 3);
    expect(route.driftTiles).toBeLessThan(0.3);
    expect(endOf(request, route.dirX, route.dirY, 1).x).toBeGreaterThan(10);
  });

  // Priced rather than forbidden, so the answer to a fight with no way out is
  // the route that is hit latest instead of an empty open list.
  it('still answers when everything is hit', () => {
    const shots: DodgeShot[] = [];
    for (let y = 4; y <= 16; y += 0.5) shots.push(straightShot({ x: 9.4, y }, 0, 12, 0, 3000));
    const { threats } = fieldOf(shots, { reachTiles: 8 });

    const route = new DodgeSearch().run(searchFor({ threats }));

    expect(route.impactMs).toBeLessThan(Infinity);
    expect(Number.isFinite(route.cost)).toBe(true);
  });

  // **The seeds are what a small budget spends itself on turning.** Without
  // them the search has to walk out from the character's own feet to reach any
  // depth at all, and in a saturated field that is the whole budget — which is
  // how four sources converging on one spot came to be answered by standing in
  // the middle of them.
  it('reaches the horizon on a budget too small to walk there', () => {
    const shots: DodgeShot[] = [];
    for (let rank = 0; rank < 5; rank += 1) {
      for (let y = 7; y <= 13; y += 0.8) {
        shots.push(straightShot({ x: 5 - rank * 1.1, y }, 0, 8, 0, 4000));
      }
    }
    const { threats } = fieldOf(shots, { reachTiles: 9 });

    // Four expansions cannot walk eight steps out from the start on their own.
    const route = new DodgeSearch().run(searchFor({ threats, maxExpansions: 4 }));

    expect(route.depth).toBe(8);
    expect(route.stepTiles).toBeGreaterThan(0);
  });

  it('answers with what it has when the budget runs out', () => {
    const shots: DodgeShot[] = [];
    for (let y = 4; y <= 16; y += 0.6) shots.push(straightShot({ x: 8, y }, 0, 6, 0, 3000));
    const { threats } = fieldOf(shots, { reachTiles: 8 });

    const route = new DodgeSearch().run(searchFor({ threats, maxExpansions: 20 }));

    expect(route.expansions).toBeLessThanOrEqual(20);
    expect(Number.isFinite(route.cost)).toBe(true);
  });

  /**
   * A band of fire closing from both sides, several ranks deep.
   *
   * Nothing inside it survives and nothing along it escapes — the ranks are
   * faster than the character either way — so the only answer is out of the
   * side, and it is several steps further than a small budget can look.
   */
  function wallOfFire(): DodgeShot[] {
    const shots: DodgeShot[] = [];
    for (let rank = 0; rank < 6; rank += 1) {
      for (let y = 8.5; y <= 11.5; y += 0.7) {
        shots.push(straightShot({ x: 4 - rank * 1.2, y }, 0, 8, 0, 4000));
        shots.push(straightShot({ x: 16 + rank * 1.2, y }, Math.PI, 8, 0, 4000));
      }
    }
    return shots;
  }

  // **The failure this was built to answer, and it is not a tuning matter.**
  // When a pattern is wide enough that everywhere nearby is hit, every first
  // step ties — they are all hit at the same moment — and A* has to expand the
  // whole tie before the depth where running clear starts to pay. Measured on
  // four sources converging on one spot, the character stood in the middle of
  // it and was hit for half of an eight-second fight.
  it('runs clear of a wall the budget could never search through', () => {
    const { threats } = fieldOf(wallOfFire(), { reachTiles: 10 });

    const route = new DodgeSearch().run(searchFor({ threats, maxExpansions: 16 }));

    // A complete answer rather than however far a partial search happened to
    // get, which is the whole of what changed.
    expect(route.depth).toBe(8);
    expect(route.impactMs).toBe(Infinity);
    // Out of the side of the band, because neither way along it is quick
    // enough to matter.
    expect(Math.abs(route.dirY)).toBeGreaterThan(Math.abs(route.dirX));
  });

  // The run is a handful of extra candidates priced on the search's own terms,
  // not a second planner beside it — so when the search can afford an answer of
  // its own, that answer is the one that stands.
  it('lets the search overrule the run when it can afford to', () => {
    const { threats } = fieldOf([straightShot({ x: 8.5, y: 10 }, 0, 8, 0, 3000)]);
    const search = new DodgeSearch();

    const budgeted = { ...search.run(searchFor({ threats, maxExpansions: 4 })) };
    const searched = search.run(searchFor({ threats, maxExpansions: 600 }));

    expect(searched.impactMs).toBe(Infinity);
    expect(searched.cost).toBeLessThanOrEqual(budgeted.cost + 1e-9);
  });

  // The danger field shifts a little every plan, so two near-equal routes swap
  // places on noise — which looks like, and is, a character vibrating.
  it('finishes the sidestep it started rather than swapping sides on noise', () => {
    const { threats } = fieldOf([straightShot({ x: 8.5, y: 10 }, 0, 8, 0, 3000)]);
    const search = new DodgeSearch();

    // Copied out, because the route is one record the search rewrites in place.
    const first = { ...search.run(searchFor({ threats })) };
    const held = search.run(
      searchFor({ threats, holdDirX: -first.dirX, holdDirY: -first.dirY, holdBias: 4 }),
    );

    // With a large enough thumb on the scale the held side wins, which is what
    // proves the term reaches the decision at all.
    expect(held.dirY * first.dirY).toBeLessThan(0);
  });

  it('leaves nothing of the last run behind when it is reset', () => {
    const search = new DodgeSearch();
    const { threats } = fieldOf([straightShot({ x: 8.5, y: 10 }, 0, 8, 0, 3000)]);
    search.run(searchFor({ threats }));
    search.reset();

    const route = search.run(searchFor());
    expect(route.stepTiles).toBe(0);
  });
});

describe('the emergency step', () => {
  function hopFor(overrides: Partial<HopRequest> = {}): HopRequest {
    const empty = fieldOf([]);
    return {
      x: 10,
      y: 10,
      anchorX: 10,
      anchorY: 10,
      tiles: MAX_HOP_TILES,
      headings: 12,
      safeClearanceTiles: 0.25,
      ground: OPEN_GROUND,
      threats: empty.threats,
      blasts: undefined,
      leadMs: 0,
      tickMs: 100,
      ...overrides,
    };
  }

  /** A monster of the ordinary size standing at a place, and its bubble. */
  function bodyAt(x: number, y: number, keepAwayTiles = 2.5): DodgeGround {
    const bodies = new EnemyBodies();
    bodies.collect([{ x, y } as EntityView], x, y, 40, (enemy) => ({
      x: enemy.x,
      y: enemy.y,
      velocityX: 0,
      velocityY: 0,
      halfTiles: ENEMY_CONTACT_HALF_TILES,
    }));
    return {
      canStand: () => true,
      isDamaging: () => false,
      crowdingAt: (px, py, aheadMs) => bodies.crowdingAt(px, py, keepAwayTiles, aheadMs),
      contactAt: (px, py, aheadMs) => bodies.contactAt(px, py, aheadMs),
    };
  }

  it('says nothing when standing still is already as good as anywhere', () => {
    expect(chooseHop(hopFor())).toBeUndefined();
  });

  // **A hop is instant, so unlike a step there is no moment in which the
  // planner could change its mind about the landing.** Into a body is contact
  // damage and a shot fired from nowhere, which is the thing it was reached for.
  it('never lands inside a monster', () => {
    const { threats } = fieldOf([straightShot({ x: 9.6, y: 10 }, 0, 8, 0, 3000)]);
    // Squarely on the northern landing places.
    const hop = chooseHop(hopFor({ threats, ground: bodyAt(10, 9.4) }));

    expect(hop).toBeDefined();
    expect(hop?.offsetY).toBeGreaterThan(0);
  });

  // Getting out from under a monster is what half the hops are for, so among
  // landing places a shot misses equally, the one that is not inside a body
  // wins — where ranking on their own ground alone would hop the shortest
  // distance, which is back where the monster is.
  it('breaks away from a body when the shots leave it a choice', () => {
    const ground = bodyAt(10.3, 10);
    const standing = ground.crowdingAt(10, 10, 0);

    const hop = chooseHop(hopFor({ ground }));

    expect(hop).toBeDefined();
    // Further out than it was, and out of the body altogether — which is the
    // whole of what a hop away from a monster is for.
    expect(hop?.crowdingTiles).toBeLessThan(standing);
    expect(ground.contactAt(10 + (hop?.offsetX ?? 0), 10 + (hop?.offsetY ?? 0), 0)).toBe(0);
  });

  it('lands clear of a shot it can get out from under', () => {
    // Passing a little to the north, so seven tenths of a tile south of it is
    // room to spare — which is what a hop has to spend.
    const { threats } = fieldOf([straightShot({ x: 9.6, y: 9.8 }, 0, 8, 0, 3000)]);
    const hop = chooseHop(hopFor({ threats }));

    expect(hop).toBeDefined();
    expect(hop?.clearanceTiles).toBeGreaterThan(0);
    // Across the line, because along it is where the shot is going.
    expect(hop?.offsetY).toBeGreaterThan(Math.abs(hop?.offsetX ?? 0));
  });

  // **One frame of walking is seven tenths of a tile and a standard shot needs
  // seven tenths and a bit**, so a bullet coming straight down the middle cannot
  // be fully stepped out of in one frame. That is a fact about the game and not
  // a bug here — what the hop is for is turning the hit into the nearest thing
  // to a miss the character can reach, and the plan twenty milliseconds later
  // walks the rest of the way.
  it('takes the best it can reach when it cannot get clear at all', () => {
    const { threats } = fieldOf([straightShot({ x: 9.6, y: 10 }, 0, 8, 0, 3000)]);
    const standing = threats.clearanceOf(0, 10, 10, 10, 10);

    const hop = chooseHop(hopFor({ threats }));

    expect(hop).toBeDefined();
    expect(hop?.clearanceTiles).toBeGreaterThan(standing);
    expect(Math.abs(hop?.offsetY ?? 0)).toBeGreaterThan(Math.abs(hop?.offsetX ?? 0));
  });

  it('never asks for more than one frame of the module can carry', () => {
    const { threats } = fieldOf([straightShot({ x: 9.6, y: 10 }, 0, 8, 0, 3000)]);
    const hop = chooseHop(hopFor({ threats, tiles: 40 }));

    expect(Math.hypot(hop?.offsetX ?? 0, hop?.offsetY ?? 0)).toBeLessThanOrEqual(
      MAX_HOP_TILES + 1e-9,
    );
  });

  // A hop out of a shot and into lava is not an escape, and unlike a walk there
  // is no next step to take back out before the ground bites.
  it('refuses to land in a wall or on ground that hurts', () => {
    const { threats } = fieldOf([straightShot({ x: 9.6, y: 10 }, 0, 8, 0, 3000)]);
    const lavaNorth: DodgeGround = {
      canStand: () => true,
      isDamaging: (_x, y) => y < 10,
      crowdingAt: () => 0,
      contactAt: () => 0,
    };
    const hop = chooseHop(hopFor({ threats, ground: lavaNorth }));

    expect(hop).toBeDefined();
    expect(hop?.offsetY).toBeGreaterThan(0);
  });

  // The one thing a hop that only looked one tick ahead gets wrong: it clears
  // the shot arriving now and lands under the one behind it.
  it('does not land under the rank behind the one it is dodging', () => {
    const shots: DodgeShot[] = [straightShot({ x: 9.6, y: 10 }, 0, 8, 0, 3000)];
    // A second wave arriving a tick later, covering everything north.
    for (let y = 8; y <= 9.8; y += 0.4) shots.push(straightShot({ x: 8.6, y }, 0, 8, 0, 3000));
    const { threats } = fieldOf(shots);

    const hop = chooseHop(hopFor({ threats }));

    expect(hop).toBeDefined();
    expect(hop?.offsetY).toBeGreaterThan(0);
  });

  it('counts a blast landing in the window as taking the ground', () => {
    const { threats } = fieldOf([straightShot({ x: 9.6, y: 10 }, 0, 8, 0, 3000)]);
    const blasts = new Blasts();
    // Covering everything north of the player, landing inside the next tick.
    blasts.collect([{ x: 10, y: 9, radiusTiles: 1.2, armsAtMs: 80 }], 0, 10, 10, 6, 800);

    const hop = chooseHop(hopFor({ threats, blasts }));

    expect(hop).toBeDefined();
    expect(hop?.offsetY).toBeGreaterThan(0);
  });
});

/**
 * What a plan costs, and the shape of screen that decides it.
 *
 * **A plan happens fifty times a second, so the worst one is what matters.** The
 * ordinary case is answered by the probe and never opens the search at all — a
 * few microseconds — and what is measured here is the case that does: a screen
 * with six ranks of fire on it and no straight line through any of them.
 *
 * The bounds are deliberately several times the measured figure. What they are
 * for is catching the kind of regression that costs an order of magnitude — an
 * index that stops pruning, a budget that stops bounding — rather than pinning a
 * number to whatever machine happens to run them.
 */
describe('what a plan costs', () => {
  /** A screen full of fire: six ranks with their gaps offset, closing head-on. */
  function bulletHell(): DodgeShot[] {
    const shots: DodgeShot[] = [];
    for (let rank = 0; rank < 6; rank += 1) {
      for (let y = 4; y <= 16; y += 1) {
        if ((y + rank) % 4 === 0) continue;
        shots.push(straightShot({ x: 2 - rank * 1.4, y }, 0, 8, 0, 3000));
      }
    }
    return shots;
  }

  function settingsFor(preset: DodgePresetId): DodgeSettings {
    return {
      ...DODGE_PRESETS[preset],
      leadMs: 60,
      hopEnabled: true,
      hopTiles: MAX_HOP_TILES,
      hopCooldownMs: 400,
    };
  }

  /** Milliseconds per plan, once the compiler has settled. */
  function costOf(settings: DodgeSettings, shots: readonly DodgeShot[], runs: number): number {
    const planner = new DodgePlanner();
    const base = {
      x: 10,
      y: 10,
      intentX: 0,
      intentY: 0,
      speedTilesPerSecond: 5.52,
      nowMs: 1_000_000,
      onDamagingGround: false,
    };
    for (let i = 0; i < 200; i += 1) {
      planner.plan({ ...base, gameTimeMs: i }, settings, OPEN_GROUND, shots);
    }

    const started = performance.now();
    for (let i = 0; i < runs; i += 1) {
      planner.plan(
        { ...base, gameTimeMs: 400 + (i % 200), nowMs: base.nowMs + i * 20 },
        settings,
        OPEN_GROUND,
        shots,
      );
    }
    return (performance.now() - started) / runs;
  }

  it('costs almost nothing when there is nothing to answer', () => {
    // The whole of why fifty plans a second is affordable: the probe settles it.
    expect(costOf(settingsFor(DodgePresetId.Balanced), [], 2000)).toBeLessThan(0.2);
  });

  it('stays inside a few milliseconds on a screen full of fire', () => {
    const shots = bulletHell();
    expect(shots.length).toBeGreaterThan(50);
    expect(costOf(settingsFor(DodgePresetId.Balanced), shots, 250)).toBeLessThan(12);
    expect(costOf(settingsFor(DodgePresetId.Cautious), shots, 250)).toBeLessThan(20);
  });

  // The budget is the guarantee: what a plan costs is bounded by how hard it was
  // told to think, and not by how much is on the screen.
  it('never expands more than it was given', () => {
    const settings = { ...settingsFor(DodgePresetId.Balanced), maxExpansions: 120 };
    const planner = new DodgePlanner();
    const plan = planner.plan(
      {
        x: 10,
        y: 10,
        intentX: 0,
        intentY: 0,
        speedTilesPerSecond: 5.52,
        gameTimeMs: 500,
        nowMs: 1_000_000,
        onDamagingGround: false,
      },
      settings,
      OPEN_GROUND,
      bulletHell(),
    );

    expect(plan.expansions).toBeLessThanOrEqual(120);
  });
});
