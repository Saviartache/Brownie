import { ByteReader } from '../binary/ByteReader.js';
import { DecodeError, FrameError } from '../errors.js';
import { HEADER_BYTES } from '../framing/frame.js';
import type { PacketRegistry } from '../registry/PacketRegistry.js';
import type {
  FieldSchema,
  FieldValue,
  PacketFields,
  PacketSchema,
  PresenceBit,
  ValueSchema,
} from '../schema/types.js';
import type { DecodedPacket } from './DecodedPacket.js';

/**
 * Decodes one deciphered frame.
 *
 * Never throws for a body problem. An id we do not define, or a body that does
 * not match its definition, yields an *opaque* packet: the original bytes are
 * kept intact and forward unchanged. That is the difference between "we cannot
 * describe this packet" and "this connection is broken", and conflating the two
 * is how a definition that drifted after a game patch takes players offline.
 *
 * @throws {FrameError} only if handed something that is not a frame at all.
 */
export function decodeFrame(registry: PacketRegistry, frame: Buffer): DecodedPacket {
  if (frame.length < HEADER_BYTES) {
    throw new FrameError(`frame of ${String(frame.length)} bytes is shorter than its header`);
  }

  const id = frame.readUInt8(4);
  const schema = registry.schemaById(id);
  if (schema === undefined) {
    return {
      id,
      name: `UNKNOWN_${String(id)}`,
      direction: undefined,
      schema: undefined,
      frame,
      fields: {},
      trailing: Buffer.from(frame.subarray(HEADER_BYTES)),
      error: undefined,
    };
  }

  try {
    const reader = new ByteReader(frame, HEADER_BYTES);
    const fields = readFields(registry, reader, schema.fields, new FieldPath(schema.name));
    return {
      id,
      name: schema.name,
      direction: schema.direction,
      schema,
      frame,
      fields,
      trailing: reader.rest(),
      error: undefined,
    };
  } catch (cause) {
    const error =
      cause instanceof DecodeError
        ? new DecodeError(cause.message, {
            ...cause.context,
            packetId: id,
            packetName: schema.name,
          })
        : new DecodeError(String(cause), { packetId: id, packetName: schema.name });
    return {
      id,
      name: schema.name,
      direction: schema.direction,
      // A body we failed to read must not be re-encoded from half-read fields,
      // so the packet is marked opaque by dropping its schema.
      schema: undefined,
      frame,
      fields: {},
      trailing: Buffer.from(frame.subarray(HEADER_BYTES)),
      error,
    };
  }
}

/**
 * Decodes a body against a schema, throwing on any mismatch. Exposed for tests
 * and tooling that want the failure rather than an opaque packet.
 */
export function decodeBody(
  registry: PacketRegistry,
  schema: PacketSchema,
  frame: Buffer,
): { fields: PacketFields; trailing: Buffer } {
  const reader = new ByteReader(frame, HEADER_BYTES);
  const fields = readFields(registry, reader, schema.fields, new FieldPath(schema.name));
  return { fields, trailing: reader.rest() };
}

/**
 * Where the decoder is, for an error message.
 *
 * A stack of names rather than a string per field. Building
 * `NEWTICK.statuses[7].data[2].value` eagerly costs one string concatenation
 * for every field of every element of every array — on the path that succeeds,
 * for a value nothing reads. A busy realm's NEWTICK carries several hundred of
 * them, and that was the single largest allocator in the proxy.
 *
 * Nothing unwinds the stack when a decode throws, and nothing should: the
 * position at the moment of the throw is exactly the answer the message wants.
 */
class FieldPath {
  readonly #parts: (string | number)[];

  constructor(root: string) {
    this.#parts = [root];
  }

  enter(name: string | number): void {
    this.#parts.push(name);
  }

  leave(): void {
    this.#parts.pop();
  }

  /** `PACKET.field[3].nested`, built only when something has gone wrong. */
  describe(): string {
    let text = '';
    for (const part of this.#parts) {
      if (typeof part === 'number') {
        text += `[${String(part)}]`;
      } else {
        text += text === '' ? part : `.${part}`;
      }
    }
    return text;
  }
}

/**
 * An absent trailing optional leaves its key unset rather than being filled
 * with the schema default.
 *
 * That makes `undefined` mean exactly "not on the wire", which is what lets the
 * encoder reproduce the original bytes without tracking which fields a stage
 * touched. The default is a *game* semantic, not a wire one — callers that want
 * it ask the schema through {@link fieldDefault}.
 */
