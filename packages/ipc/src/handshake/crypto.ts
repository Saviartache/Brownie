import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Nonces and MACs are 32 bytes, exchanged as lower-case hex. */
export const NONCE_BYTES = 32;
const HEX_32 = /^[0-9a-f]{64}$/;

export function createNonce(): string {
  return randomBytes(NONCE_BYTES).toString('hex');
}

export function isNonce(value: unknown): value is string {
  return typeof value === 'string' && HEX_32.test(value);
}

/**
 * HMAC-SHA256 over a `|`-joined field list.
 *
 * Joining with an explicit separator rather than concatenating is the whole
 * point: it makes the signed string unambiguous, so no combination of field
 * values can produce the same bytes as a different combination.
 */
export function sign(secret: Buffer, ...fields: readonly string[]): string {
  return createHmac('sha256', secret).update(fields.join('|'), 'utf8').digest('hex');
}

/**
 * Compares two hex MACs without leaking where they first differ.
 *
 * A malformed input compares false rather than throwing, so a peer cannot tell
 * "wrong shape" from "wrong value" by watching which error it gets.
 */
export function macEquals(a: string, b: string): boolean {
  if (!isNonce(a) || !isNonce(b)) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

/**
 * Rejects a secret that cannot do its job.
 *
 * @throws {RangeError} if the secret is too short to be worth having.
 */
export function requireStrongSecret(secret: Buffer): Buffer {
  if (secret.length < 16) {
    throw new RangeError(
      `IPC shared secret must be at least 16 bytes, got ${String(secret.length)}`,
    );
  }
  return secret;
}
