// Where the runtime's time goes on the paths it runs hot.
//
// `CLAUDE.md` asks for measure, optimise, measure again, so the two paths that
// run per game tick — the IPC link to the native module and the proxy's own
// packet handling — each get a number here before a change and the same number
// after it. This asserts nothing and passes nothing: it reports.
//
// Allocation is measured through V8's own GC profiler rather than from a heap
// delta. A delta taken across a run the collector ran during is a number that
// looks precise and is not; the profiler reports the heap on both sides of
// every collection, and what was allocated between them adds up from that. The
// frame and byte count on the wire is exact — it is the point of batching — so
// that is counted rather than derived.
//
//   npm run profile:ipc

import { GCProfiler } from 'node:v8';
import {
  FrameReader,
  Origin,
  createNonce,
  decodeMessage,
  encodeMessage,
  encodeTelemetry,
  sign,
} from '@brownie/ipc';
import { MutablePacket } from '@brownie/plugin-api';
import { CIPHER_OFFSET, CLIENT_KEY, Rc4, decodeFrame, encodePacket } from '@brownie/protocol';
import { createBundledRegistry } from '@brownie/protocol/bundled';
import { LogLevel, Logger } from '../apps/runtime/dist/core/logging/Logger.js';
import { NativeLink } from '../apps/runtime/dist/native/NativeLink.js';
import { StateStage } from '../apps/runtime/dist/pipeline/stages/StateStage.js';
import { PluginHost } from '../apps/runtime/dist/plugins/PluginHost.js';
import { WorldState } from '../apps/runtime/dist/state/WorldState.js';
import { createAutoAimPlugin } from '../apps/runtime/dist/features/autoaim/autoAimPlugin.js';
import { createDodgePlugin } from '../apps/runtime/dist/features/dodge/dodgePlugin.js';

const SECRET = Buffer.alloc(32, 0x5a);
const NATIVE_PID = 4242;
const RUNTIME_PID = 999;

/** Entities a busy realm puts in one NEWTICK, and stats per entity. */
const TICK_ENTITIES = 40;
const TICK_STATS = 4;

/** Entities a busy realm holds, which is what the plugin tick walks. */
const WORLD_ENTITIES = 400;

/** Shots a bullet hell puts in the air, which is what the dodge planner walks. */
const SHOTS_IN_FLIGHT = 60;

/** A bow-like weapon, so auto-aim has a shot to reason about. */
const WEAPON = { speedTilesPerMs: 0.008, lifetimeMs: 750, rateOfFire: 1 };
const WEAPON_PROJECTILE = {
  bulletType: 0,
  speed: 80,
  lifetimeMs: 750,
  damage: 100,
  size: 100,
  wavy: false,
  parametric: false,
  boomerang: false,
  amplitude: 0,
  frequency: 0,
  magnitude: 0,
  acceleration: 0,
  accelerationDelayMs: 0,
  speedClamp: 0,
};

/** Plugins and settings one full overlay sync carries. */
const SYNC_PLUGINS = 12;
const SYNC_SETTINGS = 8;
const SYNC_RUNS = 2000;

const SETTING_RECORD = 'setting|auto-nexus|hpPercent|HP%20percent|range|n|35|1|1|1|99|1|0||combat|';

if (typeof globalThis.gc !== 'function') {
  process.stderr.write('run with --expose-gc, or through `npm run profile:ipc`\n');
  process.exit(1);
}

const results = [];

/**
 * Bytes allocated while one measurement runs.
 *
 * Everything the heap grew between two collections was allocated, and the
 * profiler reports the heap on both sides of each one — so the sum across the
 * run is what the code under measurement asked for, whatever the collector did
 * about it in the meantime. `external` is the same sum for what lives outside
 * the JS heap, which is where every `Buffer` this project passes around is.
 */
