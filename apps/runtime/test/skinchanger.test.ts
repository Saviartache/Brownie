import {
  MutablePacket,
  type NativeApi,
  type SessionApi,
  type SessionView,
  type SettingValue,
} from '@brownie/plugin-api';
import { createPacket, decodeFrame, encodePacket } from '@brownie/protocol';
import { createBundledRegistry } from '@brownie/protocol/bundled';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { StatType } from '../src/constants/StatType.js';
import { createSkinChangerPlugin } from '../src/features/skinchanger/skinChangerPlugin.js';
import { PluginHost } from '../src/plugins/PluginHost.js';
import { PluginPreferences } from '../src/plugins/PluginPreferences.js';
import type { PluginStore } from '../src/plugins/PluginStore.js';
import { testLogger } from './fakes.js';

const registry = createBundledRegistry();
const SELF_ID = 1;
const OTHER_ID = 2;
const WIZARD = 0x30e;
const KNIGHT = 0x31e;
const MERLIN = 0x344;
const ROUND_KNIGHT = 0x347;
const BLUE = 0x01f0f8ff;
const PINSTRIPE = 0x04000000;

const SESSIONS: SessionApi = {
  current: () => undefined,
  all: () => [],
  onConnected: () => () => undefined,
  onDisconnected: () => () => undefined,
};

function packetOf(name: string, fields: Record<string, unknown>): MutablePacket {
  const packet = createPacket(registry, name);
  for (const [key, value] of Object.entries(fields)) packet.fields[key] = value as never;
  return new MutablePacket(decodeFrame(registry, encodePacket(registry, packet)));
}

function status(
  objectId: number,
  values: Partial<Record<'skin' | 'main' | 'accessory', number>> = {},
): Record<string, unknown> {
  const data: Record<string, unknown>[] = [];
  if (values.skin !== undefined)
    data.push({ id: StatType.Skin, value: values.skin, stackCount: 0 });
  if (values.main !== undefined) {
    data.push({ id: StatType.Texture1, value: values.main, stackCount: 0 });
  }
  if (values.accessory !== undefined) {
    data.push({ id: StatType.Texture2, value: values.accessory, stackCount: 0 });
  }
  return {
    objectId,
    position: { x: 0, y: 0 },
    data,
  };
}

