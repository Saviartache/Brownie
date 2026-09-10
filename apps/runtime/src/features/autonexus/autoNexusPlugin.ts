/**
 * Auto-nexus: leave before the hit lands, and refuse to acknowledge it if it
 * already has.
 *
 * **Two halves — the refusal and the leaving — and the `escapeEnabled` setting
 * is which of them runs.** On, a refused hit is also left behind: the `ESCAPE`
 * goes out in place of the acknowledgement the server never received. Off, the
 * feature is the floor and nothing else: the damage kinds that an
 * acknowledgement truly carries are still refused below the line, but nothing
 * ever leaves the map and no forecast is taken. The halves share every other
 * number and all of the tracking, which is why this is one setting on one
 * plugin rather than two plugins that would have to stay in step.
 *
 * **What a refusal can and cannot stop — measured, not assumed; the table in
 * `features/hazardguard` is the record.** The server simulates its own bullets
 * against the position the client reports, so a refused `PLAYERHIT` stops
 * nothing: forty applications were declined in one live session and health
 * fell all the same. Two damage kinds *are* carried by their acknowledgement —
 * the server cannot know which tile is under the player until `GROUNDDAMAGE`
 * says so, and applies an area effect from the position the `AOEACK` reports —
 * and those are what the floor refuses. One of them only carefully: a
 * character standing in damaging ground and saying nothing gets its connection
 * dropped after roughly ten seconds, so `hazard-guard` lets one admission
 * through every few seconds and this floor must not fight that clock — it
 * refuses ground only alongside an escape, which ends the standoff by leaving.
 *
 * **The consequence for block-only mode is stated plainly rather than
 * papered over:** below the line, projectile damage still lands, because
 * nothing at the proxy can stop it — the answers to a bullet are not being
 * there (`features/dodge`) and leaving (`escapeEnabled`). What the floor holds
 * below the line is area effects, refused outright and safely, and ground,
 * refused to the window `hazard-guard` already keeps. A projectile hit is
 * charged to the tracker whether its acknowledgement is dropped or not,
 * because the server applies it either way — a simulation that skipped it
 * would read high and stop trusting the line.
 *
 * **Two moments, and the earlier one leads.** The last moment an escape can
 * still work is the acknowledgement: for the two kinds it carries — ground
 * and area effects — a fatal one is dropped and the escape sent in its place,
 * and the damage genuinely never arrives. A projectile acknowledgement is
 * different, because the server does not need it: it is **held rather than
 * refused**, and sent a moment behind the escape, so the conversation
 * completes onto a character that has already left — the one ordering this
 * protocol honours where a refusal stops nothing. That is where this feature
 * used to begin, and it is a round trip later than it needs to be. The same
 * hit was in the air for most of a second first, as a shot whose curve and
 * size the runtime already knows, so a hit that is *about* to happen can be
 * read off the world and left before the client says a word.
 *
 * **The two answer to different floors, and that is what keeps the earlier one
 * honest.** Health that has actually gone is a fact, and the floor is what it
 * is measured against. A forecast is not: shots are inbound constantly, and
 * most are dodged, walked out of, or predicted wrong, so a forecast has to be
 * *nearly fatal* — a fraction of that floor, see
 * {@link DEFAULT_PREDICTED_THRESHOLD_PERCENT} — before it is worth a map on.
 * The reference implementation splits the same rule the same way, and its
 * predicted threshold is a quarter of its force threshold. Escaping on a
 * forecast at the ordinary one is the mistake that made this feature leave a
 * dungeon at 87% health with five shots inbound, none of them lethal.
 *
 * So health is tracked ahead of the server (see {@link HpTracker}), decremented
 * the instant the client acknowledges a hit, and the shots on their way in are
 * counted against it — but against its own floor — every few milliseconds.
 * Either crossing escapes.
 *
 * `ENEMYSHOOT` and `AOE` come the other way and only record what a later
 * acknowledgement will cost. `DAMAGE(kill)` and `DEATH` are last resorts for
 * anything the model did not see coming — the floor cannot refuse damage the
 * server applies without asking.
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
  DEFAULT_HEALTH_FLOOR_PERCENT,
  DEFAULT_PREDICTED_THRESHOLD_PERCENT,
  DEFAULT_PREDICT_WITHIN_MS,
  DEFAULT_THRESHOLD_PERCENT,
  FORECAST_INTERVAL_MS,
  FORECAST_SAMPLE_STEP_MS,
  GROUND_DAMAGE_ESTIMATE,
  LETHAL_ACK_RELEASE_MS,
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

/** A hit whose sending is postponed until after the escape ahead of it. */
interface HeldAck {
  /** Sends it now. */
  readonly send: () => void;
  /** Cancels the send, for a map change or a disconnect. */
  readonly cancel: () => void;
}

