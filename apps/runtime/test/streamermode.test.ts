import {
  MutablePacket,
  type NativeApi,
  type SessionApi,
  type SessionView,
} from '@brownie/plugin-api';
import type { FieldValue } from '@brownie/protocol';
import { createPacket, decodeFrame, encodePacket } from '@brownie/protocol';
import { createBundledRegistry } from '@brownie/protocol/bundled';
import { describe, expect, it } from 'vitest';

import { StatType } from '../src/constants/StatType.js';
import { IdentityDisguise, type StatValue } from '../src/features/streamermode/IdentityDisguise.js';
import { namePattern } from '../src/features/streamermode/namePattern.js';
import { createStreamerModePlugin } from '../src/features/streamermode/streamerModePlugin.js';
import { PluginHost } from '../src/plugins/PluginHost.js';
import type { SettingsRegistry } from '../src/plugins/SettingsRegistry.js';
import { testLogger } from './fakes.js';

const registry = createBundledRegistry();
const SELF_ID = 1;
const OTHER_ID = 2;
const REAL = 'Sammy';
const REAL_GUILD = 'Real Guild';
const ALIAS = 'Streamer';

interface Identity {
  readonly name?: string;
  readonly guild?: string;
  readonly stars?: number;
}

function statusOf(objectId: number, identity: Identity = {}): Record<string, FieldValue> {
  const data: FieldValue[] = [];
  if (identity.name !== undefined) {
    data.push({ id: StatType.Name, value: identity.name, stackCount: 0 });
  }
  if (identity.guild !== undefined) {
    data.push({ id: StatType.GuildName, value: identity.guild, stackCount: 0 });
  }
  if (identity.stars !== undefined) {
    data.push({ id: StatType.Stars, value: identity.stars, stackCount: 0 });
  }
  return { objectId, position: { x: 0, y: 0 }, data };
}

