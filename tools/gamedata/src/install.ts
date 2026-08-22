import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Where the game keeps the asset bundle its data lives in. */
export const ASSETS_FILE = 'resources.assets';

export interface GameInstall {
  /** The `*_Data` directory. */
  readonly dataDirectory: string;
  readonly assetsPath: string;
  readonly sizeBytes: number;
  readonly modifiedMs: number;
}

/**
 * Finds the installed game.
 *
 * Both known locations are checked by looking for the asset bundle rather than
 * the directory: an uninstall leaves the folder behind, and a launcher that has
 * been started but never finished downloading leaves it empty. The file being
 * there is the only thing that means anything.
 */
export function findGameInstall(explicitPath?: string): GameInstall | undefined {
  const candidates =
    explicitPath !== undefined && explicitPath !== ''
      ? [explicitPath]
      : [windowsDataDirectory(), macDataDirectory()];

  for (const directory of candidates) {
    const install = describeInstall(directory);
    if (install !== undefined) return install;
  }
  return undefined;
}

/** Every location searched, for an error message that can be acted on. */
export function searchedLocations(): readonly string[] {
  return [windowsDataDirectory(), macDataDirectory()];
}

/**
 * The asset bundle under a path, whichever of three things that path names.
 *
 * A person asked for "the game folder" means the one with `RotMG Exalt.exe` in
 * it — that is what a launcher, a shortcut and a file browser all show them.
 * Accepting only the `*_Data` directory made the tool reject the obvious answer
 * while printing the `*_Data` path in its error, which is the kind of near-miss
 * that costs someone ten minutes.
 *
 * The `*_Data` directory is found by suffix rather than by name because the
 * name follows the executable's, and Deca has renamed that before.
 */
function findAssets(path: string): string | undefined {
  if (path.endsWith(ASSETS_FILE)) return existsSync(path) ? path : undefined;

  const direct = join(path, ASSETS_FILE);
  if (existsSync(direct)) return direct;

  if (!existsSync(path)) return undefined;
  for (const entry of readdirSync(path).sort()) {
    if (!entry.endsWith('_Data')) continue;
    const nested = join(path, entry, ASSETS_FILE);
    if (existsSync(nested)) return nested;
  }
  return undefined;
}

export function describeInstall(dataDirectory: string): GameInstall | undefined {
  const assetsPath = findAssets(dataDirectory);
  if (assetsPath === undefined) return undefined;

  const stats = statSync(assetsPath);
  return {
    dataDirectory: assetsPath.slice(0, assetsPath.length - ASSETS_FILE.length - 1),
    assetsPath,
    sizeBytes: stats.size,
    modifiedMs: Math.trunc(stats.mtimeMs),
  };
}

function windowsDataDirectory(): string {
  const localAppData = process.env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local');
  return join(localAppData, 'RealmOfTheMadGod', 'Production', 'RotMG Exalt_Data');
}

function macDataDirectory(): string {
  return join(homedir(), 'Library', 'Application Support', 'com.decagames.rotmgexalt', 'Data');
}
