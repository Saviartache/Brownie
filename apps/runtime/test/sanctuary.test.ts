import {
  MutablePacket,
  Verdict,
  type EntityView,
  type NativeApi,
  type SessionApi,
  type SessionView,
} from '@brownie/plugin-api';
import { createPacket, decodeFrame, encodePacket } from '@brownie/protocol';
import { createBundledRegistry } from '@brownie/protocol/bundled';
import { describe, expect, it } from 'vitest';

import {
  ANIMATION_STAT,
  CHANCELLOR_DAMMAH,
  DAMMAH_SPEAKER,
  ORYX_THE_MAD_GOD_3,
  Punishment,
  punishmentFor,
  type PunishedHitRules,
} from '../src/features/sanctuary/punishedHits.js';
import { createSanctuaryPlugin } from '../src/features/sanctuary/sanctuaryPlugin.js';
import { PluginHost } from '../src/plugins/PluginHost.js';
import type { SettingsRegistry } from '../src/plugins/SettingsRegistry.js';
import { testLogger } from './fakes.js';

const registry = createBundledRegistry();

/** The two values Oryx's guard animation takes — ordinary, then exalted. */
const GUARDED = -935464302;
const GUARDED_EXALTED = -918686683;

const TREASURE_ARTIFACT = 8701;
const ORDINARY_ENEMY = 1234;

const GREETING = 'Greetings, dogged peons! I am Dammah, and I shall be your unmaker!';
const ANY_OTHER_LINE = 'Your persistence is admirable, and irrelevant.';

const ALL_ON: PunishedHitRules = {
  oryxGuard: true,
  dammahMonologue: true,
  treasureShuffle: true,
};

function entityOf(
  objectId: number,
  objectType: number,
  stats: ReadonlyMap<number, number> = new Map(),
): EntityView {
  return {
    objectId,
    objectType,
    name: '',
    hp: 100,
    maxHp: 100,
    isEnemy: true,
    isPlayer: false,
    conditions: 0,
    guildName: '',
    stat: (id) => stats.get(id),
    text: () => undefined,
    x: 0,
    y: 0,
  };
}

const guardedOryx = (objectId = 10, animation = GUARDED): EntityView =>
  entityOf(objectId, ORYX_THE_MAD_GOD_3, new Map([[ANIMATION_STAT, animation]]));

describe('which hits the Sanctuary punishes', () => {
  it('names the guard only while Oryx is playing a guard animation', () => {
    expect(punishmentFor(guardedOryx(), false, ALL_ON)).toBe(Punishment.OryxGuard);
    expect(punishmentFor(guardedOryx(10, GUARDED_EXALTED), false, ALL_ON)).toBe(
      Punishment.OryxGuard,
    );
    expect(punishmentFor(guardedOryx(10, 0), false, ALL_ON)).toBeUndefined();
    // No animation stat sent yet is not a guarded Oryx, it is an unknown one.
    expect(punishmentFor(entityOf(10, ORYX_THE_MAD_GOD_3), false, ALL_ON)).toBeUndefined();
  });

  it('reads the guard animation on Oryx alone', () => {
    // Whatever else plays this animation is not the mechanic being avoided, and
    // withholding hits on it would cost damage for nothing.
    const other = entityOf(11, ORDINARY_ENEMY, new Map([[ANIMATION_STAT, GUARDED]]));
    expect(punishmentFor(other, false, ALL_ON)).toBeUndefined();
  });

  it('names the shuffle for each of the three artifacts', () => {
    for (const objectType of [8701, 8702, 8703]) {
      expect(punishmentFor(entityOf(12, objectType), false, ALL_ON)).toBe(
        Punishment.TreasureShuffle,
      );
    }
  });

  it('names the monologue only while the chancellor is speaking', () => {
    const dammah = entityOf(13, CHANCELLOR_DAMMAH);
    expect(punishmentFor(dammah, true, ALL_ON)).toBe(Punishment.DammahMonologue);
    expect(punishmentFor(dammah, false, ALL_ON)).toBeUndefined();
  });

  it('keeps the three rules independent of one another', () => {
    // The implementation this came from returned out of the treasure branch
    // before the chancellor was ever considered, so switching the shuffle on
    // silently switched the monologue off.
    const dammah = entityOf(13, CHANCELLOR_DAMMAH);
    expect(punishmentFor(dammah, true, { ...ALL_ON, treasureShuffle: true })).toBe(
      Punishment.DammahMonologue,
    );
    expect(punishmentFor(guardedOryx(), false, { ...ALL_ON, treasureShuffle: true })).toBe(
      Punishment.OryxGuard,
    );
  });

  it('obeys each switch on its own', () => {
    expect(punishmentFor(guardedOryx(), false, { ...ALL_ON, oryxGuard: false })).toBeUndefined();
    expect(
      punishmentFor(entityOf(12, TREASURE_ARTIFACT), false, { ...ALL_ON, treasureShuffle: false }),
    ).toBeUndefined();
    expect(
      punishmentFor(entityOf(13, CHANCELLOR_DAMMAH), true, { ...ALL_ON, dammahMonologue: false }),
    ).toBeUndefined();
  });

  it('has nothing to say about an ordinary enemy', () => {
    expect(punishmentFor(entityOf(14, ORDINARY_ENEMY), true, ALL_ON)).toBeUndefined();
  });
});

