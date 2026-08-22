import {
  MutablePacket,
  type NativeApi,
  type SessionApi,
  type SessionView,
} from '@brownie/plugin-api';
import { createPacket, decodeFrame, encodePacket, type FieldValue } from '@brownie/protocol';
import { createBundledRegistry } from '@brownie/protocol/bundled';
import { describe, expect, it } from 'vitest';

import {
  createPushTileSpoofPlugin,
  replacePushTiles,
} from '../src/features/pushtiles/pushTileSpoofPlugin.js';
import { PluginHost } from '../src/plugins/PluginHost.js';
import type { SettingsRegistry } from '../src/plugins/SettingsRegistry.js';
import { RecordingSink, testLogger } from './fakes.js';

const registry = createBundledRegistry();

/** `KSW Conveyor Down` and `WhirlPool Rt` — both `<Push />` in `tiles.xml`. */
const CONVEYOR = 0x6439;
const WHIRLPOOL = 0xfb;
/** `Abyss Fort Tile`, the substitute, and `Spider Dirt`, ordinary ground. */
const ABYSS_FORT = 0xb003;
const SPIDER_DIRT = 0x222f;

const PUSHING = new Set([CONVEYOR, WHIRLPOOL]);
const gameData = { isPushing: (tileType: number) => PUSHING.has(tileType) };

describe('replacing push tiles in a decoded array', () => {
  it('rewrites the pushing ones and leaves the rest alone', () => {
    const tiles = [
      { x: 1, y: 1, type: CONVEYOR },
      { x: 2, y: 1, type: SPIDER_DIRT },
      { x: 3, y: 1, type: WHIRLPOOL },
    ];

    expect(replacePushTiles(tiles, gameData, ABYSS_FORT)).toBe(2);
    expect(tiles.map((tile) => tile.type)).toEqual([ABYSS_FORT, SPIDER_DIRT, ABYSS_FORT]);
  });

  it('edits in place rather than rebuilding the elements', () => {
    // The whole reason the caller can mark the packet once: a map change
    // reveals thousands of tiles, and none of them is a new object.
    const tile = { x: 0, y: 0, type: CONVEYOR };
    const tiles = [tile];

    replacePushTiles(tiles, gameData, ABYSS_FORT);

    expect(tiles[0]).toBe(tile);
  });

  it('skips an element that is not a tile', () => {
    const tiles: FieldValue[] = [7, [CONVEYOR], { x: 0, y: 0 }, { x: 1, y: 0, type: 'no' }];

    expect(replacePushTiles(tiles, gameData, ABYSS_FORT)).toBe(0);
  });
});

describe('the push tile spoof plugin', () => {
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
  const session = { id: 's1' } as unknown as SessionView;

  function load(
    enabled: boolean,
    isPushing: (tileType: number) => boolean = gameData.isPushing,
  ): { host: PluginHost; settings: SettingsRegistry; sink: RecordingSink } {
    const sink = new RecordingSink();
    const host = new PluginHost({
      log: testLogger(sink),
      native: NATIVE,
      sessions: SESSIONS,
      onChanged: () => undefined,
    });
    host.load(createPushTileSpoofPlugin({ isPushing }));
    host.setEnabled('push-tile-spoof', enabled);
    const settings = host.settingsOf('push-tile-spoof');
    if (settings === undefined) throw new Error('the plugin declared no settings');
    return { host, settings, sink };
  }

  function update(tiles: readonly FieldValue[]): MutablePacket {
    const packet = createPacket(registry, 'UPDATE');
    packet.fields['position'] = { x: 0, y: 0 };
    packet.fields['levelType'] = 0;
    packet.fields['tiles'] = tiles;
    packet.fields['newObjs'] = [];
    packet.fields['drops'] = [];
    return new MutablePacket(decodeFrame(registry, encodePacket(registry, packet)));
  }

  const typesIn = (packet: MutablePacket): unknown[] => {
    const tiles = packet.get('tiles');
    if (!Array.isArray(tiles)) throw new Error('the packet carries no tiles');
    return (tiles as Record<string, unknown>[]).map((tile) => tile['type']);
  };

  const tile = (x: number, type: number): FieldValue => ({ x, y: 0, type });

  it('replaces push tiles on their way to the client', () => {
    const { host } = load(true);
    const packet = update([tile(0, CONVEYOR), tile(1, SPIDER_DIRT)]);

    host.dispatchPacket(packet, session);

    expect(typesIn(packet)).toEqual([ABYSS_FORT, SPIDER_DIRT]);
    expect(packet.modified).toBe(true);
  });

  it('leaves a packet with nothing to replace to be forwarded as it arrived', () => {
    const { host } = load(true);
    const packet = update([tile(0, SPIDER_DIRT)]);

    host.dispatchPacket(packet, session);

    expect(packet.modified).toBe(false);
  });

  it('does nothing while it is switched off', () => {
    const { host } = load(false);
    const packet = update([tile(0, CONVEYOR)]);

    host.dispatchPacket(packet, session);

    expect(typesIn(packet)).toEqual([CONVEYOR]);
    expect(packet.modified).toBe(false);
  });

  it('replaces nothing without game data, rather than acting on a guess', () => {
    const { host } = load(true, () => false);
    const packet = update([tile(0, CONVEYOR)]);

    host.dispatchPacket(packet, session);

    expect(typesIn(packet)).toEqual([CONVEYOR]);
  });

  it('honours the configured substitute', () => {
    const { host, settings } = load(true);
    settings.apply('replacementType', SPIDER_DIRT);
    const packet = update([tile(0, WHIRLPOOL)]);

    host.dispatchPacket(packet, session);

    expect(typesIn(packet)).toEqual([SPIDER_DIRT]);
  });

  it('clamps a substitute the wire cannot carry', () => {
    // `Tile.type` is a `uint16`; the reference implementation's setting went to
    // 999999, which the encoder would have written as something else entirely.
    const { host, settings } = load(true);
    settings.apply('replacementType', 999999);
    const packet = update([tile(0, CONVEYOR)]);

    host.dispatchPacket(packet, session);

    expect(typesIn(packet)).toEqual([0xffff]);
  });

  it('rounds a substitute that is not a whole tile type', () => {
    const { host, settings } = load(true);
    settings.apply('replacementType', SPIDER_DIRT + 0.5);
    const packet = update([tile(0, CONVEYOR)]);

    host.dispatchPacket(packet, session);

    expect(typesIn(packet)).toEqual([SPIDER_DIRT + 1]);
  });

  it('refuses a substitute that pushes as well, and says so once', () => {
    const { host, settings, sink } = load(true);
    settings.apply('replacementType', WHIRLPOOL);

    host.dispatchPacket(update([tile(0, CONVEYOR)]), session);
    const packet = update([tile(0, CONVEYOR)]);
    host.dispatchPacket(packet, session);

    // Trading a conveyor for a whirlpool is not what was asked for.
    expect(typesIn(packet)).toEqual([CONVEYOR]);
    expect(sink.messages().filter((message) => message.includes('pushes too'))).toHaveLength(1);
  });
});
