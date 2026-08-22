import {
  MutablePacket,
  type EntityView,
  type NativeApi,
  type SessionApi,
  type SessionView,
} from '@brownie/plugin-api';
import { ByteReader, ByteWriter, createPacket, decodeFrame, encodePacket } from '@brownie/protocol';
import { createBundledRegistry } from '@brownie/protocol/bundled';
import { describe, expect, it } from 'vitest';

import { createAntiLagPlugin } from '../src/features/antilag/antiLagPlugin.js';
import { TargetIdProbe } from '../src/features/antilag/TargetIdProbe.js';
import { parseEffectTypes } from '../src/features/antilag/effectTypes.js';
import {
  AllyEffectMode,
  EntityKind,
  PetMode,
  PlayerMode,
  isRemovable,
  resolvePolicy,
  targetSize,
  withoutEntityLevers,
  type AntiLagSettings,
} from '../src/features/antilag/policy.js';
import { PluginHost } from '../src/plugins/PluginHost.js';
import type { SettingsRegistry } from '../src/plugins/SettingsRegistry.js';
import { StatType } from '../src/constants/StatType.js';
import { frameOf, testLogger } from './fakes.js';

const registry = createBundledRegistry();

const SHOWEFFECT_ID = 11;

const DEFAULTS: AntiLagSettings = {
  playerMode: PlayerMode.Off,
  petMode: PetMode.Off,
  exemptGuildmates: false,
  scaleSizes: false,
  selfPercent: 100,
  otherPercent: 100,
  dropAllyShots: false,
  allyEffects: AllyEffectMode.Off,
  hideAllyNotifications: false,
  blockedEffects: undefined,
};

describe('the resolved policy', () => {
  it('does nothing at all by default', () => {
    const policy = resolvePolicy(DEFAULTS);
    expect(policy.rewritesEntities).toBe(false);
    expect(policy.dropsAllyShots).toBe(false);
    expect(policy.filtersEffects).toBe(false);
    expect(policy.filtersNotifications).toBe(false);
  });

  it('drops ally shots as soon as the shooters are invisible', () => {
    // Not asked for directly: invisible shooters firing visible bullets is
    // never what was wanted.
    const hidden = resolvePolicy({ ...DEFAULTS, playerMode: PlayerMode.Invisible });
    expect(hidden.dropsAllyShots).toBe(true);

    const scaledToNothing = resolvePolicy({ ...DEFAULTS, scaleSizes: true, otherPercent: 0 });
    expect(scaledToNothing.dropsAllyShots).toBe(true);
  });

  it('leaves guildmates exactly as the server sent them', () => {
    const policy = resolvePolicy({
      ...DEFAULTS,
      playerMode: PlayerMode.Remove,
      exemptGuildmates: true,
      scaleSizes: true,
      otherPercent: 25,
    });

    expect(targetSize(policy, EntityKind.Guildmate, false, 120)).toBe(120);
    expect(isRemovable(policy, EntityKind.Guildmate)).toBe(false);
    expect(isRemovable(policy, EntityKind.Player)).toBe(true);
  });

  it('keeps your own pet when only other people’s are hidden', () => {
    const policy = resolvePolicy({
      ...DEFAULTS,
      petMode: PetMode.AllyFirst,
      scaleSizes: true,
      selfPercent: 80,
    });

    expect(targetSize(policy, EntityKind.Pet, true, 100)).toBe(80);
    expect(targetSize(policy, EntityKind.Pet, false, 100)).toBe(0);
  });

  it('scales against what the server sent, not against the default', () => {
    const policy = resolvePolicy({ ...DEFAULTS, scaleSizes: true, otherPercent: 50 });
    expect(targetSize(policy, EntityKind.Player, false, 60)).toBe(30);
  });

  it('turns the entity levers off for the Pet Yard and leaves the rest alone', () => {
    const settings: AntiLagSettings = {
      ...DEFAULTS,
      playerMode: PlayerMode.Remove,
      petMode: PetMode.Remove,
      scaleSizes: true,
      otherPercent: 10,
      allyEffects: AllyEffectMode.All,
    };
    const petYard = resolvePolicy(withoutEntityLevers(settings));

    expect(petYard.rewritesEntities).toBe(false);
    expect(petYard.filtersEffects).toBe(true);
  });
});

