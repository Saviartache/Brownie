import { buildRecord, parseRecord, recordKind } from '@brownie/ipc';
import {
  PluginCategory,
  definePlugin,
  type NativeApi,
  type Plugin,
  type PluginContext,
  type PluginMeta,
  type SessionApi,
  type Unsubscribe,
} from '@brownie/plugin-api';
import { describe, expect, it } from 'vitest';
import { OverlayControlPlane, type OverlayTransport } from '../src/overlay/OverlayControlPlane.js';
import { PluginHost } from '../src/plugins/PluginHost.js';
import { PluginHotkeys, type HotkeyEvent } from '../src/plugins/PluginHotkeys.js';
import { PluginPreferences } from '../src/plugins/PluginPreferences.js';
import { formatBind, normaliseBind, parseBind } from '../src/plugins/pluginBind.js';
import { RecordingSink, testLogger } from './fakes.js';

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

/** A plugin whose switch is the thing a key moves. */
function switched(id: string, bindable: PluginMeta['bindable'] = true): Plugin {
  return definePlugin({
    meta: { id, name: `The ${id}`, category: PluginCategory.Combat, bindable },
    setup: () => undefined,
  });
}

/** A plugin that arms itself with a setting, the way noclip does. */
function armed(id: string, onChange?: (on: boolean) => void): Plugin {
  return definePlugin({
    meta: { id, name: `The ${id}`, category: PluginCategory.Movement, bindable: 'active' },
    setup: (ctx: PluginContext) => {
      const active = ctx.settings.boolean('active', { default: false });
      if (onChange !== undefined) active.onChange(onChange);
    },
  });
}

/**
 * A plugin with a key for its switch and another for something it is told,
 * which is what auto-dodge and its anchor are.
 */
function twoKeyed(id: string, onChange?: (on: boolean) => void): Plugin {
  return definePlugin({
    meta: {
      id,
      name: `The ${id}`,
      category: PluginCategory.Movement,
      bindable: [{ label: 'Hotkey' }, { setting: 'anchor', label: 'Anchor here' }],
    },
    setup: (ctx: PluginContext) => {
      const anchor = ctx.settings.boolean('anchor', { default: false });
      if (onChange !== undefined) anchor.onChange(onChange);
    },
  });
}

function host(store?: PluginPreferences): PluginHost {
  return new PluginHost({
    log: testLogger(new RecordingSink()),
    native: NATIVE,
    sessions: SESSIONS,
    ...(store === undefined ? {} : { store }),
  });
}

/** Stands in for the module's end of the hotkey channel. */
class FakeHotkeys {
  #onHotkey: ((event: HotkeyEvent) => void) | undefined;
  #onDisconnected: (() => void) | undefined;

  onHotkey(listener: (event: HotkeyEvent) => void): Unsubscribe {
    this.#onHotkey = listener;
    return () => {
      this.#onHotkey = undefined;
    };
  }

  onDisconnected(listener: () => void): Unsubscribe {
    this.#onDisconnected = listener;
    return () => {
      this.#onDisconnected = undefined;
    };
  }

  press(pluginId: string, action: string, value = true, slot = ''): void {
    this.#onHotkey?.({ pluginId, slot, action, value });
  }

  drop(): void {
    this.#onDisconnected?.();
  }
}

function router(plugins: PluginHost): { native: FakeHotkeys; hotkeys: PluginHotkeys } {
  const native = new FakeHotkeys();
  const hotkeys = new PluginHotkeys({
    host: plugins,
    native,
    log: testLogger(new RecordingSink()),
  });
  hotkeys.start();
  return { native, hotkeys };
}

