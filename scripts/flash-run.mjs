// Runs the proxy for a client that was pointed at it by hand.
//
// The everyday run (`npm run live`) pairs the runtime with the injected module
// inside Exalt: the module redirects the game's connection here and reports
// where it was heading, so the runtime knows the other half of the trip. A
// Flash client has no module — it is told to connect to the proxy directly —
// so this script is how the other half is told: one IPv4, from `--host` or
// `BROWNIE_SERVER_HOST`, that the runtime forwards every session to.
//
// Which game server to name is not this script's guess to make. The one a
// previous Exalt run landed on is in `logs/runtime.log` (`connecting to
// <ip>:2050`); name it with `--host`.
//
// What the client itself needs:
//
// * the address `127.0.0.1` and the port printed below — by default `2051`,
//   **not** the live run's `2050`. The two ports are different on purpose:
//   the module inside Exalt always redirects to 2050, so a Flash runtime left
//   running there would silently take the game's traffic instead — everything
//   forwards, but nothing native (overlay, keybinds, noclip's module half)
//   is listening on that side. Separate ports make the mistake impossible;
//   `BROWNIE_PROXY_PORT` overrides if 2051 is wanted for something else.
// * nothing else. An embedded Flash client (Ruffle and the like) has its
//   socket policy probe answered by the proxy itself; the standalone
//   projector does not ask.
//
// **The protocol has to be the one this runtime speaks.** The live game's
// current protocol is what `packages/protocol` describes; a Flash client
// build from before the packet table was renumbered will pass through
// untouched (opaque packets forward byte for byte), but the plugins —
// auto-nexus among them — read nothing it says.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GAME_DATA = join(REPO, 'game-data');
const LOG_FILE = join(REPO, 'logs', 'runtime.log');

const EOL = '\n';

/** Not the live run's 2050 — see the header. */
const DEFAULT_PORT = '2051';

function upstreamFrom(argv) {
  const flag = argv.indexOf('--host');
  if (flag !== -1 && argv[flag + 1] !== undefined) return argv[flag + 1];
  return process.env['BROWNIE_SERVER_HOST'];
}

function run(command, commandArgs, label) {
  const result = spawnSync(command, commandArgs, { cwd: REPO, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${label} failed`);
}

async function main() {
  const upstream = upstreamFrom(process.argv.slice(2));
  if (upstream === undefined || !/^\d+\.\d+\.\d+\.\d+$/.test(upstream)) {
    process.stderr.write(
      'usage: node scripts/flash-run.mjs --host <game-server-ipv4>' +
        EOL +
        '   or: BROWNIE_SERVER_HOST=<ipv4> node scripts/flash-run.mjs' +
        EOL,
    );
    process.exitCode = 1;
    return;
  }
  const port = process.env['BROWNIE_PROXY_PORT'] ?? DEFAULT_PORT;

  run(
    process.execPath,
    [join(REPO, 'node_modules', 'typescript', 'bin', 'tsc'), '--build'],
    'building the runtime',
  );

  process.stdout.write(`forwarding every session to ${upstream}:2050${EOL}`);
  const runtime = spawn(process.execPath, [join(REPO, 'apps', 'runtime', 'dist', 'main.js')], {
    cwd: REPO,
    env: {
      ...process.env,
      // No BROWNIE_NATIVE: there is no injected module to talk to, and the
      // overlay is the module's — without it the runtime is just the proxy.
      BROWNIE_SERVER_HOST: upstream,
      BROWNIE_PROXY_PORT: port,
      BROWNIE_LOG_LEVEL: process.env['BROWNIE_LOG_LEVEL'] ?? 'debug',
      BROWNIE_LOG_FILE: process.env['BROWNIE_LOG_FILE'] ?? LOG_FILE,
      ...(existsSync(GAME_DATA) ? { BROWNIE_GAME_DATA_DIR: GAME_DATA } : {}),
    },
    stdio: 'inherit',
  });

  process.stdout.write(
    `${EOL}Ready. Point the client at 127.0.0.1:${port} and it will be proxied.${EOL}` +
      `Ctrl-C here stops the runtime.${EOL}` +
      `This run is also being written to ${LOG_FILE}${EOL}${EOL}`,
  );

  // Ctrl-C reaches the runtime too — it is in this console's process group. So
  // this waits rather than kills, the same contract `live-run.mjs` keeps.
  process.on('SIGINT', () => {
    process.stdout.write(`${EOL}stopping; waiting for the runtime to finish${EOL}`);
  });
  await new Promise((done) => {
    runtime.once('exit', done);
  });
}

await main();
