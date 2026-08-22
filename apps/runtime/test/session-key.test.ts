import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  SESSION_KEY_BYTES,
  SessionKeyError,
  mintSessionKey,
  publishSessionKey,
  revokeSessionKey,
  sessionKeyPath,
} from '../src/native/SessionKey.js';

describe('sessionKeyPath', () => {
  const env = { LOCALAPPDATA: 'C:\\Users\\someone\\AppData\\Local' };

  it('puts the key under LOCALAPPDATA, named after the pipe', () => {
    expect(sessionKeyPath('brownie-bridge', env)).toBe(
      join(env.LOCALAPPDATA, 'Brownie', 'brownie-bridge.key'),
    );
  });

  // The pipe name comes from configuration and decides which file gets written,
  // so it is refused rather than escaped.
  it.each(['..', '..\\..\\secrets', 'a/b', 'a\\b', '', 'has space', 'x'.repeat(65)])(
    'refuses %j as a pipe name',
    (pipeName) => {
      expect(() => sessionKeyPath(pipeName, env)).toThrow(SessionKeyError);
    },
  );

  it('refuses to guess when LOCALAPPDATA is unset', () => {
    expect(() => sessionKeyPath('brownie-bridge', {})).toThrow(SessionKeyError);
    expect(() => sessionKeyPath('brownie-bridge', { LOCALAPPDATA: '' })).toThrow(SessionKeyError);
  });
});

describe('the key itself', () => {
  it('is 32 bytes, and a different 32 bytes each time', () => {
    const first = mintSessionKey();
    const second = mintSessionKey();
    expect(first).toHaveLength(SESSION_KEY_BYTES);
    expect(first.equals(second)).toBe(false);
  });
});

describe('publishing', () => {
  let directory = '';

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'brownie-key-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('writes hex the native side can parse, and removes it again', async () => {
    const path = join(directory, 'nested', 'brownie-bridge.key');
    const secret = mintSessionKey();

    await publishSessionKey(path, secret);

    // The format is the contract with `apps/native/src/ipc/SessionKey.cpp`:
    // exactly 64 lower-case hex characters, nothing else.
    const written = await readFile(path, 'ascii');
    expect(written).toMatch(/^[0-9a-f]{64}$/);
    expect(Buffer.from(written, 'hex').equals(secret)).toBe(true);

    await revokeSessionKey(path);
    await expect(readFile(path, 'ascii')).rejects.toThrow();
  });

  it('overwrites a key left behind by an earlier run', async () => {
    const path = join(directory, 'brownie-bridge.key');
    await publishSessionKey(path, mintSessionKey());
    const second = mintSessionKey();
    await publishSessionKey(path, second);

    expect(await readFile(path, 'ascii')).toBe(second.toString('hex'));
  });

  it('treats removing an absent key as done, not as a failure', async () => {
    await expect(revokeSessionKey(join(directory, 'never-written.key'))).resolves.toBeUndefined();
  });
});
