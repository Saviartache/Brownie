import { SchemaError } from '../errors.js';
import {
  PacketDirection,
  type FieldSchema,
  type FieldValue,
  type LengthType,
  type ObjectSchema,
  type PacketSchema,
  type PresenceBit,
  type PrimitiveType,
  type ValueSchema,
} from './types.js';

const PRIMITIVES = new Set<string>([
  'byte',
  'sbyte',
  'bool',
  'int16',
  'uint16',
  'int32',
  'uint32',
  'float',
  'string',
  'utf32string',
  'compressedInt',
  'byteArray16',
  'byteArray32',
]);

const LENGTH_TYPES = new Set<string>(['byte', 'int16', 'uint16', 'int32', 'compressedInt']);
const DEFAULT_LENGTH_TYPE: LengthType = 'int16';

export interface LoadedDefinitions {
  readonly packets: readonly PacketSchema[];
  readonly objects: ReadonlyMap<string, ObjectSchema>;
}

/**
 * Validates a raw definitions document and normalises it.
 *
 * Everything here fails loudly at startup, because a definition problem that
 * survives to runtime shows up as corrupted traffic on a live connection — the
 * hardest possible place to diagnose it. Each message names the exact path in
 * the document.
 */
export function loadDefinitions(document: unknown): LoadedDefinitions {
  const root = asRecord(document, 'definitions');
  const rawObjects = asRecord(root['dataObjects'] ?? {}, 'dataObjects');
  const rawPackets = asRecord(root['packets'], 'packets');

  // Object schemas first: packet fields may reference them.
  const objectNames = new Set(Object.keys(rawObjects));
  const objects = new Map<string, ObjectSchema>();
  for (const [name, raw] of Object.entries(rawObjects)) {
    const path = `dataObjects.${name}`;
    const fields = parseFields(asRecord(raw, path)['fields'], path, objectNames, {
      allowOptional: false,
    });
    objects.set(name, { name, fields });
  }
  assertNoObjectCycles(objects);

  const packets: PacketSchema[] = [];
  const seenNames = new Map<string, number>();
  for (const [rawId, raw] of Object.entries(rawPackets)) {
    const path = `packets.${rawId}`;
    const id = Number(rawId);
    if (!Number.isInteger(id) || id < 0 || id > 255) {
      throw new SchemaError(`${path}: packet id must be an integer in 0..255`);
    }

    const record = asRecord(raw, path);
    const name = asString(record['name'], `${path}.name`);
    if (name === '') throw new SchemaError(`${path}.name must not be empty`);
    const previous = seenNames.get(name);
    if (previous !== undefined) {
      throw new SchemaError(
        `${path}.name "${name}" is already used by packet ${String(previous)} — names must be unique`,
      );
    }
    seenNames.set(name, id);

    packets.push({
      id,
      name,
      direction: parseDirection(record['direction'], `${path}.direction`),
      fields: parseFields(record['fields'], path, objectNames, { allowOptional: true }),
    });
  }

  if (packets.length === 0) throw new SchemaError('packets: document declares no packets');
  return { packets, objects };
}

function parseDirection(raw: unknown, path: string): PacketDirection {
  const value = asString(raw, path);
  if (value === 'client') return PacketDirection.ClientToServer;
  if (value === 'server') return PacketDirection.ServerToClient;
  throw new SchemaError(`${path}: expected "client" or "server", got "${value}"`);
}

function parseFields(
  raw: unknown,
  path: string,
  objectNames: ReadonlySet<string>,
  options: { allowOptional: boolean },
): readonly FieldSchema[] {
  if (!Array.isArray(raw)) throw new SchemaError(`${path}.fields must be an array`);

  const fields: FieldSchema[] = [];
  const seen = new Set<string>();
  let sawOptional = false;

  raw.forEach((entry, index) => {
    const fieldPath = `${path}.fields[${String(index)}]`;
    const record = asRecord(entry, fieldPath);
    const name = asString(record['name'], `${fieldPath}.name`);
    if (seen.has(name)) throw new SchemaError(`${fieldPath}: duplicate field name "${name}"`);
    seen.add(name);

    const optional = record['optional'] === true;
    if (optional && !options.allowOptional) {
      throw new SchemaError(
        `${fieldPath}: optional fields are only allowed on packets, not on data objects — ` +
          'an absent field inside a nested object cannot be distinguished from a short packet',
      );
    }
    // Positional layout: once a field may be absent, everything after it may be
    // absent too. A required field behind an optional one is undecodable.
    if (sawOptional && !optional) {
      throw new SchemaError(
        `${fieldPath}: required field "${name}" follows an optional field — optional fields must be trailing`,
      );
    }
    if (optional) sawOptional = true;

    const value = parseValue(record, fieldPath, objectNames);
    const presentWhen = parsePresence(record['presentWhen'], fieldPath, fields);
    fields.push({
      name,
      value,
      optional,
      presentWhen,
      defaultValue:
        optional || presentWhen !== undefined
          ? parseDefault(record['default'], fieldPath)
          : undefined,
    });
  });

  return fields;
}

/** Integer types a presence mask may be carried in. */
const MASK_TYPES: ReadonlySet<string> = new Set([
  'byte',
  'sbyte',
  'int16',
  'uint16',
  'int32',
  'uint32',
  'compressedInt',
]);

