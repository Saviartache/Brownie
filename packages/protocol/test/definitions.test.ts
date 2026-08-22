import { describe, expect, it } from 'vitest';
import { createBundledRegistry } from '../src/bundled.js';
import {
  decodeFrame,
  encodePacket,
  isOpaque,
  type FieldSchema,
  type FieldValue,
  type PacketFields,
  type PacketRegistry,
  type ValueSchema,
} from '../src/index.js';

/**
 * The definitions that actually ship. These tests are the reason the wire
 * format can stay in a JSON file: the file is validated, exercised and
 * round-tripped on every run, so a bad edit fails here rather than on a live
 * connection.
 */
const registry: PacketRegistry = createBundledRegistry();

/** Small deterministic PRNG — reproducible failures matter more than entropy. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state = (state * 1_103_515_245 + 12_345) & 0x7fff_ffff;
    return state / 0x7fff_ffff;
  };
}

function generateFields(fields: readonly FieldSchema[], rand: () => number): PacketFields {
  const values: PacketFields = {};
  for (const field of fields) {
    values[field.name] = generateValue(field.value, rand, values);
  }
  return values;
}

function generateValue(schema: ValueSchema, rand: () => number, scope: PacketFields): FieldValue {
  switch (schema.kind) {
    case 'primitive':
      return generatePrimitive(schema.type, rand);
    case 'statValue': {
      const statId = scope['id'];
      return typeof statId === 'number' && registry.isStringStat(statId)
        ? `stat-${String(Math.floor(rand() * 1000))}`
        : Math.floor(rand() * 2000) - 1000;
    }
    case 'object': {
      const objectSchema = registry.objectSchema(schema.ref);
      expect(objectSchema, `object ${schema.ref} is declared`).toBeDefined();
      return generateFields(objectSchema!.fields, rand) as FieldValue;
    }
    case 'array': {
      const count = Math.floor(rand() * 4);
      return Array.from({ length: count }, () => generateValue(schema.element, rand, {}));
    }
  }
}

function generatePrimitive(type: string, rand: () => number): FieldValue {
  const n = (max: number): number => Math.floor(rand() * max);
  switch (type) {
    case 'byte':
      return n(256);
    case 'sbyte':
      return n(256) - 128;
    case 'bool':
      return rand() > 0.5;
    case 'int16':
      return n(65536) - 32768;
    case 'uint16':
      return n(65536);
    case 'int32':
      return n(2_000_000) - 1_000_000;
    case 'uint32':
      return n(4_000_000);
    // Whole numbers only: float32 cannot represent every double, and this test
    // is about field layout, not about IEEE rounding.
    case 'float':
      return n(10_000) - 5000;
    case 'string':
    case 'utf32string':
      return rand() > 0.8 ? '' : `s${String(n(100_000))}`;
    case 'compressedInt':
      return n(200_000) - 100_000;
    case 'byteArray16':
    case 'byteArray32':
      return Buffer.from(Array.from({ length: n(8) }, () => n(256)));
    default:
      throw new Error(`generator missing for primitive ${type}`);
  }
}

describe('bundled definitions', () => {
  it('load and validate', () => {
    expect(registry.packetCount).toBeGreaterThan(100);
    expect(registry.idOf('HELLO')).toBeDefined();
    expect(registry.idOf('UPDATE')).toBeDefined();
    expect(registry.idOf('NEWTICK')).toBeDefined();
    expect(registry.idOf('RECONNECT')).toBeDefined();
  });

  it('round-trip every packet with generated values', () => {
    const rand = makeRandom(0x5eed);

    for (const name of registry.packetNames()) {
      const schema = registry.schemaByName(name)!;
      for (let attempt = 0; attempt < 4; attempt++) {
        const source = { id: schema.id, schema, fields: generateFields(schema.fields, rand) };
        const frame = encodePacket(registry, source);

        expect(frame.readInt32BE(0), `${name}: length header`).toBe(frame.length);
        expect(frame.readUInt8(4), `${name}: id byte`).toBe(schema.id);

        const decoded = decodeFrame(registry, frame);
        expect(
          isOpaque(decoded),
          `${name}: decoded cleanly — ${decoded.error?.message ?? ''}`,
        ).toBe(false);
        expect(decoded.fields, `${name}: fields survive a round trip`).toEqual(source.fields);
        expect(decoded.trailing, `${name}: nothing left over`).toHaveLength(0);

        // Re-encoding a decoded packet must reproduce the same bytes.
        expect(encodePacket(registry, decoded).equals(frame), `${name}: stable re-encode`).toBe(
          true,
        );
      }
    }
  });

  it('never throws on hostile input for any id', () => {
    const rand = makeRandom(0xbadc0de);

    for (let id = 0; id < 256; id++) {
      for (const length of [0, 1, 2, 3, 7, 16, 64, 255]) {
        const body = Buffer.from(Array.from({ length }, () => Math.floor(rand() * 256)));
        const frame = Buffer.alloc(5 + body.length);
        frame.writeInt32BE(frame.length, 0);
        frame.writeUInt8(id, 4);
        body.copy(frame, 5);

        const packet = decodeFrame(registry, frame);
        // Whatever happened, the original bytes must still be forwardable.
        expect(encodePacket(registry, packet).length).toBeGreaterThanOrEqual(5);
      }
    }
  });
});
