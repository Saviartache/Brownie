import { describe, expect, it } from 'vitest';
import {
  FrameFlags,
  FrameReader,
  HEADER_BYTES,
  IPC_VERSION,
  LinkError,
  MessageError,
  MessageType,
  Origin,
  decodeClientFrame,
  decodeMessage,
  encodeClientFrame,
  encodeMessage,
  framedSize,
  prepareMessage,
  writeHeader,
  writeMessage,
  type ClientFrameMessage,
  type Frame,
  type IpcMessage,
} from '../src/index.js';

/** A frame with one of everything, in values a float carries exactly. */
const FULL_FRAME: ClientFrameMessage = {
  kind: 'clientFrame',
  player: { x: 123.5, y: -64.25 },
  frameTimeMs: 90_000,
  scanned: true,
  born: [
    {
      ownerId: 4012,
      bulletId: 32766,
      ageMs: 12,
      x: 120.5,
      y: -60.75,
      angle: 1.5,
      speedMultiplier: 1.25,
      lifetimeMs: 1800,
      halfTiles: 0.375,
    },
  ],
  gone: [{ ownerId: 4012, bulletId: 7 }],
};

/** Encodes a message and reads it back through the framer, as the pipe would. */
function roundTrip(message: IpcMessage, from: Origin): IpcMessage {
  const reader = new FrameReader();
  reader.push(encodeMessage(message, 1));
  const frame = reader.next();
  expect(frame).not.toBeNull();
  return decodeMessage(frame!, from);
}

function rawFrame(type: number, payload: Buffer, flags: number = FrameFlags.None): Frame {
  const header = Buffer.alloc(HEADER_BYTES);
  writeHeader(header, { version: IPC_VERSION, type, flags, seq: 1, length: payload.length });
  const reader = new FrameReader();
  reader.push(Buffer.concat([header, payload]));
  return reader.next()!;
}

