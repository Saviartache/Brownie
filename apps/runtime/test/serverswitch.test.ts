import {
  MutablePacket,
  type NativeApi,
  type SessionApi,
  type SessionView,
} from '@brownie/plugin-api';
import { createPacket, decodeFrame, encodePacket } from '@brownie/protocol';
import { createBundledRegistry } from '@brownie/protocol/bundled';
import { describe, expect, it } from 'vitest';

import { GameId } from '../src/constants/GameId.js';
import { createServerSwitchPlugin } from '../src/features/serverswitch/serverSwitchPlugin.js';
import { findServer } from '../src/features/serverswitch/serverList.js';
import { PluginHost } from '../src/plugins/PluginHost.js';
import { testLogger } from './fakes.js';

const registry = createBundledRegistry();

const USEAST = '54.234.226.24';
const USSOUTH3 = '52.207.206.31';

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

interface Harness {
  host: PluginHost;
  session: SessionView;
  sent: Sent[];
  said: string[];
  /** Points the session's server link at a host, as a dial would. */
  pointAt(host: string): void;
}

/**
 * @param connectedTo where the session is, defaulting to the pair
 *   `SessionContext` reports before a server link exists.
 */
function harness(connectedTo: { host: string; port: number } = { host: '', port: 0 }): Harness {
  const sent: Sent[] = [];
  const said: string[] = [];
  const host = new PluginHost({ log: testLogger(), native: NATIVE, sessions: SESSIONS });
  host.load(createServerSwitchPlugin());
  host.setEnabled('server-switch', true);

  const where = { ...connectedTo };
  const session = {
    id: 's1',
    get server() {
      return where;
    },
    sendToClient: (name: string, fields: Readonly<Record<string, unknown>>) => {
      sent.push({ name, fields });
    },
    notify: (text: string) => said.push(text),
  } as unknown as SessionView;

  return {
    host,
    session,
    sent,
    said,
    pointAt: (at: string): void => {
      where.host = at;
      where.port = 2050;
    },
  };
}

describe('the server commands', () => {
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

  it('says which server it is returning to, when one is remembered', () => {
    const { host, session, said } = harness();
    host.dispatchCommand('con', ['USS3'], session);
    said.length = 0;

    host.dispatchCommand('con', [], session);
    expect(said).toHaveLength(2);
    expect(said[1]).toBe('Returning to USSouth3 when the game connects elsewhere.');
  });
});

/** A `HELLO` as it arrives from the client, through the real codec. */
const hello = (key: Buffer = Buffer.alloc(0)): MutablePacket => {
  const packet = createPacket(registry, 'HELLO');
  packet.fields['key'] = key;
  return new MutablePacket(decodeFrame(registry, encodePacket(registry, packet)));
};

/** A `RECONNECT` as it arrives from the server, through the real codec. */
const fromServer = (fields: {
  name: string;
  host: string;
  port: number;
  gameId: number;
  keyTime: number;
  key: Buffer;
}): MutablePacket => {
  const packet = createPacket(registry, 'RECONNECT');
  Object.assign(packet.fields, fields);
  return new MutablePacket(decodeFrame(registry, encodePacket(registry, packet)));
};

const KEYLESS_TO_USEAST = {
  name: 'USEast',
  host: USEAST,
  port: 2050,
  gameId: GameId.Nexus,
  keyTime: -1,
  key: Buffer.alloc(0),
};

describe('returning to the server last chosen', () => {
  it('adopts the first server joined, and returns there after a wrong dial', () => {
    const h = harness({ host: USEAST, port: 2050 });
    h.host.dispatchPacket(hello(), h.session);
    expect(h.sent).toEqual([]);

    // The client fell back to its own configured server after a drop.
    h.pointAt(USSOUTH3);
    h.host.dispatchPacket(hello(), h.session);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.name).toBe('RECONNECT');
    expect(h.sent[0]?.fields).toMatchObject({ name: 'USEast', host: USEAST });
    expect(h.said[0]).toContain('USEast');
  });

  it('returns to the server /con chose, not the first one joined', () => {
    const h = harness({ host: USEAST, port: 2050 });
    h.host.dispatchPacket(hello(), h.session);
    h.host.dispatchCommand('con', ['USS3'], h.session);

    h.pointAt(USEAST);
    h.host.dispatchPacket(hello(), h.session);
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]?.fields).toMatchObject({ name: 'USSouth3', host: USSOUTH3 });
  });

  it('sends nothing when the dial lands on the chosen server', () => {
    const h = harness();
    h.host.dispatchCommand('con', ['USS3'], h.session);
    h.pointAt(USSOUTH3);
    h.host.dispatchPacket(hello(), h.session);

    // `/con`'s own reconnect is the only one; the landing sent no other.
    expect(h.sent).toHaveLength(1);
    expect(h.said).toEqual(['Connecting to USSouth3...']);
  });

  it('judges nothing while the session has no server link yet', () => {
    const h = harness();
    h.host.dispatchCommand('con', ['USS3'], h.session);
    h.host.dispatchPacket(hello(), h.session);

    expect(h.sent).toHaveLength(1);
  });

  it('leaves a seated connection alone, whatever server it names', () => {
    // A dungeon handed out by the game can live on another server; the seat
    // says so, and the connection is not ours to refuse.
    const h = harness();
    h.host.dispatchCommand('con', ['USS3'], h.session);
    h.pointAt(USEAST);
    h.host.dispatchPacket(hello(Buffer.from([9, 9, 9, 9])), h.session);

    expect(h.sent).toHaveLength(1);
  });
});

