import {
  MutablePacket,
  type NativeApi,
  type SessionApi,
  type SessionView,
} from '@brownie/plugin-api';
import { createPacket, decodeFrame, encodePacket } from '@brownie/protocol';
import { createBundledRegistry } from '@brownie/protocol/bundled';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_GLOW_STAT,
  DEFAULT_SUPPORTER_STAT,
  GlowMode,
  LEAVE_ALONE,
  resolveGlowTargets,
  type GlowSettings,
} from '../src/features/glow/glowModes.js';
import { createGlowPlugin } from '../src/features/glow/glowPlugin.js';
import { PluginHost } from '../src/plugins/PluginHost.js';
import type { SettingsRegistry } from '../src/plugins/SettingsRegistry.js';
import { testLogger } from './fakes.js';

const registry = createBundledRegistry();

const DEFAULTS: GlowSettings = {
  mode: GlowMode.Off,
  glowStatId: DEFAULT_GLOW_STAT,
  supporterStatId: DEFAULT_SUPPORTER_STAT,
  customGlow: LEAVE_ALONE,
  customSupporter: LEAVE_ALONE,
};

describe('the resolved glow targets', () => {
  it('write nothing at all while the mode is off', () => {
    expect(resolveGlowTargets(DEFAULTS).size).toBe(0);
  });

  it('drive one stat per preset, and leave the other alone', () => {
    const red = resolveGlowTargets({ ...DEFAULTS, mode: GlowMode.Red });
    expect([...red]).toEqual([[DEFAULT_GLOW_STAT, 100]]);

    const purple = resolveGlowTargets({ ...DEFAULTS, mode: GlowMode.Purple });
    expect([...purple]).toEqual([[DEFAULT_SUPPORTER_STAT, 1]]);
  });

  it('take a custom value for each stat, and -1 as "leave it alone"', () => {
    const supporterOnly = resolveGlowTargets({
      ...DEFAULTS,
      mode: GlowMode.Custom,
      customSupporter: 3,
    });
    expect([...supporterOnly]).toEqual([[DEFAULT_SUPPORTER_STAT, 3]]);

    const both = resolveGlowTargets({
      ...DEFAULTS,
      mode: GlowMode.Custom,
      customGlow: 7,
      customSupporter: 2,
    });
    expect([...both]).toEqual([
      [DEFAULT_GLOW_STAT, 7],
      [DEFAULT_SUPPORTER_STAT, 2],
    ]);

    expect(resolveGlowTargets({ ...DEFAULTS, mode: GlowMode.Custom }).size).toBe(0);
  });

  it('follow a retargeted stat id', () => {
    const targets = resolveGlowTargets({
      ...DEFAULTS,
      mode: GlowMode.Purple,
      supporterStatId: 102,
    });
    expect([...targets]).toEqual([[102, 1]]);
  });

  it('ignore a stat id no status could carry', () => {
    // Reachable from config written by an older build, and an id nothing
    // matches would inject a stat the encoder cannot write.
    const targets = resolveGlowTargets({ ...DEFAULTS, mode: GlowMode.Red, glowStatId: -5 });
    expect(targets.size).toBe(0);
  });
});

