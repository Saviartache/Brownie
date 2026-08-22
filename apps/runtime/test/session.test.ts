import { createBundledRegistry } from '@brownie/protocol/bundled';
import { createPacket, decodeFrame, encodePacket, type PacketRegistry } from '@brownie/protocol';
import { describe, expect, it } from 'vitest';
import { PacketPipeline, type PipelineStage } from '../src/pipeline/PacketPipeline.js';
import {
  ProxySession,
  type ServerConnector,
  type ServerTarget,
} from '../src/proxy/ProxySession.js';
import { FakeTransport, PeerCiphers, RecordingSink, frameOf, testLogger } from './fakes.js';

const registry: PacketRegistry = createBundledRegistry();
const TARGET: ServerTarget = { host: '10.0.0.1', port: 2050 };

/** A plaintext TELEPORT frame, built through the real encoder. */
function teleportFrame(objectId: number, playerName: string): Buffer {
  const packet = createPacket(registry, 'TELEPORT');
  packet.fields['objectId'] = objectId;
  packet.fields['playerName'] = playerName;
  return encodePacket(registry, packet);
}

interface Harness {
  session: ProxySession;
  client: FakeTransport;
  gameClient: PeerCiphers;
  /** Set once the session opens the server link. */
  server: () => FakeTransport;
  gameServer: PeerCiphers;
  sink: RecordingSink;
  closed: ProxySession[];
}

function harness(
  options: {
    stages?: readonly PipelineStage[];
    resolveTarget?: () => ServerTarget | undefined;
  } = {},
): Harness {
  const client = new FakeTransport();
  let server: FakeTransport | undefined;
  const sink = new RecordingSink();
  const closed: ProxySession[] = [];

  const connector: ServerConnector = {
    connect(): FakeTransport {
      server = new FakeTransport();
      return server;
    },
  };

  const session = new ProxySession({
    id: 's1',
    registry,
    clientTransport: client,
    connector,
    resolveTarget: options.resolveTarget ?? ((): ServerTarget => TARGET),
    buildPipeline: () => new PacketPipeline(options.stages ?? [], () => undefined),
    log: testLogger(sink),
    onClosed: (s) => closed.push(s),
  });

  return {
    session,
    client,
    gameClient: PeerCiphers.gameClient(),
    server: () => {
      if (server === undefined) throw new Error('the server link was never opened');
      return server;
    },
    gameServer: PeerCiphers.gameServer(),
    sink,
    closed,
  };
}