function watchAllocations() {
  const profiler = new GCProfiler();
  profiler.start();
  const start = heapNow();

  return () => {
    const records = profiler.stop().statistics;
    let last = start;
    let heap = 0;
    let external = 0;
    for (const record of records) {
      heap += record.beforeGC.heapStatistics.usedHeapSize - last.heap;
      external += record.beforeGC.heapStatistics.externalMemory - last.external;
      last = {
        heap: record.afterGC.heapStatistics.usedHeapSize,
        external: record.afterGC.heapStatistics.externalMemory,
      };
    }
    const end = heapNow();
    return {
      count: records.length,
      heap: heap + end.heap - last.heap,
      external: external + end.external - last.external,
    };
  };
}

function heapNow() {
  const usage = process.memoryUsage();
  return { heap: usage.heapUsed, external: usage.external };
}

/**
 * @param settle runs after the warm-up and before the timed loop, for a bench
 *   that counts something of its own and must not count the warm-up.
 */
function measure(name, iterations, run, settle) {
  return measureAsync(name, iterations, run, settle, false);
}

/**
 * The same, awaiting each iteration.
 *
 * The link writes what it has queued when the turn ends, so a bench for it has
 * to end the turn — a synchronous loop would measure a batch that never goes
 * out.
 */
async function measureAsync(name, iterations, run, settle, awaited = true) {
  // Warmed, so the numbers describe steady state rather than the optimiser
  // still making up its mind about this code.
  for (let i = 0; i < Math.min(iterations, 2000); i += 1) {
    if (awaited) await run(i);
    else run(i);
  }
  globalThis.gc();
  settle?.();

  const stopWatching = watchAllocations();
  const started = process.hrtime.bigint();
  for (let i = 0; i < iterations; i += 1) {
    if (awaited) await run(i);
    else run(i);
  }
  const elapsedNs = Number(process.hrtime.bigint() - started);
  const allocated = stopWatching();

  results.push({
    name,
    nsPerOp: elapsedNs / iterations,
    opsPerSec: (iterations * 1e9) / elapsedNs,
    gcCount: allocated.count,
    heapPerOp: allocated.heap / iterations,
    externalPerOp: allocated.external / iterations,
  });
}

/** A transport that counts what the link asks it to write. */
class CountingTransport {
  writes = 0;
  bytes = 0;
  closed = false;
  #onData;
  #echo;

  constructor(echo) {
    this.#echo = echo;
  }

  send(data) {
    this.writes += 1;
    this.bytes += data.length;
    this.#echo?.(data);
  }
  onData(listener) {
    this.#onData = listener;
  }
  onClose() {}
  onError() {}
  close() {
    this.closed = true;
  }
  get pending() {
    return 0;
  }
  /** Bytes arriving from the module. */
  receive(chunk) {
    this.#onData?.(chunk);
  }
}

/** Completes the module's half of the handshake, from `docs/ipc.md`. */
function authenticate(link) {
  const reader = new FrameReader();
  const transport = new CountingTransport((data) => reader.push(data));
  link.accept(transport);

  let seq = 0;
  const challenge = createNonce();
  transport.receive(encodeMessage({ kind: 'hello', pid: NATIVE_PID, challenge }, (seq += 1)));

  let authChallenge;
  for (let frame = reader.next(); frame !== null; frame = reader.next()) {
    const message = decodeMessage(frame, Origin.Runtime);
    if (message.kind === 'authChallenge') authChallenge = message;
  }
  if (authChallenge === undefined) throw new Error('the runtime did not answer hello');

  transport.receive(
    encodeMessage(
      {
        kind: 'authResult',
        ok: true,
        response: sign(SECRET, authChallenge.challenge, authChallenge.userId, String(NATIVE_PID)),
      },
      (seq += 1),
    ),
  );
  if (!link.connected) throw new Error('the link did not authenticate');
  return transport;
}

/** A NEWTICK the size a busy realm sends. */
function buildTickFrame(registry) {
  const statuses = [];
  for (let entity = 0; entity < TICK_ENTITIES; entity += 1) {
    const data = [];
    for (let stat = 0; stat < TICK_STATS; stat += 1) {
      data.push({ id: stat, value: 1000 + stat, stackCount: 0 });
    }
    statuses.push({ objectId: entity, position: { x: entity * 1.5, y: entity * 0.5 }, data });
  }
  return encodePacket(registry, {
    id: registry.idOf('NEWTICK'),
    schema: registry.schemaByName('NEWTICK'),
    fields: {
      tickId: 7,
      tickTime: 200,
      serverRealTimeMs: 1234,
      serverLastRttMs: 40,
      statuses,
    },
    trailing: Buffer.alloc(0),
  });
}

