// Builds the native module.
//
// **Sources are discovered from disk.** The reference implementation's build
// parsed a Visual Studio project file for its source list, which meant a file
// added on disk but not in the project silently vanished from the binary — and
// needed two more tools (`sync-project.mjs`, `verify-sources.mjs`) whose only
// job was to police that drift. Walking the tree removes the entire class.
//
// The compiler is Zig's clang, installed as an ordinary dev dependency. No
// Visual Studio, no separate SDK, and the exact version is pinned in
// package-lock.json like everything else.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');

const SOURCE_ROOT = join(HERE, 'src');
const VENDOR_ROOT = join(HERE, 'vendor');
const OUT_DIR = join(HERE, 'build');

const SOURCE_EXTENSIONS = new Set(['.cpp', '.c']);

/** Include roots, in the order the compiler should search them. */
const INCLUDE_DIRS = [SOURCE_ROOT, join(VENDOR_ROOT, 'imgui'), join(VENDOR_ROOT, 'minhook'), VENDOR_ROOT];

/**
 * Finds the Zig toolchain.
 *
 * Checked in order of how deliberate each choice is: an explicit environment
 * variable beats the pinned dependency, which beats whatever happens to be on
 * PATH — so a machine with a different Zig cannot quietly change what is built.
 */
function findZig() {
  const fromEnv = process.env.ZIG;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;

  const pinned = join(REPO, 'node_modules', '@oven', 'zig-win32-x64', 'zig.exe');
  if (existsSync(pinned)) return pinned;

  const probe = spawnSync('zig', ['version'], { encoding: 'utf8' });
  if (probe.status === 0) return 'zig';

  throw new Error(
    'no Zig toolchain found. Run `npm install`, or set ZIG to a zig executable.',
  );
}

/** Every source file under a root, sorted so a build is reproducible. */
function discoverSources(root) {
  if (!existsSync(root)) return [];
  const found = [];

  const walk = (directory) => {
    for (const entry of readdirSync(directory).sort()) {
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
      } else if (SOURCE_EXTENSIONS.has(extname(entry))) {
        found.push(path);
      }
    }
  };

  walk(root);
  return found;
}

/**
 * Writes the linker's export list from `defs/exports.inc`.
 *
 * Generated rather than committed because it is a second spelling of a list
 * that already exists — and a second spelling is a second thing to forget to
 * update. `BrownieShutdown` is appended here: it is ours, not winhttp's.
 */
function writeExportDefinition() {
  const source = readFileSync(join(HERE, 'defs', 'exports.inc'), 'utf8');
  const entries = [...source.matchAll(/BROWNIE_EXPORT\((\w+),\s*(\d+)\)/g)];
  if (entries.length === 0) throw new Error('defs/exports.inc lists no exports');

  const lines = [
    'LIBRARY "D3D11"',
    'EXPORTS',
    // Each real export is answered by our `_name` stub.
    // Ordinals matter: callers import by ordinal as well as by name.
    ...entries.map(([, name, ordinal]) => `      ${name} = _${name} @${ordinal}`),
    // Ours: the only way to unload the module safely. See DllMain.cpp.
    `      BrownieShutdown @${String(entries.length + 1)}`,
    '',
  ];
  const path = join(OUT_DIR, 'd3d11.def');
  writeFileSync(path, lines.join('\n'));
  return path;
}