describe('the blocked-effect list', () => {
  it('accepts names and ids, and is unset when it names nothing', () => {
    const mask = parseEffectTypes('Stream, 200, nonsense');
    expect(mask?.[3]).toBe(1); // Stream
    expect(mask?.[200]).toBe(1);
    expect(mask?.[1]).toBe(0);

    expect(parseEffectTypes('   ')).toBeUndefined();
    expect(parseEffectTypes('nothing here')).toBeUndefined();
  });

  it('ignores an id no byte could carry', () => {
    expect(parseEffectTypes('999')).toBeUndefined();
  });
});

describe('the target id probe', () => {
  /** A body of `[type, …]`, framed the way the wire carries it. */
  const bodyFrame = (body: Buffer): Buffer => frameOf(SHOWEFFECT_ID, body);
  const BODY_START = 5;

  it('reports nothing until one layout has won repeatedly', () => {
    let learned: string | undefined;
    const probe = new TargetIdProbe((layout) => {
      learned = layout;
    });
    // 524, big-endian, straight after the type byte.
    const frame = bodyFrame(Buffer.from([7, 0, 0, 2, 12]));
    const isLive = (objectId: number): boolean => objectId === 524;

    for (let i = 0; i < 3; i++) expect(probe.read(frame, BODY_START, isLive)).toBeUndefined();
    expect(learned).toBeUndefined();

    // The fourth settles it — and is still not acted on, having been read under
    // a layout that was a candidate at the time.
    expect(probe.read(frame, BODY_START, isLive)).toBeUndefined();
    expect(learned).toBe('offset 1 (int32)');
    expect(probe.read(frame, BODY_START, isLive)).toBe(524);
  });

  it('reads the game’s compressed integer exactly as the codec does', () => {
    const encoded = new ByteWriter().compressedInt(31_337).finish();
    // The codec's own answer, so this fails if the two ever disagree.
    expect(new ByteReader(encoded).compressedInt()).toBe(31_337);

    const frame = bodyFrame(Buffer.concat([Buffer.from([7]), encoded]));
    const probe = new TargetIdProbe(() => undefined);
    const isLive = (objectId: number): boolean => objectId === 31_337;

    for (let i = 0; i < 4; i++) probe.read(frame, BODY_START, isLive);
    expect(probe.read(frame, BODY_START, isLive)).toBe(31_337);
  });

  it('never reports an id the world does not hold, locked or not', () => {
    const probe = new TargetIdProbe(() => undefined);
    const frame = bodyFrame(Buffer.from([7, 0, 0, 2, 12]));
    for (let i = 0; i < 5; i++) probe.read(frame, BODY_START, (id) => id === 524);

    expect(probe.read(frame, BODY_START, () => false)).toBeUndefined();
  });

  it('survives a body too short to hold anything', () => {
    const probe = new TargetIdProbe(() => undefined);
    expect(probe.read(bodyFrame(Buffer.from([7])), BODY_START, () => true)).toBeUndefined();
    expect(probe.read(bodyFrame(Buffer.alloc(0)), BODY_START, () => true)).toBeUndefined();
  });
});

