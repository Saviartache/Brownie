import { describe, expect, it } from 'vitest';
import { ByteReader, ByteWriter, DecodeError, EncodeError } from '../src/index.js';

describe('ByteReader', () => {
  it('reads big-endian primitives', () => {
    const buf = Buffer.from('7fff8000000000017fffffffffffffff3f800000', 'hex');
    const r = new ByteReader(buf);
    expect(r.i16()).toBe(32767);
    expect(r.i16()).toBe(-32768);
    expect(r.i32()).toBe(1);
    expect(r.i32()).toBe(0x7fffffff);
    expect(r.u32()).toBe(0xffffffff);
    expect(r.f32()).toBe(1);
    expect(r.remaining).toBe(0);
  });

  it('reads length-prefixed strings, including multi-byte UTF-8', () => {
    const w = new ByteWriter();
    w.string16('héllo ✦');
    w.string32('wide');
    const r = new ByteReader(w.finish());
    expect(r.string16()).toBe('héllo ✦');
    expect(r.string32()).toBe('wide');
  });

  describe('malformed input', () => {
    it('throws a DecodeError with an offset instead of a RangeError', () => {
      const r = new ByteReader(Buffer.from([1, 2, 3]));
      expect(() => r.i32()).toThrow(DecodeError);
      expect(() => new ByteReader(Buffer.alloc(0)).u8()).toThrow(/unexpected end of packet/);
    });

    it('rejects a string whose declared length runs past the buffer', () => {
      // length 0x7fff, one byte of payload
      const buf = Buffer.from([0x7f, 0xff, 0x41]);
      expect(() => new ByteReader(buf).string16()).toThrow(DecodeError);
    });

    it('rejects a negative string length', () => {
      expect(() => new ByteReader(Buffer.from([0xff, 0xff])).string16()).toThrow(
        /negative string length/,
      );
    });

    it('rejects a reader window outside its buffer', () => {
      expect(() => new ByteReader(Buffer.alloc(4), 0, 5)).toThrow(DecodeError);
      expect(() => new ByteReader(Buffer.alloc(4), 3, 2)).toThrow(DecodeError);
    });

    it('rejects a compressed int that never terminates', () => {
      // every byte sets the continuation bit
      const buf = Buffer.alloc(16, 0xff);
      expect(() => new ByteReader(buf).compressedInt()).toThrow(/longer than int32/);
    });

    it('rejects a compressed int beyond int32 range', () => {
      // 0xbf = continuation + sign + 63, then five full payload bytes
      const buf = Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0x0f]);
      expect(() => new ByteReader(buf).compressedInt()).toThrow(DecodeError);
    });
  });
});

describe('ByteWriter', () => {
  it('grows past its initial capacity without corrupting what was written', () => {
    const w = new ByteWriter(16);
    for (let i = 0; i < 1000; i++) w.i32(i);
    const r = new ByteReader(w.finish());
    for (let i = 0; i < 1000; i++) expect(r.i32()).toBe(i);
    expect(r.remaining).toBe(0);
  });

  it('patches a length already written', () => {
    const w = new ByteWriter();
    w.u32(0).u8(42).bytes(Buffer.from('body'));
    w.patchU32(0, w.length);
    const out = w.finish();
    expect(out.readUInt32BE(0)).toBe(out.length);
  });

  it('is single-use: a sealed writer refuses further writes', () => {
    const w = new ByteWriter();
    w.u8(1);
    w.finish();
    expect(() => w.u8(2)).toThrow(EncodeError);
    expect(() => w.finish()).toThrow(EncodeError);
    expect(() => w.patchU32(0, 1)).toThrow(EncodeError);
  });

  it('rejects values that do not fit their type', () => {
    expect(() => new ByteWriter().u8(300)).not.toThrow(); // byte is masked, as the wire does
    expect(() => new ByteWriter().i16(40000)).toThrow(EncodeError);
    expect(() => new ByteWriter().u16(-1)).toThrow(EncodeError);
    expect(() => new ByteWriter().i32(1.5)).toThrow(EncodeError);
  });

  it('rejects a patch outside the written region', () => {
    const w = new ByteWriter();
    w.u8(1);
    expect(() => w.patchU32(0, 5)).toThrow(EncodeError);
  });
});

describe('compressed int', () => {
  const values = [
    0, 1, -1, 63, -63, 64, -64, 127, 128, 255, 256, 8191, 8192, 1_000_000, -1_000_000, 0x7fffffff,
    -0x7fffffff,
  ];

  it('round-trips every representative value', () => {
    for (const value of values) {
      const w = new ByteWriter(8);
      w.compressedInt(value);
      const encoded = w.finish();
      expect(new ByteReader(encoded).compressedInt(), `value ${String(value)}`).toBe(value);
    }
  });

  it('uses the reference encoding', () => {
    // Captured from the reference implementation: sign in bit 6 of the first
    // byte, six payload bits there and seven in each continuation byte.
    const cases: ReadonlyArray<readonly [number, string]> = [
      [0, '00'],
      [1, '01'],
      [-1, '41'],
      [63, '3f'],
      [-63, '7f'],
      [64, '8001'],
      [-64, 'c001'],
      [127, 'bf01'],
      [128, '8002'],
      [8192, '808001'],
      [1_000_000, '80897a'],
      [0x7fffffff, 'bfffffff0f'],
    ];
    for (const [value, hex] of cases) {
      const w = new ByteWriter(8);
      w.compressedInt(value);
      expect(w.finish().toString('hex'), `value ${String(value)}`).toBe(hex);
    }
  });

  it('rejects non-integers and out-of-range magnitudes', () => {
    expect(() => new ByteWriter().compressedInt(1.5)).toThrow(EncodeError);
    expect(() => new ByteWriter().compressedInt(0x80000000)).toThrow(EncodeError);
  });
});
