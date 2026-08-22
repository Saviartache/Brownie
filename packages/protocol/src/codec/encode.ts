import { ByteWriter } from '../binary/ByteWriter.js';
import { EncodeError } from '../errors.js';
import type { PacketRegistry } from '../registry/PacketRegistry.js';
import type {
  FieldSchema,
  FieldValue,
  PacketFields,
  PacketSchema,
  ValueSchema,
} from '../schema/types.js';
import type { DecodedPacket } from './DecodedPacket.js';

/** The minimum a packet must carry to be serialisable. {@link DecodedPacket} satisfies it. */
export interface EncodablePacket {
  readonly id: number;
  readonly schema: PacketSchema | undefined;
  readonly fields: PacketFields;
  readonly trailing?: Buffer;
  /** Original bytes; required when the packet is opaque. */
  readonly frame?: Buffer;
}

/**
 * Serialises a packet into a complete frame, length stamped.
 *
 * Call this only for packets a stage actually modified, or packets built from
 * scratch. Forwarding an untouched packet re-uses its `frame`.
 */
export function encodePacket(registry: PacketRegistry, packet: EncodablePacket): Buffer {
  const { schema } = packet;
  if (schema === undefined) {
    if (packet.frame === undefined) {
      throw new EncodeError(`packet ${String(packet.id)} is opaque and has no original bytes`);
    }
    return packet.frame;
  }

  const writer = new ByteWriter();
  writer.u32(0); // length placeholder, stamped below
  writer.u8(packet.id);

  writeFieldList(registry, writer, schema.fields, packet.fields, schema.name);

  if (packet.trailing !== undefined && packet.trailing.length > 0) {
    writer.bytes(packet.trailing);
  }

  const total = writer.length;
  writer.patchU32(0, total);
  return writer.finish();
}

/** Builds an empty packet ready to have fields set and be encoded. */
export function createPacket(registry: PacketRegistry, name: string): DecodedPacket {
  const schema = registry.schemaByName(name);
  if (schema === undefined) throw new EncodeError(`no packet definition named "${name}"`);
  return {
    id: schema.id,
    name: schema.name,
    direction: schema.direction,
    schema,
    frame: Buffer.alloc(0),
    fields: {},
    trailing: Buffer.alloc(0),
    error: undefined,
  };
}

/**
 * Writes a field list — a packet body or a data object — in definition order.
 *
 * `values` doubles as the scope a `statValue` resolves its sibling `id` from,
 * which is why field lists are written here rather than through
 * {@link writeValue}: the dependency only exists between siblings.
 */
function writeFieldList(
  registry: PacketRegistry,
  writer: ByteWriter,
  fields: readonly FieldSchema[],
  values: Readonly<Record<string, FieldValue | undefined>>,
  path: string,
): void {
  for (const field of fields) {
    const value = values[field.name];
    const fieldPath = `${path}.${field.name}`;

    // Trailing optionals are positional: an absent one ends the packet, so
    // nothing after it can be written either. `undefined` means "not on the
    // wire", which is exactly what the decoder records.
    if (field.optional && value === undefined) return;

    if (field.value.kind === 'statValue') {
      writeStatValue(registry, writer, values, value, fieldPath);
      continue;
    }
    writeValue(registry, writer, field.value, value, fieldPath);
  }
}

function writeValue(
  registry: PacketRegistry,
  writer: ByteWriter,
  schema: ValueSchema,
  value: FieldValue | undefined,
  path: string,
): void {
  switch (schema.kind) {
    case 'primitive':
      writePrimitive(writer, schema.type, value, path);
      return;

    case 'statValue':
      // Only reachable for an array *of* stat values, which no definition uses
      // and which could not be decoded either: there would be no sibling `id`.
      throw new EncodeError(`${path}: a stat value must live inside an object that carries its id`);

    case 'object': {
      const objectSchema = registry.objectSchema(schema.ref);
      if (objectSchema === undefined) {
        throw new EncodeError(`${path}: unknown data object "${schema.ref}"`);
      }
      // Object fields are never optional (the schema loader rejects that), so
      // every field is "present".
      writeFieldList(registry, writer, objectSchema.fields, asRecord(value, path), path);
      return;
    }

    case 'array': {
      const items = value ?? [];
      if (!Array.isArray(items)) throw new EncodeError(`${path}: expected an array`);
      writeLength(writer, schema.lengthType, items.length, path);
      items.forEach((item: FieldValue, index: number) => {
        writeValue(registry, writer, schema.element, item, `${path}[${String(index)}]`);
      });
      return;
    }
  }
}

