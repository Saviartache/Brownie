import {
  MutablePacket,
  type NativeApi,
  type SessionApi,
  type SessionView,
} from '@brownie/plugin-api';
import { createPacket, decodeFrame, encodePacket } from '@brownie/protocol';
import { createBundledRegistry } from '@brownie/protocol/bundled';
import { describe, expect, it } from 'vitest';

import { ConditionEffect, conditionBitLow } from '../src/constants/ConditionEffect.js';
import { StatType } from '../src/constants/StatType.js';
import { createAntiDebuffPlugin } from '../src/features/antidebuff/antiDebuffPlugin.js';
import { SCREEN_EFFECTS, maskOf } from '../src/features/antidebuff/debuffs.js';
import { PluginHost } from '../src/plugins/PluginHost.js';
import type { SettingsRegistry } from '../src/plugins/SettingsRegistry.js';
import { testLogger } from './fakes.js';

const registry = createBundledRegistry();

const BLIND = conditionBitLow(ConditionEffect.Blind);
const DARKNESS = conditionBitLow(ConditionEffect.Darkness);
const SLOWED = conditionBitLow(ConditionEffect.Slowed);

describe('the switch table', () => {
  it('names every setting once, so none can shadow another', () => {
    const keys = SCREEN_EFFECTS.map((option) => option.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('offers only effects that change what is drawn, never what a fight does', () => {
    // The line this feature has to hold: masking a bit stops the client drawing
    // it and nothing more, so anything whose absence would *change the outcome*
    // — Slowed, Stunned, Silenced — must not be on this list pretending to.
    const offered = new Set(SCREEN_EFFECTS.map((option) => option.effect));
    for (const effect of [
      ConditionEffect.Slowed,
      ConditionEffect.Stunned,
      ConditionEffect.Silenced,
      ConditionEffect.Paralyzed,
      ConditionEffect.ArmorBroken,
    ]) {
      expect(offered.has(effect)).toBe(false);
    }
  });

  it('folds a set of options into the halves their effects live in', () => {
    expect(maskOf(SCREEN_EFFECTS).low).toBe(
      SCREEN_EFFECTS.reduce((mask, option) => mask | conditionBitLow(option.effect), 0),
    );
    // Every effect it offers lives in the first stat, so nothing is silently
    // relying on a half the state layer does not carry.
    expect(maskOf(SCREEN_EFFECTS).high).toBe(0);
  });
});

describe('the anti-debuffs plugin', () => {
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

  const SELF_ID = 42;

  const fakeSession = (selfObjectId = SELF_ID): SessionView =>
    ({ id: 's1', self: { objectId: selfObjectId }, world: {} }) as unknown as SessionView;

  function loadEnabled(): { host: PluginHost; settings: SettingsRegistry } {
    const host = new PluginHost({
      log: testLogger(),
      native: NATIVE,
      sessions: SESSIONS,
      onChanged: () => undefined,
    });
    host.load(createAntiDebuffPlugin());
    host.setEnabled('anti-debuffs', true);
    const settings = host.settingsOf('anti-debuffs');
    if (settings === undefined) throw new Error('the plugin declared no settings');
    return { host, settings };
  }

  /** Every on-by-default switch off, so a test starts from nothing. */
  function silence(settings: SettingsRegistry): void {
    for (const option of SCREEN_EFFECTS) settings.apply(option.key, false);
  }

  function packetOf(name: string, fields: Record<string, unknown>): MutablePacket {
    const packet = createPacket(registry, name);
    for (const [key, value] of Object.entries(fields)) packet.fields[key] = value as never;
    return new MutablePacket(decodeFrame(registry, encodePacket(registry, packet)));
  }

  const statusOf = (objectId: number, stats: readonly Record<string, unknown>[]) => ({
    objectId,
    position: { x: 0, y: 0 },
    data: stats,
  });

  const effectsStat = (id: number, value: number): Record<string, unknown> => ({
    id,
    value,
    stackCount: 0,
  });

  const newTick = (statuses: readonly Record<string, unknown>[]): MutablePacket =>
    packetOf('NEWTICK', {
      tickId: 0,
      tickTime: 200,
      serverRealTimeMs: 0,
      serverLastRttMs: 0,
      statuses,
    });

  /** The value the packet ends up carrying for one stat of one object. */
  function statIn(statuses: unknown, objectId: number, statId: number): number | undefined {
    if (!Array.isArray(statuses)) return undefined;
    for (const entry of statuses as Record<string, unknown>[]) {
      if (entry['objectId'] !== objectId) continue;
      const data = entry['data'];
      if (!Array.isArray(data)) return undefined;
      for (const stat of data as Record<string, unknown>[]) {
        if (stat['id'] === statId && typeof stat['value'] === 'number') return stat['value'];
      }
    }
    return undefined;
  }

  it('clears the on-screen effects out of the player’s own status', () => {
    const { host } = loadEnabled();

    const packet = newTick([
      statusOf(SELF_ID, [effectsStat(StatType.Effects, BLIND | DARKNESS | SLOWED)]),
    ]);
    host.dispatchPacket(packet, fakeSession());

    expect(packet.modified).toBe(true);
    // Slowed stays: it changes what the character does, the server still
    // believes in it, and hiding it would only make the client lie to the
    // player about why they are walking slowly.
    expect(statIn(packet.get('statuses'), SELF_ID, StatType.Effects)).toBe(SLOWED);
  });

  it('leaves every other object’s status exactly as it arrived', () => {
    const { host } = loadEnabled();

    const packet = newTick([statusOf(SELF_ID + 1, [effectsStat(StatType.Effects, BLIND)])]);
    host.dispatchPacket(packet, fakeSession());

    expect(packet.modified).toBe(false);
    expect(statIn(packet.get('statuses'), SELF_ID + 1, StatType.Effects)).toBe(BLIND);
  });

  it('forwards a tick byte for byte when the bits are already clear', () => {
    const { host } = loadEnabled();

    const packet = newTick([statusOf(SELF_ID, [effectsStat(StatType.Effects, SLOWED)])]);
    host.dispatchPacket(packet, fakeSession());

    expect(packet.modified).toBe(false);
  });

  it('clears only what is switched on', () => {
    const { host, settings } = loadEnabled();
    silence(settings);
    settings.apply('ignoreBlind', true);

    const packet = newTick([statusOf(SELF_ID, [effectsStat(StatType.Effects, BLIND | DARKNESS)])]);
    host.dispatchPacket(packet, fakeSession());

    expect(statIn(packet.get('statuses'), SELF_ID, StatType.Effects)).toBe(DARKNESS);
  });

  it('does nothing at all once every switch is off', () => {
    const { host, settings } = loadEnabled();
    silence(settings);

    const packet = newTick([statusOf(SELF_ID, [effectsStat(StatType.Effects, BLIND)])]);
    host.dispatchPacket(packet, fakeSession());

    expect(packet.modified).toBe(false);
  });

  it('has no status of its own to find before CREATESUCCESS names one', () => {
    // -1 is what the state layer reports until the server names the player. It
    // is not an object id, and a tick arriving now describes somebody else.
    const { host } = loadEnabled();

    const packet = newTick([statusOf(0, [effectsStat(StatType.Effects, BLIND)])]);
    host.dispatchPacket(packet, fakeSession(-1));

    expect(packet.modified).toBe(false);
  });

  it('does clear for a player the server really did name object 0', () => {
    // The guard has to be "not yet bound", not "id is zero": 0 is a perfectly
    // ordinary object id, and an earlier version of this stopped working for
    // whoever the server handed it to.
    const { host } = loadEnabled();

    const packet = newTick([statusOf(0, [effectsStat(StatType.Effects, BLIND)])]);
    host.dispatchPacket(packet, fakeSession(0));

    expect(packet.modified).toBe(true);
    expect(statIn(packet.get('statuses'), 0, StatType.Effects)).toBe(0);
  });

  it('never touches a packet travelling toward the server', () => {
    // Everything this feature does is to the server→client stream. A hit
    // acknowledgement going the other way is not its business any more, and
    // dropping one was the half that promised what it could not deliver.
    const { host } = loadEnabled();

    const packet = packetOf('PLAYERHIT', { bulletId: 3, objectId: 7 });
    host.dispatchPacket(packet, fakeSession());

    expect(packet.verdict).toBe('forward');
    expect(packet.modified).toBe(false);
  });
});
