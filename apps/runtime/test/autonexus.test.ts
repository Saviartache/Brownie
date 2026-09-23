import {
  MutablePacket,
  type NativeApi,
  type ProjectileView,
  type SessionApi,
  type SessionView,
} from '@brownie/plugin-api';
import { createBundledRegistry } from '@brownie/protocol/bundled';
import { createPacket, decodeFrame, encodePacket } from '@brownie/protocol';
import { describe, expect, it, vi } from 'vitest';

import { damageTaken } from '../src/features/autonexus/damage.js';
import {
  FORECAST_SAMPLE_STEP_MS,
  HP_DRIFT_SNAP,
  HP_SYNC_WARMUP_TICKS,
  MIN_DAMAGE_MULTIPLIER,
} from '../src/features/autonexus/constants.js';
import { HpTracker } from '../src/features/autonexus/HpTracker.js';
import { BulletLog } from '../src/features/autonexus/BulletLog.js';
import { strikesWithin, type ForecastShot } from '../src/features/autonexus/impact.js';
import { DEFAULT_PROJECTILE_HALF_TILES } from '../src/features/dodge/hitbox.js';
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

describe('strikesWithin', () => {
  const player = { x: 0, y: 0 };

  /** A shot on a straight course, in tiles per millisecond. */
  function flying(
    x: number,
    y: number,
    tilesPerMsX: number,
    over: Partial<{ collisionHalfTiles: number; expiresAtMs: number }> = {},
  ): ForecastShot {
    const expiresAtMs = over.expiresAtMs ?? 2000;
    return {
      collisionHalfTiles: over.collisionHalfTiles ?? DEFAULT_PROJECTILE_HALF_TILES,
      expiresAtMs,
      positionAt: (at) => (at > expiresAtMs ? undefined : { x: x + tilesPerMsX * at, y }),
    };
  }

  it('sees a shot that reaches the player inside the window', () => {
    // Four tiles out at twenty tiles a second: two hundred milliseconds away.
    expect(strikesWithin(0, player, flying(-4, 0, 0.02), 300, FORECAST_SAMPLE_STEP_MS)).toBe(true);
  });

  it('leaves one arriving after the window to a later forecast', () => {
    expect(strikesWithin(0, player, flying(-4, 0, 0.02), 100, FORECAST_SAMPLE_STEP_MS)).toBe(false);
  });

  it('catches a shot that crosses the player between two samples', () => {
    // Fast enough to clear the player's square well inside one sample step.
    expect(strikesWithin(0, player, flying(-10, 0, 0.5), 300, FORECAST_SAMPLE_STEP_MS)).toBe(true);
  });

  it('reports a miss for one passing to the side', () => {
    expect(strikesWithin(0, player, flying(-4, 2, 0.02), 300, FORECAST_SAMPLE_STEP_MS)).toBe(false);
  });

  it("measures against the shot's own hitbox", () => {
    const past = (collisionHalfTiles: number): ForecastShot =>
      flying(-4, 1.5, 0.02, { collisionHalfTiles });
    const step = FORECAST_SAMPLE_STEP_MS;
    expect(strikesWithin(0, player, past(DEFAULT_PROJECTILE_HALF_TILES), 300, step)).toBe(false);
    expect(strikesWithin(0, player, past(2), 300, step)).toBe(true);
  });

  it('counts a shot already on top of the player', () => {
    expect(strikesWithin(0, player, flying(0, 0, 0.02), 0, FORECAST_SAMPLE_STEP_MS)).toBe(true);
  });

  it('ignores one that has expired', () => {
    const spent = flying(-4, 0, 0.02, { expiresAtMs: 400 });
    expect(strikesWithin(500, player, spent, 300, FORECAST_SAMPLE_STEP_MS)).toBe(false);
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

  /**
   * One shot in flight, six tiles west of the player and closing at twenty
   * tiles a second — two hundred milliseconds from a hit unless `y` moves it
   * off the line.
   */
  function inFlight(
    over: Partial<{ ownerId: number; bulletId: number; damage: number; y: number }> = {},
  ): ProjectileView {
    const y = over.y ?? 10;
    return {
      ownerId: over.ownerId ?? 5,
      bulletId: over.bulletId ?? 100,
      bulletType: 0,
      damage: over.damage ?? 100,
      collisionHalfTiles: DEFAULT_PROJECTILE_HALF_TILES,
      beamTiles: 0,
      angle: 0,
      debuffSeverity: 0,
      maxSpeedTilesPerSecond: 20,
      firedAtMs: 0,
      expiresAtMs: 2000,
      x: 6,
      y,
      positionAt: (at) => (at > 2000 ? undefined : { x: 6 + 0.02 * at, y }),
    };
  }

  function fakeSession(
    over: Partial<{
      hp: number;
      maxHp: number;
      defense: number;
      map: string;
      shots: readonly ProjectileView[];
    }> = {},
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
      world: {
        gameTimeMs: 0,
        mapName: over.map ?? 'Dungeon',
        projectiles: () => over.shots ?? [],
      },
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

  /** The same plugin with the leaving switched off — the floor and nothing else. */
  function loadBlockOnly(): PluginHost {
    const host = loadEnabled();
    host.settingsOf('auto-nexus')?.apply('escapeEnabled', false);
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

  /** An area effect centred on the player, whose acknowledgement will land. */
  const aoeOn = (x: number, y: number, damage: number) =>
    packetOf('AOE', {
      position: { x, y },
      radius: 3,
      damage,
      effect: 0,
      effectDuration: 0,
      originType: 0,
      color: 0,
      armorPierce: false,
    });

  const newtick = () =>
    packetOf('NEWTICK', {
      tickId: 0,
      tickTime: 200,
      serverRealTimeMs: 0,
      serverLastRttMs: 0,
      statuses: [],
    });

  const mapInfo = () =>
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
    });

  it('drops the acknowledgement and escapes when a tracked hit is fatal', () => {
    const host = loadEnabled();
    const { session, sendToServer } = fakeSession({ hp: 800, maxHp: 1000 });

    host.dispatchPacket(newtick(), session); // tracker adopts 800
    host.dispatchPacket(enemyShoot(100, 5, 700), session); // a 700 shot in flight
    const hit = playerHit(100, 5);
    host.dispatchPacket(hit, session); // 800 - 700 = 100, at/below 25% (250)

    expect(sendToServer).toHaveBeenCalledWith('ESCAPE', {});
    // The server must never learn the hit landed — not now, at least: it is
    // held behind the escape, which is the next test's business.
    expect(hit.verdict).toBe('drop');
    expect(sendToServer).toHaveBeenCalledTimes(1);
  });

  // The reference implementation's `HoldLethalPlayerHit`: the server applies
  // projectile damage with or without the acknowledgement, so the
  // acknowledgement is not refused but **delayed** — the escape crosses the
  // wire first, and the hit follows it onto a character that has left.
  it('sends the held hit a moment behind the escape', async () => {
    const host = loadEnabled();
    const { session, sendToServer } = fakeSession({ hp: 800, maxHp: 1000 });
    host.dispatchPacket(newtick(), session);
    host.dispatchPacket(enemyShoot(100, 5, 700), session);
    host.dispatchPacket(playerHit(100, 5), session);

    expect(sendToServer).toHaveBeenCalledTimes(1); // only the escape, so far
    // Long enough for the hold to release; the real timer is the host's.
    await new Promise((resolve) => setTimeout(resolve, 180));

    expect(sendToServer).toHaveBeenCalledTimes(2);
    expect(sendToServer).toHaveBeenLastCalledWith('PLAYERHIT', { bulletId: 100, objectId: 5 });
  });

  it('drops a held hit when the map changes before its release', async () => {
    const host = loadEnabled();
    const { session, sendToServer } = fakeSession({ hp: 800, maxHp: 1000 });
    host.dispatchPacket(newtick(), session);
    host.dispatchPacket(enemyShoot(100, 5, 700), session);
    host.dispatchPacket(playerHit(100, 5), session);
    expect(sendToServer).toHaveBeenCalledTimes(1);

    // The escape lands as a new map before the hold runs out: the hit now
    // belongs to the map just left, and sending it would answer for a shot
    // in a place the connection is no longer in.
    host.dispatchPacket(mapInfo(), session);
    await new Promise((resolve) => setTimeout(resolve, 180));

    expect(sendToServer).toHaveBeenCalledTimes(1); // the escape, and nothing since
  });

  // The floor (30%) sits above the threshold (25%), and the band between them
  // is the whole fix: a hit leaving the player there used to be forwarded, and
  // a burst of them could land on the server faster than the escape crossed
  // the wire behind it.
  it('refuses a hit that would cross the floor even though it clears the threshold', () => {
    const host = loadEnabled();
    const { session, sendToServer } = fakeSession({ hp: 400, maxHp: 1000 });
    host.dispatchPacket(newtick(), session);
    host.dispatchPacket(enemyShoot(100, 5, 120), session);

    const hit = playerHit(100, 5);
    host.dispatchPacket(hit, session); // 400 - 120 = 280: above 250, below 300

    expect(sendToServer).toHaveBeenCalledWith('ESCAPE', {});
    expect(hit.verdict).toBe('drop');
  });

  it('forwards what stays above the floor, and charges it to the tracker', () => {
    const host = loadEnabled();
    const { session, sendToServer } = fakeSession({ hp: 1000, maxHp: 1000 });
    host.dispatchPacket(newtick(), session);
    host.dispatchPacket(enemyShoot(100, 5, 100), session);

    const first = playerHit(100, 5);
    host.dispatchPacket(first, session); // 1000 - 100 = 900, far above 300
    expect(first.verdict).toBe('forward');
    expect(sendToServer).not.toHaveBeenCalled();

    // The forwarded hit is already charged: 900 tracked, so a second hit that
    // only the tracker can see coming is refused on the floor.
    host.dispatchPacket(enemyShoot(101, 5, 650), session);
    const second = playerHit(101, 5);
    host.dispatchPacket(second, session); // 900 - 650 = 250, below the floor
    expect(second.verdict).toBe('drop');
    expect(sendToServer).toHaveBeenCalledWith('ESCAPE', {});
  });

  it('refuses an area-effect acknowledgement that names nothing pending, when low', () => {
    const host = loadEnabled();
    const { session, sendToServer } = fakeSession({ hp: 280, maxHp: 1000 });
    host.dispatchPacket(newtick(), session);
    // No AOE was ever announced: the old code forwarded this blind, and the
    // server applied damage nothing had modelled.
    const ack = packetOf('AOEACK', { time: 0, position: { x: 10, y: 10 } });
    host.dispatchPacket(ack, session);

    expect(sendToServer).toHaveBeenCalledWith('ESCAPE', {});
    expect(ack.verdict).toBe('drop');
  });

  it('forwards an unmatched area-effect acknowledgement at high health', () => {
    const host = loadEnabled();
    const { session, sendToServer } = fakeSession({ hp: 900, maxHp: 1000 });
    host.dispatchPacket(newtick(), session);
    const ack = packetOf('AOEACK', { time: 0, position: { x: 10, y: 10 } });
    host.dispatchPacket(ack, session);

    expect(ack.verdict).toBe('forward');
    expect(sendToServer).not.toHaveBeenCalled();
  });

  // The live failure this guards against: an effect was announced somewhere
  // across the room, the client answered it from where it stood, and health
  // sat in the band where a flat unknown-damage estimate crossed the floor —
  // so every heal, buff or dodged blast "escaped" at nearly half health. An
  // effect seen and stood clear of is provably harmless: the server charges
  // nothing for a position outside the radius.
  it('stays for an area effect it saw and stood clear of, however low above the floor', () => {
    const host = loadEnabled();
    const { session, self, sendToServer } = fakeSession({ hp: 400, maxHp: 1000 });
    host.dispatchPacket(newtick(), session);
    // Announced far from the player: (40, 40) against a player at (10, 10).
    host.dispatchPacket(
      packetOf('AOE', {
        position: { x: 40, y: 40 },
        radius: 2,
        damage: 150,
        effect: 0,
        effectDuration: 0,
        originType: 0,
        color: 0,
        armorPierce: false,
      }),
      session,
    );

    const ack = packetOf('AOEACK', { time: 0, position: { x: self.x, y: self.y } });
    host.dispatchPacket(ack, session);

    expect(ack.verdict).toBe('forward');
    expect(sendToServer).not.toHaveBeenCalled();
  });

  it('stays for a harmless effect that landed on the player', () => {
    const host = loadEnabled();
    const { session, self, sendToServer } = fakeSession({ hp: 350, maxHp: 1000 });
    host.dispatchPacket(newtick(), session);
    // A heal or buff: zero damage, centred on the player.
    host.dispatchPacket(
      packetOf('AOE', {
        position: { x: self.x, y: self.y },
        radius: 3,
        damage: 0,
        effect: 0,
        effectDuration: 0,
        originType: 0,
        color: 0,
        armorPierce: false,
      }),
      session,
    );

    const ack = packetOf('AOEACK', { time: 0, position: { x: self.x, y: self.y } });
    host.dispatchPacket(ack, session);

    expect(ack.verdict).toBe('forward');
    expect(sendToServer).not.toHaveBeenCalled();
  });

  it('leaves on server-confirmed health inside the band between floor and threshold', () => {
    const host = loadEnabled();
    const { session, sendToServer } = fakeSession({ hp: 280, maxHp: 1000 });
    host.dispatchPacket(newtick(), session); // the server says 280 (28%)

    expect(sendToServer).toHaveBeenCalledWith('ESCAPE', {});
  });

  // ── Block-only: the escape switched off, the floor left to work alone ─────

  // The measured truth this section rests on — the table in hazard-guard's
  // header: the server simulates its own bullets, so a refused `PLAYERHIT`
  // stops nothing. Below the line, block-only mode holds what *can* be held
  // (area effects outright, ground to hazard-guard's window) and is honest
  // about the rest.
  it('forwards and charges a crossing projectile hit with the escape off', () => {
    const host = loadBlockOnly();
    const { session, sendToServer } = fakeSession({ hp: 400, maxHp: 1000 });
    host.dispatchPacket(newtick(), session);
    host.dispatchPacket(enemyShoot(100, 5, 150), session);

    // 400 - 150 = 250, below the floor — and forwarded anyway, because the
    // server applies this damage with or without the acknowledgement.
    // Pretending to refuse it would be a switch that says it protects while
    // the health bar keeps dropping.
    const hit = playerHit(100, 5);
    host.dispatchPacket(hit, session);
    expect(hit.verdict).toBe('forward');
    expect(sendToServer).not.toHaveBeenCalled();

    // Charged, not skipped: the tracker must not read high while the server
    // deducts the damage for real. A second hit is judged against 250.
    host.dispatchPacket(enemyShoot(101, 5, 100), session);
    const second = playerHit(101, 5);
    host.dispatchPacket(second, session);
    expect(second.verdict).toBe('forward');
    expect(sendToServer).not.toHaveBeenCalled();
  });

  it('refuses a crossing area effect without leaving, and keeps refusing', () => {
    const host = loadBlockOnly();
    const { session, self, sendToServer } = fakeSession({ hp: 400, maxHp: 1000 });
    host.dispatchPacket(newtick(), session);
    host.dispatchPacket(aoeOn(self.x, self.y, 150), session);

    // 400 - 150 = 250, below the floor — and an area effect is carried by its
    // acknowledgement, so refusing the report refuses the damage.
    const first = packetOf('AOEACK', { time: 0, position: { x: self.x, y: self.y } });
    host.dispatchPacket(first, session);
    expect(first.verdict).toBe('drop');
    expect(sendToServer).not.toHaveBeenCalled();

    // The refusal is not one-shot the way an escape is: without the leaving
    // there is no latch, so every later effect meets the same gate.
    host.dispatchPacket(aoeOn(self.x, self.y, 100), session);
    const second = packetOf('AOEACK', { time: 0, position: { x: self.x, y: self.y } });
    host.dispatchPacket(second, session);
    expect(second.verdict).toBe('drop');
    expect(sendToServer).not.toHaveBeenCalled();
  });

  it('forwards ground admissions with the escape off, leaving the window to hazard-guard', () => {
    const host = loadBlockOnly();
    const { session, sendToServer } = fakeSession({ hp: 260, maxHp: 1000 });
    host.dispatchPacket(newtick(), session);

    // Already below the floor, standing in lava: refusing every admission got
    // the connection dropped after roughly ten seconds, in a reconnect loop.
    // The windowed refusal hazard-guard keeps is all there safely is, so this
    // floor lets the admission through and charges it.
    const tile = packetOf('GROUNDDAMAGE', { time: 0, position: { x: 10, y: 10 } });
    host.dispatchPacket(tile, session);
    expect(tile.verdict).toBe('forward');
    expect(sendToServer).not.toHaveBeenCalled();
  });

  it('refuses ground alongside an escape, which ends the standoff by leaving', () => {
    const host = loadEnabled();
    const { session, sendToServer } = fakeSession({ hp: 320, maxHp: 1000 });
    host.dispatchPacket(newtick(), session);

    const tile = packetOf('GROUNDDAMAGE', { time: 0, position: { x: 10, y: 10 } });
    host.dispatchPacket(tile, session); // estimate crosses the floor
    expect(tile.verdict).toBe('drop');
    expect(sendToServer).toHaveBeenCalledWith('ESCAPE', {});
  });

  // The other half of the deal: the floor is a line, not a latch. Healing
  // lifts health back over it — the tracker adopts the server's value once
  // the two have drifted apart — and the next effect passes again.
  it('lets area damage through again once health is healed back above the floor', () => {
    const host = loadBlockOnly();
    const { session, self, sendToServer } = fakeSession({ hp: 400, maxHp: 1000 });
    host.dispatchPacket(newtick(), session);
    host.dispatchPacket(aoeOn(self.x, self.y, 150), session);

    const refused = packetOf('AOEACK', { time: 0, position: { x: self.x, y: self.y } });
    host.dispatchPacket(refused, session); // 250, below the floor
    expect(refused.verdict).toBe('drop');

    // A potion, and enough ticks for the tracker to adopt it: the warm-up
    // first, then the drift snap on the heal.
    self.hp = 700;
    for (let i = 0; i < HP_SYNC_WARMUP_TICKS + 2; i += 1) host.dispatchPacket(newtick(), session);

    host.dispatchPacket(aoeOn(self.x, self.y, 100), session);
    const passes = packetOf('AOEACK', { time: 0, position: { x: self.x, y: self.y } });
    host.dispatchPacket(passes, session); // 700 - 100 = 600, well above
    expect(passes.verdict).toBe('forward');
    expect(sendToServer).not.toHaveBeenCalled();
  });

  it('takes its line from the floor setting, whichever way it is moved', () => {
    // The same area effect leaving 42% of a thousand: below a floor of 50,
    // far above one of 10.
    const raised = loadBlockOnly();
    raised.settingsOf('auto-nexus')?.apply('floorPercent', 50);
    const high = fakeSession({ hp: 500, maxHp: 1000 });
    raised.dispatchPacket(newtick(), high.session);
    raised.dispatchPacket(aoeOn(high.self.x, high.self.y, 80), high.session);
    const refused = packetOf('AOEACK', { time: 0, position: { x: high.self.x, y: high.self.y } });
    raised.dispatchPacket(refused, high.session); // 420 ≤ 500
    expect(refused.verdict).toBe('drop');

    const lowered = loadBlockOnly();
    lowered.settingsOf('auto-nexus')?.apply('floorPercent', 10);
    const low = fakeSession({ hp: 500, maxHp: 1000 });
    lowered.dispatchPacket(newtick(), low.session);
    lowered.dispatchPacket(aoeOn(low.self.x, low.self.y, 80), low.session);
    const passes = packetOf('AOEACK', { time: 0, position: { x: low.self.x, y: low.self.y } });
    lowered.dispatchPacket(passes, low.session); // 420 > the line of 250
    expect(passes.verdict).toBe('forward');
  });

  it('does not leave on server-confirmed low health with the escape off', () => {
    const host = loadBlockOnly();
    const { session, sendToServer } = fakeSession({ hp: 280, maxHp: 1000 });
    host.dispatchPacket(newtick(), session);
    expect(sendToServer).not.toHaveBeenCalled();
  });

  it('shows a lethal DAMAGE rather than hiding it for an escape that cannot come', () => {
    const host = loadBlockOnly();
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
    expect(dmg.verdict).toBe('forward');
    expect(sendToServer).not.toHaveBeenCalled();
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

  // A thousand maximum health puts the hard floor at 300 (30%) and the
  // forecast's own at 100 (10%), so every case below starts above the first
  // and can only be decided by the second.
  it('escapes on a forecast that is nearly lethal, before any acknowledgement', () => {
    const host = loadEnabled();
    const { session, sendToServer } = fakeSession({
      hp: 350,
      maxHp: 1000,
      shots: [inFlight({ damage: 250 })],
    });
    host.dispatchPacket(newtick(), session); // tracker adopts 350
    // 350 - 250 = 100, at or below the forecast's floor, and nothing has hit
    // yet — and health itself is still above the hard floor.
    host.dispatchPacket(enemyShoot(100, 5, 250), session);
    expect(sendToServer).toHaveBeenCalledWith('ESCAPE', {});
  });

  it('stays for shots that will land but leave health well up', () => {
    const host = loadEnabled();
    const { session, sendToServer } = fakeSession({
      hp: 350,
      maxHp: 1000,
      shots: [inFlight({ damage: 100 })],
    });
    host.dispatchPacket(newtick(), session);
    // 350 - 100 = 250: above the forecast's floor, and above the hard one
    // besides. A hit that is going to land is not a reason to leave, only a
    // reason to be counted when it does.
    host.dispatchPacket(enemyShoot(100, 5, 100), session);
    expect(sendToServer).not.toHaveBeenCalled();
  });

  it('refuses the acknowledgement of a hit it has already left', () => {
    const host = loadEnabled();
    const { session } = fakeSession({ hp: 350, maxHp: 1000, shots: [inFlight({ damage: 250 })] });
    host.dispatchPacket(newtick(), session);
    host.dispatchPacket(enemyShoot(100, 5, 250), session);

    const hit = playerHit(100, 5);
    host.dispatchPacket(hit, session);
    expect(hit.verdict).toBe('drop');
  });

  it('adds up everything on its way in', () => {
    const host = loadEnabled();
    const { session, sendToServer } = fakeSession({
      hp: 400,
      maxHp: 1000,
      // Either alone leaves 200, above the forecast's floor; both leave nothing.
      shots: [inFlight({ bulletId: 100, damage: 200 }), inFlight({ bulletId: 101, damage: 200 })],
    });
    host.dispatchPacket(newtick(), session);
    host.dispatchPacket(enemyShoot(100, 5, 200, 2), session);
    expect(sendToServer).toHaveBeenCalledWith('ESCAPE', {});
  });

  it('does not count a shot the client has already answered for', () => {
    const host = loadEnabled();
    const { session, sendToServer } = fakeSession({
      hp: 600,
      maxHp: 1000,
      shots: [inFlight({ damage: 200 })],
    });
    host.dispatchPacket(newtick(), session);
    host.dispatchPacket(enemyShoot(100, 5, 200), session);
    host.dispatchPacket(playerHit(100, 5), session); // 600 → 400, and it is spent

    // A multi-hit shot stays in the world after it lands. Announcing another
    // one only serves to take the forecast again: counting the spent shot would
    // charge its 200 twice and leave 200, at the forecast's floor.
    host.dispatchPacket(enemyShoot(101, 5, 1), session);
    expect(sendToServer).not.toHaveBeenCalled();
  });

  it('stays for a shot that will miss, however low health is', () => {
    const host = loadEnabled();
    const { session, sendToServer } = fakeSession({
      hp: 350,
      maxHp: 1000,
      shots: [inFlight({ damage: 250, y: 13 })], // three tiles off the line
    });
    host.dispatchPacket(newtick(), session);
    host.dispatchPacket(enemyShoot(100, 5, 250), session);
    expect(sendToServer).not.toHaveBeenCalled();
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

    host.dispatchPacket(mapInfo(), session);
    host.dispatchPacket(newtick(), session); // re-adopts 200
    host.dispatchPacket(playerHit(2, 5), session); // fatal again
    expect(sendToServer).toHaveBeenCalledTimes(2);
  });
});
