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

import { holdState, rampColour } from '../src/features/noclip/holdBudget.js';
import { createNoclipPlugin, type NoclipOutput } from '../src/features/noclip/noclipPlugin.js';
import { PluginHost } from '../src/plugins/PluginHost.js';
import type { SettingsRegistry } from '../src/plugins/SettingsRegistry.js';
import { testLogger } from './fakes.js';

const registry = createBundledRegistry();

describe('the hold budget', () => {
  it('ramps from green to red across the budget', () => {
    expect(rampColour(0)).toEqual({ red: 0x20, green: 0xdc, blue: 0x00 });
    expect(rampColour(1)).toEqual({ red: 0xff, green: 0x00, blue: 0x19 });

    const half = rampColour(0.5);
    expect(half.red).toBeGreaterThan(0x20);
    expect(half.red).toBeLessThan(0xff);
    expect(half.green).toBeLessThan(0xdc);
    expect(half.green).toBeGreaterThan(0x00);
  });

  it('clamps a share outside the budget rather than refusing it', () => {
    expect(rampColour(-1)).toEqual(rampColour(0));
    expect(rampColour(5)).toEqual(rampColour(1));
    expect(rampColour(Number.NaN)).toEqual(rampColour(1));
  });

  it('counts whole seconds down, and never shows a zero that is still holding', () => {
    expect(holdState(0, 20).secondsLeft).toBe(20);
    expect(holdState(500, 20).secondsLeft).toBe(20);
    expect(holdState(1000, 20).secondsLeft).toBe(19);
    // The last second reads as one, not as nothing: a countdown sitting at zero
    // while the hold is still on reads as one that stopped working.
    expect(holdState(19_500, 20).secondsLeft).toBe(1);
    expect(holdState(19_500, 20).spent).toBe(false);
  });

  it('is spent exactly at the budget, and says so in red', () => {
    const spent = holdState(20_000, 20);
    expect(spent.spent).toBe(true);
    expect(spent.secondsLeft).toBe(0);
    expect(spent.colour).toEqual(rampColour(1));
    expect(spent.text).toContain('20s');
  });
});

