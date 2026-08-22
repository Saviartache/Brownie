// The one test that needs both halves at once.
//
// `Session` and `Engine` have no unit test, deliberately: their contract is a
// live peer, and a test against a fake peer only proves that the fake agrees
// with the code under test. So this starts the real runtime, loads the real
// module into a real process, and checks what actually happened — that the
// session key was published and read, that the mutual handshake completed, and
// that unloading the module tore everything down without deadlocking.
//
// It needs no game. The overlay and the IL2CPP layer stay dark here, because
// neither a swap chain nor a managed runtime exists in the host — but the link
// has to work before either of those matters, and this is what says whether it
// does.

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = join(REPO, 'apps', 'native', 'build');

/** A port nothing else is likely to want, so the check does not collide. */
const PROXY_PORT = '2077';
/** Named per run, so a stale runtime cannot answer for this one. */
const PIPE = `brownie-link-check-${String(process.pid)}`;

/**
 * The TypeScript compiler, run as the ordinary script it is.
 *
 * Not through npm: on Windows npm is a batch file, which Node refuses to spawn
 * without a shell, and a shell would re-parse `process.execPath` — which
 * contains a space on a default install and would be split in half.
 */
const TSC = join(REPO, 'node_modules', 'typescript', 'bin', 'tsc');

function run(command, args, label) {
  const result = spawnSync(command, args, { cwd: REPO, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${label} failed`);
}

/** Resolves once `predicate` sees the log, or rejects after `timeoutMs`. */
function waitFor(getLog, predicate, timeoutMs, what) {
  return new Promise((resolvePromise, reject) => {
    const started = Date.now();
    const tick = () => {
      if (predicate(getLog())) {
        resolvePromise();
      } else if (Date.now() - started > timeoutMs) {
        reject(new Error(`timed out waiting for ${what}`));
      } else {
        setTimeout(tick, 100);
      }
    };
    tick();
  });
}

async function main() {
  run(process.execPath, ['apps/native/build.mjs'], 'building the module');
  run(process.execPath, ['apps/native/build.mjs', '--host'], 'building the host');
  run(process.execPath, [TSC, '--build'], 'building the runtime');

  const workspace = mkdtempSync(join(tmpdir(), 'brownie-link-'));
  let log = '';
  const runtime = spawn(process.execPath, [join(REPO, 'apps', 'runtime', 'dist', 'main.js')], {
    cwd: workspace,
    env: {
      ...process.env,
      BROWNIE_NATIVE: '1',
      BROWNIE_NATIVE_PIPE: PIPE,
      BROWNIE_LOG_LEVEL: 'debug',
      BROWNIE_PROXY_PORT: PROXY_PORT,
    },
  });
  const collect = (chunk) => {
    log += String(chunk);
  };
  runtime.stdout.on('data', collect);
  runtime.stderr.on('data', collect);

  let failure;
  try {
    await waitFor(
      () => log,
      (text) => text.includes('waiting for the native module'),
      15_000,
      'the runtime to listen',
    );

    // The module reads the pipe name from its own default, so the check drives
    // it through the same environment variable the game would be launched with.
    const host = spawnSync(join(BUILD, 'host.exe'), ['4'], {
      cwd: BUILD,
      // The module only starts an engine inside the game; this says the host
      // stands in for it.
      env: { ...process.env, BROWNIE_NATIVE_PIPE: PIPE, BROWNIE_NATIVE_ANY_HOST: '1' },
      encoding: 'utf8',
    });
    process.stdout.write(host.stdout ?? '');

    if (host.status !== 0) {
      // A non-zero exit here usually means teardown deadlocked and the process
      // was killed — which is exactly the failure this check exists to catch.
      throw new Error(`the host exited with ${String(host.status)}`);
    }
    if (!(host.stdout ?? '').includes('unloaded cleanly')) {
      throw new Error('the module did not unload cleanly');
    }

    await waitFor(
      () => log,
      (text) => text.includes('native module authenticated'),
      5_000,
      'the handshake to complete',
    );
    await waitFor(
      () => log,
      (text) => text.includes('native link closed'),
      5_000,
      'the link to close',
    );
  } catch (cause) {
    failure = cause;
  } finally {
    // Waited for, not just signalled: the workspace is the runtime's working
    // directory, and Windows refuses to remove a directory a live process is
    // sitting in.
    const exited = new Promise((done) => runtime.once('exit', done));
    runtime.kill();
    await exited;
    try {
      rmSync(workspace, { recursive: true, force: true });
    } catch {
      // A leftover temp directory is not a failed check, and reporting it as
      // one would bury the result this script exists to produce.
    }
  }

  if (failure) {
    process.stdout.write(`\n--- runtime log ---\n${log}\n`);
    process.stderr.write(`link check failed: ${failure.message}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write('link check passed: published, authenticated, closed cleanly\n');
}

await main();
