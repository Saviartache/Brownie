import { AuthError } from '../errors.js';
import type {
  AuthChallengeMessage,
  AuthResultMessage,
  HelloMessage,
  PingMessage,
  PongMessage,
} from '../messages/types.js';
import { createNonce, isNonce, macEquals, requireStrongSecret, sign } from './crypto.js';

/**
 * Mutual authentication, once per connection.
 *
 * ```
 * native → runtime   hello         { pid, challenge }
 * runtime → native   authChallenge { userId, pid, response, challenge }
 * native → runtime   authResult    { ok, response }
 * ```
 *
 * `response` is `HMAC(secret, challenge | userId | pid)` in both directions,
 * where `pid` is the *sender's* process id. Binding the pid means a captured
 * transcript cannot authenticate a different process.
 *
 * After this exchange the connection is trusted for its lifetime. The reference
 * implementation instead derived a session key and signed every subsequent
 * message with it — see `docs/ipc.md` for why that is not carried over, and
 * what replaced it.
 *
 * Liveness keeps a signed exchange, because it is one hash every few seconds
 * and it re-proves key possession rather than merely proving the socket is
 * open: `ping { nonce }` → `pong { response = HMAC(secret, nonce) }`.
 */
export class RuntimeHandshake {
  readonly #secret: Buffer;
  readonly #userId: string;
  readonly #pid: number;

  #ourChallenge: string | undefined;
  #peerPid: number | undefined;
  #complete = false;

  constructor(secret: Buffer, userId: string, pid: number) {
    this.#secret = requireStrongSecret(secret);
    this.#userId = normaliseUserId(userId);
    this.#pid = pid;
  }

  get complete(): boolean {
    return this.#complete;
  }

  /** The identity actually signed — normalised, so both sides agree on it. */
  get userId(): string {
    return this.#userId;
  }

  /** Process id of the game the native module is injected into. */
  get peerPid(): number | undefined {
    return this.#peerPid;
  }

  /**
   * Answers the native module's challenge and poses ours.
   *
   * @throws {AuthError} if the greeting is not well formed. Nothing has been
   *   proven at this point, so a bad greeting is simply a peer we hang up on.
   */
  begin(hello: HelloMessage): AuthChallengeMessage {
    if (this.#complete) throw new AuthError('handshake already completed');
    if (!isNonce(hello.challenge)) throw new AuthError('hello carries a malformed challenge');
    if (!Number.isInteger(hello.pid) || hello.pid <= 0) {
      throw new AuthError('hello carries an implausible process id');
    }

    this.#peerPid = hello.pid;
    this.#ourChallenge = createNonce();

    return {
      kind: 'authChallenge',
      userId: this.#userId,
      pid: this.#pid,
      response: sign(this.#secret, hello.challenge, this.#userId, String(this.#pid)),
      challenge: this.#ourChallenge,
    };
  }

  /**
   * Verifies the native module's answer to our challenge.
   *
   * @throws {AuthError} if the module rejected us, answered wrongly, or
   *   answered out of order.
   */
  finish(result: AuthResultMessage): void {
    const challenge = this.#ourChallenge;
    if (challenge === undefined) throw new AuthError('authResult arrived before hello');
    if (this.#complete) throw new AuthError('handshake already completed');
    if (!result.ok) throw new AuthError('native module rejected our credentials');

    const peerPid = this.#peerPid;
    if (peerPid === undefined) throw new AuthError('no peer process id recorded');

    const expected = sign(this.#secret, challenge, this.#userId, String(peerPid));
    if (!macEquals(result.response, expected)) {
      // Deliberately unspecific: a peer that cannot sign correctly learns
      // nothing further from us.
      throw new AuthError('native module failed to prove it holds the shared secret');
    }

    this.#ourChallenge = undefined;
    this.#complete = true;
  }

  /** Builds a liveness challenge and the answer we expect back. */
  createPing(): { message: PingMessage; expected: string } {
    const nonce = createNonce();
    return {
      message: { kind: 'ping', nonce },
      expected: sign(this.#secret, nonce),
    };
  }

  /** Answers the peer's liveness challenge. */
  answerPing(ping: PingMessage): PongMessage {
    if (!isNonce(ping.nonce)) throw new AuthError('ping carries a malformed nonce');
    return { kind: 'pong', response: sign(this.#secret, ping.nonce) };
  }

  /** Whether a `pong` answers the challenge we sent. */
  verifyPong(pong: PongMessage, expected: string): boolean {
    return macEquals(pong.response, expected);
  }
}

/**
 * Normalises the identity that gets signed.
 *
 * Both sides sign this string, so they must derive it identically from the same
 * input. Restricting it to a conservative ASCII set keeps the C++ side free of
 * encoding questions; an empty identity becomes an explicit token rather than
 * an empty field, because "no user" is a real state and signing an empty string
 * makes it indistinguishable from a missing field.
 */
export function normaliseUserId(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return 'anonymous';
  const safe = trimmed.replace(/[^A-Za-z0-9._-]/g, '_');
  return safe.length > 96 ? safe.slice(0, 96) : safe;
}
