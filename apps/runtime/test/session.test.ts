import { createBundledRegistry } from '@brownie/protocol/bundled';
import { createPacket, decodeFrame, encodePacket, type PacketRegistry } from '@brownie/protocol';
import { describe, expect, it } from 'vitest';
import { PacketPipeline, type PipelineStage } from '../src/pipeline/PacketPipeline.js';
import {
  ProxySession,
  type ServerConnector,
  type ServerTarget,
} from '../src/proxy/ProxySession.js';
import { SessionContext } from '../src/proxy/SessionContext.js';
import { WorldState } from '../src/state/WorldState.js';
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

    h.session.holdTraffic(true);
    h.client.receive(h.gameClient.encipher(teleportFrame(1, 'held-1')));
    h.client.receive(h.gameClient.encipher(teleportFrame(2, 'held-2')));
    expect(h.server().sent).toHaveLength(1);

    h.session.holdTraffic(false);

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

  it('holds what the server sends too, and lets that go in order as well', () => {
    const h = harness();
    h.client.receive(h.gameClient.encipher(teleportFrame(0, 'open-the-link')));
    h.session.holdTraffic(true);

    // Both directions, which is what makes this the whole socket rather than
    // half of one: a client that keeps hearing the server keeps being told
    // where the server thinks it is, and that correction is the very thing the
    // hold exists to keep off the screen.
    h.server().receive(h.gameServer.encipher(frameOf(200, Buffer.from('tick-1'))));
    h.server().receive(h.gameServer.encipher(frameOf(200, Buffer.from('tick-2'))));
    expect(h.client.sent).toHaveLength(0);

    h.session.holdTraffic(false);

    const toClient = h.client.sent.map((frame) => h.gameClient.decipher(frame));
    expect(toClient).toHaveLength(2);
    expect(toClient.map((frame) => frame.subarray(5).toString())).toEqual(['tick-1', 'tick-2']);
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

  // A notification the client silently discards is worse than one that never
  // left: nothing in the log says so, and `/ip` simply looks like a command
  // that stopped working. See `SessionContext.notify`.
  it('marks an injected chat line as having no player behind it', () => {
    const h = harness();
    h.client.receive(h.gameClient.encipher(teleportFrame(1, 'x')));
    const view = new SessionContext(h.session, new WorldState(), registry, testLogger(h.sink));
    const sentBefore = h.client.sent.length;

    view.notify('hello');

    const sent = h.client.sent.slice(sentBefore);
    expect(sent).toHaveLength(1);
    // `sent[0]` is the frame the assertion above just counted.
    const packet = decodeFrame(registry, h.gameClient.decipher(sent[0] as Buffer));
    expect(packet.name).toBe('TEXT');
    expect(packet.fields['text']).toBe('hello');
    expect(packet.fields['objectId']).toBe(-1);
    expect(packet.fields['numStars']).toBe(-1);
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

/**
 * The queue as a plugin actually reaches it: through `sendToServer`, with a
 * real encoder, a real cipher and a real socket underneath.
 *
 * The unit tests in `outbound.test.ts` cover the ordering rules. What is worth
 * proving here is the two things only the wiring can get wrong — that an
 * unpaced packet still leaves during the call, and that a held one is stamped
 * when it leaves rather than when it was asked for.
 */
describe('SessionContext and the outbound queue', () => {
  function connected(): {
    h: ReturnType<typeof harness>;
    world: WorldState;
    view: SessionContext;
    toServer: () => { name: string; fields: Readonly<Record<string, unknown>> }[];
  } {
    const h = harness();
    // The first client packet is what opens the server link.
    h.client.receive(h.gameClient.encipher(teleportFrame(1, 'x')));
    const world = new WorldState();
    world.markConnected();
    const view = new SessionContext(h.session, world, registry, testLogger(h.sink));

    // **Each frame is deciphered exactly once.** RC4 is a keystream, not a
    // function of the bytes in front of it, so reading the same frame twice
    // advances the state past everything after it and turns the rest of the
    // conversation into noise — which is the same thing that happens on a live
    // connection when one packet goes missing.
    let read = 0;
    const decoded: { name: string; fields: Readonly<Record<string, unknown>> }[] = [];
    const toServer = (): typeof decoded => {
      const frames = h.server().sent;
      for (; read < frames.length; read++) {
        const frame = frames[read];
        if (frame === undefined) continue;
        decoded.push(decodeFrame(registry, h.gameServer.decipher(frame)));
      }
      // The session's own forwarding of the packet that opened the link is not
      // what any of this is about.
      return decoded.filter((packet) => packet.name !== 'TELEPORT');
    };
    return { h, world, view, toServer };
  }

  it('sends an escape during the call, whatever else is waiting', () => {
    const c = connected();
    // Two item moves first: the lane they share is now busy for a full second.
    c.view.sendToServer('INVENTORYSWAP', swapFields(4));
    c.view.sendToServer('INVENTORYSWAP', swapFields(5));
    // An escape is somebody's life and is not in the table at all.
    c.view.sendToServer('ESCAPE', {});

    expect(c.toServer().map((packet) => packet.name)).toEqual(['INVENTORYSWAP', 'ESCAPE']);
  });

  it('holds the second item move rather than putting both on the wire', () => {
    const c = connected();
    c.view.sendToServer('INVENTORYSWAP', swapFields(4));
    c.view.sendToServer('USEITEM', {
      time: 0,
      slotObject: { objectId: 1, slotId: 4, objectType: 2594 },
      itemUsePos: { x: 0, y: 0 },
      useType: 1,
      unknownInt: 0,
    });

    // This is the collision, on the wire, with the real encoder: one packet,
    // not two inside a millisecond.
    expect(c.toServer()).toHaveLength(1);
  });

  it('stamps a held packet with the clock of the moment it leaves', async () => {
    const c = connected();
    c.view.sendToServer('INVENTORYSWAP', swapFields(4));
    c.view.sendToServer('INVENTORYSWAP', swapFields(5));

    // The client's clock, as the server has been hearing it — and moved on by
    // more than the lane's spacing while the second move waited.
    c.world.calibrateClientClock(500_000);
    await waitFor(() => c.toServer().length === 2);

    const [first, second] = c.toServer();
    // The first left before the calibration, on the only clock there was: the
    // milliseconds since this connection opened, which is a handful.
    expect(first?.fields['time']).toBeLessThan(1000);
    // Not the zero it was built with: a stamp the server reads as going
    // backwards is dropped without a word, which is indistinguishable from the
    // move simply not working.
    expect(second?.fields['time']).toBeGreaterThanOrEqual(500_000);
  });

  it('stops sending once the session has gone', async () => {
    const c = connected();
    c.view.sendToServer('INVENTORYSWAP', swapFields(4));
    c.view.sendToServer('INVENTORYSWAP', swapFields(5));
    c.view.outbound.dispose();

    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(c.toServer()).toHaveLength(1);
  });
});

/** An inventory move, with the fields the session rewrites left at zero. */
function swapFields(slotId: number): Record<string, unknown> {
  return {
    time: 0,
    position: { x: 0, y: 0 },
    slotObject1: { objectId: 100, slotId: 0, objectType: 2594 },
    slotObject2: { objectId: 1, slotId, objectType: -1 },
  };
}

/** Polls until a condition holds, or gives up — the queue runs on real timers. */
async function waitFor(done: () => boolean, timeoutMs = 3000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() > until) throw new Error('timed out waiting for the queue');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
