import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PacketRegistry } from './registry/PacketRegistry.js';

/**
 * The definitions shipped with this package, loaded from disk.
 *
 * Kept apart from the main entry point so that entry point stays free of I/O.
 * The definitions are JSON rather than generated TypeScript on purpose: the
 * wire format tracks the game's release cycle, not ours, so a patch that moves
 * a field should be a data edit that any build can pick up — not a 2 500-line
 * generated source file that has to be regenerated, reviewed and rebuilt.
 */

const DATA_DIR = new URL('../data/', import.meta.url);

function readJson(name: string): unknown {
  const path = fileURLToPath(new URL(name, DATA_DIR));
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

/** Absolute path of a bundled data file, for tooling that wants to diff or reload it. */
export function bundledDataPath(name: string): string {
  return fileURLToPath(new URL(name, DATA_DIR));
}

/**
 * Builds a registry from the bundled definitions.
 *
 * @throws {SchemaError} if the shipped data is invalid — which is a build
 *   problem, not a runtime one, and should stop startup immediately.
 */
export function createBundledRegistry(): PacketRegistry {
  return PacketRegistry.create(readJson('packet-definitions.json'), readJson('stat-types.json'));
}
