import {
  MutablePacket,
  Verdict,
  type NativeApi,
  type SessionApi,
  type SessionView,
} from '@brownie/plugin-api';
import { createPacket, decodeFrame, encodePacket } from '@brownie/protocol';
import { createBundledRegistry } from '@brownie/protocol/bundled';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createColliderPlugin } from '../src/features/collider/colliderPlugin.js';
import { PluginHost } from '../src/plugins/PluginHost.js';
import type { SettingsRegistry } from '../src/plugins/SettingsRegistry.js';
import { testLogger } from './fakes.js';

describe('the collider plugin', () => {
  const registry = createBundledRegistry();
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
    host.load(createColliderPlugin());
    host.setEnabled('player-collider', enabled);
    const settings = host.settingsOf('player-collider');
    if (settings === undefined) throw new Error('the plugin declared no settings');
    return { host, settings };
  }

  function areaAck(): MutablePacket {
    const packet = createPacket(registry, 'AOEACK');
    packet.fields['time'] = 100;
    packet.fields['position'] = { x: 10, y: 20 };
    return new MutablePacket(decodeFrame(registry, encodePacket(registry, packet)));
  }

  const session = { id: 's1' } as SessionView;

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

  it('withholds area-hit acknowledgements while protection is enabled', () => {
    const { host } = load(true);
    const packet = areaAck();

    host.dispatchPacket(packet, session);

    expect(packet.verdict).toBe(Verdict.Drop);
  });

  it('forwards area-hit acknowledgements when protection is disabled', () => {
    const { host, settings } = load(true);
    settings.apply('blockAreaDamage', false);
    const packet = areaAck();

    host.dispatchPacket(packet, session);

    expect(packet.verdict).toBe(Verdict.Forward);
  });

  it('forwards area-hit acknowledgements while the plugin is switched off', () => {
    const { host } = load(false);
    const packet = areaAck();

    host.dispatchPacket(packet, session);

    expect(packet.verdict).toBe(Verdict.Forward);
  });

  it('restates the claim once a second, because it is a lease', () => {
    load(true);

    vi.advanceTimersByTime(3000);

    // The number goes out ahead of the first claim and then not again: it is
    // the module's until it changes, and a key restated for nothing is a
    // message a second with no reader. The claim is not like that — it expires.
    expect(features).toEqual([
      ['player.colliderMultiplier', 0.5],
      ['player.collider', true],
      ['player.collider', true],
      ['player.collider', true],
    ]);
  });

  it('answers a slider move without waiting for the next tick', () => {
    const { settings } = load(true);

    settings.apply('multiplier', 0.2);

    expect(features).toEqual([
      ['player.colliderMultiplier', 0.2],
      ['player.collider', true],
    ]);
  });

  it('claims the whole circle when the hitbox is switched off, and signs it', () => {
    const { settings } = load(true);
    settings.apply('multiplier', 0.8);
    features.length = 0;

    settings.apply('noHitbox', true);

    // The sign once, ahead of the claim that applies it; the multiplier is
    // nought whatever the slider was left at. A cycle rather than a colour,
    // because the module walks it and a colour a frame would be a message a
    // frame.
    expect(features).toEqual([
      ['player.colliderMultiplier', 0],
      ['player.collider', true],
      ['scene.healthBarTintColour', 'rainbow'],
      ['scene.healthBarTint', true],
    ]);
  });

  it('restates the sign with the claim, and says what to paint it with once', () => {
    const { settings } = load(true);
    settings.apply('noHitbox', true);
    features.length = 0;

    vi.advanceTimersByTime(2000);

    expect(features).toEqual([
      ['player.collider', true],
      ['scene.healthBarTint', true],
      ['player.collider', true],
      ['scene.healthBarTint', true],
    ]);
  });

  it('gives the slider back and drops the sign at once when the hitbox returns', () => {
    const { settings } = load(true);
    settings.apply('noHitbox', true);
    features.length = 0;

    settings.apply('noHitbox', false);

    // The sign is said off rather than left to lapse: three seconds of a bar
    // still wearing it reads as a switch that did not work.
    expect(features).toEqual([
      ['player.colliderMultiplier', 0.5],
      ['player.collider', true],
      ['scene.healthBarTint', false],
    ]);
  });

  it('never mentions the sign while the hitbox is left alone', () => {
    const { settings } = load(true);
    settings.apply('multiplier', 0.2);
    vi.advanceTimersByTime(3000);

    expect(features.some(([key]) => key.startsWith('scene.'))).toBe(false);
  });

  it('refuses a value the slider cannot hold', () => {
    const { settings } = load(true);

    // Clamped by the declaration rather than trusted: the overlay, and config
    // written by an older build, are both untrusted directions.
    settings.apply('multiplier', 4);
    vi.advanceTimersByTime(1000);

    expect(features).toContainEqual(['player.colliderMultiplier', 1]);
    expect(features).not.toContainEqual(['player.colliderMultiplier', 4]);
  });

  it('says the same number once, however many ticks pass over it', () => {
    const { settings } = load(true);
    vi.advanceTimersByTime(1000);

    settings.apply('multiplier', 0.2);
    settings.apply('multiplier', 0.2);
    vi.advanceTimersByTime(3000);

    const numbers = features.filter(([key]) => key === 'player.colliderMultiplier');
    expect(numbers).toEqual([
      ['player.colliderMultiplier', 0.5],
      ['player.colliderMultiplier', 0.2],
    ]);
  });

  it('says nothing when a slider moves while it is switched off', () => {
    const { settings } = load(false);

    settings.apply('multiplier', 0.2);

    expect(features).toEqual([]);
  });

  it('stops restating the claim when it is switched off, and lets the lease end it', () => {
    const { host } = load(true);
    vi.advanceTimersByTime(1000);
    features.length = 0;

    host.setEnabled('player-collider', false);
    vi.advanceTimersByTime(5000);

    // Nothing at all — not even a false. Switching off is the module's lease
    // running out, which is what covers the ways a plugin stops without saying
    // so; see `Engine::AcceptFeature`.
    expect(features).toEqual([]);
  });

  it('drops the sign as well as the claim when it is unloaded wearing one', () => {
    const { host, settings } = load(true);
    settings.apply('noHitbox', true);
    features.length = 0;

    host.unload('player-collider');

    expect(features).toEqual([
      ['player.collider', false],
      ['scene.healthBarTint', false],
    ]);
  });

  it('drops the claim outright when it is unloaded', () => {
    const { host } = load(true);
    vi.advanceTimersByTime(1000);
    features.length = 0;

    host.unload('player-collider');

    expect(features).toEqual([['player.collider', false]]);

    // And the interval went with it: an unloaded plugin has no heartbeat left
    // to restate anything.
    vi.advanceTimersByTime(5000);
    expect(features).toEqual([['player.collider', false]]);
  });
});
