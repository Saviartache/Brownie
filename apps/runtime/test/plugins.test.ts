import {
  MutablePacket,
  PluginCategory,
  PluginState,
  definePlugin,
  type NativeApi,
  type Plugin,
  type PluginContext,
  type SessionApi,
  type SessionView,
} from '@brownie/plugin-api';
import { createBundledRegistry } from '@brownie/protocol/bundled';
import { createPacket, decodeFrame, encodePacket } from '@brownie/protocol';
import { describe, expect, it, vi } from 'vitest';
import { PluginHost } from '../src/plugins/PluginHost.js';
import { PluginPreferences } from '../src/plugins/PluginPreferences.js';
import type { PluginStore } from '../src/plugins/PluginStore.js';
import { RecordingSink, testLogger } from './fakes.js';

const registry = createBundledRegistry();

function teleport(name = 'x'): MutablePacket {
  const packet = createPacket(registry, 'TELEPORT');
  packet.fields['objectId'] = 1;
  packet.fields['playerName'] = name;
  return new MutablePacket(decodeFrame(registry, encodePacket(registry, packet)));
}

const SESSION = { id: 's1' } as unknown as SessionView;

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

function host(
  options: { store?: PluginStore; maxHandlerErrors?: number; sink?: RecordingSink } = {},
): { host: PluginHost; sink: RecordingSink; changes: number } {
  const sink = options.sink ?? new RecordingSink();
  const state = { changes: 0 };
  const created = new PluginHost({
    log: testLogger(sink),
    native: NATIVE,
    sessions: SESSIONS,
    ...(options.store === undefined ? {} : { store: options.store }),
    ...(options.maxHandlerErrors === undefined
      ? {}
      : { maxHandlerErrors: options.maxHandlerErrors }),
    onChanged: () => state.changes++,
  });
  return {
    host: created,
    sink,
    get changes(): number {
      return state.changes;
    },
  };
}

function plugin(id: string, setup: (ctx: PluginContext) => void): Plugin {
  return definePlugin({
    meta: { id, name: id, category: PluginCategory.Utility },
    setup,
  });
}

