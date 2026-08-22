/**
 * Auto-ability: uses the item in the ability slot when using it is worth it.
 *
 * **What the ability does is read from the ability, not from the class.** The
 * implementation this came from kept two hand-written sets of class ids — the
 * ones that aim and the ones that self-cast — and left the rest out, so every
 * class the game has added since did nothing at all and a Trickster holding a
 * prism was still classed as "aims at enemies" while the prism teleported him.
 * `objects.xml` states what an item does when it is used, and `gamedata/
 * abilities.ts` reads it: what moves the character, what needs a target, what
 * buffs, what it costs and how long it lasts. Nothing here knows a class id.
 *
 * **Nothing is cast that the player did not equip for.** An ability whose
 * effects the data file describes in terms `abilities.ts` does not recognise is
 * never fired, in the same way an unfamiliar weapon makes auto-aim go quiet:
 * the game adds effects faster than a table learns them, and a timer on an
 * unknown one is a timer on whatever it turns out to do.
 *
 * **It sends `USEITEM`, exactly as the client does for a key press.** The
 * position it names is where the effect lands — an enemy for an aimed ability,
 * the character for a buff — which is the same field the client fills with the
 * mouse. Injected packets do not re-enter the pipeline, so this plugin never
 * sees its own cast and needs no flag to tell one from a real key press.
 *
 * It does not reconcile with auto-drink: mana potions are that plugin's
 * threshold and this one's reserve, and moving somebody's setting on their
 * behalf would be worse than leaving both where they put them.
 */

import {
  PluginCategory,
  definePlugin,
  type Plugin,
  type Position,
  type SessionView,
} from '@brownie/plugin-api';
import { isSafeZone } from '../../constants/SafeZones.js';
import { AbilityUse, type AbilityFacts } from '../../gamedata/abilities.js';
// Auto-aim's, and deliberately not a second copy: which enemies are worth
// pointing something at is one question with one hard-won answer — a wall in
// this game is an object with hit points, and a quarter of what the file marks
// as an enemy can never lose one. Casting into either is the same waste as
// shooting at it. See `autoaim/shootable.ts`.
import { TargetPriority, selectTarget } from '../autoaim/selectTarget.js';
import { isShootable, type ShootableRules } from '../autoaim/shootable.js';

export interface AutoAbilityInputs {
  /**
   * What `objects.xml` says about an ability item. See `ObjectCatalog.item`.
   *
   * Handed over by the composition root because a plugin is not given the
   * object catalog. `undefined` is an item the catalog cannot describe — and
   * for every item at all until the data files have been read — which is what
   * makes this feature do nothing rather than guess.
   */
  readonly ability: (objectType: number) => AbilityFacts | undefined;
  /** Whether an object type is scenery. Same source and reason as {@link ability}. */
  readonly isObstacle: (objectType: number) => boolean;
  /** Whether an object type can never be hurt. Same source and reason. */
  readonly isInvincible: (objectType: number) => boolean;
}

/**
 * The second of the four worn slots, which is the ability everywhere in the
 * game: weapon, ability, armour, ring. See `state/ItemSlots.ts` for the space
 * these ids live in.
 */
const ABILITY_SLOT = 1;

/** `USEITEM.useType` for using something out of one of your own slots. */
const USE_TYPE_SELF = 1;

/**
 * How long a cast by hand holds this off.
 *
 * The point is not the game's cooldown — mana already covers that — but intent:
 * somebody who just pressed the key is using the ability deliberately, and
 * firing again a fifth of a second later spends the mana their next press
 * needed.
 */
const MANUAL_PAUSE_MS = 2000;

/**
 * How long after a map change nothing is cast.
 *
 * Long enough for the client to finish loading and for the server to state the
 * character's mana and slots for the new map. A cast built from the last map's
 * numbers is a cast at a position nothing is standing in.
 */
const MAP_SETTLE_MS = 1000;

/**
 * There is no setting for either.
 *
 * Auto-aim offers them because an invulnerable boss phase ends and a shot in
 * flight can land after it does. An ability is instant and costs mana, so there
 * is no reading under which casting one at a wall is what the player wanted.
 */
const SHOOTABLE: Omit<ShootableRules, 'isObstacle' | 'isInvincible'> = {
  skipUntouchable: true,
  skipObstacles: true,
};

/** When this session may cast again, on the world's clock. */
interface CastClock {
  nextAtMs: number;
}

