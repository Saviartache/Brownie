// What the link to the native module costs, measured against the real module.
//
// An injected module sits inside somebody's game, so its cost is not a
// footnote — it decides whether the game still feels the same with the module
// loaded. This loads the real `d3d11.dll` into the real host and speaks the
// real protocol to it over a real named pipe, then reports three things:
//
//   * **idle** — what the module's own loop costs when nothing is happening;
//   * **latency** — a signed liveness round trip, which is the module's whole
//     receive path (pipe read, framing, JSON, HMAC, reply) end to end;
//   * **throughput** — overlay records per second, and what they cost the
//     module, which is the path a settings sync and a world record travel.
//
// The runtime's own half is written out here rather than started as a process,
// so a measurement drives exactly what it means to and reads the result without
// a log in between. `link-check.mjs` is the test; this is the instrument.
//
// It needs no game: the overlay and the IL2CPP layer stay dark, exactly as in
// the link check. What is measured is the loop and the pipe, which run whether
// or not a game exists.
//
//   npm run profile:link

import {
  FrameReader,
  Origin,
  RuntimeHandshake,
  SequenceGuard,
  SequenceSource,
  decodeMessage,
  encodeMessage,
} from '@brownie/ipc';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  mintSessionKey,
  publishSessionKey,
  revokeSessionKey,
  sessionKeyPath,
} from '../apps/runtime/dist/native/SessionKey.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = join(REPO, 'apps', 'native', 'build');
const TSC = join(REPO, 'node_modules', 'typescript', 'bin', 'tsc');

const PIPE = `brownie-profile-${String(process.pid)}`;
const USER_ID = 'profile';

/** How long each phase runs. Long enough to outlast Windows' CPU accounting. */
const IDLE_SECONDS = 10;
const LOAD_SECONDS = 10;
/** Liveness round trips to time. */
const ROUND_TRIPS = 500;

/** One overlay record, the size a setting takes on the wire. */
const RECORD = 'setting|auto-nexus|hpPercent|HP%20percent|range|n|35|1|1|1|99|1|0||combat|';
/** Records per batch, as one full sync of a dozen plugins would carry. */
const RECORDS_PER_BATCH = 110;

