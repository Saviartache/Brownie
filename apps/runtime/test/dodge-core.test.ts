/**
 * The dodge's machinery: the prediction, the field it is bucketed into, the
 * shapes it is recognised as, the gaps that follow from those, the arithmetic
 * that ranks a future, and the optimizer that puts the five together.
 *
 * **Apart from `dodge.test.ts` because these are different questions.** That
 * file asks what the planner should *do* — leave me alone, step aside, come
 * back — and answers it through the planner and the plugin. This one asks
 * whether the parts underneath are correct on their own, which is where a
 * mistake is invisible from the outside: a grid that misses an overlap, a
 * recogniser that reads a checkerboard as a spiral, a ladder whose rungs are in
 * the wrong order. The last of those is the one that matters most, because a
 * mis-ordered ladder does not crash — it quietly trades a paralyse for a pellet.
 */

import { describe, expect, it } from 'vitest';
import type { Position } from '@brownie/plugin-api';

import { AttackPatterns, PatternKind } from '../src/features/dodge/AttackPatterns.js';
import { DangerField, NO_DANGER_TILES } from '../src/features/dodge/DangerField.js';
import { DodgePlanner, type DodgeSettings } from '../src/features/dodge/DodgePlanner.js';
import { DODGE_PRESETS } from '../src/features/dodge/dodgePresets.js';
import { walkableBetween, type DodgeGround } from '../src/features/dodge/DodgeGround.js';
import { PocketLock } from '../src/features/dodge/PocketLock.js';
import {
  ShotField,
  UNKNOWN_SHOT_DAMAGE,
  type DodgeShot,
  type ShotFieldOptions,
} from '../src/features/dodge/ShotField.js';
import {
  TrajectoryPlanner,
  MIN_WALK_TILES,
  type TrajectoryRequest,
} from '../src/features/dodge/TrajectoryPlanner.js';
import {
  COLLISION_PER_TICK,
  DEBUFF_PER_SEVERITY,
  decisionCost,
  stepCost,
  type TrajectoryStep,
  type TrajectoryWeights,
} from '../src/features/dodge/TrajectoryScore.js';
import { PLAYER_HALF_TILES } from '../src/features/dodge/hitbox.js';

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
    expiresAtMs: firedAtMs + lifetimeMs,
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

/** The horizon the tests below step on, unless one says otherwise. */
const HORIZON = {
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
} as const satisfies ShotFieldOptions;

/** Shots and a field over them, which is how the optimizer always sees them. */
function fieldOf(
  shots: readonly DodgeShot[],
  overrides: Partial<ShotFieldOptions> = {},
): { predicted: ShotField; danger: DangerField } {
  const options = { ...HORIZON, ...overrides };
  const predicted = new ShotField();
  predicted.build(shots, options);
  const danger = new DangerField();
  danger.build(predicted, {
    centreX: options.selfX,
    centreY: options.selfY,
    reachTiles: options.reachTiles,
    interestTiles: 0.3,
  });
  return { predicted, danger };
}

/** Nothing in the way, nothing that hurts, nobody to bump into. */
const OPEN_GROUND: DodgeGround = {
  canStand: () => true,
  hazardGapTiles: () => Infinity,
  crowdingAt: () => 0,
  contactAt: () => 0,
};

const WEIGHTS: TrajectoryWeights = {
  anchorPerTile: 1,
  dpsRadiusTiles: 0.2,
  dpsPerTick: 0.6,
  travelPerTile: 0.4,
  hopPerUse: 0.25,
  turnPerReversal: 0.18,
  safeClearanceTiles: 0.25,
  riskPerTile: 10,
  crowdPerTile: 2.5,
  hazardPerTile: 60,
  hazardClearTiles: 0.5,
};

function planFor(overrides: Partial<TrajectoryRequest> = {}): TrajectoryRequest {
  const empty = fieldOf([]);
  return {
    startX: 10,
    startY: 10,
    anchorX: 10,
    anchorY: 10,
    anchorStepX: 0,
    anchorStepY: 0,
    // A place rather than a ring, which is what nought here means and what
    // every test below but the orbiting ones is about.
    orbitX: 0,
    orbitY: 0,
    orbitTiles: 0,
    stepTiles: 0.6,
    hopTiles: 0.7,
    ticks: 8,
    tickMs: 100,
    leadMs: 0,
    headings: 12,
    weights: WEIGHTS,
    holdDirX: 0,
    holdDirY: 0,
    ground: OPEN_GROUND,
    danger: empty.danger,
    blasts: undefined,
    pockets: undefined,
    budget: 600,
    ...overrides,
  };
}

describe('where the shots will be', () => {
  it('samples on the instants the horizon steps between', () => {
    const { predicted } = fieldOf([straightShot({ x: 10, y: 4 }, Math.PI / 2, 10, 0, 900)]);

    expect(predicted.count).toBe(1);
    expect(predicted.slices).toBe(9);
    // Ten tiles a second, sampled every hundred milliseconds: one tile a slice.
    expect(predicted.yOf(0, 0)).toBeCloseTo(4, 6);
    expect(predicted.yOf(0, 3)).toBeCloseTo(7, 6);
    expect(predicted.timeOf(3)).toBe(300);
  });

  it('widens a shot in proportion to how far ahead it is asked about', () => {
    const { predicted } = fieldOf([straightShot({ x: 10, y: 4 }, Math.PI / 2, 10, 0, 900)], {
      driftTilesPerSecond: 1,
    });

    // A tile of doubt a second, so slice five is half a tile wider than slice
    // nought — which is the honest shape of a prediction nobody can check.
    expect(predicted.halfOf(0, 5) - predicted.halfOf(0, 0)).toBeCloseTo(0.5, 6);
  });

  it('distrusts a shot the model does not claim to describe several times as fast', () => {
    const straight = fieldOf([straightShot({ x: 10, y: 4 }, Math.PI / 2, 10, 0, 900)], {
      driftTilesPerSecond: 0.2,
    });
    const curling = fieldOf(
      [straightShot({ x: 10, y: 4 }, Math.PI / 2, 10, 0, 900, { motionModelled: false })],
      { driftTilesPerSecond: 0.2 },
    );

    const grown = (field: ShotField): number => field.halfOf(0, 8) - field.halfOf(0, 0);
    expect(grown(curling.predicted)).toBeGreaterThan(grown(straight.predicted) * 2.5);
  });

  it('stops where the shot stops existing', () => {
    const { predicted } = fieldOf([straightShot({ x: 10, y: 4 }, Math.PI / 2, 10, 0, 350)]);

    // Live at 0, 100, 200 and 300; gone at 400, and there is no ghost parked at
    // its last position.
    expect(predicted.liveToOf(0)).toBe(3);
    // Half of the step it dies in, which is the tile a monster's range ends on.
    expect(predicted.endFractionOf(0)).toBeCloseTo(0.5, 6);
    expect(predicted.endYOf(0)).toBeCloseTo(7.5, 6);
  });

  it('carries what each shot costs, and what it does besides', () => {
    const { predicted } = fieldOf([
      straightShot({ x: 10, y: 4 }, Math.PI / 2, 10, 0, 900, {
        damage: 240,
        debuffSeverity: 0.7,
        ownerId: 77,
      }),
      straightShot({ x: 10, y: 5 }, Math.PI / 2, 10, 0, 900),
    ]);

    expect(predicted.damageOf(0)).toBe(240);
    expect(predicted.debuffOf(0)).toBeCloseTo(0.7, 6);
    expect(predicted.ownerOf(0)).toBe(77);
    // A shot whose data states nothing is an ordinary shot, not a harmless one.
    expect(predicted.damageOf(1)).toBe(UNKNOWN_SHOT_DAMAGE);
    expect(predicted.debuffOf(1)).toBe(0);
  });

  it('drops what could never come near, and counts what it looked at', () => {
    const { predicted } = fieldOf([
      straightShot({ x: 40, y: 40 }, 0, 4, 0, 900),
      straightShot({ x: 10, y: 4 }, Math.PI / 2, 10, 0, 900),
    ]);

    expect(predicted.considered).toBe(2);
    expect(predicted.count).toBe(1);
  });

  it('does not drop a wide shot for the distance to its centre', () => {
    // Five tiles from middle to edge, sitting still eight tiles away: its centre
    // is out of reach and the player is standing inside it.
    const wide = straightShot({ x: 18, y: 10 }, 0, 0, 0, 900, {
      collisionHalfTiles: 5,
      maxSpeedTilesPerSecond: 0,
    });
    expect(fieldOf([wide]).predicted.count).toBe(1);
  });

  it('ignores a shot the game gives no collision at all', () => {
    const telegraph = straightShot({ x: 10, y: 9 }, Math.PI / 2, 4, 0, 900, {
      collisionHalfTiles: 0,
    });
    expect(fieldOf([telegraph]).predicted.count).toBe(0);
  });
});