function tick(...statuses: readonly Record<string, unknown>[]): MutablePacket {
  return packetOf('NEWTICK', {
    tickId: 0,
    tickTime: 200,
    serverRealTimeMs: 0,
    serverLastRttMs: 0,
    statuses,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function statIn(packet: MutablePacket, objectId: number, statType: number): number | undefined {
  const statuses = packet.get('statuses');
  if (!Array.isArray(statuses)) return undefined;
  const found = statuses.find((entry) => isRecord(entry) && entry['objectId'] === objectId);
  if (!isRecord(found)) return undefined;
  const stats = found['data'];
  if (!Array.isArray(stats)) return undefined;
  const stat = stats.find((entry) => isRecord(entry) && entry['id'] === statType);
  if (!isRecord(stat)) return undefined;
  return typeof stat['value'] === 'number' ? stat['value'] : undefined;
}

function session(objectType: number): SessionView {
  return { id: 's1', self: { objectId: SELF_ID, objectType } } as unknown as SessionView;
}

function load(store?: PluginStore): {
  host: PluginHost;
  options: (key: string) => readonly (readonly [string, string])[];
  value: (key: string) => SettingValue | undefined;
  set: (key: string, value: string) => void;
  nativeCalls: { key: string; value: boolean | number | string }[];
} {
  const nativeCalls: { key: string; value: boolean | number | string }[] = [];
  const native: NativeApi = {
    connected: false,
    setFeature: (key, value) => nativeCalls.push({ key, value }),
    onConnected: () => () => undefined,
  };
  const host = new PluginHost({
    log: testLogger(),
    native,
    sessions: SESSIONS,
    ...(store === undefined ? {} : { store }),
  });
  host.load(
    createSkinChangerPlugin({
      skinsForClass: (type) =>
        type === WIZARD
          ? [{ type: MERLIN, name: 'Merlin Wizard' }]
          : type === KNIGHT
            ? [{ type: ROUND_KNIGHT, name: 'Knight of the Round Knight' }]
            : [],
      mainAppearances: () => [
        { value: BLUE, name: 'Alice Blue', kind: 'color' },
        { value: PINSTRIPE, name: 'Purple Pinstripe', kind: 'effect' },
      ],
      accessoryAppearances: () => [
        { value: BLUE, name: 'Alice Blue', kind: 'color' },
        { value: PINSTRIPE, name: 'Purple Pinstripe', kind: 'effect' },
      ],
      arcaneStyles: () => ['High Violet Inferno Flipbook Style', 'Low Blue Inferno Flipbook Style'],
    }),
  );
  host.setEnabled('skin-changer', true);
  return {
    host,
    nativeCalls,
    options: (key) => {
      const descriptor = host
        .settingsOf('skin-changer')!
        .descriptors()
        .find((candidate) => candidate.key === key);
      return descriptor?.kind === 'select' ? descriptor.options : [];
    },
    value: (key) => host.settingsOf('skin-changer')!.values()[key],
    set: (key, value) => {
      host.settingsOf('skin-changer')!.apply(key, value);
    },
  };
}

describe('Skin Changer', () => {
  afterEach(() => vi.useRealTimers());

  it('uses the skin stat id handled by the current client', () => {
    expect(StatType.Skin).toBe(75);
  });

  it('shows only skins compatible with the detected class', () => {
    const { host, options } = load();

    host.dispatchPacket(tick(status(SELF_ID)), session(WIZARD));
    expect(options('skin')).toEqual([
      ['0', 'Default'],
      [String(MERLIN), 'Merlin Wizard'],
    ]);

    host.dispatchPacket(tick(status(SELF_ID)), session(KNIGHT));
    expect(options('skin')).toEqual([
      ['0', 'Default'],
      [String(ROUND_KNIGHT), 'Knight of the Round Knight'],
    ]);
  });

  it('offers cached colours and cloth effects for the correct texture layer', () => {
    const { options } = load();

    expect(options('mainAppearance')).toEqual([
      ['0', 'Default'],
      [String(BLUE), 'Color: Alice Blue'],
      [String(PINSTRIPE), 'Effect: Purple Pinstripe'],
    ]);
    expect(options('accessoryAppearance')).toEqual([
      ['0', 'Default'],
      [String(BLUE), 'Color: Alice Blue'],
      [String(PINSTRIPE), 'Effect: Purple Pinstripe'],
    ]);
  });

  it('claims the selected Arcane Style and clears it for Default or unload', () => {
    vi.useFakeTimers();
    const { host, nativeCalls, options } = load();
    const style = 'Low Blue Inferno Flipbook Style';

    expect(options('arcaneStyle')).toEqual([
      ['', 'Default'],
      ['High Violet Inferno Flipbook Style', 'High Violet Inferno Flipbook Style'],
      [style, style],
    ]);
    vi.advanceTimersByTime(1000);
    expect(nativeCalls).toEqual([]);

    host.settingsOf('skin-changer')!.apply('arcaneStyle', style);
    expect(nativeCalls).toEqual([{ key: 'player.arcaneStyle', value: style }]);

    vi.advanceTimersByTime(1000);
    expect(nativeCalls.at(-1)).toEqual({ key: 'player.arcaneStyle', value: style });

    host.settingsOf('skin-changer')!.apply('arcaneStyle', '');
    expect(nativeCalls.at(-1)).toEqual({ key: 'player.arcaneStyle', value: '' });

    host.unload('skin-changer');
    expect(nativeCalls.at(-1)).toEqual({ key: 'player.arcaneStyle', value: '' });
  });

  it('claims the selected skin through the native player setter', () => {
    vi.useFakeTimers();
    const { host, nativeCalls } = load();
    const view = session(WIZARD);
    host.dispatchPacket(tick(status(SELF_ID)), view);
    host.settingsOf('skin-changer')!.apply('skin', String(MERLIN));

    expect(nativeCalls).toEqual([{ key: 'player.skin', value: String(MERLIN) }]);

    vi.advanceTimersByTime(1000);
    expect(nativeCalls.at(-1)).toEqual({ key: 'player.skin', value: String(MERLIN) });

    host.settingsOf('skin-changer')!.apply('skin', '0');
    expect(nativeCalls.at(-1)).toEqual({ key: 'player.skin', value: '' });

    host.settingsOf('skin-changer')!.apply('skin', String(MERLIN));
    host.unload('skin-changer');
    expect(nativeCalls.at(-1)).toEqual({ key: 'player.skin', value: '' });
  });

  it('rewrites dyes only on the local player and never sends a server packet', () => {
    const { host } = load();
    const view = session(WIZARD);
    host.dispatchPacket(tick(status(SELF_ID)), view);

    host.settingsOf('skin-changer')!.apply('mainAppearance', String(PINSTRIPE));
    host.settingsOf('skin-changer')!.apply('accessoryAppearance', String(BLUE));

    const packet = tick(
      status(SELF_ID, { skin: 0, main: 0, accessory: 0 }),
      status(OTHER_ID, { skin: 0, main: 0, accessory: 0 }),
    );
    host.dispatchPacket(packet, view);

    expect(statIn(packet, SELF_ID, StatType.Skin)).toBe(0);
    expect(statIn(packet, SELF_ID, StatType.Texture1)).toBe(PINSTRIPE);
    expect(statIn(packet, SELF_ID, StatType.Texture2)).toBe(BLUE);
    expect(statIn(packet, OTHER_ID, StatType.Skin)).toBe(0);
    expect(statIn(packet, OTHER_ID, StatType.Texture1)).toBe(0);
    expect(statIn(packet, OTHER_ID, StatType.Texture2)).toBe(0);
  });

  it('remembers what was chosen for each class and restores it on the way back', () => {
    const { host, nativeCalls, value, set } = load();
    const wizardStyle = 'Low Blue Inferno Flipbook Style';
    const knightStyle = 'High Violet Inferno Flipbook Style';

    host.dispatchPacket(tick(status(SELF_ID)), session(WIZARD));
    set('skin', String(MERLIN));
    set('mainAppearance', String(PINSTRIPE));
    set('arcaneStyle', wizardStyle);

    host.dispatchPacket(tick(status(SELF_ID)), session(KNIGHT));
    expect(value('skin')).toBe('0');
    set('skin', String(ROUND_KNIGHT));
    set('mainAppearance', String(BLUE));
    set('arcaneStyle', knightStyle);

    host.dispatchPacket(tick(status(SELF_ID)), session(WIZARD));
    expect(value('skin')).toBe(String(MERLIN));
    expect(value('mainAppearance')).toBe(String(PINSTRIPE));
    expect(value('arcaneStyle')).toBe(wizardStyle);
    expect(nativeCalls.filter((call) => call.key === 'player.skin').at(-1)).toEqual({
      key: 'player.skin',
      value: String(MERLIN),
    });

    host.dispatchPacket(tick(status(SELF_ID)), session(KNIGHT));
    expect(value('skin')).toBe(String(ROUND_KNIGHT));
    expect(value('mainAppearance')).toBe(String(BLUE));
    expect(value('arcaneStyle')).toBe(knightStyle);
  });

  it('starts a class never seen before from what is on screen', () => {
    const { host, value, set } = load();

    host.dispatchPacket(tick(status(SELF_ID)), session(WIZARD));
    set('accessoryAppearance', String(BLUE));

    host.dispatchPacket(tick(status(SELF_ID)), session(KNIGHT));
    expect(value('accessoryAppearance')).toBe(String(BLUE));

    set('accessoryAppearance', String(PINSTRIPE));
    host.dispatchPacket(tick(status(SELF_ID)), session(WIZARD));
    expect(value('accessoryAppearance')).toBe(String(BLUE));
  });

  it("keeps each class's selection across a restart", () => {
    const store = new PluginPreferences();
    const first = load(store);
    first.host.dispatchPacket(tick(status(SELF_ID)), session(WIZARD));
    first.set('skin', String(MERLIN));
    first.host.dispatchPacket(tick(status(SELF_ID)), session(KNIGHT));
    first.set('skin', String(ROUND_KNIGHT));
    first.set('mainAppearance', String(BLUE));

    const second = load(store);
    second.host.dispatchPacket(tick(status(SELF_ID)), session(WIZARD));
    expect(second.value('skin')).toBe(String(MERLIN));

    second.host.dispatchPacket(tick(status(SELF_ID)), session(KNIGHT));
    expect(second.value('skin')).toBe(String(ROUND_KNIGHT));
    expect(second.value('mainAppearance')).toBe(String(BLUE));
  });

  it('restores server dyes when Default is selected', () => {
    const { host } = load();
    const view = session(WIZARD);
    host.dispatchPacket(tick(status(SELF_ID, { skin: 7, main: 11, accessory: 12 })), view);
    host.settingsOf('skin-changer')!.apply('mainAppearance', String(PINSTRIPE));
    host.settingsOf('skin-changer')!.apply('accessoryAppearance', String(BLUE));
    host.dispatchPacket(tick(status(SELF_ID)), view);

    host.settingsOf('skin-changer')!.apply('mainAppearance', '0');
    host.settingsOf('skin-changer')!.apply('accessoryAppearance', '0');
    const restored = tick(status(SELF_ID));
    host.dispatchPacket(restored, view);

    expect(statIn(restored, SELF_ID, StatType.Texture1)).toBe(11);
    expect(statIn(restored, SELF_ID, StatType.Texture2)).toBe(12);
  });
});
