import { describe, expect, it } from 'vitest';
import { PacketDirection, PacketRegistry, SchemaError, loadDefinitions } from '../src/index.js';
import { DEFINITIONS, STAT_TYPES, testRegistry } from './fixtures.js';

function load(overrides: unknown): void {
  loadDefinitions(overrides);
}

describe('loadDefinitions', () => {
  it("normalises directions to the packet's travel direction", () => {
    const registry = testRegistry();
    expect(registry.schemaByName('PING')?.direction).toBe(PacketDirection.ServerToClient);
    expect(registry.schemaByName('PLAYERSHOOT')?.direction).toBe(PacketDirection.ClientToServer);
  });

  it('defaults an array length prefix to int16', () => {
    const { packets } = loadDefinitions({
      packets: {
        '0': {
          name: 'A',
          direction: 'client',
          fields: [{ name: 'xs', type: 'array', elementType: 'byte' }],
        },
      },
      dataObjects: {},
    });
    const field = packets[0]?.fields[0];
    expect(field?.value).toEqual({
      kind: 'array',
      lengthType: 'int16',
      element: { kind: 'primitive', type: 'byte' },
    });
  });

  describe('rejects definitions that cannot describe a wire format', () => {
    it('a required field after an optional one', () => {
      expect(() =>
        load({
          packets: {
            '0': {
              name: 'A',
              direction: 'client',
              fields: [
                { name: 'a', type: 'byte', optional: true },
                { name: 'b', type: 'byte' },
              ],
            },
          },
          dataObjects: {},
        }),
      ).toThrow(/optional fields must be trailing/);
    });

    // A mask naming a field that is not there, or one that is not an integer,
    // is a typo in a data file. Caught at load, it is a startup error; caught on
    // a live connection it is a packet stream reading the wrong bytes.
    it('a presence bit pointing at a field that does not exist', () => {
      expect(() =>
        load({
          packets: {
            '0': {
              name: 'A',
              direction: 'client',
              fields: [
                { name: 'mask', type: 'byte' },
                { name: 'a', type: 'byte', presentWhen: { field: 'nope', bit: 1 } },
              ],
            },
          },
          dataObjects: {},
        }),
      ).toThrow(/no earlier field named "nope"/);
    });

    it('a presence bit pointing at a field that comes later', () => {
      expect(() =>
        load({
          packets: {
            '0': {
              name: 'A',
              direction: 'client',
              fields: [
                { name: 'a', type: 'byte', presentWhen: { field: 'mask', bit: 1 } },
                { name: 'mask', type: 'byte' },
              ],
            },
          },
          dataObjects: {},
        }),
      ).toThrow(/no earlier field named "mask"/);
    });

    it('a presence bit read out of a string', () => {
      expect(() =>
        load({
          packets: {
            '0': {
              name: 'A',
              direction: 'client',
              fields: [
                { name: 'mask', type: 'string' },
                { name: 'a', type: 'byte', presentWhen: { field: 'mask', bit: 1 } },
              ],
            },
          },
          dataObjects: {},
        }),
      ).toThrow(/cannot carry a mask/);
    });

    it('a presence bit read out of a field that may itself be absent', () => {
      expect(() =>
        load({
          packets: {
            '0': {
              name: 'A',
              direction: 'client',
              fields: [
                { name: 'gate', type: 'byte' },
                { name: 'mask', type: 'byte', presentWhen: { field: 'gate', bit: 1 } },
                { name: 'a', type: 'byte', presentWhen: { field: 'mask', bit: 1 } },
              ],
            },
          },
          dataObjects: {},
        }),
      ).toThrow(/may itself be absent/);
    });

    it('a presence bit that is more than one bit', () => {
      expect(() =>
        load({
          packets: {
            '0': {
              name: 'A',
              direction: 'client',
              fields: [
                { name: 'mask', type: 'byte' },
                { name: 'a', type: 'byte', presentWhen: { field: 'mask', bit: 3 } },
              ],
            },
          },
          dataObjects: {},
        }),
      ).toThrow(/is not a single bit/);
    });

    it('an optional field inside a data object', () => {
      expect(() =>
        load({
          packets: { '0': { name: 'A', direction: 'client', fields: [{ name: 'o', type: 'O' }] } },
          dataObjects: { O: { fields: [{ name: 'a', type: 'byte', optional: true }] } },
        }),
      ).toThrow(/only allowed on packets/);
    });

    it('a cyclic data object', () => {
      expect(() =>
        load({
          packets: { '0': { name: 'A', direction: 'client', fields: [{ name: 'o', type: 'O' }] } },
          dataObjects: {
            O: { fields: [{ name: 'p', type: 'P' }] },
            P: { fields: [{ name: 'o', type: 'O' }] },
          },
        }),
      ).toThrow(/cyclic reference/);
    });

    it('an unknown field type', () => {
      expect(() =>
        load({
          packets: {
            '0': { name: 'A', direction: 'client', fields: [{ name: 'a', type: 'quux' }] },
          },
          dataObjects: {},
        }),
      ).toThrow(/unknown type "quux"/);
    });

    it('an array of arrays', () => {
      expect(() =>
        load({
          packets: {
            '0': {
              name: 'A',
              direction: 'client',
              fields: [{ name: 'a', type: 'array', elementType: 'array' }],
            },
          },
          dataObjects: {},
        }),
      ).toThrow(/arrays of arrays/);
    });

    it('an unusable length prefix', () => {
      expect(() =>
        load({
          packets: {
            '0': {
              name: 'A',
              direction: 'client',
              fields: [{ name: 'a', type: 'array', elementType: 'byte', lengthType: 'float' }],
            },
          },
          dataObjects: {},
        }),
      ).toThrow(/lengthType/);
    });

    it('a duplicate packet name', () => {
      expect(() =>
        load({
          packets: {
            '0': { name: 'A', direction: 'client', fields: [] },
            '1': { name: 'A', direction: 'client', fields: [] },
          },
          dataObjects: {},
        }),
      ).toThrow(/names must be unique/);
    });

    it('a duplicate field name', () => {
      expect(() =>
        load({
          packets: {
            '0': {
              name: 'A',
              direction: 'client',
              fields: [
                { name: 'a', type: 'byte' },
                { name: 'a', type: 'byte' },
              ],
            },
          },
          dataObjects: {},
        }),
      ).toThrow(/duplicate field name/);
    });

    it('a packet id outside a byte', () => {
      expect(() =>
        load({
          packets: { '256': { name: 'A', direction: 'client', fields: [] } },
          dataObjects: {},
        }),
      ).toThrow(/0\.\.255/);
    });

    it('an unknown direction', () => {
      expect(() =>
        load({
          packets: { '0': { name: 'A', direction: 'sideways', fields: [] } },
          dataObjects: {},
        }),
      ).toThrow(/expected "client" or "server"/);
    });

    it('a document with no packets at all', () => {
      expect(() => load({ packets: {}, dataObjects: {} })).toThrow(/declares no packets/);
    });

    it('structurally wrong input', () => {
      expect(() => load(null)).toThrow(SchemaError);
      expect(() => load({ packets: [] })).toThrow(SchemaError);
      expect(() =>
        load({ packets: { '0': { name: 'A', direction: 'client', fields: {} } } }),
      ).toThrow(/fields must be an array/);
    });
  });
});

