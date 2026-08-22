/**
 * Auto-loot: take what is worth taking out of the bag you are standing on.
 *
 * **What counts as a bag, what counts as an item and what counts as a potion
 * all come out of `objects.xml`.** The reference implementation kept four
 * hand-written id tables for those and each of them was already behind the
 * game — its bag list was missing six of the thirty-one containers the file
 * describes, and its potion list three of the variants. Nothing here remembers
 * an id.
 *
 * **The protocol never says a pickup worked.** There is no acknowledgement for
 * "the item you asked for is in slot seven"; what confirms it is the slot
 * filling on a later tick, and a refusal — a bag somebody else emptied first —
 * looks exactly like a slow one. So a move is sent, waited on, and abandoned
 * after {@link PENDING_TIMEOUT_MS}; everything in `LootSession` is that idea.
 *
 * **A move is aimed at a slot the server has stated, never at one assumed to
 * exist.** The state layer reports a slot only when the server has said what is
 * in it, which is what makes an unresolved question about the backpack's stat
 * ids cost nothing: on a build where they have moved, the backpack is simply
 * never used. The `objectType` the swap carries is the second guard — the
 * server refuses a swap whose view of the destination disagrees with its own,
 * so the worst case is a move that does not happen rather than an item thrown
 * into a bag.
 */

import {
  PluginCategory,
  definePlugin,
  type Plugin,
  type PluginContext,
  type SessionView,
  type SettingHandle,
} from '@brownie/plugin-api';
import { isSafeZone } from '../../constants/SafeZones.js';
import { PotionKind, type ContainerFacts, type ItemFacts } from '../../gamedata/items.js';
import type { PermanentStatMaxima } from '../../gamedata/playerClasses.js';
import { isBeltSlot } from '../../state/ItemSlots.js';
import { describeBag } from './announce.js';
import { bagSlotItem, findBags, type NearbyBag } from './bags.js';
import { enlargeBags } from './bigBags.js';
import {
  BAG_SLOT_CLAIM_MS,
  GUARD_LOG_INTERVAL_MS,
  MANUAL_BLOCK_MS,
  MANUAL_PAUSE_MS,
  NOTIFY_RADIUS_TILES,
  ON_TOP_TILES,
  PICKUP_INTERVAL_MS,
  RETRY_ITEM_AFTER_MS,
  SHARED_BAG_DELAY_MS,
  SLOT_CLAIM_MS,
  STATIONARY_TICK_LIMIT,
} from './constants.js';
import { findBeltDestination, findFreeSlot, type Destination } from './destination.js';
import { enchantCount, UNIQUE_DATA_STAT } from './enchants.js';
import { LootSession, bagSlotKey } from './LootSession.js';
import { parseItemList, shouldLoot, type LootPreferences } from './lootRules.js';
import { GUARDED_PACKETS, shouldWithhold, touchesPotions } from './manualGuard.js';

/** What the composition root hands over: the game's own data, read once. */
export interface AutoLootInputs {
  readonly item: (objectType: number) => ItemFacts | undefined;
  readonly container: (objectType: number) => ContainerFacts | undefined;
  readonly statMaxima: (objectType: number) => PermanentStatMaxima | undefined;
  readonly displayName: (objectType: number) => string | undefined;
}

/**
 * `USEITEM.useType` for using something that is still in a bag.
 *
 * The reference implementation's value, observed against the live game — and
 * different from the one for a slot of your own, which auto-drink uses. The
 * position goes out as the origin for the same reason: a bag item is not used
 * *at* anywhere.
 */
const USE_TYPE_FROM_BAG = 0;

/** How the enchant filter's choices map to a count. */
const ENCHANT_CHOICES = [
  ['none', 'No filter'],
  ['uncommon', 'Uncommon — 1 or more'],
  ['rare', 'Rare — 2 or more'],
  ['legendary', 'Legendary — 3 or more'],
  ['divine', 'Divine — 4 or more'],
] as const;

