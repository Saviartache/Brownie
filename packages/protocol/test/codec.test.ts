import { describe, expect, it } from 'vitest';
import {
  ByteWriter,
  DecodeError,
  EncodeError,
  PacketRegistry,
  createPacket,
  decodeBody,
  decodeFrame,
  encodePacket,
  fieldDefault,
  fieldOr,
  isOpaque,
  type PacketFields,
  type PacketSchema,
} from '../src/index.js';
import { testRegistry } from './fixtures.js';

const registry = testRegistry();

/** Builds a frame around an already-written body. */
function frameOf(id: number, body: Buffer): Buffer {
  const out = Buffer.alloc(5 + body.length);
  out.writeInt32BE(out.length, 0);
  out.writeUInt8(id, 4);
  body.copy(out, 5);
  return out;
}

function build(id: number, write: (w: ByteWriter) => void): Buffer {
  const w = new ByteWriter();
  write(w);
  return frameOf(id, w.finish());
}

describe('decodeFrame', () => {
  it('decodes a simple packet', () => {
    const packet = decodeFrame(
      registry,
      build(0, (w) => w.i32(12345)),
    );
    expect(packet.name).toBe('PING');
    expect(packet.fields['serial']).toBe(12345);
    expect(isOpaque(packet)).toBe(false);
    expect(packet.trailing).toHaveLength(0);
  });

  it('decodes nested objects', () => {
    const packet = decodeFrame(
      registry,
      build(1, (w) => w.i32(7).f32(1.5).f32(-2.25).u8(3).u8(4)),
    );
    expect(packet.fields['position']).toEqual({ x: 1.5, y: -2.25 });
    expect(packet.fields['bulletType']).toBe(3);
    expect(packet.fields['numShots']).toBe(4);
  });

  it('resolves stat values from the sibling id, per element', () => {
    const frame = build(2, (w) => {
      w.compressedInt(2);
      w.u8(31).string16('Sorcerer').compressedInt(0); // string stat
      w.u8(7).compressedInt(4200).compressedInt(1); // numeric stat
      w.string16('label');
      w.i16(2).bytes(Buffer.from([0xaa, 0xbb]));
      w.bool(true);
      w.i16(0);
    });

    const packet = decodeFrame(registry, frame);
    expect(packet.fields['stats']).toEqual([
      { id: 31, value: 'Sorcerer', stackCount: 0 },
      { id: 7, value: 4200, stackCount: 1 },
    ]);
    expect(packet.fields['label']).toBe('label');
    expect(packet.fields['blob']).toEqual(Buffer.from([0xaa, 0xbb]));
    expect(packet.fields['flag']).toBe(true);
  });

  it('leaves absent trailing optionals unset rather than defaulted', () => {
    const packet = decodeFrame(
      registry,
      build(1, (w) => w.i32(7).f32(0).f32(0)),
    );
    // Absent and "present, holding the default" are different on the wire, and
    // only keeping them apart lets an untouched packet re-encode identically.
    expect('bulletType' in packet.fields).toBe(false);
    expect(packet.fields['numShots']).toBeUndefined();
    // The game's assumption is still available, from the schema.
    expect(fieldDefault(packet.schema!, 'bulletType')).toBe(255);
    expect(fieldOr(packet.schema!, packet.fields, 'bulletType')).toBe(255);
  });

  it('keeps bytes it could not describe as trailing data', () => {
    const packet = decodeFrame(
      registry,
      build(0, (w) => w.i32(1).bytes(Buffer.from('extra'))),
    );
    expect(packet.trailing.toString()).toBe('extra');
  });

  describe('is never fatal', () => {
    it('returns an opaque packet for an unknown id', () => {
      const frame = build(200, (w) => w.bytes(Buffer.from('whatever')));
      const packet = decodeFrame(registry, frame);
      expect(packet.name).toBe('UNKNOWN_200');
      expect(isOpaque(packet)).toBe(true);
      expect(packet.error).toBeUndefined();
      expect(encodePacket(registry, packet).equals(frame)).toBe(true);
    });

    it('returns an opaque packet, with the reason, for a truncated body', () => {
      const frame = build(0, (w) => w.u8(1)); // PING needs four bytes
      const packet = decodeFrame(registry, frame);
      expect(isOpaque(packet)).toBe(true);
      expect(packet.error).toBeInstanceOf(DecodeError);
      expect(packet.error?.message).toMatch(/PING/);
      expect(encodePacket(registry, packet).equals(frame)).toBe(true);
    });

    it('refuses an array whose declared count cannot fit in the packet', () => {
      const frame = build(2, (w) => w.compressedInt(100_000));
      const packet = decodeFrame(registry, frame);
      expect(packet.error?.message).toMatch(/only .* byte\(s\) remain/);
    });

    it('refuses a stat value with no sibling id', () => {
      // A hand-built registry where statValue has no `id` beside it.
      const broken = testRegistryWithLooseStat();
      const frame = build(0, (w) => w.compressedInt(1));
      expect(() => decodeBody(broken.registry, broken.schema, frame)).toThrow(/sibling numeric/);
    });

    it('does not throw on arbitrary bytes for any defined id', () => {
      for (const name of registry.packetNames()) {
        const id = registry.idOf(name)!;
        for (let length = 0; length < 40; length++) {
          const body = Buffer.alloc(length);
          for (let i = 0; i < length; i++) body[i] = (i * 37 + length * 11) & 0xff;
          expect(() => decodeFrame(registry, frameOf(id, body))).not.toThrow();
        }
      }
    });
  });
});