describe('the space-time danger field', () => {
  it('says nothing is near when nothing is', () => {
    const { danger } = fieldOf([]);
    expect(danger.clearanceOf(0, 10, 10, 10.5, 10)).toBe(NO_DANGER_TILES);
  });

  it('catches a shot that crosses the player between two samples', () => {
    // Forty tiles a second is four tiles a slice: it is three tiles short at
    // one sample and a tile past at the next, and overlaps nothing at either.
    const fast = straightShot({ x: 10, y: 7 }, Math.PI / 2, 40, 0, 900);
    const { danger } = fieldOf([fast]);
    expect(danger.clearanceOf(0, 10, 10, 10, 10)).toBeLessThan(0);
  });

  it('reports a distance, so a wide miss and a graze are different answers', () => {
    const grazing = fieldOf([straightShot({ x: 10.78, y: 7 }, Math.PI / 2, 10, 0, 900)]);
    const wide = fieldOf([straightShot({ x: 10.95, y: 7 }, Math.PI / 2, 10, 0, 900)]);

    const near = grazing.danger.clearanceOf(3, 10, 10, 10, 10);
    const far = wide.danger.clearanceOf(3, 10, 10, 10, 10);
    expect(near).toBeGreaterThan(0);
    expect(far).toBeGreaterThan(near);
  });

  it('takes the worst of everything in reach, not the first of them', () => {
    const { danger } = fieldOf([
      straightShot({ x: 10.95, y: 7 }, Math.PI / 2, 10, 0, 900),
      straightShot({ x: 10.78, y: 7 }, Math.PI / 2, 10, 0, 900),
    ]);
    const alone = fieldOf([straightShot({ x: 10.78, y: 7 }, Math.PI / 2, 10, 0, 900)]);

    expect(danger.clearanceOf(3, 10, 10, 10, 10)).toBeCloseTo(
      alone.danger.clearanceOf(3, 10, 10, 10, 10),
      6,
    );
  });

  it('says what landed, and takes the worst of those too', () => {
    const { danger } = fieldOf([
      straightShot({ x: 10, y: 7 }, Math.PI / 2, 10, 0, 900, { damage: 30, debuffSeverity: 0 }),
      straightShot({ x: 10, y: 7 }, Math.PI / 2, 10, 0, 900, { damage: 90, debuffSeverity: 0.4 }),
    ]);

    expect(danger.clearanceOf(3, 10, 10, 10, 10)).toBeLessThan(0);
    expect(danger.worstDamage).toBe(90);
    expect(danger.worstDebuff).toBeCloseTo(0.4, 5);
    // And a step that nothing lands on says so, rather than leaving the last
    // answer standing for the next caller to read.
    expect(danger.clearanceOf(0, 10, 10, 10, 10)).toBeGreaterThan(0);
    expect(danger.worstDamage).toBe(0);
  });

  it('does not sweep a step a shot no longer exists for', () => {
    // Gone by 250 ms, and its straight line would run over the player at 500.
    const spent = straightShot({ x: 10, y: 5 }, Math.PI / 2, 10, 0, 250);
    const { danger } = fieldOf([spent]);
    expect(danger.clearanceOf(5, 10, 10, 10, 10)).toBe(NO_DANGER_TILES);
  });

  it('sweeps the part of a step the shot lives for', () => {
    // Dies at 350 ms, a third of the way through the step it would land in.
    const expiring = straightShot({ x: 10, y: 6.8 }, Math.PI / 2, 10, 0, 330);
    const { danger } = fieldOf([expiring]);
    expect(danger.clearanceOf(3, 10, 10, 10, 10)).toBeLessThan(0);
  });

  it('stops measuring past the room the caller asked about', () => {
    const options = { ...HORIZON };
    const predicted = new ShotField();
    predicted.build([straightShot({ x: 14, y: 7 }, Math.PI / 2, 10, 0, 900)], options);
    const danger = new DangerField();
    danger.build(predicted, {
      centreX: 10,
      centreY: 10,
      reachTiles: 6,
      interestTiles: 0.3,
    });
    // Four tiles off the line is not a difference anything can act on.
    expect(danger.clearanceOf(3, 10, 10, 10, 10)).toBe(NO_DANGER_TILES);
  });

  // The grid is the whole structure: a bucketing that files a segment into the
  // wrong cell shows up as *missing* overlaps, never as slowness.
  it('agrees with the obvious answer over a screen full of fire', () => {
    let seed = 12345;
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const shots: DodgeShot[] = [];
    for (let i = 0; i < 400; i += 1) {
      const from = { x: 10 + (next() - 0.5) * 24, y: 10 + (next() - 0.5) * 24 };
      // One in nine is a boss shot wide enough to be kept out of the grid, which
      // is the path a uniform bucketing would otherwise never take.
      const collisionHalfTiles = i % 9 === 0 ? 3.5 : 0.5;
      shots.push(
        straightShot(from, next() * Math.PI * 2, 4 + next() * 12, 0, 900, {
          collisionHalfTiles,
        }),
      );
    }
    const { predicted, danger } = fieldOf(shots);
    expect(predicted.count).toBeGreaterThan(50);

    /** The same question, answered by walking every shot. */
    const brute = (slice: number, x: number, y: number): number => {
      let room = NO_DANGER_TILES;
      for (let shot = 0; shot < predicted.count; shot += 1) {
        if (predicted.liveToOf(shot) <= slice) continue;
        const half = Math.max(predicted.halfOf(shot, slice), predicted.halfOf(shot, slice + 1));
        // Standing still, so the closest approach is the nearer of the two ends
        // of the shot's own segment measured the way the game measures.
        const at = (s: number): number =>
          Math.max(Math.abs(predicted.xOf(shot, s) - x), Math.abs(predicted.yOf(shot, s) - y));
        const here = Math.min(at(slice), at(slice + 1)) - half;
        if (here < room) room = here;
      }
      return room;
    };

    for (let probe = 0; probe < 60; probe += 1) {
      const x = 10 + ((probe % 11) - 5) * 0.9;
      const y = 10 + ((probe % 7) - 3) * 1.1;
      const slice = probe % 6;
      const asked = danger.clearanceOf(slice, x, y, x, y);
      const truth = brute(slice, x, y);
      // The grid may only ever be at least as pessimistic as the truth: it
      // sweeps the whole segment where the brute force checks the two ends, and
      // it reports nothing at all past the margin the caller can act on.
      if (truth < 0.25) expect(asked).toBeLessThanOrEqual(truth + 1e-9);
      if (asked < NO_DANGER_TILES) expect(asked).toBeLessThanOrEqual(truth + 1e-9);
    }
  });
});