describe('the anti-lag plugin', () => {
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

  const SELF_ID = 1;
  const PLAYER_TYPE = 782;
  const PET_TYPE = 1500;

  function entityView(objectId: number, over: Partial<EntityView> = {}): EntityView {
    return {
      objectId,
      objectType: PLAYER_TYPE,
      name: '',
      hp: 100,
      maxHp: 100,
      isEnemy: false,
      isPlayer: true,
      conditions: 0,
      guildName: '',
      stat: () => undefined,
      text: () => undefined,
      x: 0,
      y: 0,
      ...over,
    };
  }

  function fakeSession(): {
    session: SessionView;
    world: { mapName: string; entities: Map<number, EntityView> };
  } {
    const entities = new Map<number, EntityView>();
    const world = {
      mapName: 'Dungeon',
      entities,
      entity: (objectId: number): EntityView | undefined => entities.get(objectId),
    };
    const session = {
      id: 's1',
      self: { objectId: SELF_ID },
      world,
    } as unknown as SessionView;
    return { session, world };
  }

  function loadEnabled(isPet: (objectType: number) => boolean = () => false): {
    host: PluginHost;
    settings: SettingsRegistry;
  } {
    const host = new PluginHost({
      log: testLogger(),
      native: NATIVE,
      sessions: SESSIONS,
      onChanged: () => undefined,
    });
    host.load(createAntiLagPlugin({ isPet }));
    host.setEnabled('anti-lag', true);
    const settings = host.settingsOf('anti-lag');
    if (settings === undefined) throw new Error('the plugin declared no settings');
    return { host, settings };
  }

  function packetOf(name: string, fields: Record<string, unknown>): MutablePacket {
    const packet = createPacket(registry, name);
    for (const [key, value] of Object.entries(fields)) packet.fields[key] = value as never;
    return new MutablePacket(decodeFrame(registry, encodePacket(registry, packet)));
  }

  const statusOf = (objectId: number, size?: number): Record<string, unknown> => ({
    objectId,
    position: { x: 0, y: 0 },
    data: size === undefined ? [] : [{ id: StatType.Size, value: size, stackCount: 0 }],
  });

  const newTick = (statuses: readonly Record<string, unknown>[]): MutablePacket =>
    packetOf('NEWTICK', {
      tickId: 0,
      tickTime: 200,
      serverRealTimeMs: 0,
      serverLastRttMs: 0,
      statuses,
    });

  const update = (
    newObjs: readonly Record<string, unknown>[],
    drops: readonly number[] = [],
  ): MutablePacket =>
    packetOf('UPDATE', {
      position: { x: 0, y: 0 },
      levelType: 0,
      tiles: [],
      newObjs,
      drops,
    });

  const entityEntry = (objectId: number, objectType = PLAYER_TYPE): Record<string, unknown> => ({
    objectType,
    status: statusOf(objectId),
  });

  const showEffect = (effectType: number, targetId: number): MutablePacket => {
    const body = Buffer.alloc(5);
    body.writeUInt8(effectType, 0);
    body.writeInt32BE(targetId, 1);
    return new MutablePacket(decodeFrame(registry, frameOf(SHOWEFFECT_ID, body)));
  };

  /** The size the packet ends up carrying for one status, if any. */
  function sizeIn(statuses: unknown, objectId: number): number | undefined {
    if (!Array.isArray(statuses)) return undefined;
    for (const entry of statuses as Record<string, unknown>[]) {
      if (entry['objectId'] !== objectId) continue;
      const data = entry['data'];
      if (!Array.isArray(data)) return undefined;
      for (const stat of data as Record<string, unknown>[]) {
        if (stat['id'] === StatType.Size && typeof stat['value'] === 'number') return stat['value'];
      }
    }
    return undefined;
  }

  function idsIn(entries: unknown, key: 'status' | 'self'): number[] {
    if (!Array.isArray(entries)) return [];
    return (entries as Record<string, unknown>[]).map((entry) => {
      const status = key === 'status' ? (entry['status'] as Record<string, unknown>) : entry;
      return status['objectId'] as number;
    });
  }

  it('forwards a tick byte for byte while nothing is configured', () => {
    const { host } = loadEnabled();
    const { session, world } = fakeSession();
    world.entities.set(500, entityView(500));

    const packet = newTick([statusOf(500)]);
    host.dispatchPacket(packet, session);

    expect(packet.modified).toBe(false);
    expect(packet.verdict).toBe('forward');
  });

  it('injects the size stat the server never sent', () => {
    const { host, settings } = loadEnabled();
    settings.apply('sizeScaling', true);
    settings.apply('allySize', 50);

    const { session, world } = fakeSession();
    world.entities.set(500, entityView(500));

    const packet = newTick([statusOf(500)]);
    host.dispatchPacket(packet, session);

    expect(packet.modified).toBe(true);
    expect(sizeIn(packet.get('statuses'), 500)).toBe(50);
  });

  it('scales a size the server did send, and injects it only once', () => {
    const { host, settings } = loadEnabled();
    settings.apply('sizeScaling', true);
    settings.apply('allySize', 50);

    const { session, world } = fakeSession();
    world.entities.set(500, entityView(500));

    const sent = newTick([statusOf(500, 80)]);
    host.dispatchPacket(sent, session);
    expect(sizeIn(sent.get('statuses'), 500)).toBe(40);

    // Nothing to write the second time: the client keeps a stat it was told,
    // so repeating it would grow every packet for nothing.
    const later = newTick([statusOf(500)]);
    host.dispatchPacket(later, session);
    expect(sizeIn(later.get('statuses'), 500)).toBe(50);

    const third = newTick([statusOf(500)]);
    host.dispatchPacket(third, session);
    expect(third.modified).toBe(false);
  });

  it('leaves you and your guildmates alone', () => {
    const { host, settings } = loadEnabled();
    settings.apply('hideAllies', PlayerMode.Invisible);
    settings.apply('exemptGuildmates', true);

    const { session, world } = fakeSession();
    world.entities.set(SELF_ID, entityView(SELF_ID, { guildName: 'Brownies' }));
    world.entities.set(500, entityView(500, { guildName: 'Brownies' }));
    world.entities.set(501, entityView(501, { guildName: 'Somebody Else' }));

    const packet = newTick([statusOf(SELF_ID), statusOf(500), statusOf(501)]);
    host.dispatchPacket(packet, session);

    expect(sizeIn(packet.get('statuses'), SELF_ID)).toBeUndefined();
    expect(sizeIn(packet.get('statuses'), 500)).toBeUndefined();
    expect(sizeIn(packet.get('statuses'), 501)).toBe(0);
  });

  it('removes an object from the update and keeps its ticks out too', () => {
    const { host, settings } = loadEnabled();
    settings.apply('hideAllies', PlayerMode.Remove);

    const { session, world } = fakeSession();
    world.entities.set(500, entityView(500));
    world.entities.set(600, entityView(600, { isPlayer: false, objectType: 9 }));

    const announced = update([entityEntry(500), entityEntry(600, 9)]);
    host.dispatchPacket(announced, session);

    expect(announced.modified).toBe(true);
    expect(idsIn(announced.get('newObjs'), 'status')).toEqual([600]);

    const tick = newTick([statusOf(500), statusOf(600)]);
    host.dispatchPacket(tick, session);
    expect(idsIn(tick.get('statuses'), 'self')).toEqual([600]);
  });

  it('stops stripping the ticks of an object it stopped removing', () => {
    const { host, settings } = loadEnabled();
    settings.apply('hideAllies', PlayerMode.Remove);

    const { session, world } = fakeSession();
    world.entities.set(500, entityView(500));
    host.dispatchPacket(update([entityEntry(500)]), session);

    settings.apply('hideAllies', PlayerMode.Off);
    // The object enters view again, so the client is about to hold it.
    host.dispatchPacket(update([entityEntry(500)]), session);

    const tick = newTick([statusOf(500)]);
    host.dispatchPacket(tick, session);
    expect(idsIn(tick.get('statuses'), 'self')).toEqual([500]);
  });

  it('forgets a removal when the map changes, because ids are reused', () => {
    const { host, settings } = loadEnabled();
    settings.apply('hideAllies', PlayerMode.Remove);

    const { session, world } = fakeSession();
    world.entities.set(500, entityView(500));
    host.dispatchPacket(update([entityEntry(500)]), session);

    world.mapName = 'Nexus';
    world.entities.clear();
    world.entities.set(500, entityView(500, { isPlayer: false, objectType: 9 }));

    const tick = newTick([statusOf(500)]);
    host.dispatchPacket(tick, session);
    expect(idsIn(tick.get('statuses'), 'self')).toEqual([500]);
  });

  it('leaves everything visible in the Pet Yard', () => {
    const { host, settings } = loadEnabled(() => true);
    settings.apply('petHide', PetMode.All);

    const { session, world } = fakeSession();
    world.mapName = 'Pet Yard';
    world.entities.set(700, entityView(700, { isPlayer: false, objectType: PET_TYPE }));

    const packet = newTick([statusOf(700)]);
    host.dispatchPacket(packet, session);
    expect(packet.modified).toBe(false);
  });

  it('hides pets once the game data says which objects are pets', () => {
    const { host, settings } = loadEnabled((objectType) => objectType === PET_TYPE);
    settings.apply('petHide', PetMode.All);

    const { session, world } = fakeSession();
    world.entities.set(700, entityView(700, { isPlayer: false, objectType: PET_TYPE }));

    const packet = newTick([statusOf(700)]);
    host.dispatchPacket(packet, session);
    expect(sizeIn(packet.get('statuses'), 700)).toBe(0);
  });

  it('drops ally shots only when asked', () => {
    const { host, settings } = loadEnabled();
    const { session } = fakeSession();

    const kept = packetOf('ALLYSHOOT', { unknownByte: 0, unknownShort: 0 });
    host.dispatchPacket(kept, session);
    expect(kept.verdict).toBe('forward');

    settings.apply('hideAllyProjectiles', true);
    const dropped = packetOf('ALLYSHOOT', { unknownByte: 0, unknownShort: 0 });
    host.dispatchPacket(dropped, session);
    expect(dropped.verdict).toBe('drop');
  });

  it('blocks the effect types on the list and forwards the rest', () => {
    const { host, settings } = loadEnabled();
    settings.apply('blockShowEffect', true);
    settings.apply('blockedEffectTypes', 'Stream');

    const { session } = fakeSession();

    const stream = showEffect(3, 0);
    host.dispatchPacket(stream, session);
    expect(stream.verdict).toBe('drop');

    const heal = showEffect(1, 0);
    host.dispatchPacket(heal, session);
    expect(heal.verdict).toBe('forward');
  });

  it('drops a teammate’s effects only once the body layout is known', () => {
    const { host, settings } = loadEnabled();
    settings.apply('allyEffects', AllyEffectMode.All);

    const { session, world } = fakeSession();
    world.entities.set(524, entityView(524));

    // While the layout is being learned nothing is dropped, so a wrong guess
    // could never have eaten a boss telegraph.
    for (let i = 0; i < 4; i++) {
      const learning = showEffect(7, 524);
      host.dispatchPacket(learning, session);
      expect(learning.verdict).toBe('forward');
    }

    const dropped = showEffect(7, 524);
    host.dispatchPacket(dropped, session);
    expect(dropped.verdict).toBe('drop');

    // An enemy at the same offset is not a teammate, so its telegraph stays.
    world.entities.set(900, entityView(900, { isPlayer: false, isEnemy: true, objectType: 9 }));
    const enemyTelegraph = showEffect(7, 900);
    host.dispatchPacket(enemyTelegraph, session);
    expect(enemyTelegraph.verdict).toBe('forward');
  });

  it('survives a truncated effect body', () => {
    const { host, settings } = loadEnabled();
    settings.apply('blockShowEffect', true);
    const { session } = fakeSession();

    const packet = new MutablePacket(
      decodeFrame(registry, frameOf(SHOWEFFECT_ID, Buffer.from([3]))),
    );
    host.dispatchPacket(packet, session);
    expect(packet.verdict).toBe('forward');
    expect(host.status('anti-lag')?.handlerErrors).toBe(0);
  });

  it('applies a preset, and drops the label when the mix stops matching it', () => {
    const { settings } = loadEnabled();

    settings.apply('preset', 'max');
    expect(settings.values()['hideAllies']).toBe(PlayerMode.Remove);
    expect(settings.values()['petHide']).toBe(PetMode.Remove);
    expect(settings.values()['preset']).toBe('max');

    settings.apply('hideAllies', PlayerMode.Off);
    expect(settings.values()['preset']).toBe('custom');
  });
});
