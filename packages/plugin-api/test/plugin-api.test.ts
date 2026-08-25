import { createBundledRegistry } from '@brownie/protocol/bundled';
import { ByteWriter, decodeFrame, encodePacket, type PacketRegistry } from '@brownie/protocol';
import { describe, expect, it } from 'vitest';
import {
  MutablePacket,
  type Plugin,
  PluginCategory,
  Verdict,
  clampToBounds,
  definePlugin,
  humaniseKey,
  normaliseColour,
} from '../src/index.js';

const registry: PacketRegistry = createBundledRegistry();

function frameOf(id: number, body: Buffer): Buffer {
  const out = Buffer.alloc(5 + body.length);
  out.writeInt32BE(out.length, 0);
  out.writeUInt8(id, 4);
  body.copy(out, 5);
  return out;
}

/** A real PING frame, built through the real codec. */
function pingFrame(serial: number): Buffer {
  const w = new ByteWriter();
  w.i32(serial);
  return frameOf(registry.idOf('PING')!, w.finish());
}

describe('MutablePacket', () => {
  it('reads fields without marking the packet modified', () => {
    const packet = new MutablePacket(decodeFrame(registry, pingFrame(99)));
    expect(packet.name).toBe('PING');
    expect(packet.number('serial')).toBe(99);
    // A typed accessor returns undefined rather than lying about the type.
    expect(packet.string('serial')).toBeUndefined();
    expect(packet.get('serial')).toBe(99);
    expect(packet.modified).toBe(false);
    expect(packet.verdict).toBe(Verdict.Forward);
  });

  it('marks the packet modified only when a field is set', () => {
    const packet = new MutablePacket(decodeFrame(registry, pingFrame(1)));
    packet.set('serial', 7);
    expect(packet.modified).toBe(true);
    expect(packet.number('serial')).toBe(7);

    const reencoded = encodePacket(registry, packet.decoded);
    expect(decodeFrame(registry, reencoded).fields['serial']).toBe(7);
  });

  it('refuses a field the packet does not have', () => {
    const packet = new MutablePacket(decodeFrame(registry, pingFrame(1)));
    // A typo would otherwise land in `fields`, be ignored by the encoder, and
    // look like a handler that simply did nothing.
    expect(() => packet.set('seriel', 7)).toThrow(/has no field "seriel"/);
    expect(packet.modified).toBe(false);
  });

  it('refuses to modify a packet whose body did not decode', () => {
    // PING needs four bytes; one is not enough.
    const packet = new MutablePacket(
      decodeFrame(registry, frameOf(registry.idOf('PING')!, Buffer.from([1]))),
    );
    expect(packet.opaque).toBe(true);
    expect(packet.decodeError).toBeDefined();
    expect(() => packet.set('serial', 1)).toThrow(/did not decode/);
  });

  it('treats an unknown packet as opaque but still forwardable', () => {
    const packet = new MutablePacket(decodeFrame(registry, frameOf(254, Buffer.from('xx'))));
    expect(packet.opaque).toBe(true);
    expect(packet.decodeError).toBeUndefined();
    expect(packet.frame.length).toBe(7);
  });

  it('records a drop, and lets a later stage take it back', () => {
    const packet = new MutablePacket(decodeFrame(registry, pingFrame(1)));
    packet.drop();
    expect(packet.verdict).toBe(Verdict.Drop);
    packet.forward();
    expect(packet.verdict).toBe(Verdict.Forward);
  });
});

describe('definePlugin', () => {
  const ok = {
    meta: { id: 'auto-nexus', name: 'Auto Nexus', category: PluginCategory.Combat },
    setup: () => undefined,
  };

  it('accepts a well-formed plugin', () => {
    expect(definePlugin(ok)).toBe(ok);
  });

  it('rejects an id that would break persisted config', () => {
    for (const id of ['Auto Nexus', 'autoNexus', '', 'auto--nexus', '-auto', 'auto-']) {
      expect(() => definePlugin({ ...ok, meta: { ...ok.meta, id } }), id).toThrow(TypeError);
    }
  });

  it('rejects a missing name or an unknown category', () => {
    expect(() => definePlugin({ ...ok, meta: { ...ok.meta, name: '  ' } })).toThrow(/display name/);
    expect(() =>
      definePlugin({
        ...ok,
        // A hand-written plugin can pass anything here; the check is the point.
        meta: { ...ok.meta, category: 'nonsense' as PluginCategory },
      }),
    ).toThrow(/expected one of/);
  });

  it('rejects a plugin with no setup', () => {
    expect(() =>
      definePlugin({ meta: ok.meta, setup: undefined as unknown as Plugin['setup'] }),
    ).toThrow(/no setup function/);
  });
});

describe('setting helpers', () => {
  it('clamps to declared bounds', () => {
    const options = { default: 25, min: 1, max: 99 };
    expect(clampToBounds(50, options)).toBe(50);
    expect(clampToBounds(-5, options)).toBe(1);
    expect(clampToBounds(500, options)).toBe(99);
  });

  it('falls back to the default for a value that is not a number', () => {
    expect(clampToBounds(Number.NaN, { default: 25 })).toBe(25);
    // Infinity is "not a number we can trust", not "the maximum".
    expect(clampToBounds(Number.POSITIVE_INFINITY, { default: 25, max: 99 })).toBe(25);
  });

  it('normalises the two colour spellings that cannot be mistaken', () => {
    expect(normaliseColour('#ff0000ff')).toBe('#ff0000ff');
    expect(normaliseColour('#FF00AAff')).toBe('#ff00aaff');
    // Six digits is opaque, which is the only alpha whoever typed them meant.
    expect(normaliseColour('  #00ff00  ')).toBe('#00ff00ff');
  });

  it('refuses a colour it would have to guess at', () => {
    // A short form read as a colour is the failure this exists to prevent: it
    // looks like a setting that worked, in the wrong colour.
    for (const text of ['#f00', 'red', '', '#gggggg', '#ff0000f', '#ff0000fff', 'ff0000ff']) {
      expect(normaliseColour(text)).toBeUndefined();
    }
  });

  it('humanises a key into a label', () => {
    expect(humaniseKey('hpPercentThreshold')).toBe('Hp percent threshold');
    expect(humaniseKey('auto_drink')).toBe('Auto drink');
    expect(humaniseKey('radius')).toBe('Radius');
  });
});