describe('what a future is worth', () => {
  function step(overrides: Partial<TrajectoryStep> = {}): TrajectoryStep {
    return {
      anchorTiles: 0,
      fromAnchorTiles: 0,
      travelTiles: 0,
      clearanceTiles: NO_DANGER_TILES,
      hitDamage: 0,
      hitDebuff: 0,
      crowdingTiles: 0,
      hazardGapTiles: Infinity,
      ticksLeft: 4,
      ...overrides,
    };
  }

  it('charges for standing away from where the player meant to be', () => {
    const near = stepCost(WEIGHTS, step({ anchorTiles: 0.1, fromAnchorTiles: 0.1 }));
    const far = stepCost(WEIGHTS, step({ anchorTiles: 1.1, fromAnchorTiles: 1.1 }));
    expect(far).toBeGreaterThan(near);
  });

  it('charges a flat price for leaving the ring it can fight from', () => {
    // Two hundredths of a tile apart, either side of the ring. The distance term
    // can account for a fiftieth of the difference; the rest is the step.
    const inside = stepCost(WEIGHTS, step({ anchorTiles: 0.19, fromAnchorTiles: 0.19 }));
    const outside = stepCost(WEIGHTS, step({ anchorTiles: 0.21, fromAnchorTiles: 0.21 }));
    expect(outside - inside).toBeGreaterThan(WEIGHTS.dpsPerTick * 0.9);
  });

  it('gives a step no credit for getting nearer home unless it kept its room', () => {
    // A tight step that closes the gap is charged on the ground it left, so it
    // is worth exactly what standing still was — the way home has to go round.
    const tight = stepCost(
      WEIGHTS,
      step({ anchorTiles: 0.5, fromAnchorTiles: 1.5, clearanceTiles: 0.05 }),
    );
    const stayed = stepCost(
      WEIGHTS,
      step({ anchorTiles: 1.5, fromAnchorTiles: 1.5, clearanceTiles: 0.05 }),
    );
    expect(tight).toBeCloseTo(stayed, 9);
  });

  it('charges for moving at all, so standing still is the default', () => {
    expect(stepCost(WEIGHTS, step({ travelTiles: 0.6 }))).toBeGreaterThan(
      stepCost(WEIGHTS, step()),
    );
  });

  it('puts a hit beyond anything the other terms can buy, and prefers a late one', () => {
    const worst = stepCost(
      WEIGHTS,
      step({ anchorTiles: 40, fromAnchorTiles: 40, travelTiles: 40, crowdingTiles: 4 }),
    );
    const soon = stepCost(WEIGHTS, step({ clearanceTiles: -0.1, ticksLeft: 7 }));
    const late = stepCost(WEIGHTS, step({ clearanceTiles: -0.1, ticksLeft: 0 }));
    expect(late).toBeGreaterThan(worst);
    expect(soon).toBeGreaterThan(late);
  });

  it('ranks the condition a hit carries above the damage it does', () => {
    const heavy = stepCost(WEIGHTS, step({ clearanceTiles: -0.1, hitDamage: 900 }));
    const paralysing = stepCost(
      WEIGHTS,
      step({ clearanceTiles: -0.1, hitDamage: 30, hitDebuff: 1 }),
    );
    expect(paralysing).toBeGreaterThan(heavy);
    // And still under a tick of being hit at all, so between two hits the later
    // one wins whatever it carries.
    expect(DEBUFF_PER_SEVERITY).toBeLessThan(COLLISION_PER_TICK);
  });

  it('ranks a hop below a tile of movement and a reversal below the hop', () => {
    const hop = decisionCost(WEIGHTS, true, 1);
    const reversal = decisionCost(WEIGHTS, false, -1);
    expect(hop).toBeLessThan(WEIGHTS.travelPerTile);
    expect(reversal).toBeLessThan(hop);
    expect(decisionCost(WEIGHTS, false, 1)).toBe(0);
  });
});

