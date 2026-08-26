// Packages a release: one executable, the module beside it, and everything the
// runtime reads at startup.
//
// The runtime ships as a Node single-executable application rather than as a
// folder of JavaScript, because the audience for a release is somebody who
// downloads an archive — not somebody who installs Node, matches its version
// and runs `npm install`. The cost is a 90 MB executable: a SEA is a copy of
// the whole Node binary with the bundled script appended to it.
//
// The game's own data is copied in from `game-data/`, which means this script
// packages what *this* machine extracted. That is deliberate: extraction reads
// a 375 MB asset bundle out of a local install, so it cannot happen on the
// downloader's side without shipping the extractor and the install both.

import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { inject } from 'postject';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RELEASE = join(REPO, 'release');
/** Where the bundle and the blob are built. Not shipped — an input to the exe. */
const STAGE = join(RELEASE, 'stage');
const PACKAGE = join(RELEASE, 'Brownie');
const GAME_DATA = join(REPO, 'game-data');
const PROTOCOL_DATA = join(REPO, 'packages', 'protocol', 'data');
const NATIVE_MODULE = join(REPO, 'apps', 'native', 'build', 'd3d11.dll');

/** Written out rather than escaped inline, so the output reads cleanly. */
const EOL = '\n';

/**
 * The fuse Node's own binary carries.
 *
 * Not postject's default, which is for arbitrary payloads: this one is what a
 * Node build looks for when it decides whether it is a single executable.
 */
const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

/** See `bundleRuntime`. Evaluated inside the bundle, once, at load. */
const MODULE_URL =
  'require("node:url").pathToFileURL(require("node:path").join(' +
  'require("node:path").dirname(process.execPath), "dist", "brownie.cjs")).href';

