/**
 * Auto-drink: quaff a potion when the bar falls past a threshold.
 *
 * **The only autopot.** Auto-nexus escapes and does not drink; the two are
 * separate decisions with separate thresholds, and they interact: a nexus
 * threshold at or above the drink threshold means leaving the map before a
 * potion is ever reached for. Nothing reconciles them — a plugin does not read
 * another plugin's settings, and quietly moving somebody's escape threshold
 * would be worse than leaving it where they put it — so the ordering is theirs
 * to keep, and it is recorded here because it is not visible from either
 * setting alone.
 *
 * What it drinks and where from is read rather than remembered: potions come
 * out of `objects.xml` (see `potions.ts`) and the slots come out of the state
 * layer, which reports a slot only once the server has stated it. So on a build
 * whose belt stats have moved, this drinks from the carried slots and never
 * pretends the belt is empty.
 *
 * Nothing here is predictive. A potion is drunk on health the server has
 * confirmed, because a drink that arrives is worth more than a drink that was
 * early — the packet that beats a hit is auto-nexus's job and it drops the hit
 * to do it.
 */

import { PluginCategory, definePlugin, type Plugin, type SessionView } from '@brownie/plugin-api';
import { ConditionEffect, hasConditionEffect } from '../../constants/ConditionEffect.js';
import { isSafeZone } from '../../constants/SafeZones.js';
import { findPotion } from './findPotion.js';
import { Quaff, quaffKindOf, type ItemLookup } from './potions.js';

export interface AutoDrinkInputs {
  /** What `objects.xml` says about an item. See `ObjectCatalog.item`. */
  readonly item: ItemLookup;
}

/**
 * `USEITEM.useType` for drinking something out of one of your own slots.
 *
 * The reference implementation's value, observed against the live game. A bag
 * is the other case and uses a different one — see auto-loot.
 */
const USE_TYPE_SELF = 1;

/** When the last drink of each kind went out, per session. */
interface DrinkClock {
  health: number;
  magic: number;
}

export function createAutoDrinkPlugin(inputs: AutoDrinkInputs): Plugin {
  return definePlugin({
    meta: {
      id: 'auto-drink',
      name: 'Auto Drink',
      category: PluginCategory.Items,
      description: 'Drinks health and mana potions when the bar falls past a threshold.',
    },

    setup(context) {
      const drinkHealth = context.settings.boolean('drinkHealth', {
        label: 'Drink health potions',
        default: true,
      });
      const healthPercent = context.settings.range('healthPercent', {
        label: 'Drink at or below (% health)',
        default: 70,
        min: 10,
        max: 95,
        step: 5,
      });
      const drinkMagic = context.settings.boolean('drinkMagic', {
        label: 'Drink mana potions',
        default: true,
      });
      const magicPercent = context.settings.range('magicPercent', {
        label: 'Drink at or below (% mana)',
        default: 50,
        min: 10,
        max: 95,
        step: 5,
      });
      const beltFirst = context.settings.boolean('beltFirst', {
        label: 'Drain the potion belt first',
        advanced: true,
        default: true,
      });
      const cooldownMs = context.settings.number('cooldownMs', {
        label: 'Wait between drinks (ms)',
        advanced: true,
        default: 350,
        min: 150,
        max: 2000,
        step: 50,
      });

      const bySession = new Map<string, DrinkClock>();

      const clockFor = (session: SessionView): DrinkClock => {
        let clock = bySession.get(session.id);
        if (clock === undefined) {
          clock = { health: Number.NEGATIVE_INFINITY, magic: Number.NEGATIVE_INFINITY };
          bySession.set(session.id, clock);
        }
        return clock;
      };

      const kindOf = (objectType: number): Quaff | undefined =>
        quaffKindOf(objectType, inputs.item);

      /** @returns true once a potion has been sent, so the tick stops there. */
      const drink = (
        session: SessionView,
        wanted: Quaff,
        current: number,
        maximum: number,
        percent: number,
        lastAtMs: number,
        nowMs: number,
      ): boolean => {
        if (maximum <= 0 || current > (maximum * percent) / 100) return false;
        if (nowMs - lastAtMs < cooldownMs.get()) return false;

        const found = findPotion(session.self.inventory, wanted, kindOf, beltFirst.get());
        if (found === undefined) return false;

        session.sendToServer('USEITEM', {
          time: Math.trunc(nowMs),
          slotObject: {
            objectId: session.self.objectId,
            slotId: found.slotId,
            objectType: found.objectType,
          },
          itemUsePos: { x: session.self.x, y: session.self.y },
          useType: USE_TYPE_SELF,
          unknownInt: 0,
        });
        context.log.debug(
          `drank ${wanted} from slot ${String(found.slotId)} at ${String(Math.round(current))}/${String(Math.round(maximum))}`,
        );
        return true;
      };

      context.packets.on('NEWTICK', (_packet, session) => {
        const self = session.self;
        if (!self.alive || isSafeZone(session.world.mapName)) return;

        const clock = clockFor(session);
        const nowMs = session.world.gameTimeMs;

        // Healing does nothing at all while sick, so a potion drunk then is one
        // thrown away — and the bar stays under the threshold, so it would be
        // every potion carried, one per cooldown, until the effect wore off.
        const canHeal = !hasConditionEffect(self.conditions, ConditionEffect.Sick);
        if (
          drinkHealth.get() &&
          canHeal &&
          drink(
            session,
            Quaff.Health,
            self.hp,
            self.maxHp,
            healthPercent.get(),
            clock.health,
            nowMs,
          )
        ) {
          clock.health = nowMs;
        }

        if (
          drinkMagic.get() &&
          drink(session, Quaff.Magic, self.mp, self.maxMp, magicPercent.get(), clock.magic, nowMs)
        ) {
          clock.magic = nowMs;
        }
      });

      // A map change is not a new session, so the clock survives it — but the
      // character might not, and a drink withheld for 350 ms on arrival costs
      // nothing next to one sent into a map the client has not finished
      // loading.
      context.packets.on('MAPINFO', (_packet, session) => {
        const clock = clockFor(session);
        clock.health = session.world.gameTimeMs;
        clock.magic = session.world.gameTimeMs;
      });

      context.sessions.onDisconnected((session) => {
        bySession.delete(session.id);
      });

      context.onDispose(() => {
        bySession.clear();
      });
    },
  });
}
