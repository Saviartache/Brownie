import { buildRecord, parseRecord, recordKind } from '@brownie/ipc';
import {
  MutablePacket,
  PluginCategory,
  definePlugin,
  type NativeApi,
  type Plugin,
  type PluginContext,
  type SessionApi,
  type Unsubscribe,
} from '@brownie/plugin-api';
import { createPacket, decodeFrame, encodePacket } from '@brownie/protocol';
import { createBundledRegistry } from '@brownie/protocol/bundled';
import { describe, expect, it } from 'vitest';
import { StatType } from '../src/constants/StatType.js';
import type { WeaponShot } from '../src/gamedata/EquippedWeapon.js';
import { OverlayControlPlane, type OverlayTransport } from '../src/overlay/OverlayControlPlane.js';
import { WorldStatusStage } from '../src/overlay/WorldStatusStage.js';
import { PacketOrigin } from '../src/pipeline/PacketPipeline.js';
import { PluginHost } from '../src/plugins/PluginHost.js';
import { WorldState } from '../src/state/WorldState.js';
import { RecordingSink, testLogger } from './fakes.js';

/** Stands in for the native module's end of the overlay protocol. */
class FakeOverlay implements OverlayTransport {
  connected = true;
  readonly records: string[] = [];
  #onConnected: (() => void) | undefined;
  #onAction: ((action: string) => void) | undefined;

  publishRecord(record: string): void {
    this.records.push(record);
  }

  onConnected(listener: () => void): Unsubscribe {
    this.#onConnected = listener;
    return () => {
      this.#onConnected = undefined;
    };
  }

  onControlAction(listener: (action: string) => void): Unsubscribe {
    this.#onAction = listener;
    return () => {
      this.#onAction = undefined;
    };
  }

  /** Simulates the module (re)connecting. */
  reconnect(): void {
    this.connected = true;
    this.#onConnected?.();
  }

  /** Simulates the user interacting with the overlay. */
  act(kind: string, ...fields: (string | number | boolean)[]): void {
    this.#onAction?.(buildRecord(kind, ...fields));
  }

  /** Records of one kind, split into decoded fields. */
  of(kind: string): string[][] {
    return this.records.filter((r) => recordKind(r) === kind).map((r) => parseRecord(r).slice(1));
  }

  clear(): void {
    this.records.length = 0;
  }
}

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

function plugin(id: string, setup: (ctx: PluginContext) => void): Plugin {
  return definePlugin({
    meta: { id, name: `The ${id}`, category: PluginCategory.Combat },
    setup,
  });
}

interface Harness {
  host: PluginHost;
  overlay: FakeOverlay;
  plane: OverlayControlPlane;
  sink: RecordingSink;
  /** Runs whatever publishing was queued. */
  flush: () => void;
}

function harness(): Harness {
  const sink = new RecordingSink();
  const log = testLogger(sink);
  const overlay = new FakeOverlay();
  const host = new PluginHost({ log, native: NATIVE, sessions: SESSIONS });

  const pending: (() => void)[] = [];
  const plane = new OverlayControlPlane({
    host,
    native: overlay,
    log,
    schedule: (fn) => pending.push(fn),
  });

  return {
    host,
    overlay,
    plane,
    sink,
    flush: () => {
      for (const fn of pending.splice(0)) fn();
    },
  };
}