function run(command, args, label) {
  const result = spawnSync(command, args, { cwd: REPO, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${label} failed`);
}

function step(message) {
  process.stdout.write(`${message}${EOL}`);
}

/**
 * Deletes a directory this script owns.
 *
 * Windows refuses to remove a directory anything still holds — a shell sitting
 * in it, a scanner reading the executable that was just written — and answers
 * EPERM rather than waiting. The retries cover the case that passes on its own;
 * the message covers the case that does not, because the bare errno says only
 * that a build "failed" and names a path that looks perfectly ordinary.
 */
function discard(directory) {
  try {
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (cause) {
    throw new Error(
      `could not delete ${directory}: ${cause.message}. Something is holding it open — most ` +
        'often a terminal whose working directory is inside it.',
    );
  }
}

/**
 * Bundles the runtime into one CommonJS file.
 *
 * A SEA takes a single script and no module resolution, so the workspace
 * packages have to be flattened into it. CommonJS because that is the only
 * format the injected main script may be in.
 */
async function bundleRuntime() {
  await build({
    entryPoints: [join(REPO, 'apps', 'runtime', 'dist', 'main.js')],
    outfile: join(STAGE, 'brownie.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    // Plugins are loaded from disk by URL at runtime, and reloaded when saved.
    // Left as a real `import()` — rewritten to `require()` it would refuse the
    // `.mjs` files the loader documents, and lose the cache-busting query that
    // makes a reload pick up the new source.
    supported: { 'dynamic-import': true },
    // A CommonJS bundle has no `import.meta`, and esbuild would leave it empty
    // — which `new URL(…)` refuses, at load time, before anything runs. This
    // tree reads it in one place: `@brownie/protocol` resolves `../data/`
    // against it to find the packet definitions.
    //
    // So the value is where this bundle would sit if it were on disk: one
    // directory inside the package, with `data/` beside it. That is the shape
    // the package has, and the shape the repository has.
    //
    // Written as one expression that declares one name. The banner is text
    // esbuild does not rename, so a second binding here could collide with a
    // bundled module's own top-level `join` or `dirname`.
    define: { 'import.meta.url': '__moduleUrl' },
    banner: { js: `const __moduleUrl = ${MODULE_URL};` },
    // Not minified: the bundle is a rounding error beside the Node binary it
    // is appended to, and a stack trace from a user's log has to be readable.
    minify: false,
    logLevel: 'warning',
  });
}

/** Writes the executable: the Node binary with the bundle appended to it. */
async function buildExecutable() {
  const configPath = join(STAGE, 'sea-config.json');
  const blobPath = join(STAGE, 'brownie.blob');

  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        main: join(STAGE, 'brownie.cjs'),
        output: blobPath,
        disableExperimentalSEAWarning: true,
      },
      undefined,
      2,
    )}\n`,
  );

  run(process.execPath, ['--experimental-sea-config', configPath], 'preparing the executable');

  // The Node running this script is the Node the release will carry, so the
  // release is only ever as new as the machine that built it.
  const executable = join(PACKAGE, 'brownie.exe');
  copyFileSync(process.execPath, executable);
  // Windows signs its Node builds and injecting invalidates that signature.
  // Nothing here can re-sign it, and an unsigned build is what a release from
  // a forum is either way.
  await inject(executable, 'NODE_SEA_BLOB', readFileSync(blobPath), {
    sentinelFuse: SEA_FUSE,
  });
}

/**
 * Copies in the game's own data, as the extractor left it.
 *
 * The manifest is the list — the same one the runtime reads at startup to say
 * whether the data has fallen behind the installed game. Naming the files here
 * as well would be a second spelling of it, and a second thing to forget.
 */
function copyGameData() {
  const manifestPath = join(GAME_DATA, 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw new Error(
      'no game data to package. Run `npm run gamedata extract` first — a release without it ' +
        'classifies no object as an enemy, so every feature built on that does nothing.',
    );
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const destination = join(PACKAGE, 'game-data');
  mkdirSync(destination, { recursive: true });
  copyFileSync(manifestPath, join(destination, 'manifest.json'));
  for (const file of manifest.files) {
    copyFileSync(join(GAME_DATA, file.name), join(destination, file.name));
  }
  return manifest.files.length + 1;
}

/**
 * Copies in the packages a plugin is written against.
 *
 * A plugin is a file on disk that Node imports, so `@brownie/plugin-api` has to
 * be resolvable *from that file* — the copy compiled into the executable is not
 * something an `import` statement can reach. Without this a release loads no
 * plugins at all, which the repository hides: there, Node walks up into the
 * workspace's own `node_modules` and finds them.
 *
 * Both packages are almost entirely types, and what implementation there is is
 * pure, so a plugin holding its own copy cannot disagree with the host about
 * anything. `@brownie/protocol` comes along because the type declarations name
 * it, and an editor checking a plugin has to be able to follow that.
 *
 * Source maps and build state are left behind: they point at TypeScript sources
 * that are not here.
 */
function copyPluginApi() {
  for (const name of ['plugin-api', 'protocol']) {
    const from = join(REPO, 'packages', name);
    const to = join(PACKAGE, 'node_modules', '@brownie', name);
    mkdirSync(to, { recursive: true });
    copyFileSync(join(from, 'package.json'), join(to, 'package.json'));
    cpSync(join(from, 'dist'), join(to, 'dist'), {
      recursive: true,
      filter: (path) => !path.endsWith('.map') && !path.endsWith('.tsbuildinfo'),
    });
  }
}

/**
 * The configuration a downloader gets.
 *
 * Written rather than copied from `config/`: what is in the repository is one
 * developer's working setup, and `config/plugins.json` beside it is their
 * preferences. This is the shape a first run should have — the module on, and
 * the data that was just packaged pointed at.
 */
function writeConfig() {
  const config = {
    native: { enabled: true },
    gameData: { directory: 'game-data' },
    logging: { level: 'info', file: 'logs/runtime.log' },
  };
  mkdirSync(join(PACKAGE, 'config'), { recursive: true });
  writeFileSync(
    join(PACKAGE, 'config', 'runtime.json'),
    `${JSON.stringify(config, undefined, 2)}\n`,
  );
}

function writeReadme(version) {
  const lines = [
    `Brownie ${version} — Windows x64`,
    '',
    'A MITM proxy and automation runtime for Realm of the Mad God (Exalt), with',
    'an ImGui overlay drawn inside the game. Everything it does is a plugin, and',
    'every plugin is switched on and bound to a key from that overlay.',
    '',
    'Setup',
    '-----',
    '1. Copy d3d11.dll into the game folder — the one holding "RotMG Exalt.exe",',
    '   normally %LOCALAPPDATA%\\RealmOfTheMadGod\\Production.',
    '2. Run brownie.exe from this folder. It has to be started from here: the',
    '   configuration, the plugins and the game data are all read from beside it.',
    '3. Start the game the way you normally do. Press INSERT in it for the overlay.',
    '',
    'Ctrl-C in the console stops the runtime and lets it shut down cleanly. The',
    'run is also written to logs\\runtime.log, truncated on every start.',
    '',
    'What is here',
    '------------',
    '  brownie.exe      the runtime: proxy, packet pipeline, plugin host',
    '  d3d11.dll        the module injected into the game — copy it, see above',
    '  config\\          runtime.json, and the preferences the overlay writes',
    '  plugins\\         loaded at startup, and reloaded when saved',
    '  node_modules\\    @brownie/plugin-api, which a plugin imports',
    '  data\\            the wire protocol: packet definitions and stat types',
    "  game-data\\       the game's own object and tile data",
    '',
    'game-data was extracted from one install of the game. A game patch makes it',
    'stale, and the runtime says so at startup when it no longer matches yours.',
    '',
    'data\\ is read at startup and nothing here caches it. A patch that moves a',
    'field on the wire is an edit to packet-definitions.json, not a new build.',
    '',
    'Plugins',
    '-------',
    'Drop a .js or .mjs file into plugins\\. It is loaded at startup, and saving it',
    'reloads it mid-session — no restart. Import @brownie/plugin-api for what a',
    'plugin is written against; it is in node_modules\\ here, types included, so an',
    'editor can check the file. See docs\\plugins.md in the repository.',
    '',
  ];
  writeFileSync(join(PACKAGE, 'README.txt'), lines.join('\r\n'));
}

/**
 * Archives the package.
 *
 * Windows ships bsdtar, which writes zip and every compressor this asks for. A
 * dependency for one archive would be a dependency to keep updated.
 *
 * **A zip, compressed with LZMA rather than deflate.** Nearly all of this is a
 * 90 MB Node binary: deflate leaves the archive at 38 MB and LZMA at 25, which
 * is the difference between fitting a forum's upload limit and not. Nothing
 * else in here is big enough to change that answer, and no smaller build of
 * Node closes a 13 MB gap either.
 *
 * LZMA inside a zip is in the format's specification but not in Windows'
 * reader, so Explorer's "Extract All" refuses the file and 7-Zip, WinRAR or
 * anything built on libarchive opens it. That is the cost of the extension:
 * `.7z` is what this wants to be, and a zip is what may be uploaded.
 *
 * **By full path, not by name.** A machine with Git installed has GNU tar in
 * front of it on PATH, and GNU tar knows neither format: it writes an
 * uncompressed tar under the name it was given and exits 0. Nothing downstream
 * can tell the difference until somebody tries to open it.
 *
 * Run from the release directory with relative paths, because bsdtar reads
 * `E:\...` as a remote host called `E` and fails trying to resolve it.
 */
function archive(version) {
  const bsdtar = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'tar.exe');
  if (!existsSync(bsdtar)) throw new Error(`no bsdtar at ${bsdtar} to write the archive with`);

  const name = `Brownie-${version}-win-x64.zip`;
  const result = spawnSync(
    bsdtar,
    ['-c', '-f', name, '--format', 'zip', '--options', 'zip:compression=lzma', 'Brownie'],
    { cwd: RELEASE, stdio: 'inherit' },
  );
  if (result.status !== 0) throw new Error('archiving failed');
  return join(RELEASE, name);
}

async function main() {
  const version = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version;

  step('building the module');
  run(process.execPath, [join(REPO, 'apps', 'native', 'build.mjs')], 'building the module');

  step(`${EOL}building the runtime`);
  run(
    process.execPath,
    [join(REPO, 'node_modules', 'typescript', 'bin', 'tsc'), '--build'],
    'building the runtime',
  );

  // Rebuilt from empty every time: a release that carries a file nobody meant
  // to ship is worse than one that takes a minute longer to make.
  discard(RELEASE);
  mkdirSync(STAGE, { recursive: true });
  mkdirSync(PACKAGE, { recursive: true });

  step(`${EOL}bundling`);
  await bundleRuntime();

  step('writing brownie.exe');
  await buildExecutable();

  copyFileSync(NATIVE_MODULE, join(PACKAGE, 'd3d11.dll'));
  cpSync(join(REPO, 'plugins'), join(PACKAGE, 'plugins'), { recursive: true });
  // Beside the executable rather than inside it, which keeps the one property
  // these files were made data for: a game patch that moves a field on the wire
  // is an edit, not a rebuild. `bundleRuntime` is where the runtime is told to
  // look here.
  cpSync(PROTOCOL_DATA, join(PACKAGE, 'data'), { recursive: true });
  copyPluginApi();
  writeConfig();
  writeReadme(version);
  const dataFiles = copyGameData();
  step(`packaged d3d11.dll, the plugins and ${String(dataFiles)} game data file(s)`);

  // Staging is an input to the executable, not part of it.
  discard(STAGE);

  step(`${EOL}archiving`);
  const zip = archive(version);

  step(`${EOL}release: ${PACKAGE}`);
  step(`archive: ${zip}`);
}

await main();