describe('what shape the attack is', () => {
  /** A volley from one monster, with everything the packet states. */
  function volley(
    patterns: AttackPatterns,
    atMs: number,
    angle: number,
    over: { count?: number; step?: number; x?: number; y?: number; ownerId?: number } = {},
  ): void {
    patterns.observe({
      ownerId: over.ownerId ?? 1,
      atMs,
      x: over.x ?? 10,
      y: over.y ?? 10,
      angle,
      count: over.count ?? 8,
      angleStep: over.step ?? (2 * Math.PI) / 8,
    });
  }

  it('reads a ring from a single volley, and its gap from the arm count', () => {
    const patterns = new AttackPatterns();
    volley(patterns, 0, 0);
    const reading = patterns.readingOf(1, 0);

    expect(reading?.kind).toBe(PatternKind.Ring);
    expect(reading?.arms).toBe(8);
    expect(reading?.spacingRadians).toBeCloseTo(Math.PI / 4, 6);
    // One volley is not a pattern: nothing has been confirmed by anything.
    expect(reading?.confidence).toBe(0);
  });

  it('reads a shotgun as a cone rather than a fan', () => {
    const patterns = new AttackPatterns();
    volley(patterns, 0, 0, { count: 3, step: 0.2 });
    expect(patterns.readingOf(1, 0)?.kind).toBe(PatternKind.Cone);
  });

  it('finds the turn of a spiral, and which way it is going', () => {
    const patterns = new AttackPatterns();
    const spacing = Math.PI / 4;
    // A twentieth of a gap every two hundred milliseconds, anticlockwise.
    for (let i = 0; i < 5; i += 1) volley(patterns, i * 200, i * (spacing / 20));
    const reading = patterns.readingOf(1, 800);

    expect(reading?.periodMs).toBeCloseTo(200, 3);
    expect(reading?.omegaRadiansPerSecond).toBeCloseTo(spacing / 20 / 0.2, 4);
    expect(reading?.confidence).toBe(1);
    expect(reading?.alternating).toBe(false);

    const other = new AttackPatterns();
    for (let i = 0; i < 5; i += 1)
      other.observe({
        ownerId: 2,
        atMs: i * 200,
        x: 10,
        y: 10,
        angle: -i * (spacing / 20),
        count: 8,
        angleStep: spacing,
      });
    expect(other.readingOf(2, 800)?.omegaRadiansPerSecond).toBeLessThan(0);
  });

  it('reads a checkerboard as alternating rather than as a turn of nothing', () => {
    const patterns = new AttackPatterns();
    const spacing = Math.PI / 4;
    // Half a gap either side, every volley — which averages to no turn at all.
    for (let i = 0; i < 5; i += 1) volley(patterns, i * 200, (i % 2) * (spacing / 2));
    const reading = patterns.readingOf(1, 800);

    expect(reading?.alternating).toBe(true);
    expect(reading?.omegaRadiansPerSecond).toBe(0);
    expect(reading?.confidence).toBeGreaterThan(0);
  });

  it('gives up on a monster that has walked somewhere else', () => {
    const patterns = new AttackPatterns();
    for (let i = 0; i < 5; i += 1) volley(patterns, i * 200, i * 0.05);
    expect(patterns.readingOf(1, 800)?.confidence).toBe(1);

    // Ten tiles away is a different emitter, whatever the object id says.
    volley(patterns, 1000, 0.25, { x: 20, y: 10 });
    expect(patterns.readingOf(1, 1000)?.confidence).toBe(0);
  });

  it('forgets one that has stopped firing', () => {
    const patterns = new AttackPatterns();
    for (let i = 0; i < 4; i += 1) volley(patterns, i * 200, i * 0.05);
    expect(patterns.readingOf(1, 600)).toBeDefined();
    expect(patterns.readingOf(1, 9000)).toBeUndefined();
  });

  it('offers the strongest of what is near, and nothing of what is not', () => {
    const patterns = new AttackPatterns();
    for (let i = 0; i < 4; i += 1) volley(patterns, i * 200, i * 0.05);
    expect(patterns.strongestNear(11, 10, 6, 600)?.ownerId).toBe(1);
    expect(patterns.strongestNear(60, 60, 6, 600)).toBeUndefined();
  });
});

describe('where the gaps will be', () => {
  /** A spiral, as the recogniser would have read one. */
  function spiral(omega: number, arms = 8): AttackPatterns {
    const patterns = new AttackPatterns();
    const spacing = (2 * Math.PI) / arms;
    for (let i = 0; i < 5; i += 1) {
      patterns.observe({
        ownerId: 1,
        atMs: i * 200,
        x: 10,
        y: 10,
        angle: i * omega * 0.2,
        count: arms,
        angleStep: spacing,
      });
    }
    return patterns;
  }

  /** One of that spiral's own shots, so the pockets can read its speed off it. */
  function armShots(firedAtMs: number): DodgeShot[] {
    return [
      straightShot({ x: 10, y: 10 }, 0, 8, firedAtMs, 2000, { ownerId: 1 }),
      straightShot({ x: 10, y: 10 }, Math.PI / 4, 8, firedAtMs, 2000, { ownerId: 1 }),
    ];
  }

  /** What the shots look like at the moment the pockets are worked out. */
  function armField(): ShotField {
    const predicted = new ShotField();
    predicted.build(armShots(800), { ...HORIZON, gameTimeMs: 800, selfX: 14 });
    return predicted;
  }

  const REQUEST = {
    x: 14,
    y: 10,
    withinTiles: 22,
    gameTimeMs: 800,
    leadMs: 0,
    tickMs: 100,
    ticks: 8,
    safeClearanceTiles: 0.25,
    stepTiles: 0.6,
  };

  it('says nothing at all when no pattern has been recognised', () => {
    const pockets = new PocketLock();
    const { predicted } = fieldOf([]);
    pockets.aim(new AttackPatterns(), predicted, REQUEST);
    expect(pockets.locked).toBe(false);
    expect(pockets.slices).toBe(0);
  });

  it('puts the player between two arms rather than on one', () => {
    const patterns = spiral(0.4);
    const pockets = new PocketLock();
    pockets.aim(patterns, armField(), REQUEST);

    expect(pockets.locked).toBe(true);
    // Wherever it aims, it is the same distance from the middle: a pocket is a
    // bearing at the radius the player is already fighting at, not a retreat.
    for (let slice = 0; slice < pockets.slices; slice += 1) {
      expect(Math.hypot(pockets.xOf(slice) - 10, pockets.yOf(slice) - 10)).toBeCloseTo(4, 4);
    }
  });

  it('sweeps the gap the way the pattern turns', () => {
    const angleOf = (omega: number): number[] => {
      const patterns = spiral(omega);
      const pockets = new PocketLock();
      pockets.aim(patterns, armField(), REQUEST);
      const angles: number[] = [];
      for (let slice = 0; slice < pockets.slices; slice += 1) {
        angles.push(Math.atan2(pockets.yOf(slice) - 10, pockets.xOf(slice) - 10));
      }
      return angles;
    };

    const forward = angleOf(0.4);
    const back = angleOf(-0.4);
    expect(forward[forward.length - 1]).toBeGreaterThan(forward[0] ?? 0);
    expect(back[back.length - 1]).toBeLessThan(back[0] ?? 0);
  });

  it('holds the gap it chose rather than picking a new one every plan', () => {
    const patterns = spiral(0.4);
    const predicted = armField();
    const pockets = new PocketLock();

    pockets.aim(patterns, predicted, REQUEST);
    const first = Math.atan2(pockets.yOf(0) - 10, pockets.xOf(0) - 10);
    // A plan later, with the character nudged the way the pocket went.
    pockets.aim(patterns, predicted, { ...REQUEST, gameTimeMs: 820, y: 10.05 });
    const again = Math.atan2(pockets.yOf(0) - 10, pockets.xOf(0) - 10);
    // The same gap, moved on by a fiftieth of a second of the pattern's own
    // turn — not the neighbouring one.
    expect(Math.abs(again - first)).toBeLessThan(Math.PI / 8);
  });

  // **And gives it up once holding it stops being about the character.** A
  // knockback, a second pattern or a wall they were pushed along can leave them
  // whole gaps from the one being ridden, and a waypoint over there is a hint
  // that costs a rollout and points at nothing.
  it('lets go of a gap the fight has carried them away from', () => {
    const patterns = spiral(0.4);
    const predicted = armField();
    const pockets = new PocketLock();
    const spacing = Math.PI / 4;

    pockets.aim(patterns, predicted, REQUEST);
    const held = Math.atan2(pockets.yOf(0) - 10, pockets.xOf(0) - 10);

    // Thrown a third of the way round the ring, which is three gaps: the one
    // being held is now behind them and the arms between are in the way.
    const thrown = Math.atan2(REQUEST.y - 10, REQUEST.x - 10) + spacing * 3;
    pockets.aim(patterns, predicted, {
      ...REQUEST,
      x: 10 + Math.cos(thrown) * 4,
      y: 10 + Math.sin(thrown) * 4,
    });
    const chosen = Math.atan2(pockets.yOf(0) - 10, pockets.xOf(0) - 10);

    expect(pockets.locked).toBe(true);
    // The gap it aims at is one of the ones beside them now, not the one they
    // were standing in three gaps ago.
    expect(Math.abs(chosen - thrown)).toBeLessThan(spacing);
    expect(Math.abs(chosen - held)).toBeGreaterThan(spacing);
  });

  // The other half of the same rule: an arm sweeping past puts the character
  // momentarily nearer the next gap than the one they are riding, and
  // re-choosing there is exactly the twitching the lock exists to stop.
  it('keeps the gap it is riding while an arm sweeps past it', () => {
    const patterns = spiral(0.4);
    const predicted = armField();
    const pockets = new PocketLock();
    const spacing = Math.PI / 4;

    pockets.aim(patterns, predicted, REQUEST);
    const held = Math.atan2(pockets.yOf(0) - 10, pockets.xOf(0) - 10);

    // One gap over, which is where the sweep leaves them for a plan or two.
    const drifted = Math.atan2(REQUEST.y - 10, REQUEST.x - 10) + spacing;
    pockets.aim(patterns, predicted, {
      ...REQUEST,
      x: 10 + Math.cos(drifted) * 4,
      y: 10 + Math.sin(drifted) * 4,
    });
    const again = Math.atan2(pockets.yOf(0) - 10, pockets.xOf(0) - 10);

    expect(Math.abs(again - held)).toBeLessThan(spacing / 2);
  });
});