// ── The link: Node → native ──────────────────────────────────────────────────

const telemetry = {
  alive: true,
  x: 123.5,
  y: 64.25,
  hp: 812,
  maxHp: 1100,
  defense: 35,
  defenseKnown: true,
  uptimeMs: 60_000,
};

measure('encode controlRecord', 200_000, (i) =>
  encodeMessage({ kind: 'controlRecord', record: SETTING_RECORD }, (i % 0xffff_fffe) + 1),
);

measure('encode setFeature', 200_000, (i) =>
  encodeMessage({ kind: 'setFeature', key: 'dodge.enabled', value: true }, (i % 0xffff_fffe) + 1),
);

// ── The link: native → Node, once per game frame ─────────────────────────────

const telemetryFrame = encodeMessage({ kind: 'playerTelemetry', ...telemetry }, 1);
const telemetryReader = new FrameReader();

measure('decode telemetry frame', 200_000, () => {
  telemetryReader.push(telemetryFrame);
  decodeMessage(telemetryReader.next(), Origin.Native);
});

measure('encode telemetry payload', 500_000, () => encodeTelemetry(telemetry));

// ── One full overlay sync, through the real link ─────────────────────────────

{
  const link = new NativeLink({
    log: Logger.create({ write() {} }, 'profile', LogLevel.Off),
    secret: SECRET,
    userId: 'profile',
    pid: RUNTIME_PID,
  });
  const transport = authenticate(link);

  const records = ['sync-begin'];
  for (let plugin = 0; plugin < SYNC_PLUGINS; plugin += 1) {
    records.push(`plugin|p${String(plugin)}|Plugin%20${String(plugin)}|combat|1|ready||1|`);
    for (let setting = 0; setting < SYNC_SETTINGS; setting += 1) records.push(SETTING_RECORD);
  }
  records.push('sync-end');

  await measureAsync(
    `overlay sync of ${String(records.length)} records`,
    SYNC_RUNS,
    async () => {
      for (const record of records) link.publishRecord(record);
      // One sync is one turn of the event loop, which is the batch boundary.
      await Promise.resolve();
    },
    () => {
      transport.writes = 0;
      transport.bytes = 0;
    },
  );
  results.push({
    name: '  — per sync, on the wire',
    writes: transport.writes / SYNC_RUNS,
    bytes: transport.bytes / SYNC_RUNS,
  });
}

// ── The proxy's own per-packet path ──────────────────────────────────────────

