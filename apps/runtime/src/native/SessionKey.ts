/**
 * The per-run shared secret, and where the native module finds it.
 *
 * The module cannot carry a secret: a constant compiled into a shipped DLL is a
 * constant everybody with that DLL has, which would make the handshake an
 * expensive way to authenticate nobody. So the runtime mints one per run and
 * publishes it at a path both sides derive from the same two inputs:
 *
 *     %LOCALAPPDATA%\Brownie\<pipe name>.key
 *
 * `%LOCALAPPDATA%` is readable by this user, SYSTEM and Administrators and
 * nobody else — **the same audience that can already open the named pipe**. The
 * file therefore adds no exposure the transport did not have; what it buys is
 * that the secret is fresh every run and survives nowhere.
 *
 * The C++ half is `apps/native/src/ipc/SessionKey.h`, and the two derive the
 * same path from the same rules. When they disagree, this file and that header
 * are both wrong — the path is a contract, not an implementation detail.
 */

import { randomBytes } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** Matches the native side's `kNonceBytes`. */
export const SESSION_KEY_BYTES = 32;

export class SessionKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionKeyError';
  }
}

/**
 * Resolves the agreed path.
 *
 * Pure, so the rule has a test that needs no filesystem — and so "where does
 * this file live" is answerable by reading one function.
 *
 * @throws {SessionKeyError} when `%LOCALAPPDATA%` is unset, or the pipe name is
 *   not something that can safely be a file name. The pipe name comes from
 *   configuration and decides which file gets written, so a name carrying a
 *   separator or a `..` is refused rather than escaped.
 */
export function sessionKeyPath(
  pipeName: string,
  env: Readonly<Record<string, string | undefined>>,
): string {
  // The first character must be alphanumeric, which is what rules out `..` and
  // `.` — both of which pass a plain character-set check and name a directory
  // rather than a file.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(pipeName)) {
    throw new SessionKeyError(
      `native.pipeName ${JSON.stringify(pipeName)} cannot be used as a file name`,
    );
  }
  const root = env['LOCALAPPDATA'];
  if (root === undefined || root === '') {
    throw new SessionKeyError('LOCALAPPDATA is not set, so the session key has nowhere to live');
  }
  return join(root, 'Brownie', `${pipeName}.key`);
}

/** A fresh secret. Never derived from anything: it only has to be unguessable. */
export function mintSessionKey(): Buffer {
  return randomBytes(SESSION_KEY_BYTES);
}

/**
 * Writes the secret where the module will look for it.
 *
 * Written as hex rather than raw bytes so a human debugging a failed handshake
 * can compare the two sides by eye. The mode is set for the platforms that
 * honour it; on Windows the directory's inherited ACL is what actually protects
 * it, which is the same protection the named pipe has.
 */
export async function publishSessionKey(path: string, secret: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, secret.toString('hex'), { encoding: 'ascii', mode: 0o600 });
}

/**
 * Removes the key on the way out.
 *
 * A key left behind is a key the next run does not use but a stale module might
 * still present. Absence is not an error: the point is that it is gone.
 */
export async function revokeSessionKey(path: string): Promise<void> {
  await rm(path, { force: true });
}
