// Prepares a live run and gets out of the way.
//
// Builds the module and the runtime, extracts the game's data if it is stale,
// installs `d3d11.dll` into the game folder, starts the runtime, and then waits.
// **It does not launch the game.** Start it however you normally do — the
// launcher, a shortcut, Steam — because how the game is started is not this
// script's business and getting it wrong is invisible: a game launched by the
// wrong route can sit on its title screen forever without ever opening a game
// socket, which looks exactly like a redirect that does not work.
//
// The module needs nothing from the environment: its defaults are the runtime's
// defaults, so a game started from anywhere finds the same pipe and the same
// session key.
//
// **The module is installed as `d3d11.dll`, and the name is not arbitrary.**
// `version.dll` and `winhttp.dll` — the obvious hijack targets, and the ones the
// reference implementation used — both kill this build of Exalt about a second
// into startup, inside `il2cpp_init`. Not because of anything in this project:
// Microsoft's own `version.dll` copied into the game folder does it too, and so
// does the reference implementation's own `winhttp.dll` built from its sources.
// `d3d11.dll` is tolerated. Established on a clean reinstall, by measuring each
// candidate rather than reasoning about it.
//
// The module is installed and left there; nothing is backed up or restored.

import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = join(REPO, 'apps', 'native', 'build');
const GAME_DATA = join(REPO, 'game-data');
const LOG_FILE = join(REPO, 'logs', 'runtime.log');

/** Written out rather than escaped inline, so the output reads cleanly. */
const EOL = '\n';

const args = new Set(process.argv.slice(2));

function findGameDirectory() {
  const fromEnv = process.env['BROWNIE_GAME_DIR'];
  const local = process.env['LOCALAPPDATA'] ?? '';
  const candidates = [
    ...(fromEnv === undefined ? [] : [fromEnv]),
    join(local, 'RealmOfTheMadGod', 'Production'),
    join(local, 'RealmOfTheMadGod', 'Production', 'RotMGExalt'),
  ];
  for (const candidate of candidates) {
    if (candidate !== '' && existsSync(join(candidate, 'RotMG Exalt.exe'))) return candidate;
  }
  throw new Error(
    'could not find the game. Set BROWNIE_GAME_DIR to the folder containing "RotMG Exalt.exe".',
  );
}

function run(command, commandArgs, label) {
  const result = spawnSync(command, commandArgs, { cwd: REPO, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${label} failed`);
}

async function main() {
  const gameDirectory = findGameDirectory();

  process.stdout.write(`game: ${gameDirectory}${EOL}`);

  run(process.execPath, ['apps/native/build.mjs'], 'building the module');
  run(
    process.execPath,
    [join(REPO, 'node_modules', 'typescript', 'bin', 'tsc'), '--build'],
    'building the runtime',
  );

  // The dodge planner and the world model need the game's own object and tile
  // data. Extracted once; a game patch is what makes it stale, and the manifest
  // the tool writes is what says so.
  if (!existsSync(join(GAME_DATA, 'objects.xml'))) {
    process.stdout.write(`${EOL}extracting game data (reads the game's resources.assets)${EOL}`);
    mkdirSync(GAME_DATA, { recursive: true });
    run(
      process.execPath,
      [
        join(REPO, 'tools', 'gamedata', 'dist', 'main.js'),
        'extract',
        '--game',
        gameDirectory,
        '--out',
        GAME_DATA,
      ],
      'extracting game data',
    );
  }

  // Copied every run rather than checked: the build just produced a new one,
  // and a stale module in the game folder is the kind of thing that makes a
  // fixed bug look unfixed.
  copyFileSync(join(BUILD, 'd3d11.dll'), join(gameDirectory, 'd3d11.dll'));
  process.stdout.write(`${EOL}installed d3d11.dll into the game folder${EOL}`);

  process.stdout.write(`${EOL}starting the runtime${EOL}`);
  // `--samples` keeps the bytes no schema described, which is what describing
  // one needs. Passed through as the runtime's own argument.
  const runtimeArgs = [
    join(REPO, 'apps', 'runtime', 'dist', 'main.js'),
    ...(args.has('--samples') ? ['--samples'] : []),
  ];
  const runtime = spawn(process.execPath, runtimeArgs, {
    cwd: REPO,
    // Debug, because this is bring-up and the connection story is worth having.
    // The per-packet trace sits a level below, at `trace`: it answers whether a
    // session behaved oddly because we mangled something or because the game
    // meant to, but a realm sends thousands a minute and they bury everything
    // else. Ask for it when that is the question:
    //
    //     BROWNIE_LOG_LEVEL=trace npm run live
    env: {
      ...process.env,
      BROWNIE_NATIVE: '1',
      BROWNIE_GAME_DATA_DIR: GAME_DATA,
      BROWNIE_LOG_LEVEL: process.env['BROWNIE_LOG_LEVEL'] ?? 'debug',
      // The same lines the console gets, in a file that can be read afterwards
      // — by somebody who was not watching, or who wants to grep. Truncated per
      // run, so it always holds exactly this one.
      BROWNIE_LOG_FILE: process.env['BROWNIE_LOG_FILE'] ?? LOG_FILE,
    },
    stdio: 'inherit',
  });

  process.stdout.write(
    `${EOL}Ready. Start the game now, the way you normally do.${EOL}` +
      `Press INSERT in it for the overlay. Ctrl-C here stops the runtime.${EOL}` +
      `This run is also being written to ${LOG_FILE}${EOL}${EOL}`,
  );

  // Ctrl-C reaches the runtime too — it is in this console's process group and
  // has its own handler. So this waits rather than kills: signalling a child
  // that is already shutting down cuts its teardown short, and the packet
  // capture is written during that teardown. The first version killed it and
  // the capture never appeared.
  process.on('SIGINT', () => {
    process.stdout.write(`${EOL}stopping; waiting for the runtime to finish${EOL}`);
  });
  await new Promise((done) => {
    runtime.once('exit', done);
  });
}

await main();
