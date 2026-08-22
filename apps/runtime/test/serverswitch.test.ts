import type { NativeApi, SessionApi, SessionView } from '@brownie/plugin-api';
import { createPacket, encodePacket } from '@brownie/protocol';
import { createBundledRegistry } from '@brownie/protocol/bundled';
import { describe, expect, it } from 'vitest';

import { GameId } from '../src/constants/GameId.js';
import { createServerSwitchPlugin } from '../src/features/serverswitch/serverSwitchPlugin.js';
import { findServer } from '../src/features/serverswitch/serverList.js';
import { PluginHost } from '../src/plugins/PluginHost.js';
import { testLogger } from './fakes.js';

describe('finding the server a player named', () => {
  it('takes the full name, in any case', () => {
    expect(findServer('ussouth3')).toEqual({
      kind: 'found',
      server: { name: 'USSouth3', host: '52.207.206.31' },
    });
  });

  it('takes the abbreviation, which is what anyone types', () => {
    expect(findServer('USS3')).toMatchObject({ kind: 'found', server: { name: 'USSouth3' } });
    expect(findServer('eusw')).toMatchObject({ kind: 'found', server: { name: 'EUSouthWest' } });
  });

  it('takes a prefix that only one server answers to', () => {
    expect(findServer('austral')).toMatchObject({ kind: 'found', server: { name: 'Australia' } });
  });

  it('prefers the exact name over the longer ones it is a prefix of', () => {
    expect(findServer('USWest')).toMatchObject({ kind: 'found', server: { name: 'USWest' } });
  });

  it('asks rather than choosing when a prefix fits several', () => {
    const match = findServer('usmid');
    expect(match.kind).toBe('ambiguous');
    if (match.kind !== 'ambiguous') return;
    expect(match.names).toEqual(['USMidWest', 'USMidWest2']);
  });

  it('asks when an abbreviation fits several', () => {
    // `Asia` and `Australia` both shorten to `A`.
    const match = findServer('a');
    expect(match.kind).toBe('ambiguous');
    if (match.kind !== 'ambiguous') return;
    expect(match.names).toEqual(['Asia', 'Australia']);
  });

  it('takes an address, naming it when the table knows it', () => {
    expect(findServer('54.234.226.24')).toEqual({
      kind: 'found',
      server: { name: 'USEast', host: '54.234.226.24' },
    });
  });

  it('takes an address it has never heard of, under its own name', () => {
    expect(findServer('198.51.100.7')).toEqual({
      kind: 'found',
      server: { name: '198.51.100.7', host: '198.51.100.7' },
    });
  });

  it('rejects what only looks like an address', () => {
    expect(findServer('999.1.1.1').kind).toBe('unknown');
  });

  it('rejects a name nothing answers to', () => {
    expect(findServer('mars').kind).toBe('unknown');
    expect(findServer('   ').kind).toBe('unknown');
  });
});

describe('the server commands', () => {
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

  interface Sent {
    readonly name: string;
    readonly fields: Readonly<Record<string, unknown>>;
  }

  /**
   * @param connectedTo where the session is, defaulting to the pair
   *   `SessionContext` reports before a server link exists.
   */
  function harness(connectedTo: { host: string; port: number } = { host: '', port: 0 }): {
    host: PluginHost;
    session: SessionView;
    sent: Sent[];
    said: string[];
  } {
    const sent: Sent[] = [];
    const said: string[] = [];
    const host = new PluginHost({ log: testLogger(), native: NATIVE, sessions: SESSIONS });
    host.load(createServerSwitchPlugin());
    host.setEnabled('server-switch', true);

    const session = {
      id: 's1',
      server: connectedTo,
      sendToClient: (name: string, fields: Readonly<Record<string, unknown>>) => {
        sent.push({ name, fields });
      },
      notify: (text: string) => said.push(text),
    } as unknown as SessionView;

    return { host, session, sent, said };
  }

  it('sends the client to the real address, so the connect hook can report it', () => {
    const { host, session, sent, said } = harness();
    expect(host.dispatchCommand('con', ['USS3'], session)).toBe(true);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.name).toBe('RECONNECT');
    expect(sent[0]?.fields).toEqual({
      name: 'USSouth3',
      host: '52.207.206.31',
      port: 2050,
      gameId: GameId.Nexus,
      keyTime: -1,
      key: Buffer.alloc(0),
    });
    expect(said).toEqual(['Connecting to USSouth3...']);
  });

  it('sends fields the encoder accepts', () => {
    // `SessionContext` encodes before injecting and logs a bad field rather
    // than throwing, so a name or a type that is wrong here is a command that
    // silently does nothing. Encoding what was sent is what catches that.
    const { host, session, sent } = harness();
    host.dispatchCommand('con', ['USS3'], session);

    const registry = createBundledRegistry();
    const packet = createPacket(registry, sent[0]?.name ?? '');
    Object.assign(packet.fields, sent[0]?.fields);
    expect(() => encodePacket(registry, packet)).not.toThrow();
  });

  it('lists the servers when asked for none', () => {
    const { host, session, sent, said } = harness();
    host.dispatchCommand('con', [], session);

    expect(sent).toEqual([]);
    expect(said[0]).toContain('USSouth3');
    expect(said[0]).toContain('Australia');
  });

  it('says which servers it could have meant, and moves nothing', () => {
    const { host, session, sent, said } = harness();
    host.dispatchCommand('con', ['a'], session);

    expect(sent).toEqual([]);
    expect(said).toEqual(['"a" could be Asia, Australia.']);
  });

  it('moves nothing for a name it does not know', () => {
    const { host, session, sent, said } = harness();
    host.dispatchCommand('con', ['mars'], session);

    expect(sent).toEqual([]);
    expect(said).toEqual(['No server matches "mars". Type /con for the list.']);
  });

  it('names the server this session is on', () => {
    const { host, session, said } = harness({ host: '52.207.206.31', port: 2050 });
    host.dispatchCommand('ip', [], session);

    expect(said).toEqual(['USSouth3: 52.207.206.31:2050']);
  });

  it('reports an address the table does not know, without inventing a name', () => {
    const { host, session, said } = harness({ host: '198.51.100.7', port: 2050 });
    host.dispatchCommand('ip', [], session);

    expect(said).toEqual(['198.51.100.7:2050']);
  });

  it('says so while there is no server link yet', () => {
    const { host, session, said } = harness();
    host.dispatchCommand('ip', [], session);

    expect(said).toEqual(['No game server yet.']);
  });

  it('does nothing at all while the plugin is switched off', () => {
    const { host, session, sent } = harness();
    host.setEnabled('server-switch', false);

    // False is what tells the command stage the line is not ours, so it reaches
    // the game server as typed rather than being swallowed by a plugin that is
    // not running.
    expect(host.dispatchCommand('con', ['USS3'], session)).toBe(false);
    expect(sent).toEqual([]);
  });
});