/**
 * The bit that says whether a field is on the wire. See {@link PresenceBit}.
 *
 * **Every part of it is checked here rather than at decode time**, because a
 * mask naming a field that does not exist, or one that is a string, is a typo
 * in a data file — and the difference between catching that at load and
 * catching it on a live connection is the difference between a startup error
 * and a packet stream that silently reads the wrong bytes.
 */
function parsePresence(
  raw: unknown,
  path: string,
  earlier: readonly FieldSchema[],
): PresenceBit | undefined {
  if (raw === undefined) return undefined;
  const record = asRecord(raw, `${path}.presentWhen`);
  const field = asString(record['field'], `${path}.presentWhen.field`);

  // Earlier, because the mask has to have been read before it can be consulted
  // — and in *this* list, because a nested object is read on its own.
  const carrier = earlier.find((candidate) => candidate.name === field);
  if (carrier === undefined) {
    throw new SchemaError(
      `${path}.presentWhen.field: no earlier field named "${field}" to read the mask from`,
    );
  }
  if (carrier.value.kind !== 'primitive' || !MASK_TYPES.has(carrier.value.type)) {
    throw new SchemaError(
      `${path}.presentWhen.field: "${field}" is not an integer, so it cannot carry a mask`,
    );
  }
  // A mask that is itself conditional is a mask that may not be there, and a
  // field whose presence cannot be decided is a field that cannot be read.
  if (carrier.optional || carrier.presentWhen !== undefined) {
    throw new SchemaError(
      `${path}.presentWhen.field: "${field}" may itself be absent, so it cannot decide anything`,
    );
  }

  const bit = record['bit'];
  if (typeof bit !== 'number' || !Number.isInteger(bit) || bit <= 0 || bit > 0x7fff_ffff) {
    throw new SchemaError(
      `${path}.presentWhen.bit: expected a positive integer, got ${String(bit)}`,
    );
  }
  // One bit, not a mask of several: two fields sharing a bit is a layout this
  // cannot describe, and a "bit" of 3 is nearly always a typo for 2 or 4.
  if ((bit & (bit - 1)) !== 0) {
    throw new SchemaError(`${path}.presentWhen.bit: ${String(bit)} is not a single bit`);
  }
  return { field, bit };
}

function parseValue(
  record: Readonly<Record<string, unknown>>,
  path: string,
  objectNames: ReadonlySet<string>,
): ValueSchema {
  const type = asString(record['type'], `${path}.type`);

  if (type === 'array') {
    const elementType = asString(record['elementType'], `${path}.elementType`);
    if (elementType === 'array') {
      throw new SchemaError(`${path}.elementType: arrays of arrays are not expressible`);
    }
    const rawLength = record['lengthType'];
    const lengthType =
      rawLength === undefined ? DEFAULT_LENGTH_TYPE : asString(rawLength, `${path}.lengthType`);
    if (!LENGTH_TYPES.has(lengthType)) {
      throw new SchemaError(
        `${path}.lengthType: "${lengthType}" is not one of ${[...LENGTH_TYPES].join(', ')}`,
      );
    }
    return {
      kind: 'array',
      lengthType: lengthType as LengthType,
      element: namedType(elementType, `${path}.elementType`, objectNames),
    };
  }

  return namedType(type, `${path}.type`, objectNames);
}

function namedType(type: string, path: string, objectNames: ReadonlySet<string>): ValueSchema {
  if (PRIMITIVES.has(type)) return { kind: 'primitive', type: type as PrimitiveType };
  if (type === 'statValue') return { kind: 'statValue' };
  if (objectNames.has(type)) return { kind: 'object', ref: type };
  throw new SchemaError(`${path}: unknown type "${type}"`);
}

function parseDefault(raw: unknown, path: string): FieldValue | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'number' || typeof raw === 'string' || typeof raw === 'boolean') return raw;
  throw new SchemaError(`${path}.default must be a number, string or boolean`);
}

/**
 * A data object that contains itself, directly or through another object, has
 * no finite encoding — decoding it would recurse until the stack gave out.
 */
function assertNoObjectCycles(objects: ReadonlyMap<string, ObjectSchema>): void {
  const state = new Map<string, 'visiting' | 'done'>();

  const visit = (name: string, trail: readonly string[]): void => {
    const mark = state.get(name);
    if (mark === 'done') return;
    if (mark === 'visiting') {
      throw new SchemaError(`dataObjects: cyclic reference ${[...trail, name].join(' -> ')}`);
    }
    state.set(name, 'visiting');

    const schema = objects.get(name);
    if (schema !== undefined) {
      for (const field of schema.fields) {
        const ref = referencedObject(field.value);
        if (ref !== undefined) visit(ref, [...trail, name]);
      }
    }
    state.set(name, 'done');
  };

  for (const name of objects.keys()) visit(name, []);
}

function referencedObject(value: ValueSchema): string | undefined {
  if (value.kind === 'object') return value.ref;
  if (value.kind === 'array' && value.element.kind === 'object') return value.element.ref;
  return undefined;
}

function asRecord(value: unknown, path: string): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SchemaError(`${path}: expected an object`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, path: string): string {
  if (typeof value !== 'string') throw new SchemaError(`${path}: expected a string`);
  return value;
}
