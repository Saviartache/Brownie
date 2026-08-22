import {
  MutablePacket,
  type NativeApi,
  type SessionApi,
  type SessionView,
} from '@brownie/plugin-api';
import { createBundledRegistry } from '@brownie/protocol/bundled';
import { createPacket, decodeFrame, encodePacket } from '@brownie/protocol';
import { describe, expect, it, vi } from 'vitest';

import { damageTaken } from '../src/features/autonexus/damage.js';
import {
  HP_DRIFT_SNAP,
  HP_SYNC_WARMUP_TICKS,
  MIN_DAMAGE_MULTIPLIER,
} from '../src/features/autonexus/constants.js';
import { HpTracker } from '../src/features/autonexus/HpTracker.js';
import { BulletLog } from '../src/features/autonexus/BulletLog.js';
import { ConditionEffect } from '../src/constants/ConditionEffect.js';
import { createAutoNexusPlugin } from '../src/features/autonexus/autoNexusPlugin.js';
import { PluginHost } from '../src/plugins/PluginHost.js';
import { testLogger } from './fakes.js';

const registry = createBundledRegistry();

/** Builds a decoded packet of `name` with `fields`, round-tripped so the
 *  plugin sees exactly what a live one would. */
function packetOf(name: string, fields: Record<string, unknown>): MutablePacket {
  const packet = createPacket(registry, name);
  for (const [key, value] of Object.entries(fields)) {
    packet.fields[key] = value as never;
  }
  return new MutablePacket(decodeFrame(registry, encodePacket(registry, packet)));
}

describe('damageTaken', () => {
  const plain = { defense: 0, conditions: 0, piercing: false };

  it('subtracts defence and floors the result', () => {
    expect(damageTaken(100, { ...plain, defense: 30 })).toBe(70);
  });

  it('never drops below the game floor, whatever the defence', () => {
    expect(damageTaken(100, { ...plain, defense: 500 })).toBe(
      Math.floor(100 * MIN_DAMAGE_MULTIPLIER),
    );
  });

  it('ignores defence for a piercing shot', () => {
    expect(damageTaken(100, { ...plain, defense: 40, piercing: true })).toBe(100);
  });

  it('ignores defence when armour is broken', () => {
    const conditions = 1 << ConditionEffect.ArmorBroken;
    expect(damageTaken(100, { defense: 40, conditions, piercing: false })).toBe(100);
  });

  it('takes half again the defence when armoured', () => {
    const conditions = 1 << ConditionEffect.Armored;
    // 40 → 60 defence, so a 100 shot lands 40.
    expect(damageTaken(100, { defense: 40, conditions, piercing: false })).toBe(40);
  });

  it('takes nothing while invulnerable', () => {
    const conditions = 1 << ConditionEffect.Invulnerable;
    expect(damageTaken(9999, { defense: 0, conditions, piercing: true })).toBe(0);
  });

  it('treats a non-positive shot as no damage', () => {
    expect(damageTaken(0, plain)).toBe(0);
    expect(damageTaken(-5, plain)).toBe(0);
  });
});

describe('HpTracker', () => {
  it('adopts the server value on the first tick', () => {
    const hp = new HpTracker();
    hp.syncFromServer(500, 1000);
    expect(hp.hp).toBe(500);
    expect(hp.maxHp).toBe(1000);
  });

  it('stays ahead of the server between hits rather than snapping back', () => {
    const hp = new HpTracker();
    hp.syncFromServer(1000, 1000);
    hp.applyHit(20);
    // The server has not seen the hit yet; a small drift must not erase it.
    hp.syncFromServer(1000, 1000);
    expect(hp.hp).toBe(980);
  });

  it('snaps to the server once drift is large and the warm-up has passed', () => {
    const hp = new HpTracker();
    hp.syncFromServer(1000, 1000);
    // Get past the warm-up without large drift.
    for (let i = 0; i <= HP_SYNC_WARMUP_TICKS; i += 1) hp.syncFromServer(1000, 1000);
    // A big divergence — e.g. healing the simulation did not model.
    hp.applyHit(HP_DRIFT_SNAP + 100);
    hp.syncFromServer(1000, 1000);
    expect(hp.hp).toBe(1000);
  });

  it('compares against the maximum, and says nothing before it is known', () => {
    const hp = new HpTracker();
    expect(hp.atOrBelowPercent(25)).toBe(false);
    hp.syncFromServer(200, 1000);
    expect(hp.atOrBelowPercent(25)).toBe(true);
    expect(hp.atOrBelowPercent(19)).toBe(false);
  });
});