describe('PacketRegistry', () => {
  it('maps ids and names in both directions', () => {
    const registry = testRegistry();
    expect(registry.packetCount).toBe(3);
    expect(registry.idOf('UPDATE')).toBe(2);
    expect(registry.nameOf(2)).toBe('UPDATE');
    expect(registry.schemaById(99)).toBeUndefined();
    expect(registry.packetNames()).toEqual(['PING', 'PLAYERSHOOT', 'UPDATE']);
  });

  it('answers which stats carry strings', () => {
    const registry = testRegistry();
    expect(registry.isStringStat(31)).toBe(true);
    expect(registry.isStringStat(7)).toBe(false);
    expect(registry.statName(38)).toBe('GUILD');
  });

  it('rejects malformed stat types', () => {
    expect(() => PacketRegistry.create(DEFINITIONS, { stringStats: ['x'] })).toThrow(SchemaError);
    expect(() => PacketRegistry.create(DEFINITIONS, { statNames: { a: 1 } })).toThrow(SchemaError);
    expect(() => PacketRegistry.create(DEFINITIONS, null)).toThrow(SchemaError);
  });

  it('accepts stat types with no optional fields', () => {
    expect(() => PacketRegistry.create(DEFINITIONS, {})).not.toThrow();
    expect(() => PacketRegistry.create(DEFINITIONS, STAT_TYPES)).not.toThrow();
  });
});
