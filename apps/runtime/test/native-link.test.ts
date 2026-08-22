import {
  FrameReader,
  MessageType,
  Origin,
  createNonce,
  decodeMessage,
  encodeMessage,
  macEquals,
  normaliseUserId,
  sign,
  type IpcMessage,
} from '@brownie/ipc';
import { describe, expect, it, vi } from 'vitest';
import { NativeLink } from '../src/native/NativeLink.js';
import { FakeTransport, RecordingSink, testLogger } from './fakes.js';

const SECRET = Buffer.alloc(32, 0x5a);
const NATIVE_PID = 4242;
const RUNTIME_PID = 999;
const HEARTBEAT_MS = 1000;

/**
 * The C++ side, written from `docs/ipc.md` rather than from `NativeLink`, so
 * the two would fail this test if they ever drifted apart.
 */
class NativePeer {
  readonly transport = new FakeTransport();
  readonly received: IpcMessage[] = [];
  readonly #reader = new FrameReader();
  #seq = 0;
  #challenge = createNonce();

  constructor(private readonly secret = SECRET) {}

  /** Reads whatever the runtime has sent since the last call. */
  drain(): IpcMessage[] {
    while (this.transport.sent.length > 0) {
      this.#reader.push(this.transport.sent.shift()!);
    }
    const out: IpcMessage[] = [];
    for (let frame = this.#reader.next(); frame !== null; frame = this.#reader.next()) {
      const message = decodeMessage(frame, Origin.Runtime);
      this.received.push(message);
      out.push(message);
    }
    return out;
  }

