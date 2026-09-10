/**
 * The walk-to-cursor chord, asked of its plugin.
 *
 * **The one thing these tests exist to hold onto**: the chord answers with the
 * dodge switched off, because it is the player's own escape hatch and not a
 * part of the planner. Its switch is this plugin's and nothing else's.
 */

import type { Position, SessionApi, SessionView } from '@brownie/plugin-api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCursorWalkPlugin } from '../src/features/cursorwalk/cursorWalkPlugin.js';
import { PluginHost } from '../src/plugins/PluginHost.js';
import { testLogger } from './fakes.js';

const NATIVE = {
  connected: false,
  setFeature: () => undefined,
  onConnected: () => () => undefined,
};

/** One walk refresh — the interval the plugin restates its target on. */
const A_REFRESH_MS = 20;

describe('the cursor-walk plugin', () => {
  interface Harness {
    host: PluginHost;
    moveTo: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    /** Where the chord is pointing, or nothing while nobody is asking. */
    chord: { target: Position | undefined };
    /** Whether a session exists for the walk to be about. */
    connected: (present: boolean) => void;
    step: () => void;
  }

  function harness(): Harness {
    const moveTo = vi.fn();
    const stop = vi.fn();
    const chord: { target: Position | undefined } = { target: undefined };
    const state = { present: true };

    const session = {
      id: 's1',
      self: { walkSpeedTilesPerSecond: 6 },
      notify: () => undefined,
      world: {},
    } as unknown as SessionView;

    const sessions: SessionApi = {
      current: () => (state.present ? session : undefined),
      all: () => (state.present ? [session] : []),
      onConnected: () => () => undefined,
      onDisconnected: () => () => undefined,
    };

    const host = new PluginHost({
      log: testLogger(),
      native: NATIVE,
      sessions,
      onChanged: () => undefined,
    });
    host.load(
      createCursorWalkPlugin({
        output: { moveTo, stop },
        target: () => chord.target,
      }),
    );

    return {
      host,
      moveTo,
      stop,
      chord,
      connected: (present: boolean) => {
        state.present = present;
      },
      step: () => {
        vi.advanceTimersByTime(A_REFRESH_MS);
      },
    };
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // The whole point of the plugin: the chord needs no other feature switched
  // on, so it comes ready the first time it is ever held.
  it('is enabled the moment it is loaded', () => {
    const { host } = harness();

    expect(host.isEnabled('cursor-walk')).toBe(true);
  });

  it('walks to the place the chord names, and keeps restating it', () => {
    const h = harness();
    h.chord.target = { x: 13, y: 7 };

    h.step();
    h.step();
    h.step();

    expect(h.moveTo).toHaveBeenCalledTimes(3);
    // A little under the full stat — the server's figure is the limit it will
    // accept, not a speed to ask for.
    expect(h.moveTo).toHaveBeenLastCalledWith(13, 7, 5.52, 120);
    expect(h.stop).not.toHaveBeenCalled();
  });

  it('follows the cursor as the player moves it', () => {
    const h = harness();
    h.chord.target = { x: 13, y: 7 };
    h.step();
    h.chord.target = { x: 2, y: 3 };

    h.step();

    expect(h.moveTo).toHaveBeenLastCalledWith(2, 3, 5.52, 120);
  });

  it('stops the moment nobody is asking, and once', () => {
    const h = harness();
    h.chord.target = { x: 13, y: 7 };
    h.step();

    // The release and a reading gone stale are the same thing here: no place.
    h.chord.target = undefined;
    h.step();
    h.step();

    expect(h.stop).toHaveBeenCalledTimes(1);
    expect(h.stop).toHaveBeenCalledWith(5.52);
    expect(h.moveTo).toHaveBeenCalledTimes(1);
  });

  it('says nothing while it is switched off, and answers the moment it is on', () => {
    const h = harness();
    h.host.setEnabled('cursor-walk', false);
    h.chord.target = { x: 13, y: 7 };

    h.step();

    expect(h.moveTo).not.toHaveBeenCalled();

    h.host.setEnabled('cursor-walk', true);
    h.step();

    expect(h.moveTo).toHaveBeenLastCalledWith(13, 7, 5.52, 120);
  });

  it('walks at the speed it was told', () => {
    const h = harness();
    h.host.settingsOf('cursor-walk')!.apply('speedPercent', 50);
    h.chord.target = { x: 13, y: 7 };

    h.step();

    expect(h.moveTo).toHaveBeenLastCalledWith(13, 7, 3, 120);
  });

  it('says nothing when there is no session to walk in', () => {
    const h = harness();
    h.chord.target = { x: 13, y: 7 };
    h.connected(false);

    h.step();

    expect(h.moveTo).not.toHaveBeenCalled();
    expect(h.stop).not.toHaveBeenCalled();
  });
});
