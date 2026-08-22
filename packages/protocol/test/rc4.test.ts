import { describe, expect, it } from 'vitest';
import { CLIENT_KEY, Rc4, SERVER_KEY } from '../src/index.js';

/**
 * Parity vectors captured from the reference implementation. RC4 has no room
 * for "close enough": a single wrong keystream byte desynchronises the rest of
 * the connection, so these fixed vectors are the contract with the live game.
 */
const CLIENT_KEYSTREAM_16 = 'c189296a355272315f6ca8bbbbee2690';
const SERVER_KEYSTREAM_8 = '79aa1a52a885c7a0';
const SERVER_KEYSTREAM_8_CONTINUED = '88ec875325f4694a';

function keystream(cipher: Rc4, length: number): string {
  const zeros = Buffer.alloc(length);
  cipher.process(zeros);
  return zeros.toString('hex');
}

describe('Rc4', () => {
  it('matches the reference keystream for the client key', () => {
    expect(keystream(new Rc4(CLIENT_KEY), 16)).toBe(CLIENT_KEYSTREAM_16);
  });

  it('continues its keystream across separate calls, as it must across packets', () => {
    const cipher = new Rc4(SERVER_KEY);
    expect(keystream(cipher, 8)).toBe(SERVER_KEYSTREAM_8);
    expect(keystream(cipher, 8)).toBe(SERVER_KEYSTREAM_8_CONTINUED);
  });

  it('is symmetric: two ciphers with the same key round-trip', () => {
    const payload = Buffer.from('the quick brown fox jumps over the lazy dog', 'utf8');
    const sending = new Rc4(CLIENT_KEY);
    const receiving = new Rc4(CLIENT_KEY);

    const wire = Buffer.from(payload);
    sending.process(wire);
    expect(wire.equals(payload)).toBe(false);

    receiving.process(wire);
    expect(wire.equals(payload)).toBe(true);
  });

  it('ciphers only the requested range', () => {
    const buffer = Buffer.alloc(16);
    new Rc4(CLIENT_KEY).process(buffer, 4, 8);
    expect(buffer.subarray(0, 4).every((b) => b === 0)).toBe(true);
    expect(buffer.subarray(4, 8).every((b) => b === 0)).toBe(false);
    expect(buffer.subarray(8).every((b) => b === 0)).toBe(true);
  });

  it('reset restores the initial key schedule', () => {
    const cipher = new Rc4(SERVER_KEY);
    const first = keystream(cipher, 8);
    cipher.reset();
    expect(keystream(cipher, 8)).toBe(first);
  });

  it('rejects an empty or non-hex key', () => {
    expect(() => new Rc4('')).toThrow(RangeError);
    expect(() => new Rc4('zz')).toThrow(RangeError);
    expect(() => new Rc4('abc')).toThrow(RangeError);
  });

  it('rejects a cipher range outside the buffer', () => {
    expect(() => new Rc4(CLIENT_KEY).process(Buffer.alloc(4), 0, 5)).toThrow(RangeError);
    expect(() => new Rc4(CLIENT_KEY).process(Buffer.alloc(4), 3, 2)).toThrow(RangeError);
  });
});
