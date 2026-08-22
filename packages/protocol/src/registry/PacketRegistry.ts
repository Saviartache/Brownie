import { SchemaError } from '../errors.js';
import { loadDefinitions } from '../schema/loadDefinitions.js';
import type { ObjectSchema, PacketSchema } from '../schema/types.js';

/**
 * The one place that answers "what is packet 42?".
 *
 * Built once at startup from validated definitions and immutable afterwards.
 * Everything is a map lookup rather than a `switch` over 170 cases, so adding a
 * packet is a data edit and no code changes shape.
 */
export class PacketRegistry {
  readonly #byId: ReadonlyMap<number, PacketSchema>;
  readonly #byName: ReadonlyMap<string, PacketSchema>;
  readonly #objects: ReadonlyMap<string, ObjectSchema>;
  readonly #stringStats: ReadonlySet<number>;
  readonly #statNames: ReadonlyMap<number, string>;

  private constructor(
    byId: ReadonlyMap<number, PacketSchema>,
    byName: ReadonlyMap<string, PacketSchema>,
    objects: ReadonlyMap<string, ObjectSchema>,
    stringStats: ReadonlySet<number>,
    statNames: ReadonlyMap<number, string>,
  ) {
    this.#byId = byId;
    this.#byName = byName;
    this.#objects = objects;
    this.#stringStats = stringStats;
    this.#statNames = statNames;
  }

  /**
   * @param definitions parsed `packet-definitions.json`
   * @param statTypes   parsed `stat-types.json`
   * @throws {SchemaError} if either document is invalid
   */
  static create(definitions: unknown, statTypes: unknown): PacketRegistry {
    const loaded = loadDefinitions(definitions);
    const byId = new Map<number, PacketSchema>();
    const byName = new Map<string, PacketSchema>();
    for (const schema of loaded.packets) {
      byId.set(schema.id, schema);
      byName.set(schema.name, schema);
    }
    const stats = parseStatTypes(statTypes);
    return new PacketRegistry(byId, byName, loaded.objects, stats.stringStats, stats.statNames);
  }

  get packetCount(): number {
    return this.#byId.size;
  }

  /** Every defined packet name, sorted — used by tooling and by `/cmds`-style listings. */
  packetNames(): readonly string[] {
    return [...this.#byName.keys()].sort();
  }

  /** `undefined` for an id the definitions do not describe; such packets forward opaquely. */
  schemaById(id: number): PacketSchema | undefined {
    return this.#byId.get(id);
  }

  schemaByName(name: string): PacketSchema | undefined {
    return this.#byName.get(name);
  }

  idOf(name: string): number | undefined {
    return this.#byName.get(name)?.id;
  }

  nameOf(id: number): string | undefined {
    return this.#byId.get(id)?.name;
  }

  /**
   * Never `undefined` in practice: {@link loadDefinitions} rejects a document
   * whose fields reference an object it does not declare.
   */
  objectSchema(ref: string): ObjectSchema | undefined {
    return this.#objects.get(ref);
  }

  /** Whether a stat id carries a string payload rather than a compressed int. */
  isStringStat(statId: number): boolean {
    return this.#stringStats.has(statId);
  }

  /** Human-readable stat name, for diagnostics only. */
  statName(statId: number): string | undefined {
    return this.#statNames.get(statId);
  }
}

function parseStatTypes(document: unknown): {
  stringStats: ReadonlySet<number>;
  statNames: ReadonlyMap<number, string>;
} {
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    throw new SchemaError('statTypes: expected an object');
  }
  const record = document as Record<string, unknown>;

  const rawStringStats = record['stringStats'] ?? [];
  if (!Array.isArray(rawStringStats))
    throw new SchemaError('statTypes.stringStats must be an array');
  const stringStats = new Set<number>();
  rawStringStats.forEach((value, index) => {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      throw new SchemaError(`statTypes.stringStats[${String(index)}] must be an integer`);
    }
    stringStats.add(value);
  });

  const statNames = new Map<number, string>();
  const rawNames = record['statNames'];
  if (rawNames !== undefined) {
    if (typeof rawNames !== 'object' || rawNames === null || Array.isArray(rawNames)) {
      throw new SchemaError('statTypes.statNames must be an object');
    }
    for (const [key, value] of Object.entries(rawNames as Record<string, unknown>)) {
      const id = Number(key);
      if (!Number.isInteger(id) || typeof value !== 'string') {
        throw new SchemaError(`statTypes.statNames["${key}"] must map an integer id to a string`);
      }
      statNames.set(id, value);
    }
  }

  return { stringStats, statNames };
}
