import { PluginCategory, definePlugin, type SessionView } from '@brownie/plugin-api';
import { createBundledRegistry } from '@brownie/protocol/bundled';
import { createPacket, decodeFrame, encodePacket, type PacketRegistry } from '@brownie/protocol';
import { createConnection, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { PluginStage } from '../src/pipeline/stages/PluginStage.js';
import { PluginHost } from '../src/plugins/PluginHost.js';
import { ProxyServer } from '../src/proxy/ProxyServer.js';
import type { ServerConnector, ServerTarget } from '../src/proxy/ProxySession.js';
import { FakeTransport, PeerCiphers, RecordingSink, testLogger } from './fakes.js';

const registry: PacketRegistry = createBundledRegistry();
const TARGET: ServerTarget = { host: '10.0.0.1', port: 2050 };

function teleportFrame(objectId: number, playerName: string): Buffer {
  const packet = createPacket(registry, 'TELEPORT');
  packet.fields['objectId'] = objectId;
  packet.fields['playerName'] = playerName;
  return encodePacket(registry, packet);
}

/** Hands out fake server transports so no game server is needed. */
class RecordingConnector implements ServerConnector {
  readonly transports: FakeTransport[] = [];
  readonly targets: ServerTarget[] = [];

  connect(target: ServerTarget): FakeTransport {
    this.targets.push(target);
    const transport = new FakeTransport();
    this.transports.push(transport);
    return transport;
  }

  last(): FakeTransport {
    const transport = this.transports.at(-1);
    if (transport === undefined) throw new Error('no server transport was opened');
    return transport;
  }
}

const openSockets: Socket[] = [];
const openServers: ProxyServer[] = [];

afterEach(async () => {
  for (const socket of openSockets.splice(0)) socket.destroy();
  for (const server of openServers.splice(0)) await server.close();
});

/** Waits for something the event loop has to turn over to make true. */
async function until(predicate: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`timed out waiting for ${what}`);
}

interface Harness {
  server: ProxyServer;
  connector: RecordingConnector;
  host: PluginHost;
  sink: RecordingSink;
  /** Connects a real TCP client to the proxy. */
  connect: () => Promise<Socket>;
}

async function harness(
  options: { resolve?: () => ServerTarget | undefined } = {},
): Promise<Harness> {
  const sink = new RecordingSink();
  const log = testLogger(sink);
  const connector = new RecordingConnector();

  // The stage builder needs the host, the host needs the server as its session
  // source, and neither exists before the other — so the builder reads a
  // reference filled in immediately below. It is only consulted once a client
  // connects, by which time both exist.
  const holder: { host?: PluginHost } = {};
  const server = new ProxyServer({
    registry,
    log,
    connector,
    targets: { resolve: options.resolve ?? ((): ServerTarget => TARGET) },
    buildStages: (session: SessionView) =>
      holder.host === undefined ? [] : [new PluginStage(holder.host, session)],
  });
  const host = new PluginHost({
    log,
    native: { connected: false, setFeature: () => undefined, onConnected: () => () => undefined },
    sessions: server,
  });
  holder.host = host;

  openServers.push(server);
  // Port 0 asks the OS for a free one, so tests never collide.
  await server.listen('127.0.0.1', 0);
  const port = server.address?.port;
  if (port === undefined) throw new Error('the proxy did not report a bound port');

  return {
    server,
    connector,
    host,
    sink,
    connect: async () => {
      const socket = createConnection({ host: '127.0.0.1', port });
      openSockets.push(socket);
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('error', reject);
      });
      return socket;
    },
  };
}