function readFields(
  registry: PacketRegistry,
  reader: ByteReader,
  fields: readonly FieldSchema[],
  path: FieldPath,
): PacketFields {
  const values: PacketFields = {};

  for (const field of fields) {
    // Optional fields are trailing (enforced by the schema loader), so "the
    // packet ended" is the only way one can be absent.
    if (field.optional && reader.exhausted) continue;
    // A conditional field is absent because a mask said so, which is a fact
    // stated on the wire rather than inferred from what is left — so it may sit
    // anywhere, and skipping it reads no bytes at all.
    if (field.presentWhen !== undefined && !present(field.presentWhen, values)) continue;
    path.enter(field.name);
    values[field.name] = readValue(registry, reader, field.value, path, values);
    path.leave();
  }

  return values;
}

/**
 * Whether the mask says this field is here.
 *
 * A mask that is missing or not a number reads as "nothing is here", which is
 * the safe answer: the alternative is reading bytes the packet does not have
 * and failing the whole body. The loader has already established that the field
 * exists, is an integer and is unconditional, so this is unreachable in
 * practice and is a floor rather than a check.
 */
export function present(bit: PresenceBit, values: PacketFields): boolean {
  const mask = values[bit.field];
  return typeof mask === 'number' && (mask & bit.bit) !== 0;
}

function readValue(
  registry: PacketRegistry,
  reader: ByteReader,
  schema: ValueSchema,
  path: FieldPath,
  scope: PacketFields,
): FieldValue {
  switch (schema.kind) {
    case 'primitive':
      return readPrimitive(reader, schema.type, path);

    case 'statValue': {
      // Scoped to the object being read — see ValueSchema.statValue.
      const statId = scope['id'];
      if (typeof statId !== 'number') {
        throw new DecodeError('stat value has no sibling numeric `id` to resolve its type', {
          path: path.describe(),
          offset: reader.position,
        });
      }
      return registry.isStringStat(statId) ? reader.string16() : reader.compressedInt();
    }

    case 'object':
      return readFields(
        registry,
        reader,
        objectFieldsOf(registry, schema.ref, path, reader),
        path,
      ) as FieldValue;

    case 'array': {
      const count = readLength(reader, schema.lengthType, path);
      if (count < 0) {
        throw new DecodeError(`negative array length ${String(count)}`, {
          path: path.describe(),
          offset: reader.position,
        });
      }
      // An element is at least one byte, so a count beyond what is left cannot
      // be satisfied. Checking up front turns a hostile length into one error
      // instead of a long allocation loop that fails at the end anyway.
      if (count > reader.remaining) {
        throw new DecodeError(
          `array declares ${String(count)} elements but only ${String(reader.remaining)} byte(s) remain`,
          { path: path.describe(), offset: reader.position },
        );
      }
      const items: FieldValue[] = new Array<FieldValue>(count);

      // An array of objects looks its element schema up once. The reference is
      // the same for every element by construction, and a busy NEWTICK carries
      // a couple of hundred of them.
      if (schema.element.kind === 'object') {
        const fields = objectFieldsOf(registry, schema.element.ref, path, reader);
        for (let i = 0; i < count; i++) {
          path.enter(i);
          items[i] = readFields(registry, reader, fields, path) as FieldValue;
          path.leave();
        }
        return items;
      }

      for (let i = 0; i < count; i++) {
        path.enter(i);
        items[i] = readValue(registry, reader, schema.element, path, {});
        path.leave();
      }
      return items;
    }
  }
}

function objectFieldsOf(
  registry: PacketRegistry,
  ref: string,
  path: FieldPath,
  reader: ByteReader,
): readonly FieldSchema[] {
  const schema = registry.objectSchema(ref);
  if (schema === undefined) {
    throw new DecodeError(`unknown data object "${ref}"`, {
      path: path.describe(),
      offset: reader.position,
    });
  }
  return schema.fields;
}

function readLength(reader: ByteReader, type: string, path: FieldPath): number {
  switch (type) {
    case 'byte':
      return reader.u8();
    case 'int16':
      return reader.i16();
    case 'uint16':
      return reader.u16();
    case 'int32':
      return reader.i32();
    case 'compressedInt':
      return reader.compressedInt();
    default:
      throw new DecodeError(`unsupported array length type "${type}"`, {
        path: path.describe(),
      });
  }
}

function readPrimitive(reader: ByteReader, type: string, path: FieldPath): FieldValue {
  switch (type) {
    case 'byte':
      return reader.u8();
    case 'sbyte':
      return reader.i8();
    case 'bool':
      return reader.bool();
    case 'int16':
      return reader.i16();
    case 'uint16':
      return reader.u16();
    case 'int32':
      return reader.i32();
    case 'uint32':
      return reader.u32();
    case 'float':
      return reader.f32();
    case 'string':
      return reader.string16();
    case 'utf32string':
      return reader.string32();
    case 'compressedInt':
      return reader.compressedInt();
    case 'byteArray16':
      return reader.bytes(reader.i16());
    case 'byteArray32':
      return reader.bytes(reader.i32());
    default:
      throw new DecodeError(`unsupported primitive "${type}"`, { path: path.describe() });
  }
}