describe('a bind', () => {
  it('has exactly one spelling, and the empty one is unbound', () => {
    expect(parseBind('')).toEqual({ mode: 'toggle', key: '' });
    expect(parseBind('toggle:F5')).toEqual({ mode: 'toggle', key: 'F5' });
    expect(parseBind('hold:Ctrl+Shift+A')).toEqual({ mode: 'hold', key: 'Ctrl+Shift+A' });

    // Round-trips, so a bind that has not moved never reads as a change.
    expect(formatBind({ mode: 'toggle', key: '' })).toBe('');
    expect(formatBind({ mode: 'toggle', key: 'F5' })).toBe('toggle:F5');
    // Clearing the key must not silently undo the mode the user chose.
    expect(formatBind({ mode: 'hold', key: '' })).toBe('hold:');
    expect(normaliseBind('hold:')).toBe('hold:');
  });

  it('refuses anything it is not, rather than repairing it', () => {
    for (const raw of [
      'F5',
      'sometimes:F5',
      'toggle',
      'toggle:F 5',
      'toggle:F|5',
      'toggle:Ctrl+',
      'toggle:+F',
      `toggle:${'A'.repeat(64)}`,
    ]) {
      expect(parseBind(raw), raw).toBeUndefined();
    }
  });
});

describe('binding a plugin', () => {
  it('is offered only to a plugin that asked for one', () => {
    const plugins = host();
    plugins.load(switched('auto-aim'));
    plugins.load(
      definePlugin({
        meta: { id: 'chat-filter', name: 'Chat', category: PluginCategory.Utility },
        setup: () => undefined,
      }),
    );

    expect(plugins.setBind('auto-aim', '', 'toggle:F5')).toBe(true);
    expect(plugins.bindOf('auto-aim', '')).toBe('toggle:F5');
    expect(plugins.setBind('chat-filter', '', 'toggle:F5')).toBe(false);
    expect(plugins.setBind('nothing-here', '', 'toggle:F5')).toBe(false);
    // A slot the plugin never declared is a key that would move nothing, which
    // is refused rather than stored for something to find later.
    expect(plugins.setBind('auto-aim', 'anchor', 'toggle:F6')).toBe(false);
  });

  it('keeps the bind it has when the value is not one', () => {
    const plugins = host();
    plugins.load(switched('auto-aim'));
    plugins.setBind('auto-aim', '', 'hold:Mouse5');

    expect(plugins.setBind('auto-aim', '', 'wobble:Mouse5')).toBe(false);
    expect(plugins.bindOf('auto-aim', '')).toBe('hold:Mouse5');
  });

  it('survives a restart, and a hand-edited file does not', () => {
    const store = new PluginPreferences();
    const first = host(store);
    first.load(switched('auto-aim'));
    first.setBind('auto-aim', '', 'hold:Mouse5');
    expect(store.readBind('auto-aim', '')).toBe('hold:Mouse5');

    const restarted = host(store);
    restarted.load(switched('auto-aim'));
    expect(restarted.bindOf('auto-aim', '')).toBe('hold:Mouse5');

    // What a document holds is only checked for being storable; whether it is a
    // bind is asked here, against the declaration, while the plugin loads.
    store.load({ 'auto-aim': { bind: 'whenever:Mouse5', settings: {} } });
    const third = host(store);
    third.load(switched('auto-aim'));
    expect(third.bindOf('auto-aim', '')).toBe('');
  });

  // A plugin with more than one key is one that is switched on for a run and
  // told something inside it. Each key is its own bind, kept apart by the slot
  // it moves — see `auto-dodge` and its anchor.
  it('keeps one plugin’s keys apart, and remembers each of them', () => {
    const store = new PluginPreferences();
    const plugins = host(store);
    plugins.load(twoKeyed('auto-dodge'));

    expect(plugins.setBind('auto-dodge', '', 'toggle:F5')).toBe(true);
    expect(plugins.setBind('auto-dodge', 'anchor', 'hold:Mouse4')).toBe(true);
    expect(plugins.bindOf('auto-dodge', '')).toBe('toggle:F5');
    expect(plugins.bindOf('auto-dodge', 'anchor')).toBe('hold:Mouse4');

    const restarted = host(store);
    restarted.load(twoKeyed('auto-dodge'));
    expect(restarted.bindOf('auto-dodge', '')).toBe('toggle:F5');
    expect(restarted.bindOf('auto-dodge', 'anchor')).toBe('hold:Mouse4');
  });

  // Two rows writing one stored key is one press moving whichever of them the
  // host happened to keep, so it is refused where it is written rather than
  // discovered in a fight.
  it('refuses a plugin that offers two keys for one switch', () => {
    expect(() =>
      definePlugin({
        meta: {
          id: 'confused',
          name: 'Confused',
          category: PluginCategory.Utility,
          bindable: [{ setting: 'armed' }, { setting: 'armed', label: 'Again' }],
        },
        setup: () => undefined,
      }),
    ).toThrow(TypeError);
  });

  it('is written to the document beside the switch, and read back from it', () => {
    const store = new PluginPreferences();
    store.writeBind('auto-aim', '', 'toggle:F5');
    store.writeEnabled('auto-aim', true);
    expect(store.toDocument().plugins['auto-aim']).toEqual({
      enabled: true,
      bind: 'toggle:F5',
      settings: {},
    });

    // The plugin's other keys are filed under the settings they move: the
    // switch is the one slot that is not a setting, and `"": "toggle:F5"` is
    // not a line anybody reading the file could act on.
    store.writeBind('auto-dodge', 'anchor', 'hold:Mouse4');
    expect(store.toDocument().plugins['auto-dodge']).toEqual({
      binds: { anchor: 'hold:Mouse4' },
      settings: {},
    });
    expect(store.readBind('auto-dodge', 'anchor')).toBe('hold:Mouse4');

    // A build that never bound anything writes no key at all, rather than an
    // empty one that would read as "unbound on purpose".
    const untouched = new PluginPreferences();
    untouched.writeEnabled('auto-aim', true);
    expect(untouched.toDocument().plugins['auto-aim']).toEqual({ enabled: true, settings: {} });
  });

  it('reports a change only when there is one', () => {
    let changes = 0;
    const store = new PluginPreferences(() => changes++);
    store.writeBind('auto-aim', '', 'toggle:F5');
    store.writeBind('auto-aim', '', 'toggle:F5');
    expect(changes).toBe(1);
    store.writeBind('auto-aim', 'anchor', 'toggle:F5');
    store.writeBind('auto-aim', 'anchor', 'toggle:F5');
    expect(changes).toBe(2);
  });
});

