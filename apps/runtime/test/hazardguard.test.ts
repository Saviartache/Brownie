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

import { createHazardGuardPlugin } from '../src/features/hazardguard/hazardGuardPlugin.js';
import {
  MAX_HOLD_SECONDS,
  countdownFor,
  windowFor,
} from '../src/features/hazardguard/lavaWindow.js';
import { PluginHost } from '../src/plugins/PluginHost.js';
import type { SettingsRegistry } from '../src/plugins/SettingsRegistry.js';
import { testLogger } from './fakes.js';

const HOLD_MS = 3000;
const REARM_MS = 1500;

describe('how long a refusal may last', () => {
  it('opens a window on the first admission there is', () => {
    const state = windowFor(1000, undefined, undefined, HOLD_MS, REARM_MS);

    expect(state.opened).toBe(true);
    expect(state.withhold).toBe(true);
    expect(state.openedAtMs).toBe(1000);
  });

  it('keeps withholding while the window is live', () => {
    const state = windowFor(3000, 2500, 1000, HOLD_MS, REARM_MS);

    expect(state.withhold).toBe(true);
    expect(state.opened).toBe(false);
    expect(state.openedAtMs).toBe(1000);
  });

  it('lets one admission through once the window has run out', () => {
    // **The rule that keeps the session.** Ten seconds of silence while stood
    // in damaging ground and the server drops the connection.
    const state = windowFor(4200, 3800, 1000, HOLD_MS, REARM_MS);

    expect(state.withhold).toBe(false);
  });

  it('recharges from the admission it let through', () => {
    const spent = windowFor(4200, 3800, 1000, HOLD_MS, REARM_MS);

    expect(spent.opened).toBe(true);
    expect(spent.openedAtMs).toBe(4200);
    // The very next one is inside the new window, without the character moving.
    expect(windowFor(4700, 4200, spent.openedAtMs, HOLD_MS, REARM_MS).withhold).toBe(true);
  });

  it('settles into one admission per hold while the character stands there', () => {
    // The cycle that keeps the connection *and* most of the health: the server
    // hears from us once per window, which at any hold this allows is far
    // inside the ten seconds it waits.
    let openedAtMs: number | undefined;
    let last: number | undefined;
    let through = 0;

    // Ninety seconds of standing in lava, reporting twice a second.
    for (let at = 0; at < 90_000; at += 500) {
      const state = windowFor(at, last, openedAtMs, HOLD_MS, REARM_MS);
      openedAtMs = state.openedAtMs;
      last = at;
      if (!state.withhold) through += 1;
    }

    // One per three-second window, give or take the first.
    expect(through).toBeGreaterThan(25);
    expect(through).toBeLessThan(35);
  });

  it('never leaves the server unheard for longer than the hold', () => {
    let openedAtMs: number | undefined;
    let last: number | undefined;
    let lastHeardAt = 0;
    let worstSilenceMs = 0;

    for (let at = 0; at < 90_000; at += 500) {
      const state = windowFor(at, last, openedAtMs, HOLD_MS, REARM_MS);
      openedAtMs = state.openedAtMs;
      last = at;
      if (state.withhold) {
        worstSilenceMs = Math.max(worstSilenceMs, at - lastHeardAt);
      } else {
        lastHeardAt = at;
      }
    }

    // Well under the ten seconds the server waits, by construction.
    expect(worstSilenceMs).toBeLessThan(HOLD_MS + 1000);
  });

  it('opens a new window when the character walks out and back', () => {
    // Nothing on the wire says "you left" — the gap is what says it.
    const state = windowFor(20_000, 18_000, undefined, HOLD_MS, REARM_MS);

    expect(state.opened).toBe(true);
    expect(state.withhold).toBe(true);
    expect(state.openedAtMs).toBe(20_000);
  });

  it('does not treat a gap inside the stream as walking out', () => {
    // Damaging ground reports about twice a second. A stutter shorter than the
    // re-arm gap must not restart the cycle while the character never moved,
    // which is the one way this could outstay the server's patience.
    const inside = windowFor(2400, 1800, 1000, HOLD_MS, REARM_MS);

    expect(inside.openedAtMs).toBe(1000);
    expect(inside.opened).toBe(false);
    expect(inside.withhold).toBe(true);
  });

  it('never lets a window outlast what the server tolerates', () => {
    // The ceiling is a fact about the server, not a preference, so it is
    // pinned here rather than left to a slider's maximum.
    expect(MAX_HOLD_SECONDS).toBeLessThan(10);
  });
});

