import { describe, expect, it } from 'vitest';
import {
  FrameFlags,
  FrameReader,
  HEADER_BYTES,
  IPC_MAGIC,
  IPC_VERSION,
  LinkError,
  MAX_PAYLOAD_BYTES,
  SequenceGuard,
  SequenceSource,
  nextSeq,
  readHeader,
  writeHeader,
} from '../src/index.js';

function frame(type: number, seq: number, payload: Buffer, flags = FrameFlags.None): Buffer {
  const buf = Buffer.alloc(HEADER_BYTES + payload.length);
  writeHeader(buf, { version: IPC_VERSION, type, flags, seq, length: payload.length });
  payload.copy(buf, HEADER_BYTES);
  return buf;
}

describe('frame header', () => {
  it('round-trips', () => {
    const buf = Buffer.alloc(HEADER_BYTES);
    writeHeader(buf, { version: IPC_VERSION, type: 0x0201, flags: 1, seq: 7, length: 42 });
    expect(readHeader(buf)).toEqual({
      version: IPC_VERSION,
      type: 0x0201,
      flags: 1,
      seq: 7,
      length: 42,
    });
  });

  it('starts with the ASCII magic', () => {
    const buf = Buffer.alloc(HEADER_BYTES);
    writeHeader(buf, { version: IPC_VERSION, type: 1, flags: 0, seq: 1, length: 0 });
    expect(buf.readUInt32LE(0)).toBe(IPC_MAGIC);
    expect(buf.toString('latin1', 0, 4)).toBe('BRWN');
  });

  it('rejects a peer that is not speaking this protocol', () => {
    const buf = Buffer.alloc(HEADER_BYTES);
    buf.writeUInt32LE(0xdead_beef, 0);
    expect(() => readHeader(buf)).toThrow(/not speaking this protocol/);
  });

  it('rejects a version it cannot parse', () => {
    const buf = Buffer.alloc(HEADER_BYTES);
    writeHeader(buf, { version: IPC_VERSION, type: 1, flags: 0, seq: 1, length: 0 });
    buf.writeUInt16LE(IPC_VERSION + 1, 4);
    expect(() => readHeader(buf)).toThrow(/speaks IPC version/);
  });

  it('rejects non-zero reserved bits', () => {
    const buf = Buffer.alloc(HEADER_BYTES);
    writeHeader(buf, { version: IPC_VERSION, type: 1, flags: 0, seq: 1, length: 0 });
    buf.writeUInt16LE(1, 10);
    expect(() => readHeader(buf)).toThrow(/reserved header field/);
  });

  it('rejects an oversized payload without buffering it', () => {
    const buf = Buffer.alloc(HEADER_BYTES);
    writeHeader(buf, { version: IPC_VERSION, type: 1, flags: 0, seq: 1, length: 0 });
    buf.writeUInt32LE(MAX_PAYLOAD_BYTES + 1, 16);
    expect(() => readHeader(buf)).toThrow(LinkError);
  });

  it('rejects a truncated header', () => {
    expect(() => readHeader(Buffer.alloc(HEADER_BYTES - 1))).toThrow(/not enough bytes/);
  });
});

describe('FrameReader', () => {
  it('yields nothing until a whole frame has arrived', () => {
    const reader = new FrameReader();
    const complete = frame(1, 1, Buffer.from('hello'));
    reader.push(complete.subarray(0, HEADER_BYTES));
    expect(reader.next()).toBeNull();
    reader.push(complete.subarray(HEADER_BYTES));
    expect(reader.next()?.payload.toString()).toBe('hello');
  });

  it('handles zero-length payloads', () => {
    const reader = new FrameReader();
    reader.push(frame(0x0100, 1, Buffer.alloc(0)));
    const got = reader.next();
    expect(got?.header.length).toBe(0);
    expect(got?.payload).toHaveLength(0);
    expect(reader.buffered).toBe(0);
  });

  it('splits several frames out of one chunk', () => {
    const reader = new FrameReader();
    reader.push(
      Buffer.concat([
        frame(1, 1, Buffer.from('a')),
        frame(2, 2, Buffer.from('bb')),
        frame(3, 3, Buffer.alloc(0)),
      ]),
    );
    expect([...reader.drain()].map((f) => f.header.type)).toEqual([1, 2, 3]);
  });

  it('reassembles a stream delivered one byte at a time', () => {
    const stream = Buffer.concat([
      frame(1, 1, Buffer.from('first')),
      frame(2, 2, Buffer.from('second')),
    ]);
    const reader = new FrameReader(HEADER_BYTES);
    const got: string[] = [];
    for (const byte of stream) {
      reader.push(Buffer.from([byte]));
      for (const f of reader.drain()) got.push(f.payload.toString());
    }
    expect(got).toEqual(['first', 'second']);
  });

  it('returns payloads the caller owns', () => {
    const reader = new FrameReader(64);
    reader.push(frame(1, 1, Buffer.from('keep-me')));
    const first = reader.next()!;
    const snapshot = Buffer.from(first.payload);

    for (let i = 0; i < 40; i++) reader.push(frame(2, i + 2, Buffer.alloc(50, 0xcc)));
    const later = [...reader.drain()];
    expect(later).toHaveLength(40);

    expect(first.payload.equals(snapshot)).toBe(true);
  });

  it('surfaces a bad header as a link error, leaving the bytes in place', () => {
    const reader = new FrameReader();
    const bad = Buffer.alloc(HEADER_BYTES);
    bad.writeUInt32LE(0x1234_5678, 0);
    reader.push(bad);
    expect(() => reader.next()).toThrow(LinkError);
    expect(reader.buffered).toBe(HEADER_BYTES);
  });

  it('can be reset', () => {
    const reader = new FrameReader();
    reader.push(frame(1, 1, Buffer.from('x')).subarray(0, 8));
    reader.reset();
    expect(reader.buffered).toBe(0);
    expect(reader.next()).toBeNull();
  });
});

describe('sequence numbers', () => {
  it('start at 1 and increase', () => {
    const source = new SequenceSource();
    expect(source.take()).toBe(1);
    expect(source.take()).toBe(2);
  });

  it('wrap to 1 rather than to 0', () => {
    expect(nextSeq(0xffff_fffe)).toBe(0xffff_ffff);
    expect(nextSeq(0xffff_ffff)).toBe(1);
  });

  it('accept an unbroken run', () => {
    const guard = new SequenceGuard();
    for (let i = 1; i <= 100; i++) expect(() => guard.accept(i)).not.toThrow();
  });

  it('reject a gap', () => {
    const guard = new SequenceGuard();
    guard.accept(1);
    expect(() => guard.accept(3)).toThrow(/sequence gap/);
  });

  it('reject a replay', () => {
    const guard = new SequenceGuard();
    guard.accept(1);
    guard.accept(2);
    expect(() => guard.accept(2)).toThrow(LinkError);
  });

  it('follow the source across the wrap', () => {
    const guard = new SequenceGuard();
    const source = new SequenceSource();
    // Fast-forward both to the wrap boundary.
    for (let i = 0; i < 3; i++) guard.accept(source.take());
    expect(() => guard.accept(nextSeq(3))).not.toThrow();
  });
});