describe('a key the module saw', () => {
  it('flips the switch on the way down, and does nothing on the way up', () => {
    const plugins = host();
    plugins.load(switched('auto-aim'));
    const { native } = router(plugins);

    native.press('auto-aim', 'toggle');
    expect(plugins.isEnabled('auto-aim')).toBe(true);
    native.press('auto-aim', 'toggle', false);
    expect(plugins.isEnabled('auto-aim'), 'a toggle has no release').toBe(true);
    native.press('auto-aim', 'toggle');
    expect(plugins.isEnabled('auto-aim')).toBe(false);
  });

  it('holds the switch on, and puts back what it found', () => {
    const plugins = host();
    plugins.load(switched('auto-dodge'));
    const { native } = router(plugins);

    native.press('auto-dodge', 'hold', true);
    expect(plugins.isEnabled('auto-dodge')).toBe(true);
    native.press('auto-dodge', 'hold', false);
    expect(plugins.isEnabled('auto-dodge')).toBe(false);

    // A plugin already on comes back on: a hold is a momentary override, not a
    // key that switches something off for having been pressed.
    plugins.setEnabled('auto-dodge', true);
    native.press('auto-dodge', 'hold', true);
    native.press('auto-dodge', 'hold', false);
    expect(plugins.isEnabled('auto-dodge')).toBe(true);
  });

  it('does not lose what the first press found when a second arrives', () => {
    const plugins = host();
    plugins.load(switched('auto-dodge'));
    plugins.setEnabled('auto-dodge', true);
    const { native } = router(plugins);

    native.press('auto-dodge', 'hold', true);
    native.press('auto-dodge', 'hold', true);
    native.press('auto-dodge', 'hold', false);
    expect(plugins.isEnabled('auto-dodge')).toBe(true);
  });

  it('ignores a release it never saw the start of', () => {
    const plugins = host();
    plugins.load(switched('auto-dodge'));
    plugins.setEnabled('auto-dodge', true);
    const { native } = router(plugins);

    native.press('auto-dodge', 'hold', false);
    expect(plugins.isEnabled('auto-dodge')).toBe(true);
  });

  it('lets go of every hold when the module does, and when the run ends', () => {
    const plugins = host();
    plugins.load(switched('auto-dodge'));
    const first = router(plugins);

    first.native.press('auto-dodge', 'hold', true);
    expect(plugins.isEnabled('auto-dodge')).toBe(true);
    // However the module went — killed with the key still down, most of all.
    first.native.drop();
    expect(plugins.isEnabled('auto-dodge')).toBe(false);

    const second = router(plugins);
    second.native.press('auto-dodge', 'hold', true);
    // A run that ended mid-hold must not persist the switch the hold borrowed.
    second.hotkeys.stop();
    expect(plugins.isEnabled('auto-dodge')).toBe(false);
  });

  it('is ignored when this build does not know what it means', () => {
    const plugins = host();
    plugins.load(switched('auto-aim'));
    const { native } = router(plugins);

    native.press('auto-aim', 'wobble');
    expect(plugins.isEnabled('auto-aim')).toBe(false);
  });

  it('moves the setting, not the switch, for a plugin that named one', () => {
    const plugins = host();
    const seen: boolean[] = [];
    plugins.load(armed('player-noclip', (on) => seen.push(on)));
    const { native } = router(plugins);

    // On needs both: a setting armed inside a plugin nobody enabled does
    // nothing at all, because the timers behind it never run.
    native.press('player-noclip', 'toggle', true, 'active');
    expect(plugins.isEnabled('player-noclip')).toBe(true);
    expect(plugins.isActive('player-noclip', 'active')).toBe(true);
    expect(seen).toEqual([true]);

    // Off disarms and leaves the switch alone: disarming is what makes the
    // plugin let go of what it was holding, and switching it off as well would
    // take away a plugin the user enabled themselves.
    native.press('player-noclip', 'toggle', true, 'active');
    expect(plugins.isActive('player-noclip', 'active')).toBe(false);
    expect(plugins.isEnabled('player-noclip')).toBe(true);
    expect(seen).toEqual([true, false]);
  });

  // The whole point of a second key: it moves the plugin's own setting and
  // leaves the switch where it is, while the first key goes on being the switch.
  it('moves each of a plugin’s switches from its own key', () => {
    const plugins = host();
    const seen: boolean[] = [];
    plugins.load(twoKeyed('auto-dodge', (on) => seen.push(on)));
    plugins.setEnabled('auto-dodge', true);
    const { native } = router(plugins);

    native.press('auto-dodge', 'hold', true, 'anchor');
    expect(seen).toEqual([true]);
    expect(plugins.isEnabled('auto-dodge'), 'the switch is not what that key moves').toBe(true);

    // A hold puts back what it found, on the slot it found it on.
    native.press('auto-dodge', 'hold', false, 'anchor');
    expect(seen).toEqual([true, false]);
    expect(plugins.isEnabled('auto-dodge')).toBe(true);

    // And the switch's own key still moves the switch, taking the setting with
    // it only in the sense that a disabled plugin does nothing.
    native.press('auto-dodge', 'toggle');
    expect(plugins.isEnabled('auto-dodge')).toBe(false);
    expect(seen).toEqual([true, false]);
  });

  // A hold on one slot and a hold on another are two holds. Keyed on the plugin
  // alone, the second would find the first's remembered state and the release
  // would put back the wrong one.
  it('holds two of one plugin’s switches at once', () => {
    const plugins = host();
    plugins.load(twoKeyed('auto-dodge'));
    const { native, hotkeys } = router(plugins);

    native.press('auto-dodge', 'hold', true);
    native.press('auto-dodge', 'hold', true, 'anchor');
    expect(plugins.isEnabled('auto-dodge')).toBe(true);
    expect(plugins.isActive('auto-dodge', 'anchor')).toBe(true);

    // However the run ends, each goes back to what its own hold found — which
    // is only possible because the two were remembered apart.
    hotkeys.stop();
    expect(plugins.isActive('auto-dodge', 'anchor')).toBe(false);
    expect(plugins.isEnabled('auto-dodge')).toBe(false);
  });
});