describe('message codec', () => {
  it('round-trips every message the runtime sends', () => {
    const messages: IpcMessage[] = [
      {
        kind: 'authChallenge',
        userId: 'user',
        pid: 1234,
        response: 'a'.repeat(64),
        challenge: 'b'.repeat(64),
      },
      { kind: 'ping', nonce: 'c'.repeat(64) },
      { kind: 'pong', response: 'd'.repeat(64) },
      { kind: 'setFeature', key: 'autoNexusHp', value: 25 },
      { kind: 'setFeature', key: 'autoNexusEnabled', value: true },
      { kind: 'setFeature', key: 'skinName', value: 'Sorcerer' },
      { kind: 'controlRecord', record: 'plugin|auto-drink|Auto%20Drink|combat|1||0' },
    ];
    for (const message of messages) {
      expect(roundTrip(message, Origin.Runtime), message.kind).toEqual(message);
    }
  });

  it('round-trips every message the native module sends', () => {
    const messages: IpcMessage[] = [
      { kind: 'hello', pid: 4242, challenge: 'e'.repeat(64) },
      { kind: 'authResult', ok: true, response: 'f'.repeat(64) },
      { kind: 'controlAction', action: 'toggle|auto-nexus|1' },
      { kind: 'hotkeyEvent', pluginId: 'auto-aim', slot: '', action: 'togglePlugin', value: true },
      { kind: 'hotkeyEvent', pluginId: 'auto-dodge', slot: 'anchor', action: 'hold', value: false },
      { kind: 'offsetHealth', unresolved: ['HBEAKBIHANL', 'KDAJOMOFMJB'] },
      { kind: 'serverTarget', host: '18.194.220.13', port: 2050 },
      FULL_FRAME,
    ];
    for (const message of messages) {
      expect(roundTrip(message, Origin.Native), message.kind).toEqual(message);
    }
  });

  it('marks a client frame binary and keeps everything else JSON', () => {
    const frame = encodeMessage(FULL_FRAME, 1);
    expect(frame.readUInt16LE(8) & FrameFlags.Binary).toBe(FrameFlags.Binary);

    const control = encodeMessage({ kind: 'controlAction', action: 'x' }, 1);
    expect(control.readUInt16LE(8) & FrameFlags.Binary).toBe(0);
  });

  describe('rejects messages travelling the wrong way', () => {
    it('as a link error, because the peer is not who it claims to be', () => {
      const frame = rawFrame(MessageType.SetFeature, Buffer.from('{"key":"a","value":1}'));
      expect(() => decodeMessage(frame, Origin.Native)).toThrow(LinkError);
    });

    it('the native module may not set features', () => {
      const frame = rawFrame(MessageType.SetFeature, Buffer.from('{"key":"a","value":1}'));
      expect(() => decodeMessage(frame, Origin.Native)).toThrow(
        /may only originate from the runtime/,
      );
    });

    it('the runtime may not report hotkeys', () => {
      const frame = rawFrame(
        MessageType.HotkeyEvent,
        Buffer.from('{"pluginId":"a","action":"b","value":true}'),
      );
      expect(() => decodeMessage(frame, Origin.Runtime)).toThrow(
        /may only originate from the native/,
      );
    });

    it('the runtime may not name the server the game is heading for', () => {
      // This value reaches the allowlist. Accepting it from the wrong side
      // would mean anything that can speak the protocol gets to say where the
      // proxy connects.
      const frame = rawFrame(
        MessageType.ServerTarget,
        Buffer.from('{"host":"1.2.3.4","port":2050}'),
      );
      expect(() => decodeMessage(frame, Origin.Runtime)).toThrow(
        /may only originate from the native/,
      );
    });

    it('but liveness may come from either side', () => {
      const frame = rawFrame(MessageType.Ping, Buffer.from(`{"nonce":"${'a'.repeat(64)}"}`));
      expect(() => decodeMessage(frame, Origin.Runtime)).not.toThrow();
      expect(() => decodeMessage(frame, Origin.Native)).not.toThrow();
    });
  });

  describe('rejects malformed payloads without killing the link', () => {
    const cases: ReadonlyArray<readonly [string, number, string]> = [
      ['not JSON at all', MessageType.ControlAction, 'this is not json'],
      ['a JSON array', MessageType.ControlAction, '[1,2,3]'],
      ['a missing field', MessageType.ControlAction, '{}'],
      ['a field of the wrong type', MessageType.ControlAction, '{"action":42}'],
      ['a non-integer pid', MessageType.Hello, '{"pid":1.5,"challenge":"a"}'],
      [
        'a non-boolean flag',
        MessageType.HotkeyEvent,
        '{"pluginId":"a","action":"b","value":"yes"}',
      ],
      ['a non-array list', MessageType.OffsetHealth, '{"unresolved":"a,b"}'],
      ['a list with a non-string', MessageType.OffsetHealth, '{"unresolved":["a",2]}'],
      ['a NaN feature value', MessageType.SetFeature, '{"key":"a","value":null}'],
    ];

    for (const [label, type, body] of cases) {
      it(label, () => {
        const from = type === MessageType.SetFeature ? Origin.Runtime : Origin.Native;
        expect(() => decodeMessage(rawFrame(type, Buffer.from(body)), from)).toThrow(MessageError);
      });
    }

    it('a client frame shorter than its header', () => {
      const frame = rawFrame(MessageType.ClientFrame, Buffer.alloc(8), FrameFlags.Binary);
      expect(() => decodeMessage(frame, Origin.Native)).toThrow(MessageError);
    });

    it('a client frame whose counts and length disagree', () => {
      const payload = encodeClientFrame(FULL_FRAME);
      for (const cut of [
        payload.subarray(0, payload.length - 1),
        Buffer.concat([payload, Buffer.alloc(8)]),
      ]) {
        const frame = rawFrame(MessageType.ClientFrame, cut, FrameFlags.Binary);
        expect(() => decodeMessage(frame, Origin.Native)).toThrow(MessageError);
      }
    });
  });

  it('refuses a client frame from the runtime', () => {
    const frame = rawFrame(
      MessageType.ClientFrame,
      encodeClientFrame(FULL_FRAME),
      FrameFlags.Binary,
    );
    expect(() => decodeMessage(frame, Origin.Runtime)).toThrow(LinkError);
  });

  it('keeps a message type it does not know, rather than failing', () => {
    const frame = rawFrame(0x7fff, Buffer.from('anything at all'));
    const message = decodeMessage(frame, Origin.Native);
    expect(message).toEqual({
      kind: 'unknown',
      type: 0x7fff,
      payload: Buffer.from('anything at all'),
    });
    // ...and can forward it back out unchanged.
    expect(encodeMessage(message, 2).subarray(HEADER_BYTES).toString()).toBe('anything at all');
  });

  it('writes several messages into one buffer, which reads back as several frames', () => {
    const messages: IpcMessage[] = [
      { kind: 'controlRecord', record: 'sync-begin' },
      { kind: 'setFeature', key: 'dodge.enabled', value: true },
      { kind: 'controlRecord', record: 'sync-end' },
    ];

    const prepared = messages.map(prepareMessage);
    const total = prepared.reduce((sum, one) => sum + framedSize(one), 0);
    const batch = Buffer.allocUnsafe(total);

    let offset = 0;
    prepared.forEach((one, index) => {
      offset += writeMessage(batch, offset, one, index + 1);
    });
    expect(offset, 'the batch is exactly as long as its parts said it would be').toBe(total);

    const reader = new FrameReader();
    reader.push(batch);
    const read: IpcMessage[] = [];
    for (let frame = reader.next(); frame !== null; frame = reader.next()) {
      expect(frame.header.seq).toBe(read.length + 1);
      read.push(decodeMessage(frame, Origin.Runtime));
    }
    expect(read).toEqual(messages);
  });

  it('refuses to write past the end of a buffer', () => {
    const prepared = prepareMessage({ kind: 'controlRecord', record: 'sync-begin' });
    const tooSmall = Buffer.alloc(framedSize(prepared) - 1);
    expect(() => writeMessage(tooSmall, 0, prepared, 1)).toThrow(LinkError);
  });
});

