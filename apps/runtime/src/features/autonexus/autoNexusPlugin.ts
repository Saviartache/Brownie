/**
 * Auto-nexus: leave before the hit lands, and refuse to acknowledge it if it
 * already has.
 *
 * **Two moments, and the earlier one leads.** The last moment an escape can
 * still work is the acknowledgement: `PLAYERHIT` and its siblings are
 * client→server, so a fatal one can be **dropped and the escape sent in its
 * place** — the server never applies the hit, because it never receives it.
 * That is where this feature used to begin, and it is a round trip later than
 * it needs to be. The same hit was in the air for most of a second first, as a
 * shot whose curve and size the runtime already knows, so a hit that is *about*
 * to happen can be read off the world and left before the client says a word.
 * See {@link strikesWithin} for why forecasting is safe here when an earlier
 * attempt at it was not: what is predicted is not danger but the health left if
 * these particular shots land, against the same threshold as every other path.
 *
 * So health is tracked ahead of the server (see {@link HpTracker}), the shots on
 * their way in are counted against it every few milliseconds, and either half
 * crossing the threshold escapes — after which every acknowledgement is dropped,
 * so the hits the escape was racing never reach the server at all.
 *
 * The acknowledgements are all client→server: `PLAYERHIT` for a shot,
 * `AOEACK` for an area effect, `GROUNDDAMAGE` for a damaging tile. `ENEMYSHOOT`
 * and `AOE` come the other way and only record what a later acknowledgement
 * will cost. `DAMAGE(kill)` and `DEATH` are last resorts for anything the model
 * did not see coming.
 *
 * **`onFirst`, so it reads and drops the acknowledgement before any ordinary
 * plugin can forward it.** That is the one use the priority hook exists for.
 *
 * Structured after the reference implementation's `auto-nexus`, minus what this
 * architecture reads elsewhere or does not carry: regen is left to the server's
 * own drift correction rather than simulated, and the in-game DLL escape and
 * autopot live with the features that own them.
 */

import {
  PluginCategory,
  definePlugin,
  type MutablePacket,
  type Plugin,
  type SessionView,
} from '@brownie/plugin-api';
import { isSafeZone } from '../../constants/SafeZones.js';
import { BulletLog } from './BulletLog.js';
import { HpTracker } from './HpTracker.js';
import { damageTaken } from './damage.js';
import { strikesWithin } from './impact.js';
import {
  AOE_MAX_AGE_MS,
  DEFAULT_CLOSE_SPAWN_TILES,
  DEFAULT_PREDICT_WITHIN_MS,
  DEFAULT_THRESHOLD_PERCENT,
  FORECAST_INTERVAL_MS,
  FORECAST_SAMPLE_STEP_MS,
  GROUND_DAMAGE_ESTIMATE,
  MAX_PENDING_AOES,
  MAX_VOLLEY_SHOTS,
  UNKNOWN_SHOT_DAMAGE,
} from './constants.js';

/** One area effect waiting for the acknowledgement that says it landed. */
interface PendingAoe {
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly damage: number;
  readonly piercing: boolean;
  readonly seenAtMs: number;
}

/** Everything auto-nexus tracks for one live connection. */
interface SessionNexus {
  readonly hp: HpTracker;
  readonly bullets: BulletLog;
  aoes: PendingAoe[];
  escaped: boolean;
}

