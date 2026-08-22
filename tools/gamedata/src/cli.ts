import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { extractGameData } from './extract.js';
import { findGameInstall, searchedLocations, type GameInstall } from './install.js';
import {
  buildManifest,
  checkStaleness,
  describeFile,
  readManifest,
  writeManifest,
} from './manifest.js';

/**
 * `brownie-gamedata` — pulls the game's data files out of the installed game.
 *
 * A separate tool rather than something the runtime does at startup, for three
 * reasons. It reads a several-hundred-megabyte asset bundle, which is not work
 * to do while a player is waiting to connect. It needs to run exactly once per
 * game patch, not once per launch. And its output is a set of files a person
 * may want to inspect, copy to another machine, or check into their own
 * repository — none of which is possible if the step only exists inside a
 * running proxy.
 */

const USAGE = `brownie-gamedata — extract Realm's data files from the installed game

  extract [options]   read the game's assets and write objects.xml, tiles.xml, …
  check   [options]   report whether extracted data still matches the install
  where               print where the game was found

Options
  --game <path>   the game's *_Data directory, or resources.assets itself
                  (default: the usual Windows and macOS locations)
  --out <dir>     where to write (default: ./game-data)
  --force         extract even when the existing data is already current
`;

export interface CliResult {
  readonly exitCode: number;
  readonly output: readonly string[];
}

export function runCli(argv: readonly string[], now = new Date()): CliResult {
  const output: string[] = [];
  const say = (line: string): void => {
    output.push(line);
  };

  const command = argv[0] ?? 'help';
  if (command === 'help' || command === '--help' || command === '-h') {
    say(USAGE);
    return { exitCode: 0, output };
  }

  const options = parseOptions(argv.slice(1));
  const install = findGameInstall(options.game);

  switch (command) {
    case 'where':
      return install === undefined
        ? { exitCode: 1, output: [...output, ...notFound()] }
        : { exitCode: 0, output: [describeFound(install)] };

    case 'check': {
      const staleness = checkStaleness(readManifest(options.out), install);
      say(
        staleness.stale
          ? `game data is out of date: ${staleness.reason ?? ''}`
          : 'game data is current',
      );
      // A non-zero exit is what makes this usable from a script, and what lets
      // it be the thing a build step runs before packaging.
      return { exitCode: staleness.stale ? 1 : 0, output };
    }

    case 'extract': {
      if (install === undefined) return { exitCode: 1, output: [...output, ...notFound()] };

      const staleness = checkStaleness(readManifest(options.out), install);
      if (!staleness.stale && !options.force) {
        say('game data is already current; nothing to do (use --force to extract anyway)');
        return { exitCode: 0, output };
      }

      say(describeFound(install));
      const result = extractGameData(readFileSync(install.assetsPath));
      if (result.files.length === 0) {
        say('found no data documents in the game assets — is this a Realm install?');
        return { exitCode: 1, output };
      }

      mkdirSync(options.out, { recursive: true });
      const files = result.files.map((file) => {
        writeFileSync(join(options.out, file.name), file.content);
        say(
          `  ${file.name}  ${formatBytes(file.content.length)}${file.parts > 1 ? ` (merged from ${String(file.parts)} assets)` : ''}`,
        );
        return describeFile(file.name, file.content, file.parts);
      });

      writeManifest(options.out, buildManifest(install, result.unityVersion, files, now));
      say(`wrote ${String(files.length)} file(s) to ${options.out}`);
      return { exitCode: 0, output };
    }

    default:
      say(`unknown command "${command}"`);
      say(USAGE);
      return { exitCode: 2, output };
  }
}

interface Options {
  readonly game: string | undefined;
  readonly out: string;
  readonly force: boolean;
}

function parseOptions(argv: readonly string[]): Options {
  let game: string | undefined;
  let out = resolve('game-data');
  let force = false;

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--force') {
      force = true;
    } else if (flag === '--game') {
      game = argv[++i];
    } else if (flag === '--out') {
      const value = argv[++i];
      if (value !== undefined) out = resolve(value);
    }
  }
  return { game, out, force };
}

function describeFound(install: GameInstall): string {
  return `game found: ${install.assetsPath} (${formatBytes(install.sizeBytes)}, updated ${new Date(install.modifiedMs).toISOString().slice(0, 10)})`;
}

function notFound(): string[] {
  return [
    'could not find an installed copy of the game.',
    'looked in:',
    ...searchedLocations().map((path) => `  ${path}`),
    'pass --game <path> to point at it directly.',
  ];
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