function run(command, args, label) {
  const result = spawnSync(command, args, { cwd: REPO, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${label} failed`);
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * Processor time and memory for one process, from Windows itself.
 *
 * Asked of the operating system, because the thing being measured is a DLL
 * inside a host that reports nothing about itself.
 */
function sample(pid) {
  const result = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      // Ticks rather than milliseconds: a fractional number comes back in the
      // machine's own locale, and a decimal comma parses as nothing here.
      `$p = Get-Process -Id ${String(pid)} -ErrorAction SilentlyContinue;` +
        ' if ($p) { [Console]::Out.Write(("{0} {1} {2}" -f' +
        ' $p.TotalProcessorTime.Ticks, $p.WorkingSet64, $p.PrivateMemorySize64)) }',
    ],
    { encoding: 'utf8' },
  );
  const parts = (result.stdout ?? '').trim().split(/\s+/);
  if (parts.length !== 3) return undefined;
  return {
    // One tick is 100 ns.
    cpuMs: Number(parts[0]) / 10_000,
    workingSet: Number(parts[1]),
    privateBytes: Number(parts[2]),
  };
}

/**
 * The runtime's half of the conversation, over one accepted pipe connection.
 *
 * Small on purpose: it does the handshake, answers what the module asks, and
 * exposes the two things a measurement needs — send a record, and time a round
 * trip. Everything else `NativeLink` does is policy this does not need.
 */
class Peer {
  #socket;
  #reader = new FrameReader();
  #inbound = new SequenceGuard();
  #outbound = new SequenceSource();
  #handshake;
  #onPong;
  #onReady;

  authenticated = false;
  bytesSent = 0;
  framesSent = 0;

  constructor(socket, secret, pid, onReady) {
    this.#socket = socket;
    this.#handshake = new RuntimeHandshake(secret, USER_ID, pid);
    this.#onReady = onReady;
    socket.setNoDelay(true);
    socket.on('data', (chunk) => {
      this.#consume(chunk);
    });
    socket.on('error', () => undefined);
  }

  send(message) {
    const frame = encodeMessage(message, this.#outbound.take());
    this.bytesSent += frame.length;
    this.framesSent += 1;
    return this.#socket.write(frame);
  }

  /** Sends `count` records as one write, the way the runtime batches them. */
  sendRecords(count) {
    const frames = [];
    for (let i = 0; i < count; i += 1) {
      frames.push(encodeMessage({ kind: 'controlRecord', record: RECORD }, this.#outbound.take()));
    }
    const batch = Buffer.concat(frames);
    this.bytesSent += batch.length;
    this.framesSent += count;
    return this.#socket.write(batch);
  }

  /** Sends one liveness challenge and resolves when it is answered. */
  roundTrip() {
    const { message, expected } = this.#handshake.createPing();
    return new Promise((done, fail) => {
      const timer = setTimeout(() => fail(new Error('the module did not answer a ping')), 5000);
      this.#onPong = (pong) => {
        clearTimeout(timer);
        this.#onPong = undefined;
        if (!this.#handshake.verifyPong(pong, expected)) fail(new Error('bad pong'));
        else done();
      };
      this.send(message);
    });
  }

  /** Resolves once Node has drained what has been written. */
  drained() {
    return new Promise((done) => this.#socket.write(Buffer.alloc(0), () => done()));
  }

  close() {
    this.#socket.destroy();
  }

  #consume(chunk) {
    this.#reader.push(chunk);
    for (let frame = this.#reader.next(); frame !== null; frame = this.#reader.next()) {
      this.#inbound.accept(frame.header.seq);
      const message = decodeMessage(frame, Origin.Native);
      switch (message.kind) {
        case 'hello':
          this.send(this.#handshake.begin(message));
          break;
        case 'authResult':
          this.#handshake.finish(message);
          this.authenticated = true;
          this.#onReady();
          break;
        case 'ping':
          this.send(this.#handshake.answerPing(message));
          break;
        case 'pong':
          this.#onPong?.(message);
          break;
        default:
          break;
      }
    }
  }
}

/** Waits for the module to connect and authenticate. */
function listen(secret) {
  return new Promise((done, fail) => {
    const server = createServer((socket) => {
      const peer = new Peer(socket, secret, process.pid, () => done({ server, peer }));
    });
    server.on('error', fail);
    server.listen(`\\\\.\\pipe\\${PIPE}`);
    setTimeout(() => fail(new Error('the module never authenticated')), 20_000);
  });
}

function quantile(sorted, fraction) {
  const at = Math.min(sorted.length - 1, Math.floor(sorted.length * fraction));
  return sorted[at] ?? 0;
}

function cpuLine(label, before, after, windowMs, extra = '') {
  if (before === undefined || after === undefined) {
    process.stdout.write(`${label.padEnd(12)} gone before it could be sampled\n`);
    return 0;
  }
  const cpuMs = after.cpuMs - before.cpuMs;
  process.stdout.write(
    `${label.padEnd(12)} ${cpuMs.toFixed(0).padStart(6)} ms cpu` +
      ` (${((cpuMs / windowMs) * 100).toFixed(2).padStart(6)}% of one core)` +
      `  ${(after.workingSet / 1024 / 1024).toFixed(1).padStart(5)} MB working set${extra}\n`,
  );
  return cpuMs;
}

async function main() {
  run(process.execPath, ['apps/native/build.mjs'], 'building the module');
  run(process.execPath, ['apps/native/build.mjs', '--host'], 'building the host');
  run(process.execPath, [TSC, '--build'], 'building the runtime');

  const secret = mintSessionKey();
  const keyPath = sessionKeyPath(PIPE, process.env);
  await publishSessionKey(keyPath, secret);

  const waiting = listen(secret);

  // Sleeps well past the end of the measurement; it is killed rather than
  // asked to unload, since teardown is `link-check.mjs`'s question.
  const host = spawn(join(BUILD, 'host.exe'), [String(IDLE_SECONDS + LOAD_SECONDS + 120)], {
    cwd: BUILD,
    env: { ...process.env, BROWNIE_NATIVE_PIPE: PIPE, BROWNIE_NATIVE_ANY_HOST: '1' },
  });
  host.stdout.resume();
  host.stderr.resume();

  const connectStarted = Date.now();
  const { server, peer } = await waiting;
  const connectMs = Date.now() - connectStarted;

  try {
    process.stdout.write(`\nhandshake    ${String(connectMs).padStart(6)} ms from launch\n\n`);

    // ── Idle ────────────────────────────────────────────────────────────────
    let before = sample(host.pid);
    let started = Date.now();
    await sleep(IDLE_SECONDS * 1000);
    cpuLine('idle', before, sample(host.pid), Date.now() - started);

    // ── Latency ─────────────────────────────────────────────────────────────
    const samples = [];
    for (let i = 0; i < ROUND_TRIPS; i += 1) {
      const at = process.hrtime.bigint();
      await peer.roundTrip();
      samples.push(Number(process.hrtime.bigint() - at) / 1000);
    }
    samples.sort((a, b) => a - b);
    process.stdout.write(
      `latency      ${quantile(samples, 0.5).toFixed(0).padStart(6)} us median` +
        `  ${quantile(samples, 0.99).toFixed(0).padStart(6)} us p99` +
        `  (signed round trip, ${String(ROUND_TRIPS)} of them)\n`,
    );

    // ── Throughput ──────────────────────────────────────────────────────────
    before = sample(host.pid);
    started = Date.now();
    const deadline = started + LOAD_SECONDS * 1000;
    const from = { bytes: peer.bytesSent, frames: peer.framesSent };
    while (Date.now() < deadline) {
      if (!peer.sendRecords(RECORDS_PER_BATCH)) await peer.drained();
      // Yields so a batch is one turn of the loop, as a real sync is.
      await Promise.resolve();
    }
    await peer.drained();
    const windowMs = Date.now() - started;
    const frames = peer.framesSent - from.frames;
    const bytes = peer.bytesSent - from.bytes;
    const cpuMs = cpuLine('under load', before, sample(host.pid), windowMs);
    process.stdout.write(
      `             ${Math.round((frames / windowMs) * 1000)
        .toString()
        .padStart(6)} records/s  ${((bytes / windowMs / 1000).toFixed(1) + ' MB/s').padStart(10)}` +
        `  ${((cpuMs * 1000) / Math.max(frames, 1)).toFixed(2).padStart(6)} us of module cpu per record\n`,
    );
  } finally {
    peer.close();
    server.close();
    host.kill();
    await revokeSessionKey(keyPath);
  }
}

await main();