export function createAutoNexusPlugin(): Plugin {
  return definePlugin({
    meta: {
      id: 'auto-nexus',
      name: 'Auto Nexus',
      category: PluginCategory.Combat,
      description: 'Escapes to the nexus before an unacknowledged hit would be fatal.',
    },

    setup(context) {
      const thresholdPercent = context.settings.range('thresholdPercent', {
        label: 'Escape at or below (% health)',
        default: DEFAULT_THRESHOLD_PERCENT,
        min: 1,
        max: 95,
        step: 1,
      });
      const closeSpawnTiles = context.settings.range('closeSpawnTiles', {
        label: 'Escape on a shot spawned within (tiles)',
        advanced: true,
        default: DEFAULT_CLOSE_SPAWN_TILES,
        min: 0,
        max: 0.5,
        step: 0.05,
      });
      const predictHits = context.settings.boolean('predictHits', {
        label: 'Leave before the hit lands',
        default: true,
      });
      // **The knob that decides how early is too early.** Every millisecond
      // here is a millisecond of head start for the escape and a millisecond
      // the player had to walk out of the shot instead — see
      // {@link DEFAULT_PREDICT_WITHIN_MS}.
      const predictWithinMs = context.settings.range('predictWithinMs', {
        label: 'Count shots landing within (ms)',
        advanced: true,
        default: DEFAULT_PREDICT_WITHIN_MS,
        min: 100,
        max: 800,
        step: 20,
        visibleWhen: { key: 'predictHits', equals: [true] },
      });

      // One record per session: the host holds a single plugin instance and
      // hands the session in with every packet, so state cannot live in a
      // closure variable the way a per-connection plugin's would.
      const bySession = new Map<string, SessionNexus>();

      const stateFor = (session: SessionView): SessionNexus => {
        let state = bySession.get(session.id);
        if (state === undefined) {
          state = { hp: new HpTracker(), bullets: new BulletLog(), aoes: [], escaped: false };
          bySession.set(session.id, state);
        }
        return state;
      };

      const inSafeZone = (session: SessionView): boolean => isSafeZone(session.world.mapName);

      const escape = (session: SessionView, state: SessionNexus, reason: string): void => {
        if (state.escaped) return;
        state.escaped = true;
        session.sendToServer('ESCAPE', {});
        const hp = `${String(Math.round(state.hp.hp))} / ${String(Math.round(state.hp.maxHp))}`;
        session.notify(`Auto-Nexus has triggered an escape action [${hp}] — ${reason}.`);
        context.log.info(`fired ESCAPE (${reason}) at ${hp} hp`);
      };

      /** Applies a hit, and escapes — dropping the packet — if it is fatal. */
      const takeHit = (
        session: SessionView,
        state: SessionNexus,
        packet: MutablePacket,
        damage: number,
        reason: string,
      ): void => {
        state.hp.applyHit(damage);
        if (!inSafeZone(session) && state.hp.atOrBelowPercent(thresholdPercent.get())) {
          packet.drop();
          escape(session, state, reason);
        }
      };

      const conditionsOf = (session: SessionView): number => session.self.conditions;

      // ── Leaving before the hit lands ────────────────────────────────────

      /**
       * Escapes if the shots already in flight would take health to the floor.
       *
       * Nothing here is charged to {@link HpTracker}: a shot that has not
       * connected is not damage, and the acknowledgement — which may never come,
       * because the player may walk out of it — is what pays for it. This only
       * ever asks what health *would* be.
       *
       * Silent without the game's projectile data, which is what
       * `world.projectiles()` is built from. That is why the acknowledgement
       * paths below are not merely a backstop: they are the whole feature for a
       * session running without those files.
       */
      const forecast = (session: SessionView): void => {
        if (!predictHits.get()) return;
        const state = stateFor(session);
        if (state.escaped) return;
        const self = session.self;
        if (!self.alive || inSafeZone(session)) return;

        const now = session.world.gameTimeMs;
        const withinMs = predictWithinMs.get();
        const percent = thresholdPercent.get();
        let damage = 0;
        let shots = 0;

        for (const shot of session.world.projectiles()) {
          if (!strikesWithin(now, self, shot, withinMs, FORECAST_SAMPLE_STEP_MS)) continue;
          // The damage the shot was *announced* with, which is what the server
          // will apply, in preference to the figure in its data file. Not
          // treated as piercing: unlike an unidentified acknowledgement this is
          // a shot we have seen, and assuming armour does nothing would invent
          // damage rather than round towards safety.
          const announced = state.bullets.damageOf(shot.ownerId, shot.bulletId);
          damage += damageTaken(announced ?? shot.damage, {
            defense: self.defense,
            conditions: conditionsOf(session),
            piercing: false,
          });
          shots += 1;
          if (!state.hp.atOrBelowPercent(percent, damage)) continue;
          const what = shots === 1 ? 'an inbound shot' : `${String(shots)} inbound shots`;
          escape(session, state, `${what} for ${String(damage)}`);
          return;
        }
      };

      // ── Recording the other side's fire ─────────────────────────────────

      /**
       * Escapes on a volley that spawned on top of the player.
       *
       * **The path that works with nothing but the packet.** A shot fired at
       * point-blank range leaves no time for the `PLAYERHIT` round trip, and
       * {@link forecast} would catch it — but only in a session that has the
       * game's projectile data. This one reads the announcement itself, so it
       * holds either way.
       */
      const escapeOnPointBlank = (
        packet: MutablePacket,
        session: SessionView,
        state: SessionNexus,
        damage: number,
        count: number,
      ): void => {
        const radius = closeSpawnTiles.get();
        if (radius <= 0) return;
        const origin = pointOf(packet.get('position'));
        const self = session.self;
        if (origin === undefined || !self.alive) return;
        if (Math.hypot(origin.x - self.x, origin.y - self.y) > radius) return;

        const perShot = damageTaken(damage, {
          defense: self.defense,
          conditions: conditionsOf(session),
          piercing: false,
        });
        if (
          !inSafeZone(session) &&
          self.hp - perShot * count <= (self.maxHp * thresholdPercent.get()) / 100
        ) {
          escape(session, state, `point-blank ${String(count)}-shot volley`);
        }
      };

      context.packets.onFirst('ENEMYSHOOT', (packet, session) => {
        const state = stateFor(session);
        if (state.escaped) return;

        const ownerId = packet.number('ownerId');
        const bulletId = packet.number('bulletId');
        const damage = packet.number('damage');
        if (ownerId === undefined || bulletId === undefined || damage === undefined) return;

        const raw = packet.number('numShots') ?? 1;
        const count = raw > 0 && raw < MAX_VOLLEY_SHOTS ? raw : 1;
        const now = session.world.gameTimeMs;
        state.bullets.add(ownerId, bulletId, damage, count, now);
        state.bullets.prune(now);

        escapeOnPointBlank(packet, session, state, damage, count);
        // The state stage runs ahead of the plugins, so the shot just announced
        // is already in the world: the forecast can see it now rather than up to
        // an interval later, which on a fast shot is most of its flight.
        forecast(session);
      });

      context.packets.onFirst('AOE', (packet, session) => {
        const state = stateFor(session);
        if (state.escaped) return;
        const at = pointOf(packet.get('position'));
        const radius = packet.number('radius');
        const damage = packet.number('damage');
        if (at === undefined || radius === undefined || damage === undefined) return;

        state.aoes.push({
          x: at.x,
          y: at.y,
          radius,
          damage,
          piercing: packet.boolean('armorPierce') ?? false,
          seenAtMs: session.world.gameTimeMs,
        });
        // Bounded: a burst of area effects must not grow this without limit.
        if (state.aoes.length > MAX_PENDING_AOES) state.aoes.shift();
      });

      // ── Reconciling with the server's own health ────────────────────────

      context.packets.onFirst('NEWTICK', (_packet, session) => {
        const state = stateFor(session);
        const self = session.self;
        if (!self.alive) return;
        state.hp.syncFromServer(self.hp, self.maxHp);
        // The server confirming health already at the floor — nothing was
        // dropped, so this cannot beat a hit, but it still leaves before the
        // next one.
        if (
          !state.escaped &&
          !inSafeZone(session) &&
          state.hp.atOrBelowPercent(thresholdPercent.get())
        ) {
          escape(session, state, 'server-confirmed low health');
        }
      });

      // ── The acknowledgements that carry damage the server has not applied ─

      context.packets.onFirst('PLAYERHIT', (packet, session) => {
        const state = stateFor(session);
        if (state.escaped) {
          packet.drop();
          return;
        }
        const self = session.self;
        if (!self.alive) return;

        const objectId = packet.number('objectId');
        const bulletId = packet.number('bulletId');
        if (objectId === undefined || bulletId === undefined) return;

        const known = state.bullets.damageOf(objectId, bulletId);
        state.bullets.consume(objectId, bulletId);
        const damage = damageTaken(known ?? UNKNOWN_SHOT_DAMAGE, {
          defense: self.defense,
          conditions: conditionsOf(session),
          // An unknown shot could be armour-piercing and we cannot tell, so
          // assume it is — the direction that escapes rather than dies.
          piercing: known === undefined,
        });
        takeHit(session, state, packet, damage, 'projectile hit');
      });

      context.packets.onFirst('AOEACK', (packet, session) => {
        const state = stateFor(session);
        if (state.escaped) {
          packet.drop();
          return;
        }
        const self = session.self;
        if (!self.alive) return;
        const at = pointOf(packet.get('position')) ?? { x: self.x, y: self.y };
        const now = session.world.gameTimeMs;

        let worst = 0;
        state.aoes = state.aoes.filter((aoe) => {
          if (now - aoe.seenAtMs > AOE_MAX_AGE_MS) return false;
          if (Math.hypot(at.x - aoe.x, at.y - aoe.y) > aoe.radius) return true;
          worst += damageTaken(aoe.damage, {
            defense: self.defense,
            conditions: conditionsOf(session),
            piercing: aoe.piercing,
          });
          return false; // consumed
        });
        if (worst > 0) takeHit(session, state, packet, worst, 'area effect');
      });

      context.packets.onFirst('GROUNDDAMAGE', (packet, session) => {
        const state = stateFor(session);
        if (state.escaped) {
          packet.drop();
          return;
        }
        if (!session.self.alive) return;
        const damage = damageTaken(GROUND_DAMAGE_ESTIMATE, {
          defense: session.self.defense,
          conditions: conditionsOf(session),
          // Tiles ignore armour.
          piercing: true,
        });
        takeHit(session, state, packet, damage, 'damaging tile');
      });

      // ── Last resorts: the server has already decided ────────────────────

      context.packets.onFirst('DAMAGE', (packet, session) => {
        const state = stateFor(session);
        if (state.escaped) return;
        if (packet.number('targetId') !== session.self.objectId) return;
        if (packet.boolean('kill') === true && !inSafeZone(session)) {
          // The server is about to kill us. Keeping the client from rendering
          // it buys the escape its last chance to arrive first.
          packet.drop();
          escape(session, state, 'lethal hit confirmed by server');
        }
      });

      context.packets.onFirst('DEATH', (_packet, session) => {
        // Never dropped: the client must always receive its own death. This is
        // only a final attempt to leave, which does nothing if it is genuinely
        // too late.
        const state = stateFor(session);
        if (!state.escaped && !inSafeZone(session)) escape(session, state, 'death packet');
      });

      // ── Lifecycle ───────────────────────────────────────────────────────

      // What makes a shot worth escaping is time passing, not a packet
      // arriving: one announced outside the window is the same shot inside it a
      // moment later, with nothing said on the wire in between.
      context.timers.setInterval(() => {
        const session = context.sessions.current();
        if (session !== undefined) forecast(session);
      }, FORECAST_INTERVAL_MS);

      // A new map is a clean slate: health, shots and the escape latch all
      // belong to the map they were seen in.
      context.packets.onFirst('MAPINFO', (_packet, session) => {
        const state = stateFor(session);
        state.hp.reset();
        state.bullets.clear();
        state.aoes.length = 0;
        state.escaped = false;
      });

      context.sessions.onDisconnected((session) => {
        bySession.delete(session.id);
      });
    },
  });
}

/** Reads an `{ x, y }` position field, or `undefined` if it is not one. */
function pointOf(value: unknown): { x: number; y: number } | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const { x, y } = record;
  return typeof x === 'number' && typeof y === 'number' ? { x, y } : undefined;
}