describe('the optimizer', () => {
  /** How far a plan's first move would carry the character. */
  function lands(request: TrajectoryRequest): Position {
    const planner = new TrajectoryPlanner();
    const answer = planner.run(request);
    return {
      x: request.startX + answer.dirX * answer.stepTiles,
      y: request.startY + answer.dirY * answer.stepTiles,
    };
  }

  it('stands still when there is nothing to answer', () => {
    const answer = new TrajectoryPlanner().run(planFor());
    expect(answer.stepTiles).toBe(0);
    expect(answer.hop).toBe(false);
  });

  it('gets out of the way of a shot that would land on them', () => {
    // **Straight up the y axis, and close enough that waiting is not on
    // offer.** A shot half a second out is answered by holding — see
    // {@link TrajectoryPlanner}'s note on the delayed hold — so what this
    // measures is only the case where something has to happen now.
    const { danger } = fieldOf([
      straightShot({ x: 10, y: 8.8 }, Math.PI / 2, 10, 0, 900, { collisionHalfTiles: 0.15 }),
    ]);
    const answer = new TrajectoryPlanner().run(planFor({ danger }));

    expect(answer.stepTiles).toBeGreaterThan(0);
    expect(answer.impactMs).toBe(Infinity);
    // Sideways, because that is the short way out of a line.
    expect(Math.abs(answer.dirX)).toBeGreaterThan(Math.abs(answer.dirY));
  });

  it('answers a thin lane with a fraction of a tile, not a step', () => {
    // **Two shots and a lane between them, which is what a dense pattern
    // actually is.** Neither side leaves comfortable room at any offset, so the
    // best available is the middle of the gap — and the middle is a twentieth
    // of a tile away. Anything larger gives the room back to the other shot,
    // and a tick of walking overshoots the lane entirely.
    const { danger } = fieldOf([
      straightShot({ x: 9.15, y: 8.8 }, Math.PI / 2, 10, 0, 900),
      straightShot({ x: 10.95, y: 8.8 }, Math.PI / 2, 10, 0, 900),
    ]);
    const answer = new TrajectoryPlanner().run(planFor({ danger }));

    expect(answer.stepTiles).toBeGreaterThan(0);
    expect(answer.stepTiles).toBeLessThan(MIN_WALK_TILES);
    // Towards the wider side, which is where the middle of the lane is.
    expect(answer.dirX).toBeGreaterThan(0);
    // And only the hop can deliver it — a walk of that length is a walk the
    // module rounds away. See {@link MIN_WALK_TILES}.
    expect(answer.hop).toBe(true);
  });

  it('will not spend a hop it has not been given', () => {
    const near = PLAYER_HALF_TILES + 0.5 - 0.18;
    const { danger } = fieldOf([straightShot({ x: 10 - near, y: 8.8 }, Math.PI / 2, 10, 0, 900)]);
    const answer = new TrajectoryPlanner().run(planFor({ danger, hopTiles: 0 }));

    expect(answer.hop).toBe(false);
    // And a walk is never asked for at a length the module cannot deliver.
    if (answer.stepTiles > 0) expect(answer.stepTiles).toBeGreaterThanOrEqual(MIN_WALK_TILES);
  });

  it('comes back rather than carrying on away', () => {
    const request = planFor({ startX: 12, startY: 10, anchorX: 10, anchorY: 10 });
    const at = lands(request);
    expect(at.x).toBeLessThan(12);
  });

  it('refuses to walk into ground that hurts, and walks out once it is in it', () => {
    // A pool everywhere below the line, and the character standing above it.
    const ground: DodgeGround = {
      ...OPEN_GROUND,
      hazardGapTiles: (_x, y) => y - 10,
    };
    // Something coming down the y axis, so the cheap way out would be backwards
    // into the pool if the pool were not refused.
    const { danger } = fieldOf([straightShot({ x: 10, y: 16 }, -Math.PI / 2, 10, 0, 900)]);
    const at = lands(planFor({ startY: 10.6, anchorY: 10.6, ground, danger }));
    expect(at.y).toBeGreaterThanOrEqual(10.6 - 1e-9);
  });

  it('refuses a step into a wall and finds the way that is open', () => {
    // A wall everywhere to the right of the character.
    const ground: DodgeGround = { ...OPEN_GROUND, canStand: (x) => x <= 10.05 };
    const { danger } = fieldOf([straightShot({ x: 10, y: 4 }, Math.PI / 2, 10, 0, 900)]);
    const at = lands(planFor({ ground, danger }));
    expect(at.x).toBeLessThanOrEqual(10.05);
  });

  it('never rolls more futures than it was given', () => {
    const { danger } = fieldOf([
      straightShot({ x: 10, y: 8.8 }, Math.PI / 2, 10, 0, 900, { collisionHalfTiles: 0.15 }),
    ]);
    const answer = new TrajectoryPlanner().run(planFor({ danger, budget: 20 }));
    expect(answer.evaluated).toBeLessThanOrEqual(20);
  });

  it('finishes the sidestep it started rather than swapping sides on noise', () => {
    const planner = new TrajectoryPlanner();
    // Dead level: left and right are exactly as good, so nothing but the
    // commitment can decide it.
    const { danger } = fieldOf([
      straightShot({ x: 10, y: 8.8 }, Math.PI / 2, 10, 0, 900, { collisionHalfTiles: 0.15 }),
    ]);
    const first = planner.run(planFor({ danger }));
    expect(first.stepTiles).toBeGreaterThan(0);

    const again = planner.run(planFor({ danger, holdDirX: first.dirX, holdDirY: first.dirY }));
    expect(again.dirX * first.dirX + again.dirY * first.dirY).toBeGreaterThan(0);
  });

  it('answers with the least-hit future when everything is hit', () => {
    // Four ranks converging on the character from every side.
    const walls: DodgeShot[] = [];
    for (let i = 0; i < 4; i += 1) {
      const angle = (i * Math.PI) / 2;
      for (let n = -6; n <= 6; n += 1) {
        walls.push(
          straightShot(
            {
              x: 10 - Math.cos(angle) * 7 - Math.sin(angle) * n * 0.5,
              y: 10 - Math.sin(angle) * 7 + Math.cos(angle) * n * 0.5,
            },
            angle,
            10,
            0,
            2000,
          ),
        );
      }
    }
    const { danger } = fieldOf(walls);
    const answer = new TrajectoryPlanner().run(planFor({ danger }));
    // There is no way out, and there is still an answer rather than a hang.
    expect(Number.isFinite(answer.cost)).toBe(true);
  });

  it('probes the course the player is already on without deciding anything', () => {
    const planner = new TrajectoryPlanner();
    const { danger } = fieldOf([straightShot({ x: 10, y: 4 }, Math.PI / 2, 10, 0, 900)]);
    const request = planFor({ danger });

    // Standing still walks into it.
    planner.probe(request, 0, 0, 1000);
    expect(planner.probeImpactMs).toBeLessThan(Infinity);
    // Stepping aside does not.
    planner.probe(request, 1, 0, 1000);
    expect(planner.probeImpactMs).toBe(Infinity);
    expect(planner.probeRoomTiles).toBeGreaterThan(0);
  });

  it('reports the room inside the reaction window apart from the room overall', () => {
    const planner = new TrajectoryPlanner();
    // A hair's clearance eight hundred milliseconds out, and nothing before it.
    const late = straightShot({ x: 10.55, y: 2 }, Math.PI / 2, 10, 0, 1200);
    const { danger } = fieldOf([late]);
    planner.probe(planFor({ danger }), 0, 0, 300);

    expect(planner.probeRoomTiles).toBeLessThan(0.1);
    expect(planner.probeUrgentTiles).toBeGreaterThan(planner.probeRoomTiles);
  });
});

