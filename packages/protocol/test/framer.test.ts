import { describe, expect, it } from 'vitest';
import { FrameError, MAX_FRAME_BYTES, PacketFramer } from '../src/index.js';

/** Builds a frame: int32 length (inclusive) + id byte + body. */
function frame(id: number, body: Buffer = Buffer.alloc(0)): Buffer {
  const buf = Buffer.alloc(5 + body.length);
  buf.writeInt32BE(buf.length, 0);
  buf.writeUInt8(id, 4);
  body.copy(buf, 5);
  return buf;
}

function drain(framer: PacketFramer): Buffer[] {
  return [...framer.drain()];
}

describe('PacketFramer', () => {
  it('yields nothing until a whole frame has arrived', () => {
    const f = new PacketFramer();
    f.push(Buffer.from([0, 0, 0]));
    expect(f.next()).toBeNull();
    f.push(Buffer.from([12, 7]));
    expect(f.next()).toBeNull();
    f.push(Buffer.alloc(7));
    expect(f.next()?.length).toBe(12);
  });

  it('splits several frames out of one chunk', () => {
    const f = new PacketFramer();
    f.push(Buffer.concat([frame(1, Buffer.from('a')), frame(2, Buffer.from('bb')), frame(3)]));
    const out = drain(f);
    expect(out.map((x) => x.readUInt8(4))).toEqual([1, 2, 3]);
    expect(f.buffered).toBe(0);
  });

  it('reassembles a frame delivered one byte at a time', () => {
    const original = frame(42, Buffer.from('hello world'));
    const f = new PacketFramer();
    const out: Buffer[] = [];
    for (const byte of original) {
      f.push(Buffer.from([byte]));
      out.push(...drain(f));
    }
    expect(out).toHaveLength(1);
    expect(out[0]!.equals(original)).toBe(true);
  });

  it('handles a header split across chunks', () => {
    const original = frame(9, Buffer.from('xyz'));
    const f = new PacketFramer();
    f.push(original.subarray(0, 2));
    expect(f.next()).toBeNull();
    f.push(original.subarray(2, 5));
    expect(f.next()).toBeNull();
    f.push(original.subarray(5));
    expect(f.next()!.equals(original)).toBe(true);
  });

  it('handles the tail of one frame arriving with the head of the next', () => {
    const a = frame(1, Buffer.from('aaaa'));
    const b = frame(2, Buffer.from('bbbb'));
    const stream = Buffer.concat([a, b]);
    const f = new PacketFramer();

    f.push(stream.subarray(0, a.length - 2));
    expect(drain(f)).toHaveLength(0);
    f.push(stream.subarray(a.length - 2, a.length + 3));
    expect(drain(f).map((x) => x.readUInt8(4))).toEqual([1]);
    f.push(stream.subarray(a.length + 3));
    expect(drain(f).map((x) => x.readUInt8(4))).toEqual([2]);
  });

  it('survives an arbitrary chunking of a long stream', () => {
    const frames = Array.from({ length: 200 }, (_, i) => frame(i % 256, Buffer.alloc(i % 61, i)));
    const stream = Buffer.concat(frames);

    // Deterministic pseudo-random split sizes: reproducible without a seed lib.
    const f = new PacketFramer(64);
    const received: Buffer[] = [];
    let cursor = 0;
    let rng = 1;
    while (cursor < stream.length) {
      rng = (rng * 1103515245 + 12345) & 0x7fffffff;
      const size = 1 + (rng % 97);
      f.push(stream.subarray(cursor, cursor + size));
      cursor += size;
      received.push(...drain(f));
    }

    expect(received).toHaveLength(frames.length);
    received.forEach((got, i) => {
      expect(got.equals(frames[i]!), `frame ${String(i)}`).toBe(true);
    });
    expect(f.buffered).toBe(0);
  });

  it('returns frames the caller owns, not views that later change', () => {
    const f = new PacketFramer(32);
    f.push(frame(1, Buffer.from('first-payload')));
    const first = f.next()!;
    const snapshot = Buffer.from(first);

    // Push enough to force compaction and reuse of the internal buffer.
    for (let i = 0; i < 50; i++) f.push(frame(2, Buffer.alloc(40, 0xaa)));
    drain(f);

    expect(first.equals(snapshot)).toBe(true);
  });

  describe('malformed streams', () => {
    it('rejects a frame shorter than its own header', () => {
      const f = new PacketFramer();
      const bad = Buffer.alloc(8);
      bad.writeInt32BE(4, 0); // length must be at least 5
      f.push(bad);
      expect(() => f.next()).toThrow(FrameError);
    });

    it('rejects a zero or negative length', () => {
      for (const length of [0, -1, -2_000_000]) {
        const f = new PacketFramer();
        const bad = Buffer.alloc(8);
        bad.writeInt32BE(length, 0);
        f.push(bad);
        expect(() => f.next(), `length ${String(length)}`).toThrow(FrameError);
      }
    });

    it('rejects an absurd declared length without buffering it', () => {
      const f = new PacketFramer();
      const bad = Buffer.alloc(8);
      bad.writeInt32BE(MAX_FRAME_BYTES + 1, 0);
      f.push(bad);
      expect(() => f.next()).toThrow(/desynchronised/);
      expect(f.buffered).toBe(8);
    });

    it('treats a connection that dies mid-frame as simply incomplete', () => {
      const f = new PacketFramer();
      f.push(frame(7, Buffer.alloc(100)).subarray(0, 60));
      expect(f.next()).toBeNull();
      expect(f.buffered).toBe(60);
    });
  });

  it('ignores empty chunks and can be reset', () => {
    const f = new PacketFramer();
    f.push(Buffer.alloc(0));
    expect(f.buffered).toBe(0);
    f.push(frame(1).subarray(0, 3));
    f.reset();
    expect(f.buffered).toBe(0);
    expect(f.next()).toBeNull();
  });
});
