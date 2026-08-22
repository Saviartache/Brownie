/**
 * Wire frame layout, shared by the framer, the codec and the ciphers.
 *
 * ```
 *  0      4       5                    length
 *  +------+-------+---------------------+
 *  | int32| byte  |        body         |
 *  |length|  id   |     (enciphered)    |
 *  +------+-------+---------------------+
 * ```
 *
 * `length` counts itself, so a body-less packet is exactly 5 bytes.
 */

/** Bytes before the body: 4-byte length + 1-byte id. */
export const HEADER_BYTES = 5;

/** Offset at which RC4 starts. Identical to {@link HEADER_BYTES}, named apart because it is a separate protocol fact. */
export const CIPHER_OFFSET = 5;

/** Smallest structurally valid frame. */
export const MIN_FRAME_BYTES = HEADER_BYTES;

/**
 * Largest frame we will assemble. The game never approaches this; the cap
 * exists so a desynchronised stream is rejected in constant memory instead of
 * making us buffer whatever a bad `length` claims.
 */
export const MAX_FRAME_BYTES = 1024 * 1024;

/**
 * The two fixed RC4 keys. A session runs four cipher instances built from them:
 * the client key deciphers what the game client sends and enciphers what we
 * send onward to the server; the server key does the mirror.
 */
export const CLIENT_KEY = '5a4d2016bc16dc64883194ffd9';
export const SERVER_KEY = 'c91d9eec420160730d825604e0';

/** Reads the id byte of a complete frame. */
export function frameId(frame: Buffer): number {
  return frame.readUInt8(4);
}

/** Reads the declared length of a complete frame. */
export function frameLength(frame: Buffer): number {
  return frame.readInt32BE(0);
}