describe('OverlayControlPlane', () => {
  it('does not repeat a sync that would not change anything', () => {
    const h = harness();
    h.host.load(plugin('auto-nexus', () => undefined));
    h.plane.start();
    h.flush();
    expect(h.overlay.records.length).toBeGreaterThan(0);

    h.overlay.clear();
    h.plane.publishNow();
    expect(h.overlay.records, 'nothing changed, so nothing is said').toEqual([]);

    // A change, and the whole sync goes again — the overlay commits a sync as a
    // whole, so a partial one would leave it holding a mixture.
    h.host.setEnabled('auto-nexus', true);
    h.plane.publishNow();
    expect(recordKind(h.overlay.records[0]!)).toBe('sync-begin');
    expect(recordKind(h.overlay.records.at(-1)!)).toBe('sync-end');
  });

  it('resyncs in full when the module reconnects, unchanged or not', () => {
    const h = harness();
    h.host.load(plugin('auto-nexus', () => undefined));
    h.plane.start();
    h.flush();

    h.overlay.clear();
    h.overlay.reconnect();
    h.flush();

    // A fresh module mirrors nothing, so "the same as last time" is the wrong
    // question to ask about it.
    expect(recordKind(h.overlay.records[0]!)).toBe('sync-begin');
    expect(h.overlay.of('plugin')).toHaveLength(1);
  });

  it('publishes a bracketed sync of plugins and their settings', () => {
    const h = harness();
    h.host.load(
      plugin('auto-nexus', (ctx) => {
        ctx.settings.range('hpPercent', {
          label: 'Escape below',
          default: 25,
          min: 1,
          max: 99,
          step: 1,
        });
        ctx.settings.boolean('audible', { default: true });
      }),
    );
    h.host.setEnabled('auto-nexus', true);

    h.plane.start();
    h.flush();

    expect(recordKind(h.overlay.records[0]!)).toBe('sync-begin');
    expect(recordKind(h.overlay.records.at(-1)!)).toBe('sync-end');

    expect(h.overlay.of('plugin')).toEqual([
      // The trailing `1` is `enableable`: nothing has failed, so its toggle is
      // live. Only a plugin whose `setup` threw sends `0` here.
      ['auto-nexus', 'The auto-nexus', 'combat', '1', 'enabled', '', '1'],
    ]);

    const [range, boolean] = h.overlay.of('setting');
    expect(range?.slice(0, 7)).toEqual([
      'auto-nexus',
      'hpPercent',
      'Escape below',
      'range',
      'n',
      '25',
      '1', // hasMin
    ]);
    expect(boolean?.slice(0, 6)).toEqual(['auto-nexus', 'audible', 'Audible', 'boolean', 'b', '1']);
  });

  it('carries the fields an older overlay would stop before reading', () => {
    const h = harness();
    h.host.load(
      plugin('dodge', (ctx) => {
        ctx.settings.select('planner', {
          default: 'rollout',
          group: 'Planning',
          options: [
            ['rollout', 'Rollout'],
            ['gradient', 'Gradient'],
          ],
        });
        ctx.settings.range('radius', {
          default: 1.5,
          min: 0,
          max: 4,
          advanced: true,
          visibleWhen: { key: 'planner', equals: ['gradient'] },
        });
      }),
    );
    h.plane.start();
    h.flush();

    const [select, radius] = h.overlay.of('setting');
    expect(select?.[12]).toBe('Rollout=rollout;Gradient=gradient'); // options
    expect(select?.[13]).toBe('Planning'); // group
    expect(radius?.[11]).toBe('1'); // advanced
    expect(radius?.[14]).toBe('planner=gradient'); // visibleWhen
  });

  it('says nothing at all while the module is away', () => {
    const h = harness();
    h.host.load(plugin('p', () => undefined));
    h.overlay.connected = false;

    h.plane.start();
    h.flush();

    expect(h.overlay.records).toHaveLength(0);
  });

  it('greets a reconnecting module with a full sync', () => {
    const h = harness();
    h.host.load(plugin('p', () => undefined));
    h.plane.start();
    h.flush();
    h.overlay.clear();

    h.overlay.reconnect();
    h.flush();

    expect(h.overlay.of('plugin')).toHaveLength(1);
    expect(recordKind(h.overlay.records[0]!)).toBe('sync-begin');
  });

  it('coalesces a burst of changes into one sync', () => {
    const h = harness();
    h.host.load(
      plugin('p', (ctx) => {
        ctx.settings.number('a', { default: 0 });
        ctx.settings.number('b', { default: 0 });
      }),
    );
    h.plane.start();

    h.plane.publish();
    h.plane.publish();
    h.plane.publish();
    h.flush();

    // A settings replay touches every key; one sync, not one per key.
    expect(h.overlay.records.filter((r) => recordKind(r) === 'sync-begin')).toHaveLength(1);
  });

  describe('actions', () => {
    it('toggles a plugin and republishes', () => {
      const h = harness();
      h.host.load(plugin('p', () => undefined));
      h.plane.start();
      h.flush();
      h.overlay.clear();

      h.overlay.act('toggle', 'p', '1');
      h.flush();

      expect(h.host.isEnabled('p')).toBe(true);
      expect(h.overlay.of('plugin')[0]?.[3]).toBe('1');

      h.overlay.act('toggle', 'p', '0');
      expect(h.host.isEnabled('p')).toBe(false);
    });

    it('applies a setting, converting the value to what it holds', () => {
      const h = harness();
      h.host.load(
        plugin('p', (ctx) => {
          ctx.settings.range('hp', { default: 25, min: 1, max: 99 });
          ctx.settings.boolean('on', { default: false });
          ctx.settings.text('name', { default: '' });
        }),
      );
      h.plane.start();

      h.overlay.act('setting', 'p', 'hp', 'n', '60');
      h.overlay.act('setting', 'p', 'on', 'b', '1');
      h.overlay.act('setting', 'p', 'name', 's', 'Sorcerer');

      expect(h.host.settingsOf('p')?.values()).toEqual({ hp: 60, on: true, name: 'Sorcerer' });
    });

    it('clamps a value the overlay should not have sent', () => {
      const h = harness();
      h.host.load(plugin('p', (ctx) => ctx.settings.range('hp', { default: 25, min: 1, max: 99 })));
      h.plane.start();

      h.overlay.act('setting', 'p', 'hp', 'n', '5000');

      expect(h.host.settingsOf('p')?.values()['hp']).toBe(99);
    });

    it('presses a button', () => {
      const h = harness();
      let pressed = 0;
      h.host.load(
        plugin('p', (ctx) => ctx.settings.button('go', { label: 'Go', onPress: () => pressed++ })),
      );
      h.plane.start();

      h.overlay.act('press', 'p', 'go');

      expect(pressed).toBe(1);
    });

    it('complains about a value it cannot use, without failing', () => {
      const h = harness();
      h.host.load(plugin('p', (ctx) => ctx.settings.number('n', { default: 1 })));
      h.plane.start();

      expect(() => h.overlay.act('setting', 'p', 'n', 'n', 'not a number')).not.toThrow();
      expect(h.sink.messages().join(' ')).toMatch(/unusable value/);
      expect(h.host.settingsOf('p')?.values()['n']).toBe(1);
    });

    it('shrugs at a plugin or setting it does not have', () => {
      const h = harness();
      h.plane.start();

      expect(() => h.overlay.act('setting', 'ghost', 'k', 's', 'v')).not.toThrow();
      expect(() => h.overlay.act('toggle', 'ghost', '1')).not.toThrow();
      expect(h.sink.messages().join(' ')).toMatch(/unknown plugin/);
    });

    it('ignores an action kind it does not know', () => {
      const h = harness();
      h.plane.start();
      // The same rule in reverse is what lets the two sides be updated apart.
      expect(() => h.overlay.act('from-a-newer-overlay', 'x')).not.toThrow();
    });

    it('survives a malformed record', () => {
      const h = harness();
      h.plane.start();
      expect(() => h.overlay.act('toggle')).not.toThrow();
      expect(() => h.overlay.act('setting', 'p')).not.toThrow();
    });
  });

  it('stops listening when stopped', () => {
    const h = harness();
    h.host.load(plugin('p', () => undefined));
    h.plane.start();
    h.flush();
    h.plane.stop();
    h.overlay.clear();

    h.overlay.act('toggle', 'p', '1');
    h.overlay.reconnect();
    h.flush();

    expect(h.host.isEnabled('p')).toBe(false);
    expect(h.overlay.records).toHaveLength(0);
  });

  it('refuses to start twice', () => {
    const h = harness();
    h.plane.start();
    expect(() => h.plane.start()).toThrow(/already started/);
  });
});