function statOf(
  status: Record<string, FieldValue> | undefined,
  id: number,
): FieldValue | undefined {
  const data = status?.['data'];
  if (!Array.isArray(data)) return undefined;
  for (const entry of data) {
    if (isRecord(entry) && entry['id'] === id) return entry['value'];
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, FieldValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const wanted = (identity: Identity): ReadonlyMap<number, StatValue> => {
  const targets = new Map<number, StatValue>();
  if (identity.name !== undefined) targets.set(StatType.Name, identity.name);
  if (identity.guild !== undefined) targets.set(StatType.GuildName, identity.guild);
  if (identity.stars !== undefined) targets.set(StatType.Stars, identity.stars);
  return targets;
};

describe('the pattern that finds a name in a line of chat', () => {
  it('finds it wherever it stands, in either case', () => {
    const pattern = namePattern(REAL);
    expect(pattern).toBeDefined();
    expect('hi sammy, nice cloak'.replace(pattern as RegExp, () => ALIAS)).toBe(
      `hi ${ALIAS}, nice cloak`,
    );
  });

  it('leaves a longer name that merely contains it alone', () => {
    // Two players in one realm, and only one of them is the one being hidden.
    expect('SammySosa hit for 400'.replace(namePattern(REAL) as RegExp, () => ALIAS)).toBe(
      'SammySosa hit for 400',
    );
  });

  it('reads a name with a regular expression character in it literally', () => {
    const pattern = namePattern('A.B') as RegExp;
    expect('AxB'.replace(pattern, () => ALIAS)).toBe('AxB');
    expect('A.B died'.replace(pattern, () => ALIAS)).toBe(`${ALIAS} died`);
  });

  it('has nothing to find before the server has named the character', () => {
    expect(namePattern('')).toBeUndefined();
    expect(namePattern('   ')).toBeUndefined();
  });
});

describe('the identity this client is shown for its own character', () => {
  const DISGUISE = wanted({ name: ALIAS, guild: '', stars: 0 });

  it('replaces every stat the server sent', () => {
    const disguise = new IdentityDisguise();
    const status = statusOf(SELF_ID, { name: REAL, guild: REAL_GUILD, stars: 74 });
    expect(disguise.applyTo(status, DISGUISE, true)).toBe(true);
    expect(statOf(status, StatType.Name)).toBe(ALIAS);
    expect(statOf(status, StatType.GuildName)).toBe('');
    expect(statOf(status, StatType.Stars)).toBe(0);
  });

  it('states ones the tick did not carry, for a mode switched on mid-map', () => {
    // Nothing else will: the client keeps a stat it has been told, and the only
    // packet that carries an identity again is the one that recreates the
    // character.
    const disguise = new IdentityDisguise();
    const status = statusOf(SELF_ID);
    expect(disguise.applyTo(status, DISGUISE, false)).toBe(true);
    expect(statOf(status, StatType.Name)).toBe(ALIAS);
    expect(statOf(status, StatType.GuildName)).toBe('');
    expect(statOf(status, StatType.Stars)).toBe(0);
  });

  it('states the whole identity again on the first tick after the character is created', () => {
    // The character being created is exactly when the client seeds its own
    // player from something other than this packet, and the alias written into
    // the creating packet did not survive it: entering a world put the real
    // name back on screen. So the claim is made twice.
    const disguise = new IdentityDisguise();
    disguise.applyTo(
      statusOf(SELF_ID, { name: REAL, guild: REAL_GUILD, stars: 74 }),
      DISGUISE,
      true,
    );

    const first = statusOf(SELF_ID);
    expect(disguise.applyTo(first, DISGUISE, false)).toBe(true);
    expect(statOf(first, StatType.Name)).toBe(ALIAS);

    // Once, though — after that the client believes it and repeating it would
    // re-encode a packet several times a second to say nothing.
    const later = statusOf(SELF_ID);
    expect(disguise.applyTo(later, DISGUISE, false)).toBe(false);
    expect(statOf(later, StatType.Name)).toBeUndefined();
  });

  it('leaves a value the server already sends as the wanted one alone', () => {
    const disguise = new IdentityDisguise();
    const status = statusOf(SELF_ID, { name: ALIAS, guild: '', stars: 0 });
    expect(disguise.applyTo(status, DISGUISE, true)).toBe(false);
  });

  it('states the new one when a setting changes', () => {
    const disguise = new IdentityDisguise();
    disguise.applyTo(statusOf(SELF_ID), DISGUISE, false);
    const later = statusOf(SELF_ID);
    expect(later).toBeDefined();
    expect(disguise.applyTo(later, wanted({ name: 'Someone', guild: '', stars: 0 }), false)).toBe(
      true,
    );
    expect(statOf(later, StatType.Name)).toBe('Someone');
  });

  it('leaves a status with no stats at all alone', () => {
    const disguise = new IdentityDisguise();
    expect(disguise.applyTo({ objectId: SELF_ID }, DISGUISE, false)).toBe(false);
  });

  it('has nothing to say when nothing is wanted', () => {
    const disguise = new IdentityDisguise();
    const status = statusOf(SELF_ID, { name: REAL });
    expect(disguise.applyTo(status, new Map(), false)).toBe(false);
    expect(statOf(status, StatType.Name)).toBe(REAL);
  });
});

describe('the streamer mode plugin', () => {
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

  const session = (): SessionView =>
    ({ id: 's1', self: { objectId: SELF_ID, name: REAL } }) as unknown as SessionView;

  function loadEnabled(): { host: PluginHost; settings: SettingsRegistry } {
    const host = new PluginHost({ log: testLogger(), native: NATIVE, sessions: SESSIONS });
    host.load(createStreamerModePlugin());
    host.setEnabled('streamer-mode', true);
    const settings = host.settingsOf('streamer-mode');
    if (settings === undefined) throw new Error('the plugin declared no settings');
    return { host, settings };
  }

  function update(...entities: readonly Record<string, FieldValue>[]): MutablePacket {
    const packet = createPacket(registry, 'UPDATE');
    Object.assign(packet.fields, {
      position: { x: 0, y: 0 },
      levelType: 0,
      tiles: [],
      newObjs: entities,
      drops: [],
    });
    return new MutablePacket(decodeFrame(registry, encodePacket(registry, packet)));
  }

  function tick(...statuses: readonly Record<string, FieldValue>[]): MutablePacket {
    const packet = createPacket(registry, 'NEWTICK');
    Object.assign(packet.fields, {
      tickId: 0,
      tickTime: 200,
      serverRealTimeMs: 0,
      serverLastRttMs: 0,
      statuses,
    });
    return new MutablePacket(decodeFrame(registry, encodePacket(registry, packet)));
  }

  function chat(fields: {
    name: string;
    text: string;
    objectId?: number;
    recipient?: string;
    numStars?: number;
  }): MutablePacket {
    const packet = createPacket(registry, 'TEXT');
    Object.assign(packet.fields, {
      name: fields.name,
      objectId: fields.objectId ?? OTHER_ID,
      numStars: fields.numStars ?? 74,
      bubbleTime: 0,
      recipient: fields.recipient ?? '',
      text: fields.text,
      cleanText: fields.text,
      isSupporter: false,
      starBg: 0,
    });
    return new MutablePacket(decodeFrame(registry, encodePacket(registry, packet)));
  }

  const entity = (objectId: number, identity: Identity): Record<string, FieldValue> => ({
    objectType: 0x30e,
    status: statusOf(objectId, identity),
  });

  const SELF: Identity = { name: REAL, guild: REAL_GUILD, stars: 74 };

  function statusIn(
    packet: MutablePacket,
    field: string,
    objectId: number,
  ): Record<string, FieldValue> | undefined {
    const entries = packet.get(field);
    if (!Array.isArray(entries)) return undefined;
    for (const entry of entries) {
      if (!isRecord(entry)) continue;
      const status = field === 'newObjs' ? entry['status'] : entry;
      if (isRecord(status) && status['objectId'] === objectId) return status;
    }
    return undefined;
  }

  it('draws the character under a stand-in identity, from the moment it is created', () => {
    const { host, settings } = loadEnabled();
    settings.apply('guild', 'Nobody');
    settings.apply('stars', 3);

    const packet = update(entity(SELF_ID, SELF));
    host.dispatchPacket(packet, session());
    const status = statusIn(packet, 'newObjs', SELF_ID);
    expect(statOf(status, StatType.Name)).toBe(ALIAS);
    expect(statOf(status, StatType.GuildName)).toBe('Nobody');
    expect(statOf(status, StatType.Stars)).toBe(3);
  });

  it('states it again on the first tick of a world just entered', () => {
    // The bug this exists for: the character is created with the alias, the
    // client puts the real name back, and nothing ever said it again.
    const { host } = loadEnabled();
    host.dispatchPacket(update(entity(SELF_ID, SELF)), session());

    const packet = tick(statusOf(SELF_ID));
    host.dispatchPacket(packet, session());
    expect(statOf(statusIn(packet, 'statuses', SELF_ID), StatType.Name)).toBe(ALIAS);
  });

  it('keeps every other player as the server named them', () => {
    const { host } = loadEnabled();
    const packet = update(entity(SELF_ID, SELF), entity(OTHER_ID, { name: 'Friend', stars: 20 }));
    host.dispatchPacket(packet, session());
    const other = statusIn(packet, 'newObjs', OTHER_ID);
    expect(statOf(other, StatType.Name)).toBe('Friend');
    expect(statOf(other, StatType.Stars)).toBe(20);
  });

  it('states the identity on a tick when the mode was switched on mid-map', () => {
    const { host } = loadEnabled();
    const packet = tick(statusOf(SELF_ID));
    host.dispatchPacket(packet, session());
    expect(statOf(statusIn(packet, 'statuses', SELF_ID), StatType.Name)).toBe(ALIAS);
  });

  it('leaves a tick that says nothing about us as the bytes it arrived as', () => {
    const { host } = loadEnabled();
    host.dispatchPacket(tick(statusOf(SELF_ID)), session());
    const packet = tick(statusOf(OTHER_ID));
    host.dispatchPacket(packet, session());
    expect(packet.modified).toBe(false);
  });

  it('signs what the player says with the alias and the stand-in stars', () => {
    const { host, settings } = loadEnabled();
    settings.apply('stars', 3);
    const packet = chat({ name: REAL, objectId: SELF_ID, text: 'hello' });
    host.dispatchPacket(packet, session());
    expect(packet.string('name')).toBe(ALIAS);
    expect(packet.number('numStars')).toBe(3);
  });

  it('leaves the stars on somebody else’s line alone', () => {
    const { host } = loadEnabled();
    const packet = chat({ name: 'Friend', text: 'hello', numStars: 41 });
    host.dispatchPacket(packet, session());
    expect(packet.number('numStars')).toBe(41);
  });

  it('addresses a whisper to the player under the alias', () => {
    const { host } = loadEnabled();
    const packet = chat({ name: 'Friend', recipient: REAL, text: 'you there?' });
    host.dispatchPacket(packet, session());
    expect(packet.string('name')).toBe('Friend');
    expect(packet.string('recipient')).toBe(ALIAS);
  });

  it('hides the name where somebody else says it', () => {
    const { host } = loadEnabled();
    const packet = chat({ name: 'Friend', text: `nice cloak ${REAL}!` });
    host.dispatchPacket(packet, session());
    expect(packet.string('text')).toBe(`nice cloak ${ALIAS}!`);
    expect(packet.string('cleanText')).toBe(`nice cloak ${ALIAS}!`);
  });

  it('leaves a line that never says the name as it arrived', () => {
    const { host } = loadEnabled();
    const packet = chat({ name: 'Friend', text: 'anyone for shatters?' });
    host.dispatchPacket(packet, session());
    expect(packet.modified).toBe(false);
  });

  it('writes an alias with a replacement pattern in it literally', () => {
    // `String.replace` reads `$&` in a replacement as "what was matched", which
    // would put the real name back — the one thing this plugin must never do.
    const { host, settings } = loadEnabled();
    settings.apply('alias', '$&');
    const packet = chat({ name: 'Friend', text: `hi ${REAL}` });
    host.dispatchPacket(packet, session());
    expect(packet.string('text')).toBe('hi $&');
  });

  it('leaves the name alone without an alias, and still stands in for the rest', () => {
    const { host, settings } = loadEnabled();
    settings.apply('alias', '');
    settings.apply('guild', 'Nobody');

    const created = update(entity(SELF_ID, SELF));
    host.dispatchPacket(created, session());
    const status = statusIn(created, 'newObjs', SELF_ID);
    expect(statOf(status, StatType.Name)).toBe(REAL);
    expect(statOf(status, StatType.GuildName)).toBe('Nobody');

    const said = chat({ name: REAL, objectId: SELF_ID, text: 'hello' });
    host.dispatchPacket(said, session());
    expect(said.string('name')).toBe(REAL);
  });
});