{
  const registry = createBundledRegistry();
  const tickFrame = buildTickFrame(registry);

  measure('decode NEWTICK frame', 20_000, () => decodeFrame(registry, Buffer.from(tickFrame)));

  // One cipher for the run, as a session has: the key schedule is per
  // connection, and paying for it per packet would measure the wrong thing.
  const cipher = new Rc4(CLIENT_KEY);
  const scratch = Buffer.from(tickFrame);
  measure('rc4 one NEWTICK frame', 100_000, () => {
    cipher.process(scratch, CIPHER_OFFSET);
  });

  // ── What a tick costs after it has been decoded ────────────────────────────
  //
  // The two stages that grow with the world rather than with the packet: the
  // state update walks every entity the tick names, and the plugins walk every
  // entity the world holds. Measured with a realm's worth of both, because a
  // feature that is free in an empty map and quadratic in a full one is a
  // feature that only fails where it matters.

  const world = new WorldState({
    objects: {
      isPlayer: () => false,
      isEnemy: () => true,
      occupies: () => false,
      displayName: () => undefined,
      projectile: () => WEAPON_PROJECTILE,
      rateOfFire: () => 1,
    },
  });
  world.markConnected();
  world.self.bind(1);
  world.self.applyStats([
    { id: 0, value: 1000 },
    { id: 1, value: 800 },
    { id: 22, value: 50 },
    { id: 28, value: 50 },
    { id: 8, value: 0x0a00 },
  ]);
  for (let entity = 0; entity < WORLD_ENTITIES; entity += 1) {
    world.entityStore.upsert(1000 + entity, 7, (entity % 40) * 0.7, Math.floor(entity / 40) * 0.7);
    world.entityStore.get(1000 + entity)?.applyStats([{ id: 1, value: 500 }]);
  }

  const state = new StateStage(world);
  const context = { origin: 'server', sessionId: 'profile' };
  // Decoded once, on purpose: what the decode costs is already measured above,
  // and counting it twice would hide whatever this stage does.
  const decodedTick = new MutablePacket(decodeFrame(registry, Buffer.from(tickFrame)));
  measure('apply NEWTICK to the world', 20_000, () => {
    state.handle(decodedTick, context);
  });

  const session = { id: 'profile', self: world.self, world, sendToServer() {}, notify() {} };

  const host = new PluginHost({
    log: Logger.create({ write() {} }, 'profile', LogLevel.Off),
    native: { connected: true, setFeature() {}, onConnected: () => () => {} },
    sessions: {
      current: () => session,
      all: () => [session],
      onConnected: () => () => {},
      onDisconnected: () => () => {},
    },
    onChanged: () => {},
  });

  // **The planners run on their own cadence, not on a packet**, so measuring
  // them means holding the callback they registered rather than dispatching
  // something at them. The host registers through the global, which is the one
  // place to take it from — and a real interval here would run the planners
  // *during* the measurement of something else.
  const plans = [];
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = (fn) => {
    plans.push(fn);
    // Nothing this returns is ever cleared, and `clearInterval` ignores an
    // object it did not create.
    return {};
  };
  try {
    host.load(createDodgePlugin({ moveTo() {} }));
    host.load(createAutoAimPlugin({ output: { aimAt() {} }, weapon: () => WEAPON }));
  } finally {
    globalThis.setInterval = realSetInterval;
  }
  host.setEnabled('auto-dodge', true);
  host.setEnabled('auto-aim', true);

  measure(`plugin tick, ${String(WORLD_ENTITIES)} entities`, 20_000, () => {
    host.dispatchPacket(decodedTick, session);
  });
  measure(`plugin plan, ${String(WORLD_ENTITIES)} entities`, 20_000, () => {
    for (const plan of plans) plan();
  });

  // The same plan with a bullet hell in the air. This is the heaviest thing the
  // runtime does by a wide margin — the dodge planner simulates every shot
  // against every candidate heading — and it is the one number that says
  // whether planning can block the event loop.
  for (let shot = 0; shot < SHOTS_IN_FLIGHT; shot += 1) {
    world.projectileStore.add(WEAPON_PROJECTILE, {
      ownerId: 1000 + (shot % 40),
      bulletId: shot,
      bulletType: 0,
      x: world.self.x + Math.cos(shot) * 4,
      y: world.self.y + Math.sin(shot) * 4,
      angle: Math.PI + shot,
      firedAtMs: world.gameTimeMs,
    });
  }
  measure(`plugin plan, ${String(SHOTS_IN_FLIGHT)} shots in flight`, 5_000, () => {
    for (const plan of plans) plan();
  });
}

// ── Report ───────────────────────────────────────────────────────────────────

for (const row of results) {
  if (row.writes !== undefined) {
    process.stdout.write(
      `${row.name.padEnd(34)} ${row.writes.toFixed(1).padStart(9)} writes` +
        ` ${row.bytes.toFixed(0).padStart(9)} bytes\n`,
    );
    continue;
  }
  process.stdout.write(
    `${row.name.padEnd(34)} ${row.nsPerOp.toFixed(0).padStart(9)} ns/op` +
      ` ${Math.round(row.opsPerSec).toString().padStart(11)} op/s` +
      `  alloc ${row.heapPerOp.toFixed(0).padStart(7)} heap` +
      ` ${row.externalPerOp.toFixed(0).padStart(7)} ext  gc ${String(row.gcCount).padStart(4)}\n`,
  );
}