/** Everything auto-nexus tracks for one live connection. */
interface SessionNexus {
  readonly hp: HpTracker;
  readonly bullets: BulletLog;
  aoes: PendingAoe[];
  escaped: boolean;
  heldAcks: HeldAck[];
}

export function createAutoNexusPlugin(): Plugin {
  return definePlugin({
    meta: {
      id: 'auto-nexus',
      name: 'Auto Nexus',
      category: PluginCategory.Combat,
      description:
        'Refuses damage that would be fatal, and can escape to the nexus before it lands.',
    },

    setup(context) {
      // The mode switch, ahead of the numbers because it decides what they
      // are for. Off, the feature is the floor and nothing else: damage that
      // would cross the line is still refused — health still cannot fall below
      // it on the server — but no `ESCAPE` is ever sent and nothing leaves the
      // map. The two halves share every other number and all of the tracking,
      // which is why this is a setting here rather than a second plugin.
      const escapeEnabled = context.settings.boolean('escapeEnabled', {
        label: 'Escape to the Nexus (off = block damage only)',
        default: true,
      });
      // The hard floor comes first in the list because it is the number the
      // feature is trusted on: nothing acknowledged past this line is ever
      // sent, so health cannot cross it on the server.
      const floorPercent = context.settings.range('floorPercent', {
        label: 'Refuse damage that would leave below (% health)',
        default: DEFAULT_HEALTH_FLOOR_PERCENT,
        min: 1,
        max: 95,
        step: 1,
      });
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
      // **The knob that decides whether this is a safety net or a panic
      // button**, and it is not the same one as above — see
      // {@link DEFAULT_PREDICTED_THRESHOLD_PERCENT}. Shots that are going to
      // land are the ordinary state of a dungeon; only a forecast that is
      // nearly fatal is worth a map on.
      const predictedThresholdPercent = context.settings.range('predictedThresholdPercent', {
        label: 'Escape on a forecast at or below (% health)',
        default: DEFAULT_PREDICTED_THRESHOLD_PERCENT,
        min: 1,
        max: 95,
        step: 1,
        visibleWhen: { key: 'predictHits', equals: [true] },
      });
      // Every millisecond here is a millisecond of head start for the escape
      // and a millisecond the player had to walk out of the shot instead — see
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
          state = {
            hp: new HpTracker(),
            bullets: new BulletLog(),
            aoes: [],
            escaped: false,
            heldAcks: [],
          };
          bySession.set(session.id, state);
        }
        return state;
      };

      const inSafeZone = (session: SessionView): boolean => isSafeZone(session.world.mapName);

      /**
       * The strictest of the floor and the threshold, as a share of maximum
       * health.
       *
       * Every gate below asks one question against this one line, so a user who
       * sets the threshold above the floor keeps the threshold's old meaning —
       * refuse and leave — and one who leaves it below (the common case: a
       * floor of 30 against a threshold of 25) is protected by the floor
       * without either number having to know about the other.
       */
      const rejectLine = (): number => Math.max(floorPercent.get(), thresholdPercent.get());

      /**
       * Leaves, and says whether it did.
       *
       * The one place the mode is decided. Every gate below asks to leave and
       * lets this say no: with the escape switched off the refusals still
       * happened at the call sites, and they are the whole feature. The return
       * value is for the callers that hold a hit behind the escape — there is
       * no point delaying anything for an escape that did not go out.
       */
      const escape = (session: SessionView, state: SessionNexus, reason: string): boolean => {
        if (!escapeEnabled.get() || state.escaped) return false;
        state.escaped = true;
        session.sendToServer('ESCAPE', {});
        const hp = `${String(Math.round(state.hp.hp))} / ${String(Math.round(state.hp.maxHp))}`;
        session.notify(`Auto-Nexus has triggered an escape action [${hp}] — ${reason}.`);
        context.log.info(`fired ESCAPE (${reason}) at ${hp} hp`);
        return true;
      };

      /**
       * Holds a hit the escape outran, and sends it a moment later.
       *
       * The acknowledgement is the server's record of a conversation it
       * expects to complete, and our own measurements (the table in
       * `features/hazardguard`) say refusing it outright stops nothing: the
       * server applies the damage anyway. Delaying it costs the server
       * nothing it will not wait for, and by the time it arrives the escape
       * has crossed the wire ahead of it — the hit names a character that is
       * no longer on the map, which is the one form of refusal this protocol
       * actually honours.
       */
      const holdAckBehindEscape = (
        session: SessionView,
        state: SessionNexus,
        packetName: string,
        fields: Readonly<Record<string, unknown>>,
      ): void => {
        let pending = true;
        const send = (): void => {
          if (!pending) return;
          pending = false;
          session.sendToServer(packetName, fields);
          context.log.debug(`released a held ${packetName} behind the escape`);
        };
        const cancel = context.timers.setTimeout(send, LETHAL_ACK_RELEASE_MS);
        const held: HeldAck = {
          send,
          cancel: () => {
            if (!pending) return;
            pending = false;
            cancel();
          },
        };
        state.heldAcks.push(held);
      };

      /**
       * Forgets every held hit — a new map means the ones in flight belonged
       * to the map just left, and a dead session means there is nowhere left
       * to send them.
       */
      const dropHeldAcks = (state: SessionNexus, why: string): void => {
        if (state.heldAcks.length === 0) return;
        const count = state.heldAcks.length;
        for (const held of state.heldAcks) held.cancel();
        state.heldAcks.length = 0;
        context.log.debug(`dropped ${String(count)} held hit(s) — ${why}`);
      };

      /**
       * Whether a hit of `damage` would take health to the reject line, asked
       * against health as it stands now.
       *
       * Shared by the three acknowledgement gates, which answer it with three
       * different refusals — what a refusal stops is a property of the damage
       * kind, not of the line, and the table in `features/hazardguard` is what
       * measured it.
       */
      const crossesLine = (session: SessionView, state: SessionNexus, damage: number): boolean =>
        !inSafeZone(session) && state.hp.atOrBelowPercent(rejectLine(), damage);

      /**
       * What a refused hit said, at debug: the floor's refusals are otherwise
       * silent by design, and "did it hold?" is exactly the question a live
       * session ends up asking. One line per refusal, with the numbers the
       * decision was made on.
       */
      const refused = (
        state: SessionNexus,
        kind: string,
        damage: number,
        blocked: boolean,
      ): void => {
        const hp = `${String(Math.round(state.hp.hp))} / ${String(Math.round(state.hp.maxHp))}`;
        context.log.debug(
          `refused ${kind} for ${String(damage)} at ${hp} hp (${blocked ? 'blocked' : 'escapes only'})`,
        );
      };

      const conditionsOf = (session: SessionView): number => session.self.conditions;

      // ── Leaving before the hit lands ────────────────────────────────────

      /**
       * Escapes if the shots already in flight would leave almost nothing.
       *
       * **Against its own floor, and a much lower one.** A shot that is going to
       * land is the ordinary state of a dungeon: it may be dodged, walked out of
       * or predicted wrong, and leaving the map every time one is inbound is a
       * feature nobody can play with. What earns an escape here is a forecast
       * that is nearly fatal — see {@link DEFAULT_PREDICTED_THRESHOLD_PERCENT}
       * for the split, which is the reference implementation's.
       *
       * Nothing here is charged to {@link HpTracker}: a shot that has not
       * connected is not damage, and the acknowledgement — which may never come
       * — is what pays for it. This only ever asks what health *would* be.
       *
       * Silent without the game's projectile data, which is what
       * `world.projectiles()` is built from. That is why the acknowledgement
       * paths below are not merely a backstop: they are the whole feature for a
       * session running without those files.
       */
      const forecast = (session: SessionView): void => {
        // A forecast's only act is leaving, and the timer below takes this
        // path several times a second: with the escape off there is nothing
        // here to decide and no reason to walk the shots.
        if (!escapeEnabled.get() || !predictHits.get()) return;
        const state = stateFor(session);
        if (state.escaped) return;
        const self = session.self;
        if (!self.alive || inSafeZone(session)) return;

        const now = session.world.gameTimeMs;
        const withinMs = predictWithinMs.get();
        const percent = predictedThresholdPercent.get();
        let damage = 0;
        let shots = 0;

        for (const shot of session.world.projectiles()) {
          // **A shot the client has already answered for is spent.** Its damage
          // is on the tracked health already, and `BulletLog.consume` dropping
          // it is how that is known here. Multi-hit shots stay in the world
          // after landing, so counting one twice is not hypothetical — it is
          // the difference between the forecast above and one that invents a
          // second hit the player will never take. The damage is taken from the
          // announcement rather than the shot's data file for the same reason:
          // it is the figure the server will apply.
          const announced = state.bullets.damageOf(shot.ownerId, shot.bulletId);
          if (announced === undefined) continue;
          if (!strikesWithin(now, self, shot, withinMs, FORECAST_SAMPLE_STEP_MS)) continue;

          // Not treated as piercing: unlike an unidentified acknowledgement this
          // is a shot we have seen, and assuming armour does nothing would
          // invent damage rather than round towards safety.
          damage += damageTaken(announced, {
            defense: self.defense,
            conditions: conditionsOf(session),
            piercing: false,
          });
          shots += 1;
          if (!state.hp.atOrBelowPercent(percent, damage)) continue;
          const what = shots === 1 ? 'shot' : 'shots';
          escape(session, state, `forecast: ${String(shots)} ${what} for ${String(damage)}`);
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
          self.hp - perShot * count <= (self.maxHp * rejectLine()) / 100
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
        // The server confirming health already at the line — damage the floor
        // never had a chance to refuse (it arrives with no acknowledgement to
        // hold), so all that is left is to leave before the next one.
        if (!state.escaped && !inSafeZone(session) && state.hp.atOrBelowPercent(rejectLine())) {
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

        // **The server applies this damage whatever happens to the
        // acknowledgement** — it simulates its own bullets against the
        // reported position, and the refusal of a `PLAYERHIT` was measured to
        // stop nothing. So the hit is charged first, unconditionally: a
        // simulation that skipped a "refused" one would read high and stop
        // trusting the line. What follows the charge is the escape's, and the
        // escape's is a delay rather than a refusal: the hit is held back and
        // sent behind the escape, which is the one ordering this protocol
        // honours. With the escape off there is nothing to hide behind, so
        // the hit forwards as it came.
        state.hp.applyHit(damage);
        if (crossesLine(session, state, 0)) {
          refused(state, 'projectile hit', damage, false);
          // The latch at the top of this handler means a false here is the
          // mode switch and nothing else: with the escape off there is
          // nothing to hide the hit behind, so it forwards as it came.
          if (escape(session, state, 'projectile hit')) {
            packet.drop();
            holdAckBehindEscape(session, state, 'PLAYERHIT', { bulletId, objectId });
          }
        }
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
        let inRange = false;
        const kept: PendingAoe[] = [];
        for (const aoe of state.aoes) {
          if (now - aoe.seenAtMs > AOE_MAX_AGE_MS) continue;
          if (Math.hypot(at.x - aoe.x, at.y - aoe.y) > aoe.radius) {
            kept.push(aoe);
            continue;
          }
          inRange = true;
          worst += damageTaken(aoe.damage, {
            defense: self.defense,
            conditions: conditionsOf(session),
            piercing: aoe.piercing,
          });
        }
        state.aoes = kept;
        // **An area effect is the acknowledgement's to carry** — the server
        // applies it from the position this report names, so refusing the
        // report refuses the damage. That is unconditional and safe: the
        // collider plugin ships exactly this refusal for every effect, line
        // or no line. What is charged is only what forwards.
        if (worst > 0) {
          if (crossesLine(session, state, worst)) {
            packet.drop();
            refused(state, 'area effect', worst, true);
            escape(session, state, 'area effect');
            return;
          }
          state.hp.applyHit(worst);
        }

        // Nothing this acknowledgement names is still held, and nothing it
        // named landed on the player. Three very different reasons, and only
        // one of them is worth acting on:
        //
        // * an effect **seen and stood clear of** — `kept` still holds it, and
        //   the server charges nothing for a position outside the radius. This
        //   is the ordinary case: the client answers every effect it renders,
        //   heals and party buffs included, so treating these as damage was
        //   escaping at nearly half health on a heal nobody stood in.
        // * an effect **seen and landed harmlessly** — `inRange` with nothing
        //   to charge, a heal or a buff that landed on the player.
        // * an effect **never seen at all** — not in `kept`, not consumed,
        //   nothing pending. Rare, and the one case with unknown damage behind
        //   it; below the reject line that unknown is refused rather than
        //   gambled on, which is what keeps the floor hard. Above the line it
        //   forwards as it always did — NEWTICK is the backstop there.
        if (!inRange && kept.length === 0 && !inSafeZone(session)) {
          if (state.hp.atOrBelowPercent(rejectLine())) {
            packet.drop();
            refused(state, 'unannounced area effect', 0, true);
            escape(session, state, 'unannounced area effect');
          }
        }
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

        // **Ground is carried by its acknowledgement, but only just.** The
        // server cannot know which tile is under the player until this says
        // so, so refusing it does refuse the damage — and a character that
        // stands in damaging ground saying nothing gets its connection
        // dropped after roughly ten seconds. `hazard-guard` keeps that clock
        // with its windowed refusal, and this floor must not fight it: ground
        // is refused here only alongside an escape, which ends the standoff
        // by leaving. In block-only mode the window hazard-guard already
        // keeps is all there safely is, so the admission forwards and is
        // charged like any other damage that lands.
        if (crossesLine(session, state, damage)) {
          if (escapeEnabled.get()) {
            packet.drop();
            refused(state, 'damaging tile', damage, true);
            escape(session, state, 'damaging tile');
            return;
          }
          refused(state, 'damaging tile', damage, false);
        }
        state.hp.applyHit(damage);
      });

      // ── Last resorts: the server has already decided ────────────────────

      context.packets.onFirst('DAMAGE', (packet, session) => {
        const state = stateFor(session);
        if (state.escaped) return;
        if (packet.number('targetId') !== session.self.objectId) return;
        // The server's own account of damage applied to us — ground truth
        // beside every estimate above, and worth a line at debug because
        // "what actually landed?" is exactly what a live session ends up
        // asking of a floor that is supposed to have refused it.
        context.log.debug(
          `server applied ${String(packet.number('damageAmount') ?? 0)}` +
            (packet.boolean('kill') === true ? ' (lethal)' : ''),
        );
        if (packet.boolean('kill') === true && !inSafeZone(session)) {
          // The server is about to kill us. Keeping the client from rendering
          // it buys the escape its last chance to arrive first — which is why
          // the drop belongs to the escape half: with the escape switched off
          // nothing is racing, and hiding a death nothing can prevent would
          // only make it a mystery.
          if (escapeEnabled.get()) packet.drop();
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
        // First among the resets, because the escape this map answers means
        // the hits held behind it belonged to the map just left — sending one
        // now would be a shot from a place the connection is no longer in.
        dropHeldAcks(state, 'the map changed before their release');
        state.hp.reset();
        state.bullets.clear();
        state.aoes.length = 0;
        state.escaped = false;
      });

      context.sessions.onDisconnected((session) => {
        // The session's view is going away with it, and a held hit's send
        // closes over that view — cancelling keeps the timer from firing into
        // a session that no longer exists.
        dropHeldAcks(stateFor(session), 'the session disconnected');
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
