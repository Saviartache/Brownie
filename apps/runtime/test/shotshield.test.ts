import type { NativeApi, SessionApi } from '@brownie/plugin-api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createShotShieldPlugin } from '../src/features/shotshield/shotShieldPlugin.js';
import { PluginHost } from '../src/plugins/PluginHost.js';
import type { SettingsRegistry } from '../src/plugins/SettingsRegistry.js';
import { testLogger } from './fakes.js';

describe('the projectile manipulation plugin', () => {
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
    host.load(createShotShieldPlugin());
    host.setEnabled('shot-shield', enabled);
    const settings = host.settingsOf('shot-shield');
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

  it('takes the whole hitbox off by default, and says so before it claims', () => {
    load(true);

    vi.advanceTimersByTime(1000);

    // Both values ahead of the claim: a claim the module heard first would be a
    // claim on whatever it was already holding.
    expect(features).toEqual([
      ['shots.shieldMultiplier', 0],
      ['shots.shieldMode', 'shrink'],
      ['shots.shield', true],
    ]);
  });

  it('restates the claim once a second, and the values not at all', () => {
    load(true);

    vi.advanceTimersByTime(3000);

    expect(features).toEqual([
      ['shots.shieldMultiplier', 0],
      ['shots.shieldMode', 'shrink'],
      ['shots.shield', true],
      ['shots.shield', true],
      ['shots.shield', true],
    ]);
  });

  it('answers a mode change without waiting for the next tick', () => {
    const { settings } = load(true);
    vi.advanceTimersByTime(1000);
    features.length = 0;

    settings.apply('mode', 'disarm');

    expect(features).toEqual([
      ['shots.shieldMode', 'disarm'],
      ['shots.shield', true],
    ]);
  });

  it('answers a slider move without waiting for the next tick', () => {
    const { settings } = load(true);
    vi.advanceTimersByTime(1000);
    features.length = 0;

    settings.apply('multiplier', 0.35);

    expect(features).toEqual([
      ['shots.shieldMultiplier', 0.35],
      ['shots.shield', true],
    ]);
  });

  it('says the same value once, however many ticks pass over it', () => {
    const { settings } = load(true);
    vi.advanceTimersByTime(1000);

    settings.apply('multiplier', 0.2);
    settings.apply('multiplier', 0.2);
    vi.advanceTimersByTime(3000);

    expect(features.filter(([key]) => key === 'shots.shieldMultiplier')).toEqual([
      ['shots.shieldMultiplier', 0],
      ['shots.shieldMultiplier', 0.2],
    ]);
    expect(features.filter(([key]) => key === 'shots.shieldMode')).toEqual([
      ['shots.shieldMode', 'shrink'],
    ]);
  });

  it('refuses a mode the declaration does not have', () => {
    const { settings } = load(true);
    vi.advanceTimersByTime(1000);
    features.length = 0;

    // The overlay, and config written by an older build, are both untrusted
    // directions: a mode that is not one of the three falls back to the
    // default rather than travelling on to the module.
    settings.apply('mode', 'invulnerable');
    vi.advanceTimersByTime(1000);

    expect(features).not.toContainEqual(['shots.shieldMode', 'invulnerable']);
  });

  it('refuses a multiplier the slider cannot hold', () => {
    const { settings } = load(true);

    settings.apply('multiplier', 4);
    vi.advanceTimersByTime(1000);

    expect(features).toContainEqual(['shots.shieldMultiplier', 1]);
    expect(features).not.toContainEqual(['shots.shieldMultiplier', 4]);
  });

  it('says nothing when a setting changes while it is switched off', () => {
    const { settings } = load(false);

    settings.apply('mode', 'redirect');
    settings.apply('multiplier', 0.5);

    expect(features).toEqual([]);
  });

  it('stops restating the claim when it is switched off, and lets the lease end it', () => {
    const { host } = load(true);
    vi.advanceTimersByTime(1000);
    features.length = 0;

    host.setEnabled('shot-shield', false);
    vi.advanceTimersByTime(5000);

    // Nothing at all — not even a false. Switching off is the module's lease
    // running out, which is what covers the ways a plugin stops without saying
    // so; see `Engine::AcceptFeature`.
    expect(features).toEqual([]);
  });

  it('drops the claim outright when it is unloaded', () => {
    const { host } = load(true);
    vi.advanceTimersByTime(1000);
    features.length = 0;

    host.unload('shot-shield');

    expect(features).toEqual([['shots.shield', false]]);

    // And the interval went with it: an unloaded plugin has no heartbeat left
    // to restate anything.
    vi.advanceTimersByTime(5000);
    expect(features).toEqual([['shots.shield', false]]);
  });

  it('never claims the redirect unless it is chosen', () => {
    const { settings } = load(true);
    settings.apply('multiplier', 0.4);
    vi.advanceTimersByTime(3000);

    expect(features.some(([, value]) => value === 'redirect')).toBe(false);
  });
});