describe("the Oryx's Sanctuary plugin", () => {
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

  interface Harness {
    host: PluginHost;
    settings: SettingsRegistry;
    /** Objects the world holds, keyed by object id. */
    objects: Map<number, EntityView>;
    world: { mapName: string };
    session: SessionView;
    notified: string[];
  }

  function harness(): Harness {
    const objects = new Map<number, EntityView>();
    const notified: string[] = [];
    const world = {
      mapName: "Oryx's Sanctuary",
      entities: () => objects.values(),
      entity: (objectId: number) => objects.get(objectId),
    };
    const session = {
      id: 's1',
      world,
      notify: (text: string) => notified.push(text),
    } as unknown as SessionView;

    const host = new PluginHost({
      log: testLogger(),
      native: NATIVE,
      sessions: SESSIONS,
      onChanged: () => undefined,
    });
    host.load(createSanctuaryPlugin());
    host.setEnabled('oryx-sanctuary', true);
    const settings = host.settingsOf('oryx-sanctuary');
    if (settings === undefined) throw new Error('the plugin declared no settings');

    return { host, settings, objects, world, session, notified };
  }

  function enemyHit(targetId: number): MutablePacket {
    const packet = createPacket(registry, 'ENEMYHIT');
    Object.assign(packet.fields, {
      time: 0,
      bulletId: 1,
      ownerId: 2,
      targetId,
      kill: false,
      unknownId: 0,
    });
    return new MutablePacket(decodeFrame(registry, encodePacket(registry, packet)));
  }

  function chatLine(cleanText: string, name = DAMMAH_SPEAKER, numStars = -1): MutablePacket {
    const packet = createPacket(registry, 'TEXT');
    Object.assign(packet.fields, {
      name,
      objectId: 13,
      numStars,
      bubbleTime: 0,
      recipient: '',
      text: cleanText,
      cleanText,
      isSupporter: false,
      starBg: 0,
    });
    return new MutablePacket(decodeFrame(registry, encodePacket(registry, packet)));
  }

  /** Whether the hit report reaches the game server. */
  function reports(h: Harness, targetId: number): boolean {
    const packet = enemyHit(targetId);
    h.host.dispatchPacket(packet, h.session);
    return packet.verdict === Verdict.Forward;
  }

  function say(h: Harness, cleanText: string, name?: string, numStars?: number): void {
    h.host.dispatchPacket(chatLine(cleanText, name, numStars), h.session);
  }

  it('withholds a hit on Oryx while he is guarded and sends one when he is not', () => {
    const h = harness();
    h.objects.set(10, guardedOryx());
    expect(reports(h, 10)).toBe(false);

    h.objects.set(10, entityOf(10, ORYX_THE_MAD_GOD_3, new Map([[ANIMATION_STAT, 0]])));
    expect(reports(h, 10)).toBe(true);
  });

  it('sends a hit on an ordinary enemy, and on an id the world does not hold', () => {
    const h = harness();
    h.objects.set(14, entityOf(14, ORDINARY_ENEMY));
    expect(reports(h, 14)).toBe(true);
    expect(reports(h, 999)).toBe(true);
  });

  it('follows the chancellor into and out of his monologue', () => {
    const h = harness();
    h.objects.set(13, entityOf(13, CHANCELLOR_DAMMAH));
    expect(reports(h, 13)).toBe(true);

    say(h, GREETING);
    expect(reports(h, 13)).toBe(false);

    say(h, ANY_OTHER_LINE);
    expect(reports(h, 13)).toBe(true);
  });

  it('ignores a line that is not the chancellor speaking', () => {
    const h = harness();
    h.objects.set(13, entityOf(13, CHANCELLOR_DAMMAH));

    say(h, GREETING, 'SomePlayer');
    expect(reports(h, 13)).toBe(true);

    // Fame is only ever negative for a speaker that is not a player.
    say(h, GREETING, DAMMAH_SPEAKER, 0);
    expect(reports(h, 13)).toBe(true);
  });

  it('forgets the monologue on a map change', () => {
    const h = harness();
    h.objects.set(13, entityOf(13, CHANCELLOR_DAMMAH));
    say(h, GREETING);
    expect(reports(h, 13)).toBe(false);

    // A phase belongs to the map it was announced in, and an object id is only
    // unique within one.
    h.world.mapName = 'Nexus';
    expect(reports(h, 13)).toBe(true);
  });

  it('leaves the treasure shuffle alone until it is asked to withhold it', () => {
    const h = harness();
    h.objects.set(12, entityOf(12, TREASURE_ARTIFACT));
    expect(reports(h, 12)).toBe(true);

    h.settings.apply('treasureShuffle', true);
    expect(reports(h, 12)).toBe(false);
  });

  it('withholds nothing at all once every switch is off', () => {
    const h = harness();
    h.objects.set(10, guardedOryx());
    h.objects.set(13, entityOf(13, CHANCELLOR_DAMMAH));
    say(h, GREETING);

    for (const key of ['oryxGuard', 'dammahMonologue', 'treasureShuffle']) {
      h.settings.apply(key, false);
    }

    expect(reports(h, 10)).toBe(true);
    expect(reports(h, 13)).toBe(true);
  });

  it('reports the raw animation value, which is what settles the stat id', () => {
    const h = harness();
    h.objects.set(10, guardedOryx());
    h.objects.set(12, entityOf(12, TREASURE_ARTIFACT));
    h.objects.set(13, entityOf(13, CHANCELLOR_DAMMAH));
    say(h, GREETING);
    expect(reports(h, 10)).toBe(false);

    h.host.dispatchCommand('o3', [], h.session);

    const line = h.notified.at(-1) ?? '';
    expect(line).toContain(`animation=${String(GUARDED)}`);
    expect(line).toContain('GUARDED');
    expect(line).toContain('1 treasure artifacts');
    expect(line).toContain('SPEAKING');
    expect(line).toContain(`${Punishment.OryxGuard} 1`);
  });

  it('says so when there is nothing of the Sanctuary to see', () => {
    const h = harness();
    h.world.mapName = 'Nexus';

    h.host.dispatchCommand('o3', [], h.session);

    expect(h.notified.at(-1)).toContain('nothing of the Sanctuary in view');
  });
});