describe('a reconnect the server sent', () => {
  it('is rewritten in flight when it moves the character with no seat', () => {
    const h = harness();
    h.host.dispatchCommand('con', ['USS3'], h.session);
    const packet = fromServer(KEYLESS_TO_USEAST);
    h.host.dispatchPacket(packet, h.session);

    expect(packet.modified).toBe(true);
    expect(packet.fields).toEqual({
      name: 'USSouth3',
      host: USSOUTH3,
      port: 2050,
      gameId: GameId.Nexus,
      keyTime: -1,
      key: Buffer.alloc(0),
    });
    expect(h.said[1]).toContain('USEast');
    // The pipeline rebuilds a modified packet rather than forwarding its
    // bytes, so the rewrite has to survive the codec.
    expect(() => encodePacket(registry, packet.decoded)).not.toThrow();
  });

  it('passes a keyed reconnect untouched, even to another server', () => {
    const h = harness();
    h.host.dispatchCommand('con', ['USS3'], h.session);
    const packet = fromServer({
      name: 'Undead Lair',
      host: USEAST,
      port: 2050,
      gameId: 4711,
      keyTime: 1234,
      key: Buffer.from([1, 2, 3, 4]),
    });
    h.host.dispatchPacket(packet, h.session);

    expect(packet.modified).toBe(false);
    expect(h.sent).toHaveLength(1);
  });

  it('passes a keyless reconnect that already names the chosen server', () => {
    const h = harness();
    h.host.dispatchCommand('con', ['USS3'], h.session);
    const packet = fromServer({ ...KEYLESS_TO_USEAST, host: USSOUTH3, name: 'USSouth3' });
    h.host.dispatchPacket(packet, h.session);

    expect(packet.modified).toBe(false);
  });

  it('passes everything while no server has been chosen', () => {
    const h = harness();
    const packet = fromServer(KEYLESS_TO_USEAST);
    h.host.dispatchPacket(packet, h.session);

    expect(packet.modified).toBe(false);
    expect(h.sent).toEqual([]);
  });
});

describe('giving up on an unreachable chosen server', () => {
  it('stops after three returns that never landed, and settles where the game is', () => {
    const h = harness();
    h.host.dispatchCommand('con', ['USS3'], h.session);
    h.pointAt(USEAST);
    for (let i = 0; i < 3; i++) h.host.dispatchPacket(hello(), h.session);
    expect(h.sent).toHaveLength(4); // /con's own, and three returns

    h.host.dispatchPacket(hello(), h.session);
    expect(h.sent).toHaveLength(4);
    expect(h.said.some((line) => line.includes('Gave up'))).toBe(true);

    // The game's fallback host is now the chosen one, so the same dial that
    // was wrong a moment ago is where the player stays.
    h.host.dispatchPacket(hello(), h.session);
    expect(h.sent).toHaveLength(4);
  });

  it('counts again from zero once a return lands', () => {
    const h = harness();
    h.host.dispatchCommand('con', ['USS3'], h.session);
    h.pointAt(USEAST);
    h.host.dispatchPacket(hello(), h.session);
    h.pointAt(USSOUTH3);
    h.host.dispatchPacket(hello(), h.session);
    h.pointAt(USEAST);
    for (let i = 0; i < 3; i++) h.host.dispatchPacket(hello(), h.session);
    expect(h.sent).toHaveLength(5); // no give-up: only three failures in a row

    h.host.dispatchPacket(hello(), h.session);
    expect(h.sent).toHaveLength(5);
    expect(h.said.some((line) => line.includes('Gave up'))).toBe(true);
  });

  it('is rearmed by /con after giving up', () => {
    const h = harness();
    h.host.dispatchCommand('con', ['USS3'], h.session);
    h.pointAt(USEAST);
    for (let i = 0; i < 4; i++) h.host.dispatchPacket(hello(), h.session); // three returns, then give-up

    h.host.dispatchCommand('con', ['USS3'], h.session);
    h.host.dispatchPacket(hello(), h.session);
    expect(h.sent).toHaveLength(6); // /con, three returns, /con again, one more return
  });
});
