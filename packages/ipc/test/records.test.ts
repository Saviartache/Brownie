import { describe, expect, it } from 'vitest';
import {
  buildRecord,
  decimalField,
  encodeField,
  encodeList,
  encodeOptions,
  intField,
  parseList,
  parseRecord,
  recordKind,
} from '../src/index.js';

describe('overlay record codec', () => {
  it('builds the documented setting record', () => {
    const record = buildRecord(
      'setting',
      'auto-drink',
      'hpPercent',
      'HP percent',
      'range',
      'n',
      7,
      true,
      0,
      true,
      14,
      1,
      false,
      '',
    );
    expect(record).toBe('setting|auto-drink|hpPercent|HP%20percent|range|n|7|1|0|1|14|1|0|');
    expect(recordKind(record)).toBe('setting');
  });

  it('round-trips fields that contain separators', () => {
    const nasty = 'a|b;c=d%e f';
    const record = buildRecord('text', nasty);
    expect(record.split('|')).toHaveLength(2);
    expect(parseRecord(record)[1]).toBe(nasty);
  });

  it('round-trips non-ASCII text', () => {
    const record = buildRecord('ui-notice', 'info', 'Игрок вошёл — 100% готов');
    expect(/^[\x20-\x7e|]*$/.test(record)).toBe(true);
    expect(parseRecord(record)[2]).toBe('Игрок вошёл — 100% готов');
  });

  it('encodes booleans as 1 and 0', () => {
    expect(encodeField(true)).toBe('1');
    expect(encodeField(false)).toBe('0');
  });

  it('treats a missing field as empty rather than as "undefined"', () => {
    expect(encodeField(undefined)).toBe('');
    expect(encodeField(null)).toBe('');
    expect(buildRecord('plugin', 'id', null)).toBe('plugin|id|');
  });

  it('returns an undecodable field verbatim instead of throwing', () => {
    // A stray '%' is not valid percent-encoding.
    expect(parseRecord('ui|100%|ok')).toEqual(['ui', '100%', 'ok']);
  });

  it('keeps trailing empty fields, which are positional', () => {
    expect(parseRecord('a|b||')).toEqual(['a', 'b', '', '']);
  });

  describe('lists', () => {
    it('round-trip', () => {
      expect(parseList(encodeList(['a', 'b', 'c']))).toEqual(['a', 'b', 'c']);
      expect(parseList('')).toEqual([]);
    });

    it('replace a semicolon in a cell, because it cannot be escaped', () => {
      expect(encodeList(['one;two', 'three'])).toBe('one,two;three');
    });

    it('build combo options', () => {
      expect(
        encodeOptions([
          ['Off', 0],
          ['On', 1],
        ]),
      ).toBe('Off=0;On=1');
    });
  });

  describe('number fields', () => {
    it('round integers', () => {
      expect(intField(3.6)).toBe('4');
      expect(intField(-3.6)).toBe('-4');
    });

    it('keep one decimal', () => {
      expect(decimalField(12.34)).toBe('12.3');
      expect(decimalField(12.35)).toBe('12.4');
    });

    it('turn non-finite input into 0 rather than "NaN"', () => {
      expect(intField(Number.NaN)).toBe('0');
      expect(intField(Number.POSITIVE_INFINITY)).toBe('0');
      expect(decimalField(Number.NaN)).toBe('0');
    });
  });
});