describe('ProxyServer', () => {
  it('reports the address it actually bound', async () => {
    const h = await harness();
    expect(h.server.listening).toBe(true);
    expect(h.server.address?.host).toBe('127.0.0.1');
    expect(h.server.address?.port).toBeGreaterThan(0);
  });

  it('refuses to listen twice', async () => {
    const h = await harness();
    await expect(h.server.listen('127.0.0.1', 0)).rejects.toThrow(/already listening/);
  });

  it('gives each accepted client a session, and forgets it on disconnect', async () => {
    const h = await harness();
    const connected: string[] = [];
    const disconnected: string[] = [];
    h.server.onConnected((session) => connected.push(session.id));
    h.server.onDisconnected((session) => disconnected.push(session.id));

    const socket = await h.connect();
    // A session begins when the client speaks, not when the socket appears —
    // the first bytes are what rule out a Flash policy probe.
    socket.write(PeerCiphers.gameClient().encipher(teleportFrame(1, 'hello')));
    await until(() => h.server.sessionCount === 1, 'the session to be accepted');
    expect(connected).toHaveLength(1);
    expect(h.server.current()?.id).toBe(connected[0]);

    socket.destroy();
    await until(() => h.server.sessionCount === 0, 'the session to be dropped');
    expect(disconnected).toEqual(connected);
    expect(h.server.current()).toBeUndefined();
  });

  it('answers an embedded Flash policy probe without opening a session', async () => {
    const h = await harness();
    const socket = await h.connect();

    const reply = await new Promise<Buffer>((resolve, reject) => {
      const parts: Buffer[] = [];
      socket.on('data', (part: Buffer) => {
        parts.push(part);
        const whole = Buffer.concat(parts);
        if (whole.includes(0)) resolve(whole);
      });
      socket.once('error', reject);
      socket.write('<policy-file-request/>\0');
    });

    expect(reply.subarray(0, 5).toString()).toBe('<?xml');
    expect(reply.toString()).toContain('allow-access-from');
    // A probe is one connection that asks and leaves; the game itself would
    // arrive on the next one.
    await until(() => h.server.sessionCount === 0, 'no session to exist');
    expect(h.connector.transports).toHaveLength(0);
  });

  it('carries a packet from a real socket through to the server link', async () => {
    const h = await harness();
    const socket = await h.connect();
    const gameClient = PeerCiphers.gameClient();
    const gameServer = PeerCiphers.gameServer();

    socket.write(gameClient.encipher(teleportFrame(1, 'through-the-proxy')));

    await until(() => h.connector.transports.length === 1, 'the server link to open');
    await until(() => h.connector.last().sent.length === 1, 'the packet to be forwarded');

    expect(h.connector.targets).toEqual([TARGET]);
    const forwarded = decodeFrame(registry, gameServer.decipher(h.connector.last().sent[0]!));
    expect(forwarded.fields['playerName']).toBe('through-the-proxy');
  });

  it('runs plugins against the session, after state is current', async () => {
    const h = await harness();
    const seen: { name: string; sessionId: string }[] = [];
    h.host.load(
      definePlugin({
        meta: { id: 'observer', name: 'Observer', category: PluginCategory.Utility },
        setup: (ctx) =>
          ctx.packets.on('TELEPORT', (packet, session) => {
            seen.push({ name: packet.name, sessionId: session.id });
          }),
      }),
    );
    h.host.setEnabled('observer', true);

    const socket = await h.connect();
    socket.write(PeerCiphers.gameClient().encipher(teleportFrame(1, 'x')));

    await until(() => seen.length === 1, 'the plugin to see the packet');
    expect(seen[0]?.name).toBe('TELEPORT');
    expect(seen[0]?.sessionId).toBe(h.server.current()?.id);
  });

  it('lets a plugin drop a packet before it leaves', async () => {
    const h = await harness();
    h.host.load(
      definePlugin({
        meta: { id: 'blocker', name: 'Blocker', category: PluginCategory.Utility },
        setup: (ctx) => ctx.packets.on('TELEPORT', (packet) => packet.drop()),
      }),
    );
    h.host.setEnabled('blocker', true);

    const socket = await h.connect();
    socket.write(PeerCiphers.gameClient().encipher(teleportFrame(1, 'blocked')));

    await until(() => h.connector.transports.length === 1, 'the server link to open');
    // Give it every chance to be forwarded before concluding that it was not.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(h.connector.last().sent).toHaveLength(0);
  });

  it("puts what a plugin sends behind the client's next packet, not in the middle of a tick", async () => {
    // A server tick reaches the plugins before it reaches the client. A pickup
    // sent from there would go out ahead of the shot acknowledgements the
    // client is about to send for that tick — so it waits for the client, and
    // follows the client's own answer.
    const h = await harness();
    h.host.load(
      definePlugin({
        meta: { id: 'looter', name: 'Looter', category: PluginCategory.Items },
        setup: (ctx) =>
          ctx.packets.on('NEWTICK', (_packet, session) => {
            session.sendToServer('INVENTORYSWAP', {
              time: 0,
              position: { x: 0, y: 0 },
              slotObject1: { objectId: 100, slotId: 0, objectType: 2594 },
              slotObject2: { objectId: 1, slotId: 4, objectType: -1 },
            });
          }),
      }),
    );
    h.host.setEnabled('looter', true);

    const socket = await h.connect();
    const gameClient = PeerCiphers.gameClient();
    const gameServer = PeerCiphers.gameServer();
    socket.write(gameClient.encipher(teleportFrame(1, 'open')));
    await until(() => h.connector.transports.length === 1, 'the server link to open');
    await until(() => h.connector.last().sent.length === 1, 'the packet to be forwarded');

    h.connector
      .last()
      .receive(gameServer.encipher(encodePacket(registry, createPacket(registry, 'NEWTICK'))));
    // Every chance to go out early before concluding that it did not.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(h.connector.last().sent).toHaveLength(1);

    socket.write(gameClient.encipher(encodePacket(registry, createPacket(registry, 'MOVE'))));
    await until(() => h.connector.last().sent.length === 3, 'the move and the pickup');
    const names = h.connector
      .last()
      .sent.map((frame) => decodeFrame(registry, gameServer.decipher(frame)).name);
    expect(names).toEqual(['TELEPORT', 'MOVE', 'INVENTORYSWAP']);
  });

  it('closes the session when no target vouches for it', async () => {
    const h = await harness({ resolve: () => undefined });
    const socket = await h.connect();

    socket.write(PeerCiphers.gameClient().encipher(teleportFrame(1, 'x')));

    // The refusal closes the client socket, which is the observable end of the
    // session: counting sessions alone would pass before one had opened.
    await new Promise<void>((resolve, reject) => {
      socket.once('close', resolve);
      socket.once('error', reject);
    });
    expect(h.connector.transports).toHaveLength(0);
    expect(h.sink.messages().join(' ')).toMatch(/no allowed server target/);
  });

  it('closes every live session when it shuts down', async () => {
    const h = await harness();
    const socket = await h.connect();
    socket.write(PeerCiphers.gameClient().encipher(teleportFrame(1, 'hello')));
    await until(() => h.server.sessionCount === 1, 'the session to be accepted');

    await h.server.close();

    expect(h.server.sessionCount).toBe(0);
    expect(h.server.listening).toBe(false);
    expect(h.server.address).toBeUndefined();
  });
});
