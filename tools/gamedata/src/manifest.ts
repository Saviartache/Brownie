import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GameInstall } from './install.js';

export const MANIFEST_FILE = 'manifest.json';
const MANIFEST_VERSION = 1;

export interface ManifestFile {
  readonly name: string;
  readonly bytes: number;
  readonly sha256: string;
  /** How many game assets were merged to produce it. */
  readonly parts: number;
}

/**
 * What was extracted, from what, and when.
 *
 * The point of recording the *source* is staleness. Extracted data is a copy of
 * something the game replaces on its own schedule, and a copy with no record of
 * its origin cannot be told from a current one — which is how a proxy ends up
 * classifying last patch's monsters and nobody can say why.
 */
export interface GameDataManifest {
  readonly version: number;
  readonly extractedAt: string;
  readonly unityVersion: string;
  readonly source: {
    readonly path: string;
    readonly sizeBytes: number;
    readonly modifiedMs: number;
  };
  readonly files: readonly ManifestFile[];
}

export function describeFile(name: string, content: Buffer, parts: number): ManifestFile {
  return {
    name,
    bytes: content.length,
    sha256: createHash('sha256').update(content).digest('hex'),
    parts,
  };
}

export function buildManifest(
  install: GameInstall,
  unityVersion: string,
  files: readonly ManifestFile[],
  now: Date,
): GameDataManifest {
  return {
    version: MANIFEST_VERSION,
    extractedAt: now.toISOString(),
    unityVersion,
    source: {
      path: install.assetsPath,
      sizeBytes: install.sizeBytes,
      modifiedMs: install.modifiedMs,
    },
    files,
  };
}

export function writeManifest(directory: string, manifest: GameDataManifest): void {
  writeFileSync(join(directory, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

/**
 * Reads a manifest, or `undefined` if there is none or it cannot be understood.
 *
 * An unreadable manifest is treated as absent rather than as an error: the
 * useful response is the same — extract again — and failing instead would make
 * a corrupt file harder to recover from than a missing one.
 */
export function readManifest(directory: string): GameDataManifest | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(directory, MANIFEST_FILE), 'utf8')) as unknown;
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;

  // Validated as `unknown`, not as a `Partial<GameDataManifest>`: the file was
  // written by some other build, or edited by hand, and typing it as our own
  // shape would make the checks below look redundant to a reader and to the
  // compiler alike.
  const record = parsed as Record<string, unknown>;
  if (record['version'] !== MANIFEST_VERSION) return undefined;

  const source = record['source'];
  if (typeof source !== 'object' || source === null) return undefined;
  const sourceRecord = source as Record<string, unknown>;
  if (typeof sourceRecord['sizeBytes'] !== 'number') return undefined;
  if (typeof sourceRecord['modifiedMs'] !== 'number') return undefined;
  if (typeof record['extractedAt'] !== 'string') return undefined;

  return record as unknown as GameDataManifest;
}

export interface Staleness {
  readonly stale: boolean;
  /** Present when stale; phrased so it can be shown as-is. */
  readonly reason?: string;
}

/**
 * Whether extracted data still describes the installed game.
 *
 * Size and modification time, not a hash of the bundle: `resources.assets` is
 * hundreds of megabytes, and reading it on every startup to answer a question
 * that only matters after a patch would cost more than the check is worth. A
 * patch changes both.
 */
export function checkStaleness(
  manifest: GameDataManifest | undefined,
  install: GameInstall | undefined,
): Staleness {
  if (manifest === undefined) {
    return { stale: true, reason: 'no game data has been extracted yet' };
  }
  if (install === undefined) {
    // Nothing to compare against. The data may be perfectly current — it was
    // extracted from an install this machine no longer has — so this is not a
    // claim that it is stale.
    return { stale: false };
  }
  if (
    manifest.source.sizeBytes !== install.sizeBytes ||
    manifest.source.modifiedMs !== install.modifiedMs
  ) {
    // Deliberately not "the game is newer": a reinstall or a rollback changes
    // the file without moving its date forward, and claiming an order the
    // evidence does not support is how a message stops being trusted.
    return {
      stale: true,
      reason: `the installed game no longer matches what this data came from (game file dated ${new Date(install.modifiedMs).toISOString().slice(0, 10)}, extracted ${manifest.extractedAt.slice(0, 10)})`,
    };
  }
  return { stale: false };
}