describe('the countdown over the character', () => {
  it('rounds up, so the last second reads as one rather than zero', () => {
    expect(countdownFor(2500, 3).secondsLeft).toBe(1);
    expect(countdownFor(2500, 3).spent).toBe(false);
  });

  it('says the window is spent once it has run out', () => {
    const line = countdownFor(3000, 3);

    expect(line.spent).toBe(true);
    expect(line.secondsLeft).toBe(0);
  });

  it('uses no hyphen, because the game draws one as a star', () => {
    expect(countdownFor(0, 3).text).not.toContain('-');
    expect(countdownFor(3000, 3).text).not.toContain('-');
  });
});

describe('the hazard guard plugin', () => {
  const registry = createBundledRegistry();
  const shown: string[] = [];

  const native: NativeApi = {
    connected: false,
    setFeature: () => undefined,
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
    host.load(
      createHazardGuardPlugin({
        showText: (text) => {
          shown.push(text);
        },
      }),
    );
    host.setEnabled('hazard-guard', enabled);
    const settings = host.settingsOf('hazard-guard');
    if (settings === undefined) throw new Error('the plugin declared no settings');
    return { host, settings };
  }

  function groundDamage(): MutablePacket {
    const packet = createPacket(registry, 'GROUNDDAMAGE');
    packet.fields['time'] = 1000;
    packet.fields['position'] = { x: 4, y: 9 };
    return new MutablePacket(decodeFrame(registry, encodePacket(registry, packet)));
  }

  function playerHit(): MutablePacket {
    const packet = createPacket(registry, 'PLAYERHIT');
    packet.fields['bulletId'] = 3;
    packet.fields['objectId'] = 12;
    return new MutablePacket(decodeFrame(registry, encodePacket(registry, packet)));
  }

  const session = { id: 's1' } as SessionView;

  beforeEach(() => {
    shown.length = 0;
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('withholds the admission when the character walks in', () => {
    const { host } = load(true);
    const packet = groundDamage();

    host.dispatchPacket(packet, session);

    expect(packet.verdict).toBe(Verdict.Drop);
  });

  it('shows the countdown over the character while it is withholding', () => {
    const { host } = load(true);

    host.dispatchPacket(groundDamage(), session);

    expect(shown[0]).toContain('3s left');
  });

  it('counts down a second at a time', () => {
    const { host } = load(true);
    host.dispatchPacket(groundDamage(), session);

    vi.advanceTimersByTime(1000);

    expect(shown.at(-1)).toContain('2s left');
  });

  it('takes one tick per window while the character stands in it', () => {
    const { host } = load(true);
    const verdicts: Verdict[] = [];

    // Twelve seconds of standing in lava, reporting twice a second.
    for (let step = 0; step < 24; step++) {
      const packet = groundDamage();
      host.dispatchPacket(packet, session);
      verdicts.push(packet.verdict);
      vi.advanceTimersByTime(500);
    }

    const through = verdicts.filter((verdict) => verdict === Verdict.Forward).length;
    // One per three-second window rather than all twenty-four — and never none,
    // which is what would end the session.
    expect(through).toBeGreaterThan(2);
    expect(through).toBeLessThan(6);
  });

  it('recharges without the character moving, and restarts the countdown when it does', () => {
    const { host } = load(true);

    // Twelve seconds of standing in it, well past several windows.
    for (let step = 0; step < 24; step++) {
      host.dispatchPacket(groundDamage(), session);
      vi.advanceTimersByTime(500);
    }

    // A countdown that started from the top more than once is a window that
    // recharged — the character never moved.
    const restarts = shown.filter((line) => line.includes('3s left')).length;
    expect(restarts).toBeGreaterThan(1);
  });

  it('gives a whole window when the character walks out and back', () => {
    const { host } = load(true);
    host.dispatchPacket(groundDamage(), session);
    vi.advanceTimersByTime(500);
    host.dispatchPacket(groundDamage(), session);

    // Out for long enough to count as having left, then back in.
    vi.advanceTimersByTime(5000);
    const again = groundDamage();
    host.dispatchPacket(again, session);

    expect(again.verdict).toBe(Verdict.Drop);
    expect(shown.at(-1)).toContain('3s left');
  });

  it('forwards it while the plugin is switched off', () => {
    const { host } = load(false);
    const packet = groundDamage();

    host.dispatchPacket(packet, session);

    expect(packet.verdict).toBe(Verdict.Forward);
  });

  it('leaves the shot acknowledgement alone', () => {
    // Deliberately not offered: withholding `PLAYERHIT` does not stop the
    // damage in this build, because the server simulates its own bullets. A
    // switch that claimed otherwise would be one that lies, so this plugin
    // must not touch the packet even by accident.
    const { host } = load(true);
    const packet = playerHit();

    host.dispatchPacket(packet, session);

    expect(packet.verdict).toBe(Verdict.Forward);
  });
});
