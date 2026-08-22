/**
 * RC4 as the game uses it.
 *
 * Two properties matter and both are protocol facts, not implementation
 * choices:
 *
 * 1. The keystream is **continuous across packets**. One cipher instance
 *    belongs to one direction of one connection for that connection's whole
 *    life; dropping or reordering a single packet desynchronises it
 *    permanently. This is why the proxy queues rather than discards.
 * 2. Only the packet *body* is enciphered — the 4-byte length and the 1-byte
 *    id travel in clear. That offset is a caller's concern, so this class
 *    ciphers an arbitrary range and knows nothing about packets.
 */
export class Rc4 {
  readonly #key: Uint8Array;
  readonly #state = new Uint8Array(256);
  #x = 0;
  #y = 0;

  constructor(key: Uint8Array | string) {
    const bytes = typeof key === 'string' ? hexToBytes(key) : key;
    if (bytes.length === 0) throw new RangeError('RC4 key must not be empty');
    this.#key = Uint8Array.from(bytes);
    this.reset();
  }

  /**
   * Re-runs the key schedule. Used when a direction's connection restarts.
   *
   * Every `?? 0` below is unreachable: each index is either a loop counter
   * bounded by 256 or a value masked with `& 0xff`, and the arrays are exactly
   * 256 bytes. They are written out rather than asserted away because
   * `noUncheckedIndexedAccess` cannot see the mask, and an assertion here would
   * be indistinguishable from an assertion somewhere it *does* matter.
   */
  reset(): void {
    const state = this.#state;
    const key = this.#key;
    this.#x = 0;
    this.#y = 0;
    for (let i = 0; i < 256; i++) state[i] = i;

    let j = 0;
    for (let i = 0; i < 256; i++) {
      j = (j + (state[i] ?? 0) + (key[i % key.length] ?? 0)) & 0xff;
      const tmp = state[i] ?? 0;
      state[i] = state[j] ?? 0;
      state[j] = tmp;
    }
  }

  /**
   * XORs `buffer[start, end)` with the keystream, in place.
   * RC4 is symmetric, so this both enciphers and deciphers.
   */
  process(buffer: Uint8Array, start = 0, end = buffer.length): void {
    if (start < 0 || end > buffer.length || start > end) {
      throw new RangeError('cipher range outside buffer');
    }
    const state = this.#state;
    let x = this.#x;
    let y = this.#y;

    for (let i = start; i < end; i++) {
      x = (x + 1) & 0xff;
      y = (y + (state[x] ?? 0)) & 0xff;
      const tmp = state[x] ?? 0;
      state[x] = state[y] ?? 0;
      state[y] = tmp;
      buffer[i] = (buffer[i] ?? 0) ^ (state[((state[x] ?? 0) + (state[y] ?? 0)) & 0xff] ?? 0);
    }

    this.#x = x;
    this.#y = y;
  }
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new RangeError(`not a hex key: ${hex}`);
  }
  return Uint8Array.from(Buffer.from(hex, 'hex'));
}