describe('BulletLog', () => {
  it('fans a volley out across consecutive ids and looks each one up', () => {
    const log = new BulletLog();
    log.add(7, 100, 55, 3, 0);
    expect(log.damageOf(7, 100)).toBe(55);
    expect(log.damageOf(7, 102)).toBe(55);
    expect(log.damageOf(7, 103)).toBeUndefined();
    expect(log.damageOf(8, 100)).toBeUndefined(); // a different owner
  });

  it('forgets a shot once its hit is accounted for', () => {
    const log = new BulletLog();
    log.add(7, 100, 55, 1, 0);
    log.consume(7, 100);
    expect(log.damageOf(7, 100)).toBeUndefined();
  });

  it('prunes shots past their age', () => {
    const log = new BulletLog();
    log.add(7, 100, 55, 1, 0);
    log.prune(20_000);
    expect(log.size).toBe(0);
  });
});

// The plugin, driven through the real host so the priority hook and the enable
// gate run as they do in production.
describe('the auto-nexus plugin', () => {
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

  function fakeSession(
    over: Partial<{ hp: number; maxHp: number; defense: number; map: string }> = {},
  ): {
    session: SessionView;
    self: {
      objectId: number;
      hp: number;
      maxHp: number;
      defense: number;
      conditions: number;
      x: number;
      y: number;
      alive: boolean;
    };
    sendToServer: ReturnType<typeof vi.fn>;
  } {
    const self = {
      objectId: 1,
      hp: over.hp ?? 1000,
      maxHp: over.maxHp ?? 1000,
      defense: over.defense ?? 0,
      conditions: 0,
      x: 10,
      y: 10,
      alive: true,
    };
    const sendToServer = vi.fn();
    const session = {
      id: 's1',
      self,
      world: { gameTimeMs: 0, mapName: over.map ?? 'Dungeon' },
      sendToServer,
      notify: () => undefined,
    } as unknown as SessionView;
    return { session, self, sendToServer };
  }

  function loadEnabled(): PluginHost {
    const host = new PluginHost({
      log: testLogger(),
      native: NATIVE,
      sessions: SESSIONS,
      onChanged: () => undefined,
    });
    host.load(createAutoNexusPlugin());
    host.setEnabled('auto-nexus', true);
    return host;
  }

  const enemyShoot = (bulletId: number, ownerId: number, damage: number, numShots = 1) =>
    packetOf('ENEMYSHOOT', {
      bulletId,
      ownerId,
      bulletType: 0,
      position: { x: 40, y: 40 }, // far from the player, so close-spawn does not fire
      angle: 0,
      damage,
      numShots,
      angleInc: 0,
    });

  const playerHit = (bulletId: number, objectId: number) =>
    packetOf('PLAYERHIT', { bulletId, objectId });

  const newtick = () =>
    packetOf('NEWTICK', {
      tickId: 0,
      tickTime: 200,
      serverRealTimeMs: 0,
      serverLastRttMs: 0,
      statuses: [],
    });

  it('drops the acknowledgement and escapes when a tracked hit is fatal', () => {
    const host = loadEnabled();
    const { session, sendToServer } = fakeSession({ hp: 800, maxHp: 1000 });

    host.dispatchPacket(newtick(), session); // tracker adopts 800
    host.dispatchPacket(enemyShoot(100, 5, 700), session); // a 700 shot in flight
    const hit = playerHit(100, 5);
    host.dispatchPacket(hit, session); // 800 - 700 = 100, at/below 25% (250)

    expect(sendToServer).toHaveBeenCalledWith('ESCAPE', {});
    // The server must never learn the hit landed.
    expect(hit.verdict).toBe('drop');
  });

  it('forwards a survivable hit and stays', () => {
    const host = loadEnabled();
    const { session, sendToServer } = fakeSession({ hp: 1000, maxHp: 1000 });

    host.dispatchPacket(newtick(), session);
    host.dispatchPacket(enemyShoot(100, 5, 100), session);
    const hit = playerHit(100, 5);
    host.dispatchPacket(hit, session);

    expect(sendToServer).not.toHaveBeenCalled();
    expect(hit.verdict).toBe('forward');
  });

  it('accumulates hits the server has not yet applied', () => {
    const host = loadEnabled();
    const { session, sendToServer } = fakeSession({ hp: 1000, maxHp: 1000 });
    host.dispatchPacket(newtick(), session);

    // Three 300 shots: the first two survive (700, 400), the third is fatal.
    for (let i = 0; i < 3; i += 1) host.dispatchPacket(enemyShoot(100 + i, 5, 300), session);
    host.dispatchPacket(playerHit(100, 5), session);
    host.dispatchPacket(playerHit(101, 5), session);
    expect(sendToServer).not.toHaveBeenCalled();
    host.dispatchPacket(playerHit(102, 5), session);
    expect(sendToServer).toHaveBeenCalledTimes(1);
  });

  it('treats an unknown shot as a piercing 200 and still reacts', () => {
    const host = loadEnabled();
    const { session, sendToServer } = fakeSession({ hp: 300, maxHp: 1000, defense: 50 });
    host.dispatchPacket(newtick(), session);
    // No ENEMYSHOOT recorded: 200 piercing → 300 - 200 = 100 ≤ 250.
    host.dispatchPacket(playerHit(999, 5), session);
    expect(sendToServer).toHaveBeenCalledWith('ESCAPE', {});
  });

  it('does not fire in a safe zone', () => {
    const host = loadEnabled();
    const { session, sendToServer } = fakeSession({ hp: 100, maxHp: 1000, map: 'Nexus' });
    host.dispatchPacket(newtick(), session);
    host.dispatchPacket(enemyShoot(100, 5, 90), session);
    host.dispatchPacket(playerHit(100, 5), session);
    expect(sendToServer).not.toHaveBeenCalled();
  });

  it('escapes on a point-blank volley before any PLAYERHIT', () => {
    const host = loadEnabled();
    const { session, self, sendToServer } = fakeSession({ hp: 1000, maxHp: 1000 });
    host.dispatchPacket(newtick(), session);
    // Spawned on the player, two shots of 600: 1000 - 1200 ≤ 250.
    host.dispatchPacket(
      packetOf('ENEMYSHOOT', {
        bulletId: 1,
        ownerId: 5,
        bulletType: 0,
        position: { x: self.x, y: self.y },
        angle: 0,
        damage: 600,
        numShots: 2,
        angleInc: 0,
      }),
      session,
    );
    expect(sendToServer).toHaveBeenCalledWith('ESCAPE', {});
  });

  it('escapes on a server-confirmed lethal DAMAGE, dropping it', () => {
    const host = loadEnabled();
    const { session, sendToServer } = fakeSession({ hp: 1000, maxHp: 1000 });
    host.dispatchPacket(newtick(), session);
    const dmg = packetOf('DAMAGE', {
      targetId: 1,
      effects: [],
      damageAmount: 9999,
      kill: true,
      bulletId: 0,
      objectId: 5,
    });
    host.dispatchPacket(dmg, session);
    expect(sendToServer).toHaveBeenCalledWith('ESCAPE', {});
    expect(dmg.verdict).toBe('drop');
  });

  it('escapes only once, and keeps suppressing later hits', () => {
    const host = loadEnabled();
    const { session, sendToServer } = fakeSession({ hp: 200, maxHp: 1000 });
    host.dispatchPacket(newtick(), session);
    host.dispatchPacket(playerHit(1, 5), session); // fatal → escape
    expect(sendToServer).toHaveBeenCalledTimes(1);

    const later = playerHit(2, 5);
    host.dispatchPacket(later, session);
    expect(sendToServer).toHaveBeenCalledTimes(1); // no second escape
    expect(later.verdict).toBe('drop'); // but still suppressed
  });

  it('re-arms on a new map', () => {
    const host = loadEnabled();
    const { session, sendToServer } = fakeSession({ hp: 200, maxHp: 1000 });
    host.dispatchPacket(newtick(), session);
    host.dispatchPacket(playerHit(1, 5), session);
    expect(sendToServer).toHaveBeenCalledTimes(1);

    host.dispatchPacket(
      packetOf('MAPINFO', {
        width: 1,
        height: 1,
        name: 'Dungeon',
        displayName: 'Dungeon',
        realmName: '',
        fp: 0,
        background: 0,
        difficulty: 0,
        allowPlayerTeleport: false,
        noSave: false,
        showDisplays: false,
        maxPlayers: 0,
        gameOpenedTime: 0,
        serverVersion: '',
        viewDistance: 0,
        bgColor: 0,
        modifier: '',
        unknownShort1: 0,
        unknownBool: false,
        unknownShort2: 0,
        maxRealmScore: 0,
        currentRealmScore: 0,
      }),
      session,
    );
    host.dispatchPacket(newtick(), session); // re-adopts 200
    host.dispatchPacket(playerHit(2, 5), session); // fatal again
    expect(sendToServer).toHaveBeenCalledTimes(2);
  });
});