  send(message: IpcMessage): void {
    this.#seq += 1;
    this.transport.receive(encodeMessage(message, this.#seq));
  }

  /** Sends a frame with a sequence number of our choosing. */
  sendRaw(message: IpcMessage, seq: number): void {
    this.transport.receive(encodeMessage(message, seq));
  }

  hello(): void {
    this.send({ kind: 'hello', pid: NATIVE_PID, challenge: this.#challenge });
  }

  /** Completes the handshake, checking the runtime's half of it. */
  authenticate(): void {
    this.hello();
    const challenge = this.drain().find((m) => m.kind === 'authChallenge');
    expect(challenge, 'runtime answers hello with a challenge').toBeDefined();
    if (challenge?.kind !== 'authChallenge') throw new Error('unreachable');

    expect(
      macEquals(
        challenge.response,
        sign(this.secret, this.#challenge, challenge.userId, String(RUNTIME_PID)),
      ),
      'runtime signed our challenge correctly',
    ).toBe(true);

    this.send({
      kind: 'authResult',
      ok: true,
      response: sign(this.secret, challenge.challenge, challenge.userId, String(NATIVE_PID)),
    });
    // The runtime replays its feature state synchronously on authenticating.
    this.drain();
  }

  /** Sends a well-framed, correctly sequenced frame with a broken payload. */
  sendCorrupted(): void {
    this.#seq += 1;
    const frame = encodeMessage({ kind: 'controlAction', action: 'ok' }, this.#seq);
    const payload = '{"not-an-action":1}'.padEnd(frame.length - 20, ' ');
    frame.write(payload, 20, 'utf8');
    this.transport.receive(frame);
  }

  /** Answers a liveness challenge the runtime sent. */
  answerPings(): number {
    let answered = 0;
    for (const message of this.drain()) {
      if (message.kind !== 'ping') continue;
      this.send({ kind: 'pong', response: sign(this.secret, message.nonce) });
      answered++;
    }
    return answered;
  }
}

/**
 * Ends the turn, so the link writes what it has queued.
 *
 * Outgoing messages are gathered and written once per turn of the event loop —
 * one pipe write for a whole overlay sync rather than one per record. A test
 * that queues a message and reads the wire in the same turn reads an empty
 * wire; this is the turn ending. Answers to something the peer sent need it
 * only when the peer's message arrived on a timer rather than on the wire.
 */
function written(): Promise<void> {
  return Promise.resolve();
}

function link(options: { sink?: RecordingSink } = {}): { link: NativeLink; sink: RecordingSink } {
  const sink = options.sink ?? new RecordingSink();
  return {
    link: new NativeLink({
      log: testLogger(sink),
      secret: SECRET,
      userId: 'player one',
      pid: RUNTIME_PID,
      heartbeatIntervalMs: HEARTBEAT_MS,
      maxMisses: 3,
    }),
    sink,
  };
}

describe('NativeLink', () => {
  it('completes the handshake and reports itself connected', () => {
    const { link: native } = link();
    const peer = new NativePeer();
    let connectedEvents = 0;
    native.onConnected(() => connectedEvents++);

    expect(native.accept(peer.transport)).toBe(true);
    expect(native.connected).toBe(false);

    peer.authenticate();

    expect(native.connected).toBe(true);
    expect(connectedEvents).toBe(1);
  });

  it('signs the normalised identity, so both sides agree on it', () => {
    const { link: native } = link();
    const peer = new NativePeer();
    native.accept(peer.transport);
    peer.hello();

    const challenge = peer.drain().find((m) => m.kind === 'authChallenge');
    if (challenge?.kind !== 'authChallenge') throw new Error('unreachable');
    expect(challenge.userId).toBe(normaliseUserId('player one'));
    expect(challenge.pid).toBe(RUNTIME_PID);
  });

  it('refuses a peer that cannot prove it holds the secret', () => {
    const { link: native, sink } = link();
    const impostor = new NativePeer(Buffer.alloc(32, 0x01));
    native.accept(impostor.transport);
    impostor.hello();

    const challenge = impostor.drain().find((m) => m.kind === 'authChallenge');
    if (challenge?.kind !== 'authChallenge') throw new Error('unreachable');
    impostor.send({
      kind: 'authResult',
      ok: true,
      response: sign(
        Buffer.alloc(32, 0x01),
        challenge.challenge,
        challenge.userId,
        String(NATIVE_PID),
      ),
    });

    expect(native.connected).toBe(false);
    expect(impostor.transport.closed).toBe(true);
    expect(sink.messages().join(' ')).toMatch(/authentication failed/);
  });

  it('refuses data sent before authentication', () => {
    const { link: native, sink } = link();
    const peer = new NativePeer();
    const actions: string[] = [];
    native.onControlAction((action) => actions.push(action));
    native.accept(peer.transport);

    peer.send({ kind: 'controlAction', action: 'toggle|x|1' });

    expect(actions).toEqual([]);
    expect(native.connected).toBe(false);
    expect(sink.messages().join(' ')).toMatch(/before authenticating/);
  });

  it('refuses a second connection rather than dropping the live one', () => {
    const { link: native } = link();
    const first = new NativePeer();
    native.accept(first.transport);
    first.authenticate();

    const second = new NativePeer();
    expect(native.accept(second.transport)).toBe(false);
    expect(second.transport.closed).toBe(true);
    expect(native.connected).toBe(true);
  });

  describe('feature replay', () => {
    it('re-sends every key on connect, because the module stores nothing', () => {
      const { link: native } = link();
      native.setFeature('autoNexusEnabled', true);
      native.setFeature('autoNexusHp', 25);
      native.setFeature('skin', 'Sorcerer');
      native.setFeature('autoNexusHp', 30); // last value wins

      const peer = new NativePeer();
      native.accept(peer.transport);
      peer.authenticate();

      const features = peer.received.filter((m) => m.kind === 'setFeature');
      expect(features).toEqual([
        { kind: 'setFeature', key: 'autoNexusEnabled', value: true },
        { kind: 'setFeature', key: 'autoNexusHp', value: 30 },
        { kind: 'setFeature', key: 'skin', value: 'Sorcerer' },
      ]);
    });

    it('replays again after a reconnect', () => {
      const { link: native } = link();
      const first = new NativePeer();
      native.accept(first.transport);
      first.authenticate();
      native.setFeature('k', 1);
      first.drain();

      native.disconnect('test');
      const second = new NativePeer();
      native.accept(second.transport);
      second.authenticate();

      expect(second.received.filter((m) => m.kind === 'setFeature')).toEqual([
        { kind: 'setFeature', key: 'k', value: 1 },
      ]);
    });

    it('sends a live change straight through', async () => {
      const { link: native } = link();
      const peer = new NativePeer();
      native.accept(peer.transport);
      peer.authenticate();
      peer.drain();

      native.setFeature('live', 7);
      await written();

      expect(peer.drain()).toEqual([{ kind: 'setFeature', key: 'live', value: 7 }]);
    });
  });

  describe('batching', () => {
    it('writes everything queued in one turn as a single write, in order', async () => {
      const { link: native } = link();
      const peer = new NativePeer();
      native.accept(peer.transport);
      peer.authenticate();
      peer.transport.sent.length = 0;

      for (let i = 0; i < 20; i++) native.publishRecord(`record|${String(i)}`);
      expect(peer.transport.sent, 'nothing goes out before the turn ends').toHaveLength(0);

      await written();

      expect(peer.transport.sent, 'one write for the whole burst').toHaveLength(1);
      expect(
        peer.drain().map((message) => (message.kind === 'controlRecord' ? message.record : '')),
      ).toEqual(Array.from({ length: 20 }, (_unused, i) => `record|${String(i)}`));
    });

    it('answers the peer within the turn its message arrived on', () => {
      const { link: native } = link();
      const peer = new NativePeer();
      native.accept(peer.transport);

      // The handshake is the case that matters: a reply held for a microtask
      // would be a reply the peer waits for with nothing else in flight.
      peer.hello();

      expect(peer.drain().map((message) => message.kind)).toEqual(['authChallenge']);
      expect(native.connected).toBe(false);
    });

    it('drops what is queued when the link goes away', async () => {
      const { link: native } = link();
      const peer = new NativePeer();
      native.accept(peer.transport);
      peer.authenticate();
      peer.transport.sent.length = 0;

      native.publishRecord('record|queued');
      native.disconnect('test');
      await written();

      expect(peer.transport.sent).toHaveLength(0);
    });
  });

  describe('events', () => {
    it('forwards actions, hotkeys, telemetry and offset health', () => {
      const { link: native } = link();
      const peer = new NativePeer();
      const actions: string[] = [];
      const hotkeys: string[] = [];
      const health: string[][] = [];
      let hp = 0;
      native.onControlAction((a) => actions.push(a));
      native.onHotkey((e) => hotkeys.push(e.pluginId));
      native.onTelemetry((t) => (hp = t.hp));
      native.onOffsetHealth((h) => health.push([...h.unresolved]));

      native.accept(peer.transport);
      peer.authenticate();

      peer.send({ kind: 'controlAction', action: 'ui|page|key|1' });
      peer.send({ kind: 'hotkeyEvent', pluginId: 'auto-aim', action: 'togglePlugin', value: true });
      peer.send({
        kind: 'playerTelemetry',
        alive: true,
        x: 1,
        y: 2,
        hp: 640,
        maxHp: 770,
        defense: 25,
        uptimeMs: 10,
      });
      peer.send({ kind: 'offsetHealth', unresolved: ['HBEAKBIHANL'] });

      expect(actions).toEqual(['ui|page|key|1']);
      expect(hotkeys).toEqual(['auto-aim']);
      expect(hp).toBe(640);
      expect(health).toEqual([['HBEAKBIHANL']]);
    });

    it('ignores a message type it does not know', () => {
      const { link: native } = link();
      const peer = new NativePeer();
      native.accept(peer.transport);
      peer.authenticate();

      peer.send({ kind: 'unknown', type: 0x7fff, payload: Buffer.from('from a newer module') });

      expect(native.connected).toBe(true);
    });

    it('closes on a message only the runtime may send', () => {
      const { link: native, sink } = link();
      const peer = new NativePeer();
      native.accept(peer.transport);
      peer.authenticate();

      peer.send({ kind: 'setFeature', key: 'x', value: 1 });

      expect(native.connected).toBe(false);
      expect(sink.messages().join(' ')).toMatch(/may only originate from the runtime/);
    });
  });

  describe('link integrity', () => {
    it('closes on a sequence gap', () => {
      const { link: native, sink } = link();
      const peer = new NativePeer();
      native.accept(peer.transport);
      peer.authenticate();

      peer.sendRaw({ kind: 'controlAction', action: 'x' }, 99);

      expect(native.connected).toBe(false);
      expect(sink.messages().join(' ')).toMatch(/sequence gap/);
    });

    it('drops one malformed payload without closing the link', () => {
      const { link: native } = link();
      const peer = new NativePeer();
      native.accept(peer.transport);
      peer.authenticate();

      peer.sendCorrupted();

      expect(native.connected).toBe(true);
    });

    it('closes when the transport goes away', () => {
      const { link: native } = link();
      const peer = new NativePeer();
      native.accept(peer.transport);
      peer.authenticate();

      peer.transport.close();

      expect(native.connected).toBe(false);
    });
  });

  describe('heartbeat', () => {
    it('challenges periodically and accepts a correct answer', async () => {
      vi.useFakeTimers();
      try {
        const { link: native } = link();
        const peer = new NativePeer();
        native.accept(peer.transport);
        peer.authenticate();
        peer.drain();

        vi.advanceTimersByTime(HEARTBEAT_MS);
        await written();
        expect(peer.answerPings()).toBe(1);

        // Answered every time, the link stays up indefinitely.
        for (let i = 0; i < 5; i++) {
          vi.advanceTimersByTime(HEARTBEAT_MS);
          await written();
          expect(peer.answerPings(), `challenge ${String(i)}`).toBe(1);
        }
        expect(native.connected).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('closes after too many unanswered challenges', () => {
      vi.useFakeTimers();
      try {
        const { link: native, sink } = link();
        const peer = new NativePeer();
        native.accept(peer.transport);
        peer.authenticate();

        vi.advanceTimersByTime(HEARTBEAT_MS * 4);

        expect(native.connected).toBe(false);
        expect(sink.messages().join(' ')).toMatch(/unanswered heartbeats/);
      } finally {
        vi.useRealTimers();
      }
    });

    it('closes when a challenge is answered incorrectly', async () => {
      vi.useFakeTimers();
      try {
        const { link: native, sink } = link();
        const peer = new NativePeer();
        native.accept(peer.transport);
        peer.authenticate();
        peer.drain();

        vi.advanceTimersByTime(HEARTBEAT_MS);
        await written();
        const ping = peer.drain().find((m) => m.kind === 'ping');
        expect(ping).toBeDefined();
        peer.send({ kind: 'pong', response: sign(SECRET, 'the wrong nonce') });

        expect(native.connected).toBe(false);
        expect(sink.messages().join(' ')).toMatch(/answered a liveness challenge incorrectly/);
      } finally {
        vi.useRealTimers();
      }
    });

    it("answers the module's own challenge", () => {
      const { link: native } = link();
      const peer = new NativePeer();
      native.accept(peer.transport);
      peer.authenticate();
      peer.drain();

      const nonce = createNonce();
      peer.send({ kind: 'ping', nonce });

      const pong = peer.drain().find((m) => m.kind === 'pong');
      expect(pong?.kind).toBe('pong');
      if (pong?.kind !== 'pong') throw new Error('unreachable');
      expect(macEquals(pong.response, sign(SECRET, nonce))).toBe(true);
    });
  });

  it('drops records and features when nothing is connected, rather than queueing forever', () => {
    const { link: native } = link();
    native.publishRecord('plugin|a|A|combat|1||0');
    expect(native.connected).toBe(false);

    const peer = new NativePeer();
    native.accept(peer.transport);
    peer.authenticate();

    // The record predates the connection and is gone; the overlay resyncs in
    // full on connect, so there is nothing to recover.
    expect(peer.received.some((m) => m.kind === 'controlRecord')).toBe(false);
    expect(MessageType.ControlRecord).toBeGreaterThan(0);
  });
});