/**
 * What a plan costs, at the size the feature is built for.
 *
 * **Measured rather than asserted about**, because every claim in this feature's
 * design is a claim about affordability: the grid instead of a tree, the coarse
 * pass before the fine one, the cull before the prediction, the budget over the
 * candidates. A figure that drifts is the only warning any of those have stopped
 * being true, and the alternative — finding out in a fight — is the thing this
 * was rewritten to stop doing.
 *
 * The bounds are deliberately loose: what they catch is an order of magnitude,
 * which is what a broken cull or a quadratic build actually looks like. A
 * continuous-integration machine under load is not a stopwatch.
 */
describe('what a plan costs', () => {
  /** A repeatable screenful, so a failure is the same failure twice. */
  function screenful(count: number): DodgeShot[] {
    let seed = 987654321;
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const shots: DodgeShot[] = [];
    for (let i = 0; i < count; i += 1) {
      // Half of them across the ground the character can reach, half further
      // out — which is what the cull is for, and what a realm actually looks
      // like when four things are firing at once.
      const spread = i % 2 === 0 ? 14 : 60;
      shots.push(
        straightShot(
          { x: 10 + (next() - 0.5) * spread, y: 10 + (next() - 0.5) * spread },
          next() * Math.PI * 2,
          4 + next() * 14,
          0,
          2000,
          { damage: 40 + Math.round(next() * 200), maxSpeedTilesPerSecond: 18 },
        ),
      );
    }
    return shots;
  }

  /** One whole plan: predict, bucket, roll, choose. */
  function planOnce(shots: readonly DodgeShot[]): number {
    const options = { ...HORIZON, reachTiles: 5 };
    const predicted = new ShotField();
    const danger = new DangerField();
    const planner = new TrajectoryPlanner();

    const started = performance.now();
    predicted.build(shots, options);
    danger.build(predicted, {
      centreX: options.selfX,
      centreY: options.selfY,
      reachTiles: options.reachTiles,
      interestTiles: 0.25,
    });
    planner.run(planFor({ danger, budget: 280 }));
    return performance.now() - started;
  }

  /** The middle of a run, so one unlucky pause does not decide the answer. */
  function typicalMs(shots: readonly DodgeShot[], runs: number): number {
    const taken: number[] = [];
    for (let i = 0; i < runs; i += 1) taken.push(planOnce(shots));
    taken.sort((a, b) => a - b);
    return taken[taken.length >> 1] ?? 0;
  }

  it('costs almost nothing when there is nothing to answer', () => {
    expect(typicalMs([], 200)).toBeLessThan(1);
  });

  it('keeps only the shots that could reach us, whatever is on the screen', () => {
    const predicted = new ShotField();
    predicted.build(screenful(1000), { ...HORIZON, reachTiles: 5 });

    expect(predicted.considered).toBe(1000);
    // **The cull is the whole of what makes a thousand affordable**, and it is
    // the one number that says whether it is still working: everything past it
    // is predicted nine times over and bucketed eight, so a cull that stopped
    // culling would not be slower by a little.
    expect(predicted.count).toBeLessThan(650);
  });

  it('stays inside a few milliseconds on a screen with a thousand shots on it', () => {
    const shots = screenful(1000);
    // Warm, because the first plan of a session grows every table it owns and
    // nothing after it allocates at all — which is the property being asserted
    // as much as the figure is.
    typicalMs(shots, 5);
    // **About five milliseconds on the machine this was written on**, and the
    // bound is loose because a continuous-integration machine under load is not
    // a stopwatch: what it catches is an order of magnitude, which is what a
    // cull that stopped culling or a build that went quadratic looks like.
    //
    // **And it is the worst case rather than the cost of the feature.** Five
    // hundred shots able to reach the character inside a second is a saturated
    // boss phase; the ordinary plan never opens the optimizer at all, because
    // the probe answers it — see `DodgePlanner`.
    expect(typicalMs(shots, 60)).toBeLessThan(12);
  });

  it('never rolls more futures than the budget allows', () => {
    const shots = screenful(1000);
    const options = { ...HORIZON, reachTiles: 5 };
    const predicted = new ShotField();
    predicted.build(shots, options);
    const danger = new DangerField();
    danger.build(predicted, {
      centreX: options.selfX,
      centreY: options.selfY,
      reachTiles: options.reachTiles,
      interestTiles: 0.25,
    });

    const answer = new TrajectoryPlanner().run(planFor({ danger, budget: 24 }));
    expect(answer.evaluated).toBeLessThanOrEqual(24);
    // And it still has an answer, because standing still is candidate nought.
    expect(Number.isFinite(answer.cost)).toBe(true);
  });
});