export function createAutoAbilityPlugin(inputs: AutoAbilityInputs): Plugin {
  return definePlugin({
    meta: {
      id: 'auto-ability',
      name: 'Auto Ability',
      category: PluginCategory.Combat,
      description: 'Uses the equipped ability when there is something to use it on.',
    },

    setup(context) {
      const castAimed = context.settings.boolean('castAimed', {
        label: 'Cast aimed abilities at enemies',
        default: true,
      });
      const castSelf = context.settings.boolean('castSelf', {
        label: 'Cast buffs, auras and heals on yourself',
        default: true,
      });
      const rangeTiles = context.settings.range('rangeTiles', {
        label: 'Look for enemies within (tiles)',
        default: 8,
        min: 3,
        max: 20,
        step: 1,
      });
      // Applies to the self-casts; the aimed ones need a target by definition.
      // On by default because a stun aura in an empty room is mana spent on
      // nothing, and off is for the player who wants a speed buff kept up while
      // walking somewhere.
      const onlyNearEnemies = context.settings.boolean('onlyNearEnemies', {
        label: 'Hold buffs until an enemy is near',
        default: true,
      });
      const mpReservePercent = context.settings.range('mpReservePercent', {
        label: 'Keep at least (% mana)',
        default: 0,
        min: 0,
        max: 90,
        step: 5,
      });
      // A floor under everything the data file says, not the interval itself:
      // what an ability costs and how long it lasts already pace it. This is
      // what stops a free, instant ability from being sent on every tick.
      const minIntervalMs = context.settings.number('minIntervalMs', {
        label: 'Wait between casts (ms)',
        advanced: true,
        default: 700,
        min: 250,
        max: 5000,
        step: 50,
      });

      const rules: ShootableRules = {
        ...SHOOTABLE,
        isObstacle: inputs.isObstacle,
        isInvincible: inputs.isInvincible,
      };

      const bySession = new Map<string, CastClock>();

      const clockFor = (session: SessionView): CastClock => {
        let clock = bySession.get(session.id);
        if (clock === undefined) {
          clock = { nextAtMs: Number.NEGATIVE_INFINITY };
          bySession.set(session.id, clock);
        }
        return clock;
      };

      /** How long to wait after a cast before the next one is worth sending. */
      const intervalOf = (ability: AbilityFacts, aimed: boolean): number => {
        const refreshMs = aimed ? 0 : (ability.refreshMs ?? 0);
        return Math.max(minIntervalMs.get(), ability.cooldownMs ?? 0, refreshMs);
      };

      const nearestEnemy = (session: SessionView): Position | undefined =>
        selectTarget(session.world.enemies(), {
          shooterX: session.self.x,
          shooterY: session.self.y,
          maxRangeTiles: rangeTiles.get(),
          priority: TargetPriority.Closest,
          accept: (enemy) => isShootable(enemy, rules),
        });

      context.packets.on('NEWTICK', (_packet, session) => {
        const self = session.self;
        if (!self.alive || isSafeZone(session.world.mapName)) return;

        const slot = self.inventory.at(ABILITY_SLOT);
        if (slot === undefined || slot.objectType <= 0) return;

        const ability = inputs.ability(slot.objectType);
        if (ability === undefined || ability.use === AbilityUse.Never) return;

        const aimed = ability.use === AbilityUse.Aimed;
        if (!(aimed ? castAimed.get() : castSelf.get())) return;

        const nowMs = session.world.gameTimeMs;
        const clock = clockFor(session);
        if (nowMs < clock.nextAtMs) return;

        // The cost first, then the reserve on top of it: a cast that leaves the
        // bar under what the player asked to keep is one they did not want, and
        // a cast the server refuses for want of mana is a packet sent for
        // nothing. An unstated maximum reserves nothing rather than everything.
        const reserve = self.maxMp > 0 ? (self.maxMp * mpReservePercent.get()) / 100 : 0;
        if (self.mp < ability.mpCost + reserve) return;

        // Where the effect lands. A buff ignores the point — the game centres
        // it on the character whatever the client sent — so it is cast where
        // the character stands, which is a position that is always legal.
        let at: Position = self;
        if (aimed || onlyNearEnemies.get()) {
          const enemy = nearestEnemy(session);
          if (enemy === undefined) return;
          if (aimed) at = enemy;
        }

        session.sendToServer('USEITEM', {
          time: Math.trunc(nowMs),
          slotObject: {
            objectId: self.objectId,
            slotId: ABILITY_SLOT,
            objectType: slot.objectType,
          },
          itemUsePos: { x: at.x, y: at.y },
          useType: USE_TYPE_SELF,
          unknownInt: 0,
        });
        const waitMs = intervalOf(ability, aimed);
        clock.nextAtMs = nowMs + waitMs;
        context.log.debug(
          `cast ${ability.use} 0x${slot.objectType.toString(16)} at ${at.x.toFixed(1)},${at.y.toFixed(1)} for ${String(ability.mpCost)} mp, again in ${String(waitMs)} ms`,
        );
      });

      // `USEITEM` only ever flows from the client, and our own casts are
      // injected past the pipeline — so anything seen here is the player's own
      // key press.
      context.packets.on('USEITEM', (packet, session) => {
        if (packet.opaque) return;
        if (slotIdOf(packet.get('slotObject')) !== ABILITY_SLOT) return;

        const clock = clockFor(session);
        clock.nextAtMs = Math.max(clock.nextAtMs, session.world.gameTimeMs + MANUAL_PAUSE_MS);
      });

      context.packets.on('MAPINFO', (_packet, session) => {
        clockFor(session).nextAtMs = session.world.gameTimeMs + MAP_SETTLE_MS;
      });

      context.onDispose(
        context.sessions.onDisconnected((session) => {
          bySession.delete(session.id);
        }),
      );
      context.onDispose(() => {
        bySession.clear();
      });
    },
  });
}

/** `SlotObject.slotId` out of a decoded `USEITEM`, when it holds one. */
function slotIdOf(slotObject: unknown): number | undefined {
  if (typeof slotObject !== 'object' || slotObject === null || Array.isArray(slotObject)) {
    return undefined;
  }
  const slotId = (slotObject as Record<string, unknown>)['slotId'];
  return typeof slotId === 'number' ? slotId : undefined;
}