/** Stands in for the native module's end of the overlay protocol. */
class FakeOverlay implements OverlayTransport {
  connected = true;
  readonly records: string[] = [];
  #onAction: ((action: string) => void) | undefined;

  publishRecord(record: string): void {
    this.records.push(record);
  }

  onConnected(): Unsubscribe {
    return () => undefined;
  }

  onControlAction(listener: (action: string) => void): Unsubscribe {
    this.#onAction = listener;
    return () => {
      this.#onAction = undefined;
    };
  }

  act(kind: string, ...fields: string[]): void {
    this.#onAction?.(buildRecord(kind, ...fields));
  }

  of(kind: string): string[][] {
    return this.records.filter((r) => recordKind(r) === kind).map((r) => parseRecord(r).slice(1));
  }
}

describe('the bind an overlay draws', () => {
  function harness(): { plugins: PluginHost; overlay: FakeOverlay; plane: OverlayControlPlane } {
    const log = testLogger(new RecordingSink());
    const overlay = new FakeOverlay();
    const plugins = new PluginHost({ log, native: NATIVE, sessions: SESSIONS });
    const plane = new OverlayControlPlane({
      host: plugins,
      native: overlay,
      log,
      schedule: (flush) => flush(),
    });
    return { plugins, overlay, plane };
  }

  it('is published for a bindable plugin and for no other', () => {
    const h = harness();
    h.plugins.load(switched('auto-aim'));
    h.plugins.load(
      definePlugin({
        meta: { id: 'chat-filter', name: 'Chat', category: PluginCategory.Utility },
        setup: () => undefined,
      }),
    );
    h.plugins.setBind('auto-aim', '', 'hold:Mouse5');
    h.plane.publishNow();

    // The slot and the name it is drawn under travel with it: an overlay has to
    // be able to tell one of a plugin's keys from another, and it is told what
    // to call them rather than knowing what any of them are for.
    expect(h.overlay.of('bind')).toEqual([['auto-aim', 'hold', 'Mouse5', '', 'Hotkey']]);
  });

  it('is published once for each key a plugin offers', () => {
    const h = harness();
    h.plugins.load(twoKeyed('auto-dodge'));
    h.plugins.setBind('auto-dodge', 'anchor', 'hold:Mouse4');
    h.plane.publishNow();

    expect(h.overlay.of('bind')).toEqual([
      ['auto-dodge', 'toggle', '', '', 'Hotkey'],
      ['auto-dodge', 'hold', 'Mouse4', 'anchor', 'Anchor here'],
    ]);
  });

  it('comes back as its two halves and is stored as one value', () => {
    const h = harness();
    h.plugins.load(switched('auto-aim'));
    h.plane.start();

    h.overlay.act('bind', 'auto-aim', 'toggle', 'Ctrl+F5');
    expect(h.plugins.bindOf('auto-aim', '')).toBe('toggle:Ctrl+F5');

    // Clearing the key keeps the mode, so binding a new one does not also make
    // the user choose the mode again.
    h.overlay.act('bind', 'auto-aim', 'hold', '');
    expect(h.plugins.bindOf('auto-aim', '')).toBe('hold:');
    expect(h.overlay.of('bind').at(-1)).toEqual(['auto-aim', 'hold', '', '', 'Hotkey']);

    // And an overlay that says something this build cannot read changes nothing.
    h.overlay.act('bind', 'auto-aim', 'sometimes', 'F5');
    expect(h.plugins.bindOf('auto-aim', '')).toBe('hold:');
  });

  it('names the key it is moving, and an overlay that names none means the switch', () => {
    const h = harness();
    h.plugins.load(twoKeyed('auto-dodge'));
    h.plane.start();

    h.overlay.act('bind', 'auto-dodge', 'hold', 'Mouse4', 'anchor');
    expect(h.plugins.bindOf('auto-dodge', 'anchor')).toBe('hold:Mouse4');
    expect(h.plugins.bindOf('auto-dodge', ''), 'and only that one').toBe('');

    // An overlay built before a plugin could offer two keys draws its switch
    // and says nothing about a slot, which is exactly what it meant.
    h.overlay.act('bind', 'auto-dodge', 'toggle', 'F5');
    expect(h.plugins.bindOf('auto-dodge', '')).toBe('toggle:F5');
  });
});