function main() {
  const args = new Set(process.argv.slice(2));
  const listOnly = args.has('--list');

  // Three things get built from this tree, and which one is a mode rather than
  // a separate script: they share every flag, and a second build script is a
  // second place for those flags to drift.
  const mode = args.has('--test') ? 'test' : args.has('--host') ? 'host' : 'dll';

  const sources =
    mode === 'host'
      ? // The host loads the module; it must not contain a copy of it.
        discoverSources(join(HERE, 'host'))
      : [
          ...discoverSources(mode === 'test' ? join(HERE, 'test') : SOURCE_ROOT),
          ...(mode === 'test'
            ? discoverSources(SOURCE_ROOT).filter((f) => !f.endsWith('DllMain.cpp'))
            : []),
          // Vendored libraries are compiled, not linked from a binary: they are
          // small, and building them with the same flags as everything else is
          // what keeps a mismatch in the runtime or the exception model from
          // being a mystery.
          //
          // Built into the self-check too, because the hook layer is one of the
          // few parts that can be tested honestly without a game — by detouring
          // a function in this very binary.
          ...discoverSources(join(VENDOR_ROOT, 'minhook')),
          ...discoverSources(join(VENDOR_ROOT, 'imgui')),
        ];

  if (sources.length === 0) {
    process.stderr.write('no sources found — is this the right directory?\n');
    process.exitCode = 1;
    return;
  }

  if (listOnly) {
    for (const source of sources) process.stdout.write(`${relative(HERE, source)}\n`);
    return;
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const zig = findZig();
  const output = join(OUT_DIR, {test: 'selftest.exe', host: 'host.exe', dll: 'd3d11.dll'}[mode]);

  // Warnings are on and specific. Turning one off globally because existing
  // code trips it is how a codebase stops being told about its own bugs.
  const common = [
    '--target=x86_64-windows-gnu',
    args.has('--debug') ? '-O0' : '-O2',
    '-Wall',
    '-Wextra',
    ...INCLUDE_DIRS.flatMap((dir) => ['-I', dir]),
  ];

  // `-std=c++20` is rejected outright on a C source, so the standard is set per
  // language.
  //
  // `-fno-exceptions` because the module has exactly one error mechanism and it
  // is `Result<T>` — see `core/Result.h`. Nothing here throws, so the flag
  // states what is already true rather than changing what the code does.
  const cxxOnly = ['-std=c++20', '-fno-exceptions'];

  // The stricter warnings are held to this project's own code. Vendored sources
  // are somebody else's: enforcing our rules there would mean either editing
  // them, and losing the ability to take an upstream fix, or turning the
  // warning off for everyone — which is how a codebase stops being told about
  // its own bugs.
  const strict = ['-Wshadow', '-Wconversion'];
  const isOurs = (source) => !source.startsWith(VENDOR_ROOT);

  const objectDir = join(OUT_DIR, 'obj');
  mkdirSync(objectDir, { recursive: true });
  process.stdout.write(
    `building ${relative(HERE, output)} from ${String(sources.length)} source file(s)\n`,
  );

  // Compiled one at a time rather than in a single command: a flag that does
  // not apply to every source has to be applied per language, and object files
  // are what an incremental build will need.
  const objects = [];
  for (const source of sources) {
    const isCxx = extname(source) === '.cpp';
    const object = join(objectDir, `${relative(HERE, source).replace(/[\\/]/g, '_')}.o`);
    const compile = spawnSync(
      zig,
      [
        isCxx ? 'c++' : 'cc',
        ...common,
        ...(isCxx ? cxxOnly : ['-std=c11']),
        ...(isOurs(source) ? strict : []),
        '-c',
        source,
        '-o',
        object,
      ],
      { stdio: 'inherit' },
    );
    if (compile.status !== 0) {
      process.exitCode = compile.status ?? 1;
      return;
    }
    objects.push(object);
  }

  const link = spawnSync(
    zig,
    [
      'c++',
      ...common,
      args.has('--debug') ? '-g' : '-s',
      ...(mode !== 'dll'
        ? []
        : [
            '-shared',
            // The export list, generated from the same X-macro the stubs come
            // from, so the two can never disagree about which names exist.
            writeExportDefinition(),
          ]),
      // Win32 crypto for the handshake; Winsock for the connect redirect;
      // Direct3D to resolve the swap chain's Present without scanning for it;
      // the rest is what ImGui's Win32 and D3D11 backends reach for — GDI and
      // DWM for window metrics, the shader compiler for the two shaders the
      // backend builds at startup.
      //
      // No `dxguid`: the toolchain ships no import library for it, because it
      // is a static table of GUID constants rather than a DLL. The two
      // interface ids this project needs come from `__uuidof` instead, which
      // the headers already carry.
      '-lbcrypt',
      '-lws2_32',
      '-ld3d11',
      '-ld3dcompiler_47',
      '-lgdi32',
      '-ldwmapi',
      ...objects,
      '-o',
      output,
    ],
    { stdio: 'inherit' },
  );
  if (link.status !== 0) {
    process.exitCode = link.status ?? 1;
    return;
  }
  process.stdout.write(`built ${output}\n`);

  // The self-check is run from here rather than chained in package.json: a
  // relative path with forward slashes is a command in a POSIX shell and a
  // syntax error in cmd.exe, so the npm script only worked in whichever shell
  // it happened to be written in.
  if (mode === 'test') {
    const run = spawnSync(output, [], { stdio: 'inherit' });
    process.exitCode = run.status ?? 1;
  }
}

main();