describe('ProxySession', () => {
  it('opens the server link on the first client packet and forwards it', () => {
    const h = harness();
    const frame = teleportFrame(1, 'first');

    h.client.receive(h.gameClient.encipher(frame));

    expect(h.session.target).toEqual(TARGET);
    expect(h.server().sent).toHaveLength(1);
    expect(h.gameServer.decipher(h.server().sent[0]!).equals(frame)).toBe(true);
  });

  it('forwards server packets back to the client', () => {
    const h = harness();
    h.client.receive(h.gameClient.encipher(teleportFrame(1, 'open-the-link')));

    const fromServer = frameOf(255, Buffer.from('server-side'));
    h.server().receive(h.gameServer.encipher(fromServer));

    expect(h.client.sent).toHaveLength(1);
    expect(h.gameClient.decipher(h.client.sent[0]!).equals(fromServer)).toBe(true);
  });

  it('keeps both keystreams in step across many packets in both directions', () => {
    const h = harness();
    h.client.receive(h.gameClient.encipher(teleportFrame(0, 'hello')));

    for (let i = 1; i <= 20; i++) {
      h.client.receive(h.gameClient.encipher(teleportFrame(i, `c${String(i)}`)));
      h.server().receive(h.gameServer.encipher(frameOf(200, Buffer.from(`s${String(i)}`))));
    }

    // Deciphering in order only works if nothing was dropped, duplicated or
    // re-ordered — which is exactly the property RC4 continuity depends on.
    const toServer = h.server().sent.map((f) => h.gameServer.decipher(f));
    expect(toServer).toHaveLength(21);
    expect(decodeFrame(registry, toServer[20]!).fields['playerName']).toBe('c20');

    const toClient = h.client.sent.map((f) => h.gameClient.decipher(f));
    expect(toClient).toHaveLength(20);
    expect(toClient[19]!.subarray(5).toString()).toBe('s20');
  });

  it('holds what the client sends, and lets it go in order', () => {
    const h = harness();
    h.client.receive(h.gameClient.encipher(teleportFrame(0, 'open-the-link')));
    expect(h.server().sent).toHaveLength(1);

    h.session.holdClientTraffic(true);
    h.client.receive(h.gameClient.encipher(teleportFrame(1, 'held-1')));
    h.client.receive(h.gameClient.encipher(teleportFrame(2, 'held-2')));
    expect(h.server().sent).toHaveLength(1);

    h.session.holdClientTraffic(false);

    // In order and complete. Nothing may be dropped: the frames are enciphered
    // in the order they were handed over, so a missing one leaves the server
    // deciphering noise from there on — and the game's own tick answers are in
    // this stream, which the server counts.
    const toServer = h.server().sent.map((frame) => h.gameServer.decipher(frame));
    expect(toServer).toHaveLength(3);
    expect(toServer.map((frame) => decodeFrame(registry, frame).fields['playerName'])).toEqual([
      'open-the-link',
      'held-1',
      'held-2',
    ]);
  });

  it('keeps letting the server through while the client is held', () => {
    const h = harness();
    h.client.receive(h.gameClient.encipher(teleportFrame(0, 'open-the-link')));
    h.session.holdClientTraffic(true);

    // Only one direction is held. The client has to keep hearing the server, or
    // it has nothing to answer and nothing to draw.
    h.server().receive(h.gameServer.encipher(frameOf(200, Buffer.from('tick'))));

    expect(h.client.sent).toHaveLength(1);
  });

  it('forwards an untouched packet as the exact bytes that arrived', () => {
    // A packet with trailing bytes the schema does not describe: rebuilding it
    // from fields would be the moment they were lost.
    const h = harness();
    const withTrailer = Buffer.concat([teleportFrame(1, 'x'), Buffer.from('trailing')]);
    withTrailer.writeInt32BE(withTrailer.length, 0);

    h.client.receive(h.gameClient.encipher(withTrailer));

    expect(h.gameServer.decipher(h.server().sent[0]!).equals(withTrailer)).toBe(true);
  });

  it('re-encodes a packet a stage modified', () => {
    const h = harness({
      stages: [{ name: 'rewrite', handle: (packet) => packet.set('objectId', 4242) }],
    });

    h.client.receive(h.gameClient.encipher(teleportFrame(1, 'rewrite-me')));

    const received = decodeFrame(registry, h.gameServer.decipher(h.server().sent[0]!));
    expect(received.fields['objectId']).toBe(4242);
    expect(received.fields['playerName']).toBe('rewrite-me');
  });

  it('does not forward a packet a stage dropped', () => {
    const h = harness({
      stages: [
        {
          name: 'block',
          handle: (packet) => {
            if (packet.string('playerName') === 'blocked') packet.drop();
          },
        },
      ],
    });

    h.client.receive(h.gameClient.encipher(teleportFrame(1, 'allowed')));
    h.client.receive(h.gameClient.encipher(teleportFrame(2, 'blocked')));
    h.client.receive(h.gameClient.encipher(teleportFrame(3, 'allowed')));

    const names = h
      .server()
      .sent.map((f) => decodeFrame(registry, h.gameServer.decipher(f)).fields['playerName']);
    expect(names).toEqual(['allowed', 'allowed']);
  });

  it('injects a packet toward the server', () => {
    const h = harness();
    h.client.receive(h.gameClient.encipher(teleportFrame(1, 'open')));

    const injected = createPacket(registry, 'TELEPORT');
    injected.fields['objectId'] = 7;
    injected.fields['playerName'] = 'injected';
    h.session.injectToServer(injected);

    // Deciphered in order: an injected packet advances the same keystream as a
    // forwarded one, which is why injecting is safe but skipping is not.
    const [forwarded, sent] = h.server().sent.map((f) => h.gameServer.decipher(f));
    expect(decodeFrame(registry, forwarded!).fields['playerName']).toBe('open');
    expect(decodeFrame(registry, sent!).fields['playerName']).toBe('injected');
  });

  it('refuses to open a link to a target nothing vouched for', () => {
    const h = harness({ resolveTarget: () => undefined });

    h.client.receive(h.gameClient.encipher(teleportFrame(1, 'x')));

    expect(h.session.closed).toBe(true);
    expect(h.closed).toHaveLength(1);
    expect(h.sink.messages().join(' ')).toMatch(/no allowed server target/);
  });

  it('closes once, whatever closes it', () => {
    const h = harness();
    h.client.receive(h.gameClient.encipher(teleportFrame(1, 'x')));

    h.session.close('first');
    h.session.close('second');
    h.client.close();

    expect(h.closed).toHaveLength(1);
    expect(h.client.closed).toBe(true);
    expect(h.server().closed).toBe(true);
  });

  it('closes when the client goes away', () => {
    const h = harness();
    h.client.receive(h.gameClient.encipher(teleportFrame(1, 'x')));

    h.client.close();

    expect(h.session.closed).toBe(true);
    expect(h.server().closed).toBe(true);
  });

  it('closes when the server goes away', () => {
    const h = harness();
    h.client.receive(h.gameClient.encipher(teleportFrame(1, 'x')));

    h.server().close();

    expect(h.session.closed).toBe(true);
    expect(h.client.closed).toBe(true);
  });

  it('closes on a desynchronised stream rather than trying to resynchronise', () => {
    const h = harness();
    const garbage = Buffer.alloc(8);
    garbage.writeInt32BE(0, 0); // a frame cannot be zero bytes long

    h.client.receive(garbage);

    expect(h.session.closed).toBe(true);
    expect(h.sink.messages().join(' ')).toMatch(/client link failed/);
  });

  it('ignores packets that arrive after it closed', () => {
    const h = harness();
    h.client.receive(h.gameClient.encipher(teleportFrame(1, 'x')));
    const sentBefore = h.server().sent.length;

    h.session.close('done');
    h.client.receive(h.gameClient.encipher(teleportFrame(2, 'late')));

    expect(h.server().sent).toHaveLength(sentBefore);
  });
});
