import type { NativeApi, SessionApi } from '@brownie/plugin-api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_GLOW_COLOUR, createGlowPlugin } from '../src/features/glow/glowPlugin.js';
import { PluginHost } from '../src/plugins/PluginHost.js';
import type { SettingsRegistry } from '../src/plugins/SettingsRegistry.js';
import { testLogger } from './fakes.js';

const FEATURE_KEY = 'player.glow';
const COLOUR_KEY = 'player.glowColour';

describe('the glow plugin', () => {
  const features: [string, boolean | number | string][] = [];

  const native: NativeApi = {
    connected: true,
    setFeature: (key, value) => {
      features.push([key, value]);
    },
    onConnected: () => () => undefined,
  };

  const sessions: SessionApi = {
    current: () => undefined,
    all: () => [],
    onConnected: () => () => undefined,
    onDisconnected: () => () => undefined,
  };

  function load(enabled: boolean): { host: PluginHost; settings: SettingsRegistry } {
    const host = new PluginHost({
      log: testLogger(),
      native,
      sessions,
      onChanged: () => undefined,
    });
    host.load(createGlowPlugin());
    host.setEnabled('glow', enabled);
    const settings = host.settingsOf('glow');
    if (settings === undefined) throw new Error('the plugin declared no settings');
    return { host, settings };
  }

  beforeEach(() => {
    features.length = 0;
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('claims nothing while it is switched off', () => {
    load(false);

    vi.advanceTimersByTime(5000);

    expect(features).toEqual([]);
  });

  it('sends the colour before the claim, and then only the claim', () => {
    load(true);

    vi.advanceTimersByTime(1000);
    expect(features).toEqual([
      [COLOUR_KEY, DEFAULT_GLOW_COLOUR],
      [FEATURE_KEY, true],
    ]);

    // The claim expires and the colour does not, so a second later restates one
    // and not the other.
    features.length = 0;
    vi.advanceTimersByTime(1000);
    expect(features).toEqual([[FEATURE_KEY, true]]);
  });

  it('answers a change of colour without waiting for the next claim', () => {
    const { settings } = load(true);
    vi.advanceTimersByTime(1000);
    features.length = 0;

    settings.apply('colour', '#00FF00');

    expect(features).toEqual([
      [COLOUR_KEY, '#00ff00ff'],
      [FEATURE_KEY, true],
    ]);
  });

  it('keeps claiming the colour it has when a value that is not one arrives', () => {
    const { settings } = load(true);
    vi.advanceTimersByTime(1000);
    features.length = 0;

    // Refused by the setting itself, so the plugin never sees it — and the
    // glow stays lit in the colour the module already has rather than going
    // out.
    expect(settings.apply('colour', '#gg0000')).toBe(false);
    vi.advanceTimersByTime(2000);

    expect(features).toEqual([
      [FEATURE_KEY, true],
      [FEATURE_KEY, true],
    ]);
  });

  it('releases the claim when it is unloaded', () => {
    const { host } = load(true);
    vi.advanceTimersByTime(1000);
    features.length = 0;

    host.unload('glow');

    expect(features).toEqual([[FEATURE_KEY, false]]);
  });
});