describe('the noclip plugin', () => {
  const features: [string, boolean | number | string][] = [];
  const shown: string[] = [];
  let disconnect: (session: SessionView) => void = () => undefined;

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
    onDisconnected: (listener) => {
      disconnect = listener;
      return () => undefined;
    },
  };

  const holds: boolean[] = [];

  const output: NoclipOutput = {
    showText: (text) => {
      shown.push(text);
    },
    holdUplink: (held) => {
      holds.push(held);
    },
  };

  function load(): { host: PluginHost; settings: SettingsRegistry } {
    const host = new PluginHost({
      log: testLogger(),
      native,
      sessions,
      onChanged: () => undefined,
    });
    host.load(createNoclipPlugin(output));
    host.setEnabled('player-noclip', true);
    const settings = host.settingsOf('player-noclip');
    if (settings === undefined) throw new Error('the plugin declared no settings');
    return { host, settings };
  }

  const move = (): MutablePacket => {
    const packet = createPacket(registry, 'MOVE');
    packet.fields['tickId'] = 4;
    packet.fields['serverRealTimeMSofLastNewTick'] = 0;
    packet.fields['records'] = [];
    return new MutablePacket(decodeFrame(registry, encodePacket(registry, packet)));
  };

  const session = (): SessionView => ({ id: 's1' }) as unknown as SessionView;

  const lastFeature = (): boolean | number | string | undefined => features.at(-1)?.[1];

  beforeEach(() => {
    features.length = 0;
    shown.length = 0;
    holds.length = 0;
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('holds nothing while it is switched off', () => {
    const { host } = load();

    const packet = move();
    host.dispatchPacket(packet, session());

    // Never dropped, in any state. Dropping a `MOVE` leaves a gap in the tick
    // numbers the server counts, and that is what kicked us the moment noclip
    // was switched off.
    expect(packet.verdict).toBe(Verdict.Forward);
    expect(holds).toEqual([]);
    expect(features).toEqual([]);
    expect(shown).toEqual([]);
  });

  it('claims the module’s half and holds the uplink once switched on', () => {
    const { host, settings } = load();
    settings.apply('active', true);

    expect(holds).toEqual([true]);
    expect(features).toEqual([['player.noclip', true]]);
    expect(shown).toEqual(['Noclip: 20s left']);

    const packet = move();
    host.dispatchPacket(packet, session());
    expect(packet.verdict).toBe(Verdict.Forward);
  });

  it('lets the uplink go before it drops the claim', () => {
    const { settings } = load();
    settings.apply('active', true);
    holds.length = 0;
    features.length = 0;

    settings.apply('active', false);

    // Order matters: the burst the client has been queueing is its own account
    // of where it walked, and it has to reach the server while the module is
    // still saying yes to the walkability it walked through.
    expect(holds).toEqual([false]);
    expect(features).toEqual([['player.noclip', false]]);
  });

  it('counts down from the moment it was switched on, not on a clock of its own', () => {
    const { settings } = load();

    // Switched on part-way through a second. A ticker registered at setup and
    // left running would fire 100 ms later and say `20s left` a second time,
    // then 19 — and a countdown that repeats a number reads as a stuck one.
    vi.advanceTimersByTime(900);
    settings.apply('active', true);
    vi.advanceTimersByTime(2000);

    expect(shown).toEqual(['Noclip: 20s left', 'Noclip: 19s left', 'Noclip: 18s left']);
  });

  it('stops the countdown when the hold ends, and starts a fresh one after', () => {
    const { settings } = load();
    settings.apply('active', true);
    vi.advanceTimersByTime(1500);
    settings.apply('active', false);
    shown.length = 0;

    // Nothing while nothing is held: the ticker is gone, not idling.
    vi.advanceTimersByTime(5000);
    expect(shown).toEqual([]);

    // And the next hold gets the whole budget rather than the rest of the last.
    settings.apply('active', true);
    expect(shown).toEqual(['Noclip: 20s left']);
  });

  it('restates the claim on every tick, because it is a lease and not a flag', () => {
    const { settings } = load();
    settings.apply('active', true);
    features.length = 0;

    vi.advanceTimersByTime(3000);

    expect(features).toEqual([
      ['player.noclip', true],
      ['player.noclip', true],
      ['player.noclip', true],
    ]);
    expect(shown.at(-1)).toBe('Noclip: 17s left');
  });

  it('switches itself off when the budget is spent, and lets the uplink go', () => {
    const { settings } = load();
    settings.apply('active', true);

    vi.advanceTimersByTime(20_000);

    expect(settings.values()['active']).toBe(false);
    expect(lastFeature()).toBe(false);
    expect(holds.at(-1)).toBe(false);
    expect(shown.at(-1)).toBe('Noclip off: 20s hold spent');
  });

  it('honours a shorter budget', () => {
    const { settings } = load();
    settings.apply('holdSeconds', 3);
    settings.apply('active', true);
    expect(shown).toEqual(['Noclip: 3s left']);

    vi.advanceTimersByTime(3000);

    expect(settings.values()['active']).toBe(false);
    expect(lastFeature()).toBe(false);
  });

  it('lets go when the session it was holding ends', () => {
    const { settings } = load();
    settings.apply('active', true);

    disconnect(session());

    expect(settings.values()['active']).toBe(false);
    expect(lastFeature()).toBe(false);
    expect(holds.at(-1)).toBe(false);
  });

  it('holds once however many times it is asked', () => {
    const { settings } = load();
    settings.apply('active', true);
    settings.apply('active', true);
    expect(holds).toEqual([true]);

    settings.apply('active', false);
    settings.apply('active', false);
    expect(holds).toEqual([true, false]);
  });
});