function writeStatValue(
  registry: PacketRegistry,
  writer: ByteWriter,
  scope: Readonly<Record<string, FieldValue | undefined>>,
  value: FieldValue | undefined,
  path: string,
): void {
  const statId = scope['id'];
  if (typeof statId !== 'number') {
    throw new EncodeError(`${path}: stat value has no sibling numeric \`id\``);
  }
  if (registry.isStringStat(statId)) {
    writer.string16(typeof value === 'string' ? value : '');
  } else {
    writer.compressedInt(typeof value === 'number' ? value : 0);
  }
}

function writeLength(writer: ByteWriter, type: string, count: number, path: string): void {
  switch (type) {
    case 'byte':
      writer.u8(count);
      return;
    case 'int16':
      writer.i16(count);
      return;
    case 'uint16':
      writer.u16(count);
      return;
    case 'int32':
      writer.i32(count);
      return;
    case 'compressedInt':
      writer.compressedInt(count);
      return;
    default:
      throw new EncodeError(`${path}: unsupported array length type "${type}"`);
  }
}

function writePrimitive(
  writer: ByteWriter,
  type: string,
  value: FieldValue | undefined,
  path: string,
): void {
  switch (type) {
    case 'byte':
      writer.u8(asNumber(value, path));
      return;
    case 'sbyte':
      writer.i8(asNumber(value, path));
      return;
    case 'bool':
      writer.bool(value === true);
      return;
    case 'int16':
      writer.i16(asNumber(value, path));
      return;
    case 'uint16':
      writer.u16(asNumber(value, path));
      return;
    case 'int32':
      writer.i32(asNumber(value, path));
      return;
    case 'uint32':
      writer.u32(asNumber(value, path));
      return;
    case 'float':
      writer.f32(typeof value === 'number' ? value : 0);
      return;
    case 'string':
      writer.string16(asString(value, path));
      return;
    case 'utf32string':
      writer.string32(asString(value, path));
      return;
    case 'compressedInt':
      writer.compressedInt(asNumber(value, path));
      return;
    case 'byteArray16': {
      const bytes = asBytes(value, path);
      writer.i16(bytes.length).bytes(bytes);
      return;
    }
    case 'byteArray32': {
      const bytes = asBytes(value, path);
      writer.i32(bytes.length).bytes(bytes);
      return;
    }
    default:
      throw new EncodeError(`${path}: unsupported primitive "${type}"`);
  }
}

function asNumber(value: FieldValue | undefined, path: string): number {
  if (typeof value === 'number') return value;
  if (value === undefined) return 0;
  throw new EncodeError(`${path}: expected a number, got ${typeof value}`);
}

function asString(value: FieldValue | undefined, path: string): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return '';
  throw new EncodeError(`${path}: expected a string, got ${typeof value}`);
}

function asBytes(value: FieldValue | undefined, path: string): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (value === undefined) return Buffer.alloc(0);
  throw new EncodeError(`${path}: expected a byte buffer`);
}

/**
 * Takes `unknown` rather than `FieldValue` on purpose: field values reach the
 * encoder from plugin code and persisted JSON, so the declared type is a claim
 * and not a guarantee. Validating here is what keeps a bad value from becoming
 * a malformed packet on a live connection.
 */
function asRecord(value: unknown, path: string): Readonly<Record<string, FieldValue | undefined>> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Buffer.isBuffer(value)
  ) {
    throw new EncodeError(`${path}: expected an object`);
  }
  return value as Record<string, FieldValue | undefined>;
}