describe('encodePacket', () => {
  it('round-trips every decoded packet byte-for-byte', () => {
    const frames = [
      build(0, (w) => w.i32(-5)),
      build(1, (w) => w.i32(7).f32(1.5).f32(-2.25).u8(3).u8(4)),
      build(1, (w) => w.i32(7).f32(1.5).f32(-2.25)),
      build(2, (w) => {
        w.compressedInt(1);
        w.u8(38).string16('guild').compressedInt(9);
        w.string16('x');
        w.i16(0);
        w.bool(false);
        w.i16(3).compressedInt(-1).compressedInt(0).compressedInt(70000);
      }),
    ];

    for (const frame of frames) {
      const packet = decodeFrame(registry, frame);
      expect(isOpaque(packet)).toBe(false);
      expect(encodePacket(registry, packet).equals(frame), packet.name).toBe(true);
    }
  });

  it('writes a trailing optional that a stage set, and omits one it did not', () => {
    const frame = build(1, (w) => w.i32(7).f32(0).f32(0));
    const packet = decodeFrame(registry, frame);

    expect(encodePacket(registry, packet).equals(frame)).toBe(true);

    packet.fields['bulletType'] = 9;
    const rewritten = encodePacket(registry, packet);
    expect(rewritten.length).toBe(frame.length + 1);
    expect(decodeFrame(registry, rewritten).fields['bulletType']).toBe(9);
    // numShots was never set, so it stays off the wire.
    expect('numShots' in decodeFrame(registry, rewritten).fields).toBe(false);
  });

  it('stamps the frame length', () => {
    const packet = createPacket(registry, 'PING');
    packet.fields['serial'] = 1;
    const encoded = encodePacket(registry, packet);
    expect(encoded.readInt32BE(0)).toBe(encoded.length);
    expect(encoded.readUInt8(4)).toBe(0);
  });

  it('builds a packet from scratch', () => {
    const packet = createPacket(registry, 'UPDATE');
    const fields: PacketFields = {
      stats: [{ id: 31, value: 'name', stackCount: 0 }],
      label: 'hi',
      blob: Buffer.from([1, 2, 3]),
      flag: true,
      tiles: [1, 2, 3],
    };
    packet.fields = fields;

    const decoded = decodeFrame(registry, encodePacket(registry, packet));
    expect(decoded.fields).toEqual(fields);
  });

  it('rejects an unknown packet name', () => {
    expect(() => createPacket(registry, 'NOPE')).toThrow(EncodeError);
  });

  it('rejects values that do not match their field type', () => {
    const packet = createPacket(registry, 'PING');
    packet.fields['serial'] = 'not a number';
    expect(() => encodePacket(registry, packet)).toThrow(/expected a number/);
  });

  it('refuses to encode an opaque packet with no original bytes', () => {
    expect(() => encodePacket(registry, { id: 9, schema: undefined, fields: {} })).toThrow(
      /no original bytes/,
    );
  });
});

/**
 * A definition with a bare `statValue` and no `id` beside it. The real
 * definitions never do this, but a hand-edited file could, and the decoder must
 * say so rather than guess an encoding.
 */
function testRegistryWithLooseStat(): { registry: PacketRegistry; schema: PacketSchema } {
  const loose = PacketRegistry.create(
    {
      packets: {
        '0': { name: 'LOOSE', direction: 'server', fields: [{ name: 'v', type: 'statValue' }] },
      },
      dataObjects: {},
    },
    { stringStats: [] },
  );
  return { registry: loose, schema: loose.schemaByName('LOOSE')! };
}
