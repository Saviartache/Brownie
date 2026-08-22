import {
  MutablePacket,
  PluginCategory,
  Verdict,
  definePlugin,
  type NativeApi,
  type SessionApi,
  type SessionView,
} from '@brownie/plugin-api';
import { createBundledRegistry } from '@brownie/protocol/bundled';
import { createPacket, decodeFrame, encodePacket } from '@brownie/protocol';
import { describe, expect, it } from 'vitest';
import { CommandStage } from '../src/pipeline/stages/CommandStage.js';
import { PacketOrigin, type PacketContext } from '../src/pipeline/PacketPipeline.js';
import { PluginHost } from '../src/plugins/PluginHost.js';
import { RecordingSink, testLogger } from './fakes.js';

const registry = createBundledRegistry();

const SESSION = { id: 's1' } as unknown as SessionView;

const NATIVE: NativeApi = {
  connected: false,
  setFeature: () => undefined,
  onConnected: () => () => undefined,
};

const SESSIONS: SessionApi = {
  current: () => undefined,
  all: () => [],
  onConnected: () => () => undefined,
  onDisconnected: () => () => undefined,
};

const FROM_CLIENT: PacketContext = { origin: PacketOrigin.Client, sessionId: 's1' };
const FROM_SERVER: PacketContext = { origin: PacketOrigin.Server, sessionId: 's1' };

function chat(text: string): MutablePacket {
  const packet = createPacket(registry, 'PLAYERTEXT');
  packet.fields['text'] = text;
  return new MutablePacket(decodeFrame(registry, encodePacket(registry, packet)));
}

/** A packet that is not chat at all, to prove the stage ignores everything else. */
function teleport(): MutablePacket {
  const packet = createPacket(registry, 'TELEPORT');
  packet.fields['objectId'] = 1;
  packet.fields['playerName'] = 'someone';
  return new MutablePacket(decodeFrame(registry, encodePacket(registry, packet)));
}

function harness(): {
  stage: CommandStage;
  calls: string[][];
  host: PluginHost;
  enable(): void;
} {
  const calls: string[][] = [];
  const host = new PluginHost({
    log: testLogger(new RecordingSink()),
    native: NATIVE,
    sessions: SESSIONS,
  });
  host.load(
    definePlugin({
      meta: { id: 'p', name: 'P', category: PluginCategory.Utility, description: 'test' },
      setup: (context) => {
        context.commands.register({
          name: 'nexus',
          description: 'go to the nexus',
          run: (args) => calls.push([...args]),
        });
      },
    }),
  );

  return {
    stage: new CommandStage(host, SESSION),
    calls,
    host,
    enable: () => void host.setEnabled('p', true),
  };
}

describe('CommandStage', () => {
  it('runs a registered command and keeps the line out of the game', () => {
    const h = harness();
    h.enable();
    const packet = chat('/nexus');

    h.stage.handle(packet, FROM_CLIENT);

    expect(h.calls).toEqual([[]]);
    // Dropped, so the server never sees the player appearing to say "/nexus".
    expect(packet.verdict).toBe(Verdict.Drop);
  });

  it('passes the arguments along, split on whitespace', () => {
    const h = harness();
    h.enable();

    h.stage.handle(chat('/nexus  now   please'), FROM_CLIENT);

    expect(h.calls).toEqual([['now', 'please']]);
  });

  it('matches the name regardless of case, as the host does', () => {
    const h = harness();
    h.enable();

    h.stage.handle(chat('/NEXUS'), FROM_CLIENT);

    expect(h.calls).toEqual([[]]);
  });

  it('leaves the game its own commands', () => {
    const h = harness();
    h.enable();
    const packet = chat('/tell someone hello');

    h.stage.handle(packet, FROM_CLIENT);

    expect(h.calls).toEqual([]);
    // The game has `/tell`, `/who` and `/trade`. Swallowing every slash would
    // break all of them.
    expect(packet.verdict).toBe(Verdict.Forward);
  });

  it('leaves ordinary chat alone', () => {
    const h = harness();
    h.enable();
    const packet = chat('hello everyone');

    h.stage.handle(packet, FROM_CLIENT);

    expect(packet.verdict).toBe(Verdict.Forward);
  });

  it('does not treat a bare prefix as a command', () => {
    const h = harness();
    h.enable();
    const packet = chat('/');

    h.stage.handle(packet, FROM_CLIENT);

    expect(h.calls).toEqual([]);
    expect(packet.verdict).toBe(Verdict.Forward);
  });

  it('ignores a disabled plugin, so its command reaches the game', () => {
    const h = harness();
    const packet = chat('/nexus');

    h.stage.handle(packet, FROM_CLIENT);

    expect(h.calls).toEqual([]);
    expect(packet.verdict).toBe(Verdict.Forward);
  });

  it('ignores anything the server said, and anything that is not chat', () => {
    const h = harness();
    h.enable();

    const fromServer = chat('/nexus');
    h.stage.handle(fromServer, FROM_SERVER);

    const other = teleport();
    h.stage.handle(other, FROM_CLIENT);

    expect(h.calls).toEqual([]);
    expect(fromServer.verdict).toBe(Verdict.Forward);
    expect(other.verdict).toBe(Verdict.Forward);
  });

  it('forwards the line when the command throws, so the failure is visible', () => {
    const calls: string[] = [];
    const host = new PluginHost({
      log: testLogger(new RecordingSink()),
      native: NATIVE,
      sessions: SESSIONS,
    });
    host.load(
      definePlugin({
        meta: { id: 'bad', name: 'Bad', category: PluginCategory.Utility, description: 'test' },
        setup: (context) => {
          context.commands.register({
            name: 'boom',
            description: 'throws',
            run: () => {
              calls.push('ran');
              throw new Error('bug');
            },
          });
        },
      }),
    );
    host.setEnabled('bad', true);
    const packet = chat('/boom');

    new CommandStage(host, SESSION).handle(packet, FROM_CLIENT);

    // It ran and failed. Dropping the line as well would leave the user with
    // no feedback at all — not even the game's "unknown command".
    expect(calls).toEqual(['ran']);
    expect(packet.verdict).toBe(Verdict.Forward);
  });
});