type EnchantChoice = (typeof ENCHANT_CHOICES)[number][0];

const ENCHANT_COUNT: Readonly<Record<EnchantChoice, number>> = {
  none: 0,
  uncommon: 1,
  rare: 2,
  legendary: 3,
  divine: 4,
};

export function createAutoLootPlugin(inputs: AutoLootInputs): Plugin {
  return definePlugin({
    meta: {
      id: 'auto-loot',
      name: 'Auto Loot',
      category: PluginCategory.Items,
      description: 'Takes what you asked for out of the bag you are standing on.',
    },

    setup(context) {
      const tiers = 'Tiers';
      const taking = 'What to take';
      const behaviour = 'Behaviour';

      const minWeaponTier = tierSetting(context, 'minWeaponTier', 'Weapons', 11, tiers);
      const minAbilityTier = tierSetting(context, 'minAbilityTier', 'Abilities', 6, tiers);
      const minArmorTier = tierSetting(context, 'minArmorTier', 'Armour', 11, tiers);
      const minRingTier = tierSetting(context, 'minRingTier', 'Rings', 6, tiers);

      const untiered = context.settings.boolean('untiered', {
        label: 'Untiered (UT) items',
        group: taking,
        default: true,
      });
      const setItems = context.settings.boolean('setItems', {
        label: 'Set (ST) items',
        group: taking,
        default: false,
      });
      const healthPotions = context.settings.boolean('healthPotions', {
        label: 'Health potions',
        group: taking,
        default: false,
      });
      const magicPotions = context.settings.boolean('magicPotions', {
        label: 'Mana potions',
        group: taking,
        default: false,
      });
      const statPotions = context.settings.boolean('statPotions', {
        label: 'Stat potions',
        group: taking,
        default: true,
      });
      const lifeManaPotions = context.settings.boolean('lifeManaPotions', {
        label: 'Life and mana potions',
        group: taking,
        default: true,
      });
      const eggs = context.settings.boolean('eggs', {
        label: 'Pet eggs',
        group: taking,
        default: false,
      });
      const marks = context.settings.boolean('marks', {
        label: 'Exaltation marks',
        group: taking,
        default: false,
      });
      const minEnchants = context.settings.select<EnchantChoice>('minEnchants', {
        label: 'Enchants an item must carry',
        group: taking,
        advanced: true,
        default: 'none',
        options: ENCHANT_CHOICES,
      });
      const always = context.settings.text('always', {
        label: 'Always take (object ids)',
        group: taking,
        advanced: true,
        default: '',
        maxLength: 4096,
      });
      const never = context.settings.text('never', {
        label: 'Never take (object ids)',
        group: taking,
        advanced: true,
        default: '',
        maxLength: 4096,
      });

      const useBackpack = context.settings.boolean('useBackpack', {
        label: 'Use the backpack',
        group: behaviour,
        default: true,
      });
      const backpackFirst = context.settings.boolean('backpackFirst', {
        label: 'Fill the backpack first',
        group: behaviour,
        advanced: true,
        default: false,
      });
      const waitOnSharedBags = context.settings.boolean('waitOnSharedBags', {
        label: 'Give others a moment on shared bags',
        group: behaviour,
        default: true,
      });
      const pauseWhenIdle = context.settings.boolean('pauseWhenIdle', {
        label: 'Stop while standing still',
        group: behaviour,
        default: true,
      });
      const drinkStatPotions = context.settings.boolean('drinkStatPotions', {
        label: 'Drink stat potions straight from the bag',
        group: behaviour,
        advanced: true,
        default: false,
      });
      const guardManualPotions = context.settings.boolean('guardManualPotions', {
        label: 'Stand down when you move a potion yourself',
        group: behaviour,
        advanced: true,
        default: true,
      });
      const announceBags = context.settings.boolean('announceBags', {
        label: 'Say when a bag appears',
        group: behaviour,
        default: false,
      });
      const bigBags = context.settings.boolean('bigBags', {
        label: 'Draw loot bags larger',
        group: behaviour,
        default: false,
      });

      /**
       * The rules, resolved once and again whenever one of them moves.
       *
       * Rebuilt on change rather than read per item: a tick over a full bag
       * asks eight times, and two of these are lists that have to be parsed.
       */
      const readPreferences = (): LootPreferences => ({
        minWeaponTier: minWeaponTier.get(),
        minAbilityTier: minAbilityTier.get(),
        minArmorTier: minArmorTier.get(),
        minRingTier: minRingTier.get(),
        untiered: untiered.get(),
        setItems: setItems.get(),
        healthPotions: healthPotions.get(),
        magicPotions: magicPotions.get(),
        statPotions: statPotions.get(),
        lifeManaPotions: lifeManaPotions.get(),
        eggs: eggs.get(),
        marks: marks.get(),
        minEnchants: ENCHANT_COUNT[minEnchants.get()],
        always: parseItemList(always.get()),
        never: parseItemList(never.get()),
      });

      let preferences = readPreferences();
      const refresh = (): void => {
        preferences = readPreferences();
      };
      for (const handle of [
        minWeaponTier,
        minAbilityTier,
        minArmorTier,
        minRingTier,
        untiered,
        setItems,
        healthPotions,
        magicPotions,
        statPotions,
        lifeManaPotions,
        eggs,
        marks,
        minEnchants,
        always,
        never,
      ]) {
        context.onDispose(handle.onChange(refresh));
      }

      const bySession = new Map<string, LootSession>();
      const stateFor = (session: SessionView): LootSession => {
        let state = bySession.get(session.id);
        if (state === undefined) {
          state = new LootSession();
          bySession.set(session.id, state);
        }
        return state;
      };

      const isPotion = (objectType: number): boolean =>
        inputs.item(objectType)?.potion !== undefined;

      // ── Taking things ────────────────────────────────────────────────────

      /** Whether the potion would raise a stat that is already at its ceiling. */
      const alreadyCapped = (session: SessionView, facts: ItemFacts): boolean => {
        const raises = facts.potion?.raises;
        if (raises === undefined) return false;
        const maxima = inputs.statMaxima(session.self.objectType);
        // No data for this class is not a reason to skip a potion; it is a
        // reason not to claim to know.
        if (maxima === undefined) return false;
        const ceiling = maxima[raises];
        return ceiling > 0 && session.self.permanentStats[raises] >= ceiling;
      };

      const destinationFor = (
        session: SessionView,
        state: LootSession,
        objectType: number,
        facts: ItemFacts | undefined,
        nowMs: number,
      ): Destination | undefined => {
        const inventory = session.self.inventory;
        const claimed = (slotId: number): boolean => state.slots.held(slotId, nowMs);

        const kind = facts?.potion?.kind;
        if (facts !== undefined && (kind === PotionKind.Heal || kind === PotionKind.Magic)) {
          const belt = findBeltDestination(inventory, objectType, facts.beltStack, claimed);
          if (belt !== undefined) return belt;
        }
        return findFreeSlot(inventory, useBackpack.get(), backpackFirst.get(), claimed);
      };

      /** @returns true once something has been sent, so the tick stops there. */
      const takeFrom = (
        session: SessionView,
        state: LootSession,
        bag: NearbyBag,
        nowMs: number,
      ): boolean => {
        const uniqueData = bag.entity.text(UNIQUE_DATA_STAT);

        for (let slot = 0; slot < bag.facts.slots; slot += 1) {
          const objectType = bagSlotItem(bag.entity, slot);
          if (objectType <= 0) continue;

          const key = bagSlotKey(bag.entity.objectId, slot, objectType);
          if (state.bagSlots.held(key, nowMs) || state.attempts.held(key, nowMs)) continue;

          const facts = inputs.item(objectType);

          if (
            drinkStatPotions.get() &&
            facts?.potion?.kind === PotionKind.Permanent &&
            !alreadyCapped(session, facts)
          ) {
            drinkFromBag(session, bag, slot, objectType);
            state.lastActionAtMs = nowMs;
            state.attempts.hold(key, nowMs + RETRY_ITEM_AFTER_MS);
            return true;
          }

          const candidate = {
            objectType,
            facts,
            name: inputs.displayName(objectType) ?? '',
            enchants: enchantCount(uniqueData, slot),
          };
          if (!shouldLoot(candidate, preferences)) continue;

          const destination = destinationFor(session, state, objectType, facts, nowMs);
          // Nowhere to put it is a fact about the whole inventory, not about
          // this slot, so there is nothing further in this bag to try.
          if (destination === undefined) return false;

          moveFromBag(session, bag, slot, objectType, destination);

          const kind = facts?.potion?.kind;
          const quaffable = kind === PotionKind.Heal || kind === PotionKind.Magic;
          state.lastActionAtMs = nowMs;
          state.attempts.hold(key, nowMs + RETRY_ITEM_AFTER_MS);
          state.startPending({
            slotId: destination.slotId,
            expectedQuantity: destination.expectedQuantity,
            sinceMs: nowMs,
            potion: quaffable,
          });
          // A potion is the case where the evidence lags: a belt slot's count
          // is the only sign it landed. Claim both ends for long enough that a
          // late confirmation cannot be read as "it never arrived".
          if (quaffable || isBeltSlot(destination.slotId)) {
            state.slots.hold(destination.slotId, nowMs + SLOT_CLAIM_MS);
            state.bagSlots.hold(key, nowMs + BAG_SLOT_CLAIM_MS);
            state.blockUntilMs = Math.max(state.blockUntilMs, nowMs + MANUAL_BLOCK_MS);
          }
          return true;
        }
        return false;
      };

      const drinkFromBag = (
        session: SessionView,
        bag: NearbyBag,
        slot: number,
        objectType: number,
      ): void => {
        session.sendToServer('USEITEM', {
          time: Math.trunc(session.world.gameTimeMs),
          slotObject: { objectId: bag.entity.objectId, slotId: slot, objectType },
          itemUsePos: { x: 0, y: 0 },
          useType: USE_TYPE_FROM_BAG,
          unknownInt: 0,
        });
        context.log.debug(`drank ${String(objectType)} from bag ${String(bag.entity.objectId)}`);
      };

      const moveFromBag = (
        session: SessionView,
        bag: NearbyBag,
        slot: number,
        objectType: number,
        destination: Destination,
      ): void => {
        session.sendToServer('INVENTORYSWAP', {
          time: Math.trunc(session.world.gameTimeMs),
          position: { x: session.self.x, y: session.self.y },
          slotObject1: { objectId: bag.entity.objectId, slotId: slot, objectType },
          slotObject2: {
            objectId: session.self.objectId,
            slotId: destination.slotId,
            objectType: destination.objectType,
          },
          tickId: 0,
        });
        context.log.debug(
          `took ${String(objectType)} from bag ${String(bag.entity.objectId)} into slot ${String(destination.slotId)}`,
        );
      };

      // ── The tick ─────────────────────────────────────────────────────────

      const announce = (session: SessionView, state: LootSession, bags: NearbyBag[]): void => {
        for (const bag of bags) {
          if (state.announced.has(bag.entity.objectId)) continue;
          state.announced.add(bag.entity.objectId);
          const name = inputs.displayName(bag.entity.objectType) ?? 'Bag';
          session.notify(
            `${name} (${bag.distanceTiles.toFixed(1)}t): ${describeBag(bag, inputs.displayName)}`,
            'Auto Loot',
          );
        }
      };

      /** Drops what is remembered about bags that are no longer in the world. */
      const forgetGoneBags = (session: SessionView, state: LootSession): void => {
        for (const objectId of state.bagSeenAtMs.keys()) {
          if (session.world.entity(objectId) === undefined) state.bagSeenAtMs.delete(objectId);
        }
        for (const objectId of state.announced) {
          if (session.world.entity(objectId) === undefined) state.announced.delete(objectId);
        }
      };

      context.packets.on('NEWTICK', (_packet, session) => {
        const self = session.self;
        if (!self.alive || isSafeZone(session.world.mapName)) return;

        const state = stateFor(session);
        const nowMs = session.world.gameTimeMs;

        state.trackMovement(self.x, self.y);
        state.expire(nowMs);
        state.resolvePending(self.inventory, nowMs);

        const bags = findBags(session.world, self, inputs.container, NOTIFY_RADIUS_TILES);
        for (const bag of bags) {
          // First seen when it *appeared*, not when it was stepped on — which
          // is what makes the shared-bag delay a moment for whoever else is in
          // the room rather than a moment after arriving.
          if (!state.bagSeenAtMs.has(bag.entity.objectId)) {
            state.bagSeenAtMs.set(bag.entity.objectId, nowMs);
          }
        }
        if (announceBags.get()) announce(session, state, bags);
        forgetGoneBags(session, state);

        if (nowMs < state.pauseUntilMs) return;
        if (pauseWhenIdle.get() && state.stationaryTicks > STATIONARY_TICK_LIMIT) return;
        if (state.pending !== undefined) return;

        let standingOnOne = false;
        for (const bag of bags) {
          // Nearest first, so the first one out of reach ends the search.
          if (bag.distanceTiles > ON_TOP_TILES) break;
          standingOnOne = true;

          if (waitOnSharedBags.get() && bag.facts.shared) {
            const seenAtMs = state.bagSeenAtMs.get(bag.entity.objectId) ?? nowMs;
            if (nowMs - seenAtMs < SHARED_BAG_DELAY_MS) continue;
          }
          if (nowMs - state.lastActionAtMs < PICKUP_INTERVAL_MS) continue;
          if (takeFrom(session, state, bag, nowMs)) return;
        }

        // Off every bag: the next one stepped on is emptied without waiting.
        if (!standingOnOne) state.lastActionAtMs = Number.NEGATIVE_INFINITY;
      });

      // ── The player's own hands ───────────────────────────────────────────

      for (const packetName of GUARDED_PACKETS) {
        context.packets.on(packetName, (packet, session) => {
          if (!guardManualPotions.get()) return;
          if (!touchesPotions(packet, isPotion, isBeltSlot)) return;

          const state = stateFor(session);
          const nowMs = session.world.gameTimeMs;

          if (
            shouldWithhold(packet.name, state.pending?.potion === true, nowMs < state.blockUntilMs)
          ) {
            packet.drop();
            if (nowMs - state.lastGuardLogAtMs >= GUARD_LOG_INTERVAL_MS) {
              state.lastGuardLogAtMs = nowMs;
              context.log.info(`withheld ${packet.name}: a pickup of ours is still settling`);
            }
          } else {
            // Standing down cancels what is in flight as well: whatever the
            // player is doing is a better guide to where their items are than
            // a move we sent before they started.
            state.attempts.clear();
            state.slots.clear();
            state.bagSlots.clear();
          }
          state.pauseUntilMs = Math.max(state.pauseUntilMs, nowMs + MANUAL_PAUSE_MS);
        });
      }

      // ── Making bags visible ──────────────────────────────────────────────

      context.packets.on('UPDATE', (packet, _session) => {
        if (!bigBags.get() || packet.opaque) return;
        enlargeBags(packet, (objectType) => inputs.container(objectType) !== undefined);
      });

      // ── Lifecycle ────────────────────────────────────────────────────────

      // An object id is only unique within a map, so everything remembered
      // about a bag is about a bag that no longer exists.
      context.packets.on('MAPINFO', (_packet, session) => {
        stateFor(session).reset();
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

function tierSetting(
  context: PluginContext,
  key: string,
  label: string,
  fallback: number,
  group: string,
): SettingHandle<number> {
  return context.settings.range(key, {
    label: `${label} — lowest tier to take`,
    group,
    default: fallback,
    min: 0,
    max: 20,
    step: 1,
  });
}