describe('client frame', () => {
  it('is its header, 36 bytes a shot made and 8 a shot gone', () => {
    expect(encodeClientFrame(FULL_FRAME)).toHaveLength(20 + 36 + 8);
    const empty: ClientFrameMessage = {
      kind: 'clientFrame',
      player: undefined,
      frameTimeMs: undefined,
      scanned: false,
      born: [],
      gone: [],
    };
    expect(encodeClientFrame(empty)).toHaveLength(20);
    expect(decodeClientFrame(encodeClientFrame(empty))).toEqual(empty);
  });

  it('is laid out as the module packs it', () => {
    // Written by hand, byte by byte, as `DodgeTelemetry.cpp` writes it — so the
    // two ends are checked against the document rather than against each other.
    const payload = Buffer.alloc(20 + 36 + 8);
    payload.writeUInt8(0b111, 0);
    payload.writeUInt16LE(1, 2);
    payload.writeUInt16LE(1, 4);
    payload.writeInt32LE(90_000, 8);
    payload.writeFloatLE(123.5, 12);
    payload.writeFloatLE(-64.25, 16);
    payload.writeInt32LE(4012, 20);
    payload.writeUInt16LE(32766, 24);
    payload.writeInt32LE(12, 28);
    payload.writeFloatLE(120.5, 32);
    payload.writeFloatLE(-60.75, 36);
    payload.writeFloatLE(1.5, 40);
    payload.writeFloatLE(1.25, 44);
    payload.writeFloatLE(1800, 48);
    payload.writeFloatLE(0.375, 52);
    payload.writeInt32LE(4012, 56);
    payload.writeUInt16LE(7, 60);
    expect(decodeClientFrame(payload)).toEqual(FULL_FRAME);
  });

  it('keeps "no player" apart from a player at the origin, and the same for the clock', () => {
    const decoded = decodeClientFrame(
      encodeClientFrame({ ...FULL_FRAME, player: undefined, scanned: false, born: [], gone: [] }),
    );
    expect(decoded.player).toBeUndefined();
    expect(decoded.frameTimeMs).toBe(90_000);

    const origin = decodeClientFrame(
      encodeClientFrame({ ...FULL_FRAME, player: { x: 0, y: 0 }, frameTimeMs: 0 }),
    );
    expect(origin.player).toEqual({ x: 0, y: 0 });
    expect(origin.frameTimeMs).toBe(0);
  });

  it('refuses a scan with no clock to age it by', () => {
    const payload = encodeClientFrame({ ...FULL_FRAME, frameTimeMs: undefined });
    expect(() => decodeClientFrame(payload)).toThrow(/without a clock/);
  });

  it('refuses shots in a frame that says it did not scan', () => {
    const payload = encodeClientFrame(FULL_FRAME);
    payload.writeUInt8(0b011, 0);
    expect(() => decodeClientFrame(payload)).toThrow(/did not scan/);
  });

  it('carries a shot that is not a number through, for its reader to drop', () => {
    const decoded = decodeClientFrame(
      encodeClientFrame({
        ...FULL_FRAME,
        born: [{ ...FULL_FRAME.born[0]!, angle: Number.NaN }],
      }),
    );
    expect(Number.isNaN(decoded.born[0]?.angle)).toBe(true);
  });
});