/**
 * The whole pipeline, on the thing it was built for.
 *
 * **A spiral is the case every stage of this feature exists to answer**, and it
 * is the one case none of them can answer alone: the prediction says where the
 * arms are, the field says which places they take, the recogniser says the whole
 * thing is turning, and the pockets say which way the gap the character is
 * standing in is going. Tested through the planner rather than through the
 * parts, because what is being asserted is that the four agree.
 */
describe('riding a spiral', () => {
  /** How many arms, and how fast the whole thing turns. */
  const ARMS = 12;
  const SPACING = (2 * Math.PI) / ARMS;
  const PERIOD_MS = 250;
  const OMEGA = SPACING / 6 / (PERIOD_MS / 1000);
  const SHOT_SPEED = 8;
  const ORIGIN = { x: 10, y: 10 };

  /** The volleys, as `ENEMYSHOOT` would have announced them. */
  function fired(atMs: number): AttackPatterns {
    const patterns = new AttackPatterns();
    for (let volley = 0; volley * PERIOD_MS <= atMs; volley += 1) {
      const firedAtMs = volley * PERIOD_MS;
      patterns.observe({
        ownerId: 1,
        atMs: firedAtMs,
        x: ORIGIN.x,
        y: ORIGIN.y,
        angle: (OMEGA * firedAtMs) / 1000,
        count: ARMS,
        angleStep: SPACING,
      });
    }
    return patterns;
  }

  /** And the arms themselves, still in flight. */
  function arms(atMs: number): DodgeShot[] {
    const shots: DodgeShot[] = [];
    for (let volley = 0; volley * PERIOD_MS <= atMs; volley += 1) {
      const firedAtMs = volley * PERIOD_MS;
      const base = (OMEGA * firedAtMs) / 1000;
      for (let arm = 0; arm < ARMS; arm += 1) {
        shots.push(
          straightShot(ORIGIN, base + arm * SPACING, SHOT_SPEED, firedAtMs, 2000, {
            ownerId: 1,
            collisionHalfTiles: 0.1,
          }),
        );
      }
    }
    return shots;
  }

  it('recognises the turn and follows the gap round with it', () => {
    const atMs = 1200;
    const patterns = fired(atMs);
    const reading = patterns.readingOf(1, atMs);
    expect(reading?.arms).toBe(ARMS);
    expect(reading?.confidence).toBe(1);
    expect(reading?.omegaRadiansPerSecond).toBeCloseTo(OMEGA, 3);

    // Standing four tiles out, in the middle of a gap — which is where the
    // pockets say to be, and where the arms are not.
    const radius = 4;
    const lag = (radius / SHOT_SPEED) * 1000;
    const angle = (OMEGA * (atMs - lag)) / 1000 + SPACING / 2;
    const pockets = new PocketLock();
    const predicted = new ShotField();
    const options = {
      ...HORIZON,
      gameTimeMs: atMs,
      leadMs: 0,
      selfX: ORIGIN.x + Math.cos(angle) * radius,
      selfY: ORIGIN.y + Math.sin(angle) * radius,
      reachTiles: 5,
    };
    predicted.build(arms(atMs), options);
    pockets.aim(patterns, predicted, {
      x: options.selfX,
      y: options.selfY,
      withinTiles: 22,
      gameTimeMs: atMs,
      leadMs: 0,
      tickMs: 100,
      ticks: 8,
      safeClearanceTiles: 0.25,
      stepTiles: 0.6,
    });

    expect(pockets.locked).toBe(true);
    // The gap it is holding is the one the character is standing in, and it is
    // going round: every waypoint is at the same radius and further along.
    const bearing = (slice: number): number =>
      Math.atan2(pockets.yOf(slice) - ORIGIN.y, pockets.xOf(slice) - ORIGIN.x);
    expect(Math.abs(bearing(0) - angle)).toBeLessThan(SPACING / 2);
    expect(bearing(pockets.slices - 1)).toBeGreaterThan(bearing(0));
    for (let slice = 0; slice < pockets.slices; slice += 1) {
      const at = Math.hypot(pockets.xOf(slice) - ORIGIN.x, pockets.yOf(slice) - ORIGIN.y);
      expect(at).toBeCloseTo(radius, 4);
    }
  });

  it('crosses the arms with the pattern rather than running out through them', () => {
    const atMs = 1200;
    const radius = 4;
    const lag = (radius / SHOT_SPEED) * 1000;
    // Half a gap behind the middle, so the arm behind is closing on them: the
    // answer is to move round with the pattern, not outwards through it.
    const angle = (OMEGA * (atMs - lag)) / 1000 + SPACING * 0.22;
    const at = {
      x: ORIGIN.x + Math.cos(angle) * radius,
      y: ORIGIN.y + Math.sin(angle) * radius,
    };

    const planner = new DodgePlanner();
    const plan = planner.plan(
      {
        x: at.x,
        y: at.y,
        intentX: 0,
        intentY: 0,
        speedTilesPerSecond: 5.52,
        gameTimeMs: atMs,
        nowMs: 1_000_000,
        onDamagingGround: false,
      },
      SPIRAL_SETTINGS,
      OPEN_GROUND,
      arms(atMs),
      [],
      fired(atMs),
    );

    // Whatever it chose, it is not hit and it has not run for the horizon.
    expect(plan.impactMs).toBe(Infinity);
    expect(plan.stepTiles).toBeLessThanOrEqual(0.7 + 1e-9);
    // **And it went round rather than out**, which is the whole of what riding
    // one means: at sixteen arms the corridor between two of them is half a tile
    // wide and the way along it is the way the pattern is turning. Outwards is a
    // wall of arms; inwards the same corridor narrows until it closes.
    const radial = plan.dirX * Math.cos(angle) + plan.dirY * Math.sin(angle);
    const along = -plan.dirX * Math.sin(angle) + plan.dirY * Math.cos(angle);
    expect(Math.abs(along)).toBeGreaterThan(Math.abs(radial));
    // The way it is going, not against it.
    expect(along).toBeGreaterThan(0);
  });
});

/** The planner's own defaults, at the balanced preset. */
const SPIRAL_SETTINGS: DodgeSettings = {
  ...DODGE_PRESETS.balanced,
  leadMs: 60,
  hazardClearTiles: 0.5,
  hopEnabled: true,
  hopTiles: 0.7,
  hopCooldownMs: 400,
};