describe('PluginHost', () => {
  it('loads a plugin disabled, and delivers nothing until it is enabled', () => {
    const h = host();
    const seen: string[] = [];
    h.host.load(plugin('watcher', (ctx) => ctx.packets.on('TELEPORT', (p) => seen.push(p.name))));

    expect(h.host.status('watcher')?.state).toBe(PluginState.Loaded);
    h.host.dispatchPacket(teleport(), SESSION);
    expect(seen).toEqual([]);

    h.host.setEnabled('watcher', true);
    h.host.dispatchPacket(teleport(), SESSION);
    expect(seen).toEqual(['TELEPORT']);

    h.host.setEnabled('watcher', false);
    h.host.dispatchPacket(teleport(), SESSION);
    expect(seen).toEqual(['TELEPORT']);
  });

  it('runs onFirst handlers ahead of ordinary ones, across plugins', () => {
    const h = host();
    const order: string[] = [];
    h.host.load(
      plugin('ordinary', (ctx) => ctx.packets.on('TELEPORT', () => order.push('normal'))),
    );
    h.host.load(
      plugin('safety', (ctx) => ctx.packets.onFirst('TELEPORT', () => order.push('first'))),
    );
    h.host.load(plugin('watcher', (ctx) => ctx.packets.onAny(() => order.push('any'))));
    for (const id of ['ordinary', 'safety', 'watcher']) h.host.setEnabled(id, true);

    h.host.dispatchPacket(teleport(), SESSION);

    // Registered second, but a safety-critical handler must see the packet
    // before anything that might drop it.
    expect(order).toEqual(['first', 'normal', 'any']);
  });

  it('only delivers a named subscription to that packet', () => {
    const h = host();
    let hits = 0;
    h.host.load(plugin('p', (ctx) => ctx.packets.on('NEWTICK', () => hits++)));
    h.host.setEnabled('p', true);

    h.host.dispatchPacket(teleport(), SESSION);

    expect(hits).toBe(0);
  });

  describe('failure isolation', () => {
    it('a plugin that throws in setup is inert, and its neighbours are untouched', () => {
      const h = host();
      let delivered = 0;
      h.host.load(
        plugin('broken', () => {
          throw new Error('bad setup');
        }),
      );
      h.host.load(plugin('fine', (ctx) => ctx.packets.on('TELEPORT', () => delivered++)));
      h.host.setEnabled('broken', true);
      h.host.setEnabled('fine', true);

      h.host.dispatchPacket(teleport(), SESSION);

      expect(h.host.status('broken')?.state).toBe(PluginState.Failed);
      expect(h.host.status('broken')?.error).toBe('bad setup');
      expect(h.host.isEnabled('broken')).toBe(false);
      expect(delivered).toBe(1);
    });

    it('drops registrations a plugin made before it threw in setup', () => {
      const h = host();
      let delivered = 0;
      h.host.load(
        plugin('half', (ctx) => {
          ctx.packets.on('TELEPORT', () => delivered++);
          throw new Error('and then it failed');
        }),
      );
      // The gate would stop it anyway; this is about not being half-live.
      h.host.dispatchPacket(teleport(), SESSION);
      expect(delivered).toBe(0);
      expect(h.host.commands()).toHaveLength(0);
    });

    it('a throwing handler costs its plugin its turn, not the packet', () => {
      const h = host();
      const seen: string[] = [];
      h.host.load(
        plugin('broken', (ctx) =>
          ctx.packets.on('TELEPORT', () => {
            throw new Error('handler bug');
          }),
        ),
      );
      h.host.load(plugin('fine', (ctx) => ctx.packets.on('TELEPORT', () => seen.push('fine'))));
      h.host.setEnabled('broken', true);
      h.host.setEnabled('fine', true);

      const packet = teleport();
      expect(() => h.host.dispatchPacket(packet, SESSION)).not.toThrow();

      expect(seen).toEqual(['fine']);
      expect(packet.verdict).toBe('forward');
      expect(h.host.status('broken')?.handlerErrors).toBe(1);
    });

    it('switches off a plugin that keeps throwing, and says why', () => {
      const h = host({ maxHandlerErrors: 3 });
      h.host.load(
        plugin('noisy', (ctx) =>
          ctx.packets.on('TELEPORT', () => {
            throw new Error('again');
          }),
        ),
      );
      h.host.setEnabled('noisy', true);

      for (let i = 0; i < 5; i++) h.host.dispatchPacket(teleport(), SESSION);

      const status = h.host.status('noisy');
      expect(status?.state).toBe(PluginState.Failed);
      expect(status?.error).toMatch(/disabled after 3 handler errors/);
      // It stopped being called, so the count did not keep climbing.
      expect(status?.handlerErrors).toBe(3);
    });

    it('lets a plugin switched off for failing be switched back on', () => {
      const h = host({ maxHandlerErrors: 3 });
      let broken = true;
      h.host.load(
        plugin('noisy', (ctx) =>
          ctx.packets.on('TELEPORT', () => {
            if (broken) throw new Error('again');
          }),
        ),
      );
      h.host.setEnabled('noisy', true);
      for (let i = 0; i < 3; i++) h.host.dispatchPacket(teleport(), SESSION);
      expect(h.host.status('noisy')?.state).toBe(PluginState.Failed);

      // Its subscriptions were never removed, so "try again" is a reasonable
      // thing to ask for — and until this worked, the only way to clear the
      // state was to restart the runtime.
      broken = false;
      expect(h.host.setEnabled('noisy', true)).toBe(true);

      const recovered = h.host.status('noisy');
      expect(recovered?.state).toBe(PluginState.Enabled);
      expect(recovered?.handlerErrors).toBe(0);
      // The reason went with it: a stale "disabled after 3 handler errors"
      // under a plugin that is now running is worse than no message at all.
      expect(recovered?.error).toBeUndefined();

      h.host.dispatchPacket(teleport(), SESSION);
      expect(h.host.status('noisy')?.handlerErrors).toBe(0);
    });

    it('keeps a plugin whose setup threw out of reach', () => {
      const h = host();
      h.host.load(
        plugin('broken', () => {
          throw new Error('bad setup');
        }),
      );

      // That one registered nothing before it threw, so switching it on would
      // run nothing. Its file has to be fixed and reloaded.
      expect(h.host.setEnabled('broken', true)).toBe(false);
      expect(h.host.status('broken')?.state).toBe(PluginState.Failed);
      expect(h.host.isEnabled('broken')).toBe(false);
    });
  });

  describe('unloading', () => {
    it('removes every subscription the plugin made', () => {
      const h = host();
      let hits = 0;
      h.host.load(
        plugin('p', (ctx) => {
          ctx.packets.on('TELEPORT', () => hits++);
          ctx.packets.onAny(() => hits++);
        }),
      );
      h.host.setEnabled('p', true);
      h.host.dispatchPacket(teleport(), SESSION);
      expect(hits).toBe(2);

      h.host.unload('p');
      h.host.dispatchPacket(teleport(), SESSION);

      expect(hits).toBe(2);
      expect(h.host.status('p')).toBeUndefined();
    });

    it('runs disposers in reverse order, and one failing does not stop the rest', () => {
      const h = host();
      const order: string[] = [];
      h.host.load(
        plugin('p', (ctx) => {
          ctx.onDispose(() => order.push('first'));
          ctx.onDispose(() => {
            throw new Error('rude disposer');
          });
          ctx.onDispose(() => order.push('last'));
        }),
      );

      h.host.unload('p');

      expect(order).toEqual(['last', 'first']);
      expect(h.sink.messages().join(' ')).toMatch(/threw while disposing/);
    });

    it('cancels timers the plugin created', () => {
      vi.useFakeTimers();
      try {
        const h = host();
        let ticks = 0;
        h.host.load(plugin('p', (ctx) => ctx.timers.setInterval(() => ticks++, 100)));
        h.host.setEnabled('p', true);

        vi.advanceTimersByTime(250);
        expect(ticks).toBe(2);

        h.host.unload('p');
        vi.advanceTimersByTime(1000);
        expect(ticks).toBe(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not fire a timer while the plugin is disabled', () => {
      vi.useFakeTimers();
      try {
        const h = host();
        let ticks = 0;
        h.host.load(plugin('p', (ctx) => ctx.timers.setInterval(() => ticks++, 100)));
        vi.advanceTimersByTime(500);
        expect(ticks).toBe(0);

        h.host.setEnabled('p', true);
        vi.advanceTimersByTime(100);
        expect(ticks).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('unloads everything, in reverse load order', () => {
      const h = host();
      const disposed: string[] = [];
      for (const id of ['a', 'b', 'c']) {
        h.host.load(plugin(id, (ctx) => ctx.onDispose(() => disposed.push(id))));
      }

      h.host.disposeAll();

      expect(disposed).toEqual(['c', 'b', 'a']);
      expect(h.host.statuses()).toHaveLength(0);
    });
  });

  describe('commands', () => {
    it('runs a command and reports that it was consumed', () => {
      const h = host();
      const args: string[][] = [];
      h.host.load(
        plugin('p', (ctx) =>
          ctx.commands.register({
            name: 'nexus',
            description: 'Escape.',
            run: (a) => args.push([...a]),
          }),
        ),
      );
      h.host.setEnabled('p', true);

      expect(h.host.dispatchCommand('NEXUS', ['now'], SESSION)).toBe(true);
      expect(args).toEqual([['now']]);
    });

    it('does not consume an unknown command, or one whose plugin is off', () => {
      const h = host();
      h.host.load(
        plugin('p', (ctx) =>
          ctx.commands.register({ name: 'x', description: '', run: () => undefined }),
        ),
      );
      expect(h.host.dispatchCommand('x', [], SESSION)).toBe(false);
      expect(h.host.dispatchCommand('nope', [], SESSION)).toBe(false);
    });

    it('does not consume a command whose handler threw', () => {
      const h = host();
      h.host.load(
        plugin('p', (ctx) =>
          ctx.commands.register({
            name: 'boom',
            description: '',
            run: () => {
              throw new Error('bug');
            },
          }),
        ),
      );
      h.host.setEnabled('p', true);

      // Swallowing the message as well as the error would leave the user with
      // no feedback at all.
      expect(h.host.dispatchCommand('boom', [], SESSION)).toBe(false);
    });

    it('refuses a name another plugin already took', () => {
      const h = host();
      h.host.load(
        plugin('first', (ctx) =>
          ctx.commands.register({ name: 'dup', description: '', run: () => undefined }),
        ),
      );
      h.host.load(
        plugin('second', (ctx) =>
          ctx.commands.register({ name: 'dup', description: '', run: () => undefined }),
        ),
      );

      expect(h.host.status('second')?.state).toBe(PluginState.Failed);
      expect(h.host.commands()).toHaveLength(1);
    });

    it('releases its commands when unloaded', () => {
      const h = host();
      h.host.load(
        plugin('p', (ctx) =>
          ctx.commands.register({ name: 'x', description: '', run: () => undefined }),
        ),
      );
      h.host.unload('p');
      expect(h.host.commands()).toHaveLength(0);
    });
  });

  it('refuses to load the same id twice', () => {
    const h = host();
    h.host.load(plugin('p', () => undefined));
    expect(() => h.host.load(plugin('p', () => undefined))).toThrow(/already loaded/);
  });
});

describe('settings', () => {
  it('reads defaults, and writes through the handle', () => {
    const h = host();
    let handle: { get: () => number; set: (v: number) => void } | undefined;
    h.host.load(
      plugin('p', (ctx) => {
        handle = ctx.settings.range('hp', { default: 25, min: 1, max: 99 });
      }),
    );

    expect(handle?.get()).toBe(25);
    handle?.set(50);
    expect(handle?.get()).toBe(50);
  });

  it('clamps and refuses values that do not fit the declaration', () => {
    const h = host();
    h.host.load(plugin('p', (ctx) => ctx.settings.range('hp', { default: 25, min: 1, max: 99 })));
    const settings = h.host.settingsOf('p')!;

    expect(settings.apply('hp', 500)).toBe(true);
    expect(settings.values()['hp']).toBe(99);
    expect(settings.apply('hp', 'not a number')).toBe(false);
    expect(settings.apply('unknown', 1)).toBe(false);
  });

  it('coerces the type losses that JSON and text fields legitimately cause', () => {
    const h = host();
    h.host.load(
      plugin('p', (ctx) => {
        ctx.settings.boolean('on', { default: false });
        ctx.settings.number('n', { default: 0 });
      }),
    );
    const settings = h.host.settingsOf('p')!;

    expect(settings.apply('on', '1')).toBe(true);
    expect(settings.values()['on']).toBe(true);
    expect(settings.apply('n', '42')).toBe(true);
    expect(settings.values()['n']).toBe(42);
    expect(settings.apply('on', 'perhaps')).toBe(false);
  });

  it('holds a colour in one spelling, and refuses anything that is not one', () => {
    const h = host();
    h.host.load(
      plugin('p', (ctx) => {
        // Six digits declared, eight held: a plugin reading this back gets the
        // one spelling whatever it wrote.
        ctx.settings.colour('tint', { default: '#FF0000' });
      }),
    );
    const settings = h.host.settingsOf('p')!;

    expect(settings.values()['tint']).toBe('#ff0000ff');
    expect(settings.apply('tint', '#00FF00')).toBe(true);
    expect(settings.values()['tint']).toBe('#00ff00ff');
    // Refused rather than coerced, so what the plugin claims is still a colour.
    expect(settings.apply('tint', '#0f0')).toBe(false);
    expect(settings.values()['tint']).toBe('#00ff00ff');
  });

  it('refuses a colour default that is not a colour', () => {
    const h = host();
    h.host.load(
      plugin('badcolour', (ctx) => ctx.settings.colour('tint', { default: 'chartreuse' })),
    );

    expect(h.host.status('badcolour')?.state).toBe(PluginState.Failed);
  });

  it('notifies a listener, including for a change made from outside', () => {
    const h = host();
    const seen: number[] = [];
    h.host.load(
      plugin('p', (ctx) => {
        ctx.settings.number('n', { default: 1 }).onChange((value) => seen.push(value));
      }),
    );

    h.host.settingsOf('p')!.apply('n', 7);
    h.host.settingsOf('p')!.apply('n', 7); // unchanged: no second notification

    expect(seen).toEqual([7]);
  });

  it('restores a persisted value, and ignores one that no longer fits', () => {
    const store = new PluginPreferences();
    store.load({ p: { settings: { hp: 60, gone: 1, tooBig: 1000 } } });
    const h = host({ store });
    h.host.load(
      plugin('p', (ctx) => {
        ctx.settings.range('hp', { default: 25, min: 1, max: 99 });
        ctx.settings.range('tooBig', { default: 5, min: 0, max: 10 });
      }),
    );

    const settings = h.host.settingsOf('p')!;
    expect(settings.values()['hp']).toBe(60);
    // Bounds tightened since it was persisted: clamped, not left out of range.
    expect(settings.values()['tooBig']).toBe(10);
  });

  it('persists a change', () => {
    const store = new PluginPreferences();
    const h = host({ store });
    h.host.load(plugin('p', (ctx) => ctx.settings.boolean('on', { default: false })));
    h.host.settingsOf('p')!.apply('on', true);

    expect(store.read('p')).toEqual({ on: true });
  });

  it('restores the switch, and persists moving it', () => {
    const store = new PluginPreferences();
    store.load({ on: { enabled: true }, off: { enabled: false } });

    const h = host({ store });
    h.host.load(plugin('on', () => undefined));
    h.host.load(plugin('off', () => undefined));

    expect(h.host.isEnabled('on')).toBe(true);
    expect(h.host.status('on')?.state).toBe(PluginState.Enabled);
    expect(h.host.isEnabled('off')).toBe(false);

    h.host.setEnabled('on', false);
    expect(store.readEnabled('on')).toBe(false);
  });

  it('starts a plugin it has never seen the way the plugin asks to start', () => {
    const store = new PluginPreferences();
    const h = host({ store });
    h.host.load(
      definePlugin({
        meta: {
          id: 'eager',
          name: 'eager',
          category: PluginCategory.Utility,
          enabledByDefault: true,
        },
        setup: () => undefined,
      }),
    );

    expect(h.host.isEnabled('eager')).toBe(true);
    // Restoring is not a change: nothing was written, so a later build changing
    // the default still applies.
    expect(store.readEnabled('eager')).toBeUndefined();

    // Switched off by hand, that *is* a change, and it outranks the default.
    h.host.setEnabled('eager', false);
    expect(store.readEnabled('eager')).toBe(false);
  });

  it('refuses a duplicate key, a bad select default, and a late declaration', () => {
    const h = host();
    h.host.load(
      plugin('dup', (ctx) => {
        ctx.settings.boolean('a', { default: false });
        ctx.settings.boolean('a', { default: false });
      }),
    );
    expect(h.host.status('dup')?.state).toBe(PluginState.Failed);

    h.host.load(
      plugin('badselect', (ctx) => {
        ctx.settings.select('mode', { default: 'c', options: [['a', 'A']] } as never);
      }),
    );
    expect(h.host.status('badselect')?.state).toBe(PluginState.Failed);

    let escaped: PluginContext | undefined;
    h.host.load(
      plugin('late', (ctx) => {
        escaped = ctx;
      }),
    );
    expect(() => escaped?.settings.boolean('later', { default: true })).toThrow(
      /after setup returned/,
    );
  });

  it('refuses a multi-select whose default is not among its options', () => {
    const h = host();
    h.host.load(
      plugin('badmulti', (ctx) => {
        ctx.settings.multiSelect('picks', { default: ['c'], options: [['a', 'A']] } as never);
      }),
    );
    expect(h.host.status('badmulti')?.state).toBe(PluginState.Failed);
  });

  it('updates a select options list and resets a value that no longer fits', () => {
    const h = host();
    let handle: ReturnType<PluginContext['settings']['select']> | undefined;
    h.host.load(
      plugin('dynamic', (ctx) => {
        handle = ctx.settings.select('skin', {
          default: '0',
          options: [
            ['0', 'Default'],
            ['10', 'Wizard skin'],
          ],
        });
      }),
    );
    handle!.set('10');

    handle!.setOptions([
      ['0', 'Default'],
      ['20', 'Knight skin'],
    ]);

    expect(handle!.get()).toBe('0');
    expect(h.host.settingsOf('dynamic')!.descriptors()[0]).toMatchObject({
      options: [
        ['0', 'Default'],
        ['20', 'Knight skin'],
      ],
    });
  });

  it('keeps a persisted dynamic selection until its live options are known', () => {
    const store = new PluginPreferences();
    store.load({ dynamic: { settings: { skin: '836' } } });
    const h = host({ store });
    let handle: ReturnType<PluginContext['settings']['select']> | undefined;
    h.host.load(
      plugin('dynamic', (ctx) => {
        handle = ctx.settings.select<string>('skin', {
          default: '0',
          dynamic: true,
          options: [['0', 'Default']],
        });
      }),
    );

    expect(handle!.get()).toBe('836');
    handle!.setOptions([
      ['0', 'Default'],
      ['836', 'Merlin Wizard'],
    ]);
    expect(handle!.get()).toBe('836');
  });

  it('keeps a multi-select to its options and to one canonical spelling', () => {
    const h = host();
    let handle: ReturnType<PluginContext['settings']['multiSelect']> | undefined;
    h.host.load(
      plugin('multi', (ctx) => {
        handle = ctx.settings.multiSelect('picks', {
          default: ['b'],
          options: [
            ['a', 'A'],
            ['b', 'B'],
            ['c', 'C'],
          ],
        });
      }),
    );
    const settings = h.host.settingsOf('multi')!;

    // The default seeds the value, exposed to the plugin as an array.
    expect(handle!.get()).toEqual(['b']);
    expect(settings.values()['picks']).toBe('b');

    // Order-independent: whatever order the keys arrive in, the stored string is
    // the options' declared order — so the same set never looks like a change.
    expect(settings.apply('picks', 'c,a')).toBe(true);
    expect(settings.values()['picks']).toBe('a,c');
    expect(handle!.get()).toEqual(['a', 'c']);
    expect(handle!.has('a')).toBe(true);
    expect(handle!.has('b')).toBe(false);

    // Unknown keys are dropped, not refused: an older config naming a portal
    // this build no longer lists keeps the rest of the choice.
    expect(settings.apply('picks', 'a,zzz,b')).toBe(true);
    expect(settings.values()['picks']).toBe('a,b');

    // Empty is a real value — nothing chosen — not "unset".
    expect(settings.apply('picks', '')).toBe(true);
    expect(handle!.get()).toEqual([]);

    // A write through the handle joins the array back to the canonical string.
    handle!.set(['c', 'b']);
    expect(settings.values()['picks']).toBe('b,c');
  });

  it('runs a button and labels a setting that did not name itself', () => {
    const h = host();
    let pressed = 0;
    h.host.load(
      plugin('p', (ctx) => {
        ctx.settings.button('go', { label: 'Go', onPress: () => pressed++ });
        ctx.settings.number('hpPercentThreshold', { default: 1 });
      }),
    );
    const settings = h.host.settingsOf('p')!;

    expect(settings.press('go')).toBe(true);
    expect(settings.press('nope')).toBe(false);
    expect(pressed).toBe(1);
    expect(settings.descriptors().find((d) => d.key === 'hpPercentThreshold')?.label).toBe(
      'Hp percent threshold',
    );
  });
});
