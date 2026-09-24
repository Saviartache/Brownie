import type { MutablePacket } from '@brownie/plugin-api';
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

/** The client answering a server tick, which is what it does most often. */
function moveFrame(tickId: number): Buffer {
  const packet = createPacket(registry, 'MOVE');
  packet.fields['tickId'] = tickId;
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
    onClientPacketPassed?: (packet: MutablePacket) => void;
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
    ...(options.onClientPacketPassed === undefined
      ? {}
      : { onClientPacketPassed: options.onClientPacketPassed }),
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

  it('tells its listener about a client packet only once it is on the wire', () => {
    // Whatever the listener injects has to land *behind* the client's packet,
    // where the client's own next one would: the client sends every packet
    // after the shot acknowledgements it owes, so that is where it owes none.
    const escape = createPacket(registry, 'ESCAPE');
    // The listener needs the session and the session needs the listener, so the
    // listener reads a reference filled in once both exist.
    const holder: { session?: ProxySession } = {};
    const h = harness({
      onClientPacketPassed: () => {
        holder.session?.injectToServer(escape);
      },
    });
    holder.session = h.session;

    h.client.receive(h.gameClient.encipher(teleportFrame(1, 'first')));
    h.client.receive(h.gameClient.encipher(moveFrame(2)));

    const onWire = h
      .server()
      .sent.map((frame) => decodeFrame(registry, h.gameServer.decipher(frame)).name);
    expect(onWire).toEqual(['TELEPORT', 'ESCAPE', 'MOVE', 'ESCAPE']);
  });

  it('reports a client packet a stage withheld, and never a server one', () => {
    // Withheld is still a point where the client owes nothing — the
    // acknowledgements ahead of it went out — so the listener is told, and
    // can see from the verdict that the server never heard it.
    const passed: string[] = [];
    const h = harness({
      stages: [{ name: 'withhold', handle: (packet) => packet.drop() }],
      onClientPacketPassed: (packet) => passed.push(`${packet.name}:${packet.verdict}`),
    });

    h.client.receive(h.gameClient.encipher(teleportFrame(1, 'held')));
    h.server().receive(h.gameServer.encipher(frameOf(255, Buffer.from('server-side'))));

    expect(passed).toEqual(['TELEPORT:drop']);
    expect(h.server().sent).toHaveLength(0);
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
 * real encoder, a real cipher and a real socket underneath, and the session
 * telling the queue when the client has spoken — wired the way `ProxyServer`
 * wires it.
 *
 * The unit tests in `outbound.test.ts` cover the ordering rules. What is worth
 * proving here is what only the wiring can get wrong — that an unpaced packet
 * still leaves during the call, that a held one lands on the wire behind the
 * client's own packet and not ahead of it, and that it is stamped when it
 * leaves rather than when it was asked for.
 */
describe('SessionContext and the outbound queue', () => {
  function connected(): {
    h: ReturnType<typeof harness>;
    world: WorldState;
    view: SessionContext;
    /** Everything on the server link after the packet that opened it, in order. */
    wire: () => { name: string; fields: Readonly<Record<string, unknown>> }[];
    /** What the queue put there, without the client's own traffic. */
    toServer: () => { name: string; fields: Readonly<Record<string, unknown>> }[];
    /** The client answers a server tick. */
    clientSpeaks: () => void;
  } {
    // The same knot `ProxyServer` ties: the session exists before the view that
    // owns the queue, so the listener reads a reference filled in below.
    const holder: { passed?: (packet: MutablePacket) => void } = {};
    const h = harness({
      onClientPacketPassed: (packet) => {
        holder.passed?.(packet);
      },
    });
    // The first client packet is what opens the server link.
    h.client.receive(h.gameClient.encipher(teleportFrame(1, 'x')));
    const world = new WorldState();
    world.markConnected();
    const view = new SessionContext(h.session, world, registry, testLogger(h.sink));
    holder.passed = (packet) => {
      view.outbound.clientPacketPassed(packet);
    };

    // **Each frame is deciphered exactly once.** RC4 is a keystream, not a
    // function of the bytes in front of it, so reading the same frame twice
    // advances the state past everything after it and turns the rest of the
    // conversation into noise — which is the same thing that happens on a live
    // connection when one packet goes missing.
    let read = 0;
    const decoded: { name: string; fields: Readonly<Record<string, unknown>> }[] = [];
    const wire = (): typeof decoded => {
      const frames = h.server().sent;
      for (; read < frames.length; read++) {
        const frame = frames[read];
        if (frame === undefined) continue;
        decoded.push(decodeFrame(registry, h.gameServer.decipher(frame)));
      }
      // The session's own forwarding of the packet that opened the link is not
      // what any of this is about.
      return decoded.slice(1);
    };
    const toServer = (): typeof decoded => wire().filter((packet) => packet.name !== 'MOVE');
    let tick = 0;
    const clientSpeaks = (): void => {
      h.client.receive(h.gameClient.encipher(moveFrame(++tick)));
    };
    return { h, world, view, wire, toServer, clientSpeaks };
  }

  it('sends an escape during the call, whatever else is waiting', () => {
    const c = connected();
    // Two item moves first: they wait for the client, and then for each other.
    c.view.sendToServer('INVENTORYSWAP', swapFields(4));
    c.view.sendToServer('INVENTORYSWAP', swapFields(5));
    // An escape is somebody's life and is not in the table at all.
    c.view.sendToServer('ESCAPE', {});
    expect(c.toServer().map((packet) => packet.name)).toEqual(['ESCAPE']);

    c.clientSpeaks();
    expect(c.toServer().map((packet) => packet.name)).toEqual(['ESCAPE', 'INVENTORYSWAP']);
  });

  it('puts a held packet on the wire right behind the client, never ahead of it', () => {
    const c = connected();
    c.view.sendToServer('INVENTORYSWAP', swapFields(4));
    expect(c.wire()).toEqual([]);

    c.clientSpeaks();
    expect(c.wire().map((packet) => packet.name)).toEqual(['MOVE', 'INVENTORYSWAP']);
  });

  it('holds the second item move rather than putting both on the wire', () => {
    const c = connected();
    c.view.sendToServer('INVENTORYSWAP', swapFields(4));
    c.view.sendToServer('USEITEM', {
      time: 0,
      slotObject: { objectId: 1, slotId: 4, objectType: 2594 },
      itemUsePos: { x: 0, y: 0 },
      useType: 0,
      unknownInt: 0,
    });
    c.clientSpeaks();

    // This is the collision, on the wire, with the real encoder: one packet,
    // not two inside a millisecond.
    expect(c.toServer()).toHaveLength(1);
  });

  it('stamps a held packet with the clock of the moment it leaves', async () => {
    const c = connected();
    c.view.sendToServer('INVENTORYSWAP', swapFields(4));
    c.view.sendToServer('INVENTORYSWAP', swapFields(5));
    c.clientSpeaks();

    // The client's clock, as the server has been hearing it — and moved on by
    // more than the lane's spacing while the second move waited.
    c.world.calibrateClientClock(500_000);
    await new Promise((resolve) => setTimeout(resolve, 1050));
    c.clientSpeaks();

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
    c.clientSpeaks();
    c.view.sendToServer('INVENTORYSWAP', swapFields(5));
    c.view.outbound.dispose();

    await new Promise((resolve) => setTimeout(resolve, 1050));
    c.clientSpeaks();
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