describe('WorldStatusStage', () => {
  const registry = createBundledRegistry();
  const context = { origin: PacketOrigin.Server, sessionId: 's1' };

  function newtick(): MutablePacket {
    const packet = createPacket(registry, 'NEWTICK');
    packet.fields['tickId'] = 0;
    packet.fields['tickTime'] = 200;
    packet.fields['serverRealTimeMs'] = 0;
    packet.fields['serverLastRttMs'] = 0;
    packet.fields['statuses'] = [];
    return new MutablePacket(decodeFrame(registry, encodePacket(registry, packet)));
  }

  function harness(weapon?: (objectType: number) => WeaponShot | undefined): {
    world: WorldState;
    stage: WorldStatusStage;
    records: string[];
    at: number;
  } {
    const world = new WorldState();
    world.markConnected();
    const records: string[] = [];
    // Past the rate limit from the start, so the first tick is published — the
    // real clock is a wall time, which is always past it.
    const box = { at: 1000 };
    const stage = new WorldStatusStage(world, {
      publish: (record) => records.push(record),
      now: () => box.at,
      ...(weapon === undefined ? {} : { weapon }),
    });
    return {
      world,
      stage,
      records,
      get at() {
        return box.at;
      },
      set at(value: number) {
        box.at = value;
      },
    };
  }

  it('publishes what the server last said', () => {
    const h = harness();
    h.world.self.applyStats([
      { id: 0, value: 1000, stackCount: 0 },
      { id: 1, value: 800, stackCount: 0 },
    ]);
    h.stage.handle(newtick(), context);
    expect(h.records[0]).toMatch(/^world\|800\|1000\|/);
  });

  it('says nothing when nothing has changed', () => {
    const h = harness();
    h.stage.handle(newtick(), context);
    expect(h.records).toHaveLength(1);

    // A later tick, well past the rate limit, with a world that has not moved.
    h.at = 10_000;
    h.stage.handle(newtick(), context);
    expect(h.records).toHaveLength(1);
  });

  it('says so again as soon as something does change', () => {
    const h = harness();
    h.stage.handle(newtick(), context);
    h.at = 10_000;
    h.world.self.moveTo(3, 4);
    h.stage.handle(newtick(), context);

    expect(h.records).toHaveLength(2);
    expect(h.records[1]).toContain('|300|400|');
  });

  // What the planner keeps the player inside comes out of a 35 MB data file
  // nobody reads. Being able to see it next to the name it was read for is the
  // whole point of the record.
  describe('the weapon it reports', () => {
    const BOW: WeaponShot = {
      name: 'Bow of Covert Havens',
      speedTilesPerMs: 0.016,
      lifetimeMs: 440,
      reachTiles: 7.04,
    };
    const holding = (world: WorldState, objectType: number): void => {
      world.self.applyStats([{ id: StatType.Inventory0, value: objectType, stackCount: 0 }]);
    };

    it('names it, with the numbers the range was worked out from', () => {
      const h = harness(() => BOW);
      holding(h.world, 0xb06);
      h.stage.handle(newtick(), context);

      expect(h.records).toContain('weapon|Bow%20of%20Covert%20Havens|2822|1600|440|704');
    });

    it('says it once and not on every tick after it', () => {
      const h = harness(() => BOW);
      holding(h.world, 0xb06);
      h.stage.handle(newtick(), context);
      const said = h.records.filter((record) => record.startsWith('weapon|')).length;

      h.at = 10_000;
      h.world.self.moveTo(3, 4);
      h.stage.handle(newtick(), context);

      expect(h.records.filter((record) => record.startsWith('weapon|'))).toHaveLength(said);
    });

    it('reports an item the catalog does not describe, with its type', () => {
      const h = harness(() => undefined);
      holding(h.world, 0xb06);
      h.stage.handle(newtick(), context);

      expect(h.records).toContain('weapon||2822|0|0|0');
    });

    it('reports an empty hand as no weapon at all', () => {
      const h = harness(() => BOW);
      h.stage.handle(newtick(), context);

      expect(h.records).toContain('weapon||-1|0|0|0');
    });
  });
});