/**
 * Where it will not put the character, whatever the shots say.
 *
 * **The failure these exist for is the one that shipped.** A candidate whose
 * first step ran into a wall was *rolled* as though it had stood still — which
 * is safe, cheap, and very often the best answer available — and then
 * *commanded* as the step it had not taken. Nothing between the runtime and the
 * character tests the ground on the way: the module is handed an offset and
 * walks along it. So a plan that names a place the body does not fit is a
 * character running into a wall at full speed for as long as the record stands,
 * and the only place that can be stopped is here.
 */
describe('what the ground refuses', () => {
  /** Everything east of `edge` is wall. */
  function wallEastOf(edge: number): DodgeGround {
    return { ...OPEN_GROUND, canStand: (x) => x <= edge };
  }

  /** A pillar one tile wide, which a single step steps clean over. */
  function pillarAt(tileX: number, tileY: number): DodgeGround {
    return {
      ...OPEN_GROUND,
      canStand: (x, y) => Math.floor(x) !== tileX || Math.floor(y) !== tileY,
    };
  }

  /**
   * Every first move the optimizer will make in one situation.
   *
   * The winner alone would pass by luck — what has to hold is that *no*
   * candidate can name unwalkable ground, whichever of them the shots happen to
   * make cheapest.
   */
  function chosen(ground: DodgeGround, danger: DangerField, budget = 600): Position {
    const answer = new TrajectoryPlanner().run(planFor({ ground, danger, budget }));
    return {
      x: 10 + answer.dirX * answer.stepTiles,
      y: 10 + answer.dirY * answer.stepTiles,
    };
  }

  it('never names a place the body does not fit, however it is pressed', () => {
    // Boxed in on three sides, with a shot coming up the one lane that is left:
    // every candidate but a handful is refused, and the cheapest of the refused
    // ones is refused for being safe.
    const ground: DodgeGround = {
      ...OPEN_GROUND,
      canStand: (x, y) => x <= 10.05 && x >= 9.6 && y >= 9.6,
    };
    const { danger } = fieldOf([
      straightShot({ x: 10, y: 8.8 }, Math.PI / 2, 10, 0, 900, { collisionHalfTiles: 0.15 }),
    ]);

    const at = chosen(ground, danger);
    expect(ground.canStand(at.x, at.y)).toBe(true);
  });

  it('will not step over a pillar narrower than the step', () => {
    // A tile of wall due east, between the character and open ground beyond it.
    // Both ends of an eastward step are clear and everything in between is not,
    // which is exactly what sampling only the ends cannot see.
    const ground = pillarAt(10, 9);
    expect(ground.canStand(10.5, 9.5)).toBe(false);
    expect(ground.canStand(11.4, 9.5)).toBe(true);

    expect(walkableBetween(ground, 9.4, 9.5, 11.4, 9.5)).toBe(false);
    // And the ends alone say nothing at all, which is the whole point.
    expect(ground.canStand(9.4, 9.5)).toBe(true);
  });

  it('samples a step closely enough that a body cannot be pulled through', () => {
    // A wall one tile thick, and a step that starts and finishes clear of it.
    const ground = pillarAt(12, 10);
    expect(walkableBetween(ground, 11.4, 10.5, 13.4, 10.5)).toBe(false);
    // A step that stops short of it is still allowed: the rule is about the
    // path, not about the direction.
    expect(walkableBetween(ground, 11.4, 10.5, 11.6, 10.5)).toBe(true);
  });

  // **The shape of the bug this file exists to keep dead.** A refused course is
  // not an expensive course — under every continuation it is the character
  // standing exactly where they were, which is cheap, safe, and often the best
  // answer on the board. Scored that way and commanded as the step it never
  // took, it is a character walking into a wall at full speed.
  it('does not let a refused course become a cheap way of standing still', () => {
    // One heading refused and every other one open: standing still is then only
    // available *through* the wall, so a planner that prices a refused course as
    // standing still has to choose it.
    const closed = Math.PI / 6;
    const ground: DodgeGround = {
      ...OPEN_GROUND,
      canStand: (x, y) => {
        const dx = x - 10;
        const dy = y - 10;
        if (dx * dx + dy * dy < 0.01) return true;
        return Math.abs(Math.atan2(dy, dx) - closed) > 0.2;
      },
    };
    // Dragged off the anchor, with the way back across a shot: walking home
    // costs, so standing still is what the arithmetic wants.
    const { danger } = fieldOf([
      straightShot({ x: 8.6, y: 6 }, Math.PI / 2, 9, 0, 900, { collisionHalfTiles: 0.4 }),
    ]);
    const answer = new TrajectoryPlanner().run(
      planFor({ startX: 10, startY: 10, anchorX: 8.5, anchorY: 10, ground, danger }),
    );

    const at = { x: 10 + answer.dirX * answer.stepTiles, y: 10 + answer.dirY * answer.stepTiles };
    expect(ground.canStand(at.x, at.y)).toBe(true);
    expect(walkableBetween(ground, 10, 10, at.x, at.y)).toBe(true);
  });

  it('holds rather than walking into a wall when holding is the safe answer', () => {
    // Nothing in the air at all, and a wall a hair to the east. There is nothing
    // to dodge, so the answer is to stand — and the wall must not be able to
    // masquerade as one.
    const { danger } = fieldOf([]);
    const answer = new TrajectoryPlanner().run(planFor({ ground: wallEastOf(10.05), danger }));
    expect(answer.stepTiles).toBe(0);
  });

  it('finds the open side when one side is closed', () => {
    const ground = wallEastOf(10.05);
    const { danger } = fieldOf([
      straightShot({ x: 10, y: 8.8 }, Math.PI / 2, 10, 0, 900, { collisionHalfTiles: 0.15 }),
    ]);
    const at = chosen(ground, danger);

    expect(at.x).toBeLessThanOrEqual(10.05);
    expect(ground.canStand(at.x, at.y)).toBe(true);
  });

  it('will not hop through a wall it could not walk through', () => {
    // A hop is one frame of the character's own movement, not a teleport: the
    // module asks the game to walk there, and the game does not walk through
    // geometry. A landing chosen past a wall is a landing nothing arrives at.
    const ground = pillarAt(10, 10);
    const { danger } = fieldOf([
      straightShot({ x: 9.4, y: 8.8 }, Math.PI / 2, 20, 0, 900, { collisionHalfTiles: 0.15 }),
    ]);
    const answer = new TrajectoryPlanner().run(
      planFor({ startX: 9.9, startY: 9.9, anchorX: 9.9, anchorY: 9.9, ground, danger }),
    );
    const at = { x: 9.9 + answer.dirX * answer.stepTiles, y: 9.9 + answer.dirY * answer.stepTiles };

    expect(ground.canStand(at.x, at.y)).toBe(true);
    expect(walkableBetween(ground, 9.9, 9.9, at.x, at.y)).toBe(true);
  });
});
