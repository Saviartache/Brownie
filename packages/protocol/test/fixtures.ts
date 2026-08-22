import { PacketRegistry } from '../src/index.js';

/**
 * A small hand-written protocol that exercises every schema feature the real
 * definitions use: nested objects, arrays with each length type, stat values in
 * both encodings, and trailing optional fields.
 */
export const DEFINITIONS = {
  packets: {
    '0': {
      name: 'PING',
      direction: 'server',
      fields: [{ name: 'serial', type: 'int32' }],
    },
    '1': {
      name: 'PLAYERSHOOT',
      direction: 'client',
      fields: [
        { name: 'objectId', type: 'int32' },
        { name: 'position', type: 'Location' },
        { name: 'bulletType', type: 'byte', optional: true, default: 255 },
        { name: 'numShots', type: 'byte', optional: true, default: 0 },
      ],
    },
    '2': {
      name: 'UPDATE',
      direction: 'server',
      fields: [
        { name: 'stats', type: 'array', lengthType: 'compressedInt', elementType: 'StatData' },
        { name: 'label', type: 'string' },
        { name: 'blob', type: 'byteArray16' },
        { name: 'flag', type: 'bool' },
        { name: 'tiles', type: 'array', lengthType: 'int16', elementType: 'compressedInt' },
      ],
    },
  },
  dataObjects: {
    Location: {
      fields: [
        { name: 'x', type: 'float' },
        { name: 'y', type: 'float' },
      ],
    },
    StatData: {
      fields: [
        { name: 'id', type: 'byte' },
        { name: 'value', type: 'statValue' },
        { name: 'stackCount', type: 'compressedInt' },
      ],
    },
  },
} as const;

/** Stat ids 31 and 38 carry strings; everything else is a compressed int. */
export const STAT_TYPES = {
  stringStats: [31, 38],
  statNames: { '31': 'NAME', '38': 'GUILD' },
} as const;

export function testRegistry(): PacketRegistry {
  return PacketRegistry.create(DEFINITIONS, STAT_TYPES);
}
