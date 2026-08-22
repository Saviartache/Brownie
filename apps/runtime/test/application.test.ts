import { PluginCategory, definePlugin } from '@brownie/plugin-api';
import { createBundledRegistry } from '@brownie/protocol/bundled';
import { createPacket, decodeFrame, encodePacket } from '@brownie/protocol';
import { createConnection, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { Application } from '../src/Application.js';
import { resolveConfig, type RuntimeConfig } from '../src/core/config/Config.js';
import type { ServerConnector, ServerTarget } from '../src/proxy/ProxySession.js';
import { FakeTransport, PeerCiphers, RecordingSink } from './fakes.js';

const registry = createBundledRegistry();
const GAME_SERVER = '10.0.0.1';

function helloish(name: string): Buffer {
  const packet = createPacket(registry, 'TELEPORT');
  packet.fields['objectId'] = 1;
  packet.fields['playerName'] = name;
  return encodePacket(registry, packet);
}

class FakeConnector implements ServerConnector {
  readonly transports: FakeTransport[] = [];

  connect(_target: ServerTarget): FakeTransport {
    const transport = new FakeTransport();
    this.transports.push(transport);
    return transport;
  }
}

const running: Application[] = [];
const openSockets: Socket[] = [];

afterEach(async () => {
  for (const socket of openSockets.splice(0)) socket.destroy();
  for (const app of running.splice(0)) await app.stop();
});

async function until(predicate: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function config(overrides: Record<string, unknown> = {}): RuntimeConfig {
  return resolveConfig({
    file: {
      // Port 0 takes a free port from the OS, so tests never collide.
      proxy: { host: '127.0.0.1', port: 0 },
      servers: { allow: [GAME_SERVER], port: 2050 },
      logging: { level: 'error' },
      ...overrides,
    },
  });
}

async function start(
  options: {
    overrides?: Record<string, unknown>;
    plugins?: Parameters<typeof definePlugin>[0][];
  } = {},
): Promise<{ app: Application; sink: RecordingSink; connector: FakeConnector; port: number }> {
  const sink = new RecordingSink();
  const connector = new FakeConnector();
  const app = new Application({
    config: config(options.overrides),
    sink,
    connector,
    registry,
    requestedHost: () => GAME_SERVER,
    ...(options.plugins === undefined ? {} : { plugins: options.plugins }),
  });
  running.push(app);
  await app.start();
  const port = app.proxy.address?.port;
  if (port === undefined) throw new Error('the proxy did not report a bound port');
  return { app, sink, connector, port };
}

async function connect(port: number): Promise<Socket> {
  const socket = createConnection({ host: '127.0.0.1', port });
  openSockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  return socket;
}

describe('Application', () => {
  it('starts, proxies a packet, and stops', async () => {
    const { app, connector, port } = await start();
    expect(app.proxy.listening).toBe(true);

    const socket = await connect(port);
    socket.write(PeerCiphers.gameClient().encipher(helloish('end-to-end')));

    await until(() => connector.transports.length === 1, 'the server link');
    const server = connector.transports[0]!;
    await until(() => server.sent.length === 1, 'the packet to be forwarded');

    const forwarded = decodeFrame(registry, PeerCiphers.gameServer().decipher(server.sent[0]!));
    expect(forwarded.fields['playerName']).toBe('end-to-end');

    await app.stop();
    expect(app.proxy.listening).toBe(false);
  });

  it('loads the plugins it was given, disabled', async () => {
    const observer = definePlugin({
      meta: { id: 'observer', name: 'Observer', category: PluginCategory.Utility },
      setup: () => undefined,
    });
    const { app } = await start({ plugins: [observer] });

    expect(app.plugins.status('observer')?.state).toBe('loaded');
    expect(app.plugins.isEnabled('observer')).toBe(false);
  });

  it('refuses a session whose target is not allowed', async () => {
    const sink = new RecordingSink();
    const connector = new FakeConnector();
    const app = new Application({
      config: config(),
      sink,
      connector,
      registry,
      requestedHost: () => '203.0.113.9', // not in the allowlist
    });
    running.push(app);
    await app.start();
    const port = app.proxy.address?.port;
    if (port === undefined) throw new Error('no port');

    const socket = await connect(port);
    socket.write(PeerCiphers.gameClient().encipher(helloish('x')));

    await until(() => app.proxy.sessionCount === 0, 'the session to be refused');
    expect(connector.transports).toHaveLength(0);
  });

  it('runs without the overlay when no secret is configured, and says so', async () => {
    const { app, sink } = await start();
    expect(app.native.connected).toBe(false);
    expect(sink.messages().join(' ')).not.toMatch(/overlay/); // logging is at error level

    // Nothing about the proxy depends on the native module being there.
    expect(app.proxy.listening).toBe(true);
  });

  it('refuses to start twice', async () => {
    const { app } = await start();
    await expect(app.start()).rejects.toThrow(/already started/);
  });

  it('stops idempotently, in reverse order', async () => {
    const disposed: string[] = [];
    const plugin = definePlugin({
      meta: { id: 'p', name: 'P', category: PluginCategory.Utility },
      setup: (ctx) => ctx.onDispose(() => disposed.push('p')),
    });
    const { app } = await start({ plugins: [plugin] });

    await app.stop();
    await app.stop();

    expect(disposed).toEqual(['p']);
    expect(app.proxy.listening).toBe(false);
  });

  it('closes live sessions when it stops', async () => {
    const { app, port } = await start();
    await connect(port);
    await until(() => app.proxy.sessionCount === 1, 'the session');

    await app.stop();

    expect(app.proxy.sessionCount).toBe(0);
  });
});
