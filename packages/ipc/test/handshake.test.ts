import { describe, expect, it } from 'vitest';
import {
  AuthError,
  RuntimeHandshake,
  createNonce,
  isNonce,
  macEquals,
  normaliseUserId,
  requireStrongSecret,
  sign,
  type AuthResultMessage,
  type HelloMessage,
} from '../src/index.js';

const SECRET = Buffer.alloc(32, 0xab);
const NATIVE_PID = 4242;
const RUNTIME_PID = 1234;

/**
 * Stands in for the C++ side. Written from `docs/ipc.md` rather than from the
 * implementation, so it fails if the two ever drift.
 */
function nativePeer(secret = SECRET) {
  const challenge = createNonce();
  return {
    hello: { kind: 'hello', pid: NATIVE_PID, challenge } satisfies HelloMessage,
    answer(runtimeChallenge: string, userId: string): AuthResultMessage {
      return {
        kind: 'authResult',
        ok: true,
        response: sign(secret, runtimeChallenge, userId, String(NATIVE_PID)),
      };
    },
    verifyRuntime(response: string, userId: string): boolean {
      return macEquals(response, sign(secret, challenge, userId, String(RUNTIME_PID)));
    },
  };
}

describe('RuntimeHandshake', () => {
  it('completes a mutual exchange', () => {
    const native = nativePeer();
    const handshake = new RuntimeHandshake(SECRET, 'player-one', RUNTIME_PID);

    const challenge = handshake.begin(native.hello);
    expect(native.verifyRuntime(challenge.response, challenge.userId)).toBe(true);
    expect(isNonce(challenge.challenge)).toBe(true);
    expect(handshake.complete).toBe(false);
    expect(handshake.peerPid).toBe(NATIVE_PID);

    handshake.finish(native.answer(challenge.challenge, challenge.userId));
    expect(handshake.complete).toBe(true);
  });

  it('refuses a peer that does not hold the secret', () => {
    const native = nativePeer(Buffer.alloc(32, 0x01));
    const handshake = new RuntimeHandshake(SECRET, 'player-one', RUNTIME_PID);
    const challenge = handshake.begin(native.hello);

    expect(() => handshake.finish(native.answer(challenge.challenge, challenge.userId))).toThrow(
      AuthError,
    );
    expect(handshake.complete).toBe(false);
  });

  it('refuses a replayed answer bound to a different process', () => {
    const secret = SECRET;
    const native = nativePeer(secret);
    const handshake = new RuntimeHandshake(secret, 'player-one', RUNTIME_PID);
    const challenge = handshake.begin(native.hello);

    // Correct secret and correct challenge, but signed for another pid.
    const forged: AuthResultMessage = {
      kind: 'authResult',
      ok: true,
      response: sign(secret, challenge.challenge, challenge.userId, '9999'),
    };
    expect(() => handshake.finish(forged)).toThrow(/failed to prove/);
  });

  it('refuses an answer to a challenge it never sent', () => {
    const native = nativePeer();
    const handshake = new RuntimeHandshake(SECRET, 'player-one', RUNTIME_PID);
    const stale = createNonce();
    handshake.begin(native.hello);
    expect(() => handshake.finish(native.answer(stale, 'player-one'))).toThrow(AuthError);
  });

  it('refuses a rejection', () => {
    const native = nativePeer();
    const handshake = new RuntimeHandshake(SECRET, 'player-one', RUNTIME_PID);
    handshake.begin(native.hello);
    expect(() =>
      handshake.finish({ kind: 'authResult', ok: false, response: 'a'.repeat(64) }),
    ).toThrow(/rejected our credentials/);
  });

  it('refuses a malformed greeting', () => {
    const handshake = new RuntimeHandshake(SECRET, 'u', RUNTIME_PID);
    expect(() => handshake.begin({ kind: 'hello', pid: 1, challenge: 'short' })).toThrow(
      /malformed challenge/,
    );
    expect(() => handshake.begin({ kind: 'hello', pid: 0, challenge: createNonce() })).toThrow(
      /implausible process id/,
    );
  });

  it('refuses to run twice', () => {
    const native = nativePeer();
    const handshake = new RuntimeHandshake(SECRET, 'u', RUNTIME_PID);
    const challenge = handshake.begin(native.hello);
    handshake.finish(native.answer(challenge.challenge, challenge.userId));
    expect(() => handshake.begin(native.hello)).toThrow(/already completed/);
  });

  it('refuses an answer before a greeting', () => {
    const handshake = new RuntimeHandshake(SECRET, 'u', RUNTIME_PID);
    expect(() =>
      handshake.finish({ kind: 'authResult', ok: true, response: 'a'.repeat(64) }),
    ).toThrow(/before hello/);
  });

  describe('liveness', () => {
    it('answers its own challenge', () => {
      const handshake = new RuntimeHandshake(SECRET, 'u', RUNTIME_PID);
      const { message, expected } = handshake.createPing();
      const pong = handshake.answerPing(message);
      expect(handshake.verifyPong(pong, expected)).toBe(true);
    });

    it('rejects an answer to a different challenge', () => {
      const handshake = new RuntimeHandshake(SECRET, 'u', RUNTIME_PID);
      const a = handshake.createPing();
      const b = handshake.createPing();
      expect(handshake.verifyPong(handshake.answerPing(b.message), a.expected)).toBe(false);
    });

    it('rejects a malformed nonce', () => {
      const handshake = new RuntimeHandshake(SECRET, 'u', RUNTIME_PID);
      expect(() => handshake.answerPing({ kind: 'ping', nonce: 'nope' })).toThrow(AuthError);
    });
  });
});

describe('crypto helpers', () => {
  it('signs unambiguously across field boundaries', () => {
    // Without a separator, ("ab","c") and ("a","bc") would sign identically.
    expect(sign(SECRET, 'ab', 'c')).not.toBe(sign(SECRET, 'a', 'bc'));
  });

  it('compares MACs without accepting malformed input', () => {
    const mac = sign(SECRET, 'x');
    expect(macEquals(mac, mac)).toBe(true);
    expect(macEquals(mac, sign(SECRET, 'y'))).toBe(false);
    expect(macEquals(mac, '')).toBe(false);
    expect(macEquals(mac, 'not hex at all')).toBe(false);
  });

  it('rejects a secret too short to be worth having', () => {
    expect(() => requireStrongSecret(Buffer.alloc(8))).toThrow(RangeError);
    expect(() => requireStrongSecret(Buffer.alloc(32))).not.toThrow();
  });

  it('produces fresh nonces', () => {
    const seen = new Set(Array.from({ length: 64 }, () => createNonce()));
    expect(seen.size).toBe(64);
    expect([...seen].every(isNonce)).toBe(true);
  });
});

describe('normaliseUserId', () => {
  it('gives "no user" an explicit name', () => {
    expect(normaliseUserId('')).toBe('anonymous');
    expect(normaliseUserId('   ')).toBe('anonymous');
  });

  it('keeps a conservative ASCII set and replaces the rest', () => {
    expect(normaliseUserId('player.one_2-3')).toBe('player.one_2-3');
    expect(normaliseUserId('Ivan Петров')).toBe('Ivan_______');
  });

  it('bounds the length', () => {
    expect(normaliseUserId('a'.repeat(200))).toHaveLength(96);
  });
});
