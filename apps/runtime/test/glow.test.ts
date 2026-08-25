import type { NativeApi, SessionApi } from '@brownie/plugin-api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { normaliseGlowColour } from '../src/features/glow/glowColour.js';
import { DEFAULT_GLOW_COLOUR, createGlowPlugin } from '../src/features/glow/glowPlugin.js';
import { PluginHost } from '../src/plugins/PluginHost.js';
import type { SettingsRegistry } from '../src/plugins/SettingsRegistry.js';
import { RecordingSink, testLogger } from './fakes.js';

const FEATURE_KEY = 'player.glow';
const COLOUR_KEY = 'player.glowColour';

describe('a typed glow colour', () => {
  it('is taken as the module spells it', () => {
    expect(normaliseGlowColour('#ff0000ff')).toBe('#ff0000ff');
  });

  it('forgives the two spellings that cannot be mistaken', () => {
    expect(normaliseGlowColour('#FF00AAff')).toBe('#ff00aaff');
    expect(normaliseGlowColour('  #00ff00  ')).toBe('#00ff00ff');
  });

  it('refuses everything else rather than guessing at it', () => {
    // A short form read as a colour is the failure this exists to prevent: it
    // looks like a feature that worked, in the wrong colour.
    for (const text of ['#f00', 'red', '', '#gggggg', '#ff0000f', '#ff0000fff', 'ff0000ff']) {
      expect(normaliseGlowColour(text)).toBeUndefined();
    }
  });
});

describe('the glow plugin', () => {
  const features: [string, boolean | number | string][] = [];
  let sink = new RecordingSink();

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
      log: testLogger(sink),
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
    sink = new RecordingSink();
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

  it('keeps the last colour and says so when what was typed is not one', () => {
    const { settings } = load(true);
    vi.advanceTimersByTime(1000);
    features.length = 0;

    settings.apply('colour', '#gg0000');
    vi.advanceTimersByTime(2000);

    // The glow stays lit in whatever the module already has: a typo should not
    // put the character's glow out.
    expect(features).toEqual([
      [FEATURE_KEY, true],
      [FEATURE_KEY, true],
      [FEATURE_KEY, true],
    ]);
    // Once for the typo, not once a second for as long as it stands.
    expect(sink.messages().filter((m) => m.includes('#gg0000'))).toHaveLength(1);
  });

  it('releases the claim when it is unloaded', () => {
    const { host } = load(true);
    vi.advanceTimersByTime(1000);
    features.length = 0;

    host.unload('glow');

    expect(features).toEqual([[FEATURE_KEY, false]]);
  });
});