describe('the glow plugin', () => {
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

  const SELF_ID = 1;
  const OTHER_ID = 500;
  const PLAYER_TYPE = 782;

  function loadEnabled(): { host: PluginHost; settings: SettingsRegistry } {
    const host = new PluginHost({
      log: testLogger(),
      native: NATIVE,
      sessions: SESSIONS,
      onChanged: () => undefined,
    });
    host.load(createGlowPlugin());
    host.setEnabled('glow', true);
    const settings = host.settingsOf('glow');
    if (settings === undefined) throw new Error('the plugin declared no settings');
    return { host, settings };
  }

  const session = (objectId = SELF_ID): SessionView =>
    ({ id: 's1', self: { objectId } }) as unknown as SessionView;

  function packetOf(name: string, fields: Record<string, unknown>): MutablePacket {
    const packet = createPacket(registry, name);
    for (const [key, value] of Object.entries(fields)) packet.fields[key] = value as never;
    return new MutablePacket(decodeFrame(registry, encodePacket(registry, packet)));
  }

  const statusOf = (
    objectId: number,
    stats: readonly Record<string, unknown>[] = [],
  ): Record<string, unknown> => ({
    objectId,
    position: { x: 0, y: 0 },
    data: stats,
  });

  const stat = (id: number, value: number | string): Record<string, unknown> => ({
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

  const update = (statuses: readonly Record<string, unknown>[]): MutablePacket =>
    packetOf('UPDATE', {
      position: { x: 0, y: 0 },
      levelType: 0,
      tiles: [],
      newObjs: statuses.map((status) => ({ objectType: PLAYER_TYPE, status })),
      drops: [],
    });

  /** The value one status ends up carrying for a stat, if any. */
  function statIn(entries: unknown, objectId: number, statId: number): number | string | undefined {
    if (!Array.isArray(entries)) return undefined;
    for (const entry of entries as Record<string, unknown>[]) {
      const status = (entry['status'] ?? entry) as Record<string, unknown>;
      if (status['objectId'] !== objectId) continue;
      const data = status['data'];
      if (!Array.isArray(data)) return undefined;
      for (const found of data as Record<string, unknown>[]) {
        const value = found['value'];
        if (found['id'] === statId && (typeof value === 'number' || typeof value === 'string')) {
          return value;
        }
      }
    }
    return undefined;
  }

  it('forwards a tick byte for byte while the mode is off', () => {
    const { host, settings } = loadEnabled();
    settings.apply('mode', GlowMode.Off);

    const packet = newTick([statusOf(SELF_ID)]);
    host.dispatchPacket(packet, session());

    expect(packet.modified).toBe(false);
    expect(packet.verdict).toBe('forward');
  });

  it('injects the glow stat the server never sent, on your record only', () => {
    const { host } = loadEnabled();

    const packet = update([statusOf(SELF_ID), statusOf(OTHER_ID)]);
    host.dispatchPacket(packet, session());

    expect(packet.modified).toBe(true);
    expect(statIn(packet.get('newObjs'), SELF_ID, DEFAULT_GLOW_STAT)).toBe(100);
    expect(statIn(packet.get('newObjs'), OTHER_ID, DEFAULT_GLOW_STAT)).toBeUndefined();
  });

  it('rewrites a value the server did send, and then says nothing more', () => {
    const { host } = loadEnabled();
    const view = session();

    const sent = newTick([statusOf(SELF_ID, [stat(DEFAULT_GLOW_STAT, 0)])]);
    host.dispatchPacket(sent, view);
    expect(statIn(sent.get('statuses'), SELF_ID, DEFAULT_GLOW_STAT)).toBe(100);

    // The client keeps a stat it has been told, so repeating it every tick
    // would re-encode every packet to say what it already believes.
    const later = newTick([statusOf(SELF_ID)]);
    host.dispatchPacket(later, view);
    expect(later.modified).toBe(false);
  });

  it('puts back exactly what the server last sent when the glow goes off', () => {
    const { host, settings } = loadEnabled();
    const view = session();

    host.dispatchPacket(newTick([statusOf(SELF_ID, [stat(DEFAULT_GLOW_STAT, 6)])]), view);

    settings.apply('mode', GlowMode.Off);
    const packet = newTick([statusOf(SELF_ID)]);
    host.dispatchPacket(packet, view);

    expect(packet.modified).toBe(true);
    expect(statIn(packet.get('statuses'), SELF_ID, DEFAULT_GLOW_STAT)).toBe(6);
  });

  it('restores an override left behind by a retargeted stat id', () => {
    const { host, settings } = loadEnabled();
    const view = session();

    host.dispatchPacket(newTick([statusOf(SELF_ID, [stat(DEFAULT_GLOW_STAT, 4)])]), view);

    settings.apply('glowStatId', 60);
    const packet = newTick([statusOf(SELF_ID)]);
    host.dispatchPacket(packet, view);

    expect(statIn(packet.get('statuses'), SELF_ID, DEFAULT_GLOW_STAT)).toBe(4);
    expect(statIn(packet.get('statuses'), SELF_ID, 60)).toBe(100);
  });

  it('restores a stat the server never sent to the client’s own default', () => {
    const { host, settings } = loadEnabled();
    const view = session();

    host.dispatchPacket(newTick([statusOf(SELF_ID)]), view);

    settings.apply('mode', GlowMode.Off);
    const packet = newTick([statusOf(SELF_ID)]);
    host.dispatchPacket(packet, view);

    expect(statIn(packet.get('statuses'), SELF_ID, DEFAULT_GLOW_STAT)).toBe(0);
  });

  it('injects again once the client rebuilds the character', () => {
    const { host } = loadEnabled();
    const view = session();

    host.dispatchPacket(newTick([statusOf(SELF_ID)]), view);

    // A map change: the old object is gone, and with it everything the client
    // was told about it.
    const announced = update([statusOf(SELF_ID)]);
    host.dispatchPacket(announced, view);

    expect(statIn(announced.get('newObjs'), SELF_ID, DEFAULT_GLOW_STAT)).toBe(100);
  });

  it('leaves a stat the server sends as text alone', () => {
    const { host, settings } = loadEnabled();
    // Only reachable by retargeting by hand — and a number written there would
    // reach the client as an empty name.
    settings.apply('glowStatId', 31);

    const packet = newTick([statusOf(SELF_ID, [stat(31, 'Somebody')])]);
    host.dispatchPacket(packet, session());

    expect(packet.modified).toBe(false);
    expect(statIn(packet.get('statuses'), SELF_ID, 31)).toBe('Somebody');
  });

  it('does nothing until the player has been named', () => {
    const { host } = loadEnabled();

    // Negative until `CREATESUCCESS`, and not a value any status carries.
    const packet = newTick([statusOf(SELF_ID)]);
    host.dispatchPacket(packet, session(-1));

    expect(packet.modified).toBe(false);
  });
});
