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
 * exist**, and three guards keep it that way — each of them bought with a live
 * session. The state layer reports a slot only when the server has said what is
 * in it, so a build that moved the backpack's stat ids means the backpack goes
 * unused rather than mis-addressed. What is free is then worked out in full
 * *before* a bag is looked at, against the game's own item data, so a group of
 * stats that is not the inventory is recognised as such instead of being aimed
 * into to find out — see `destination.ts`. And the `objectType` the swap
 * carries is checked by the server against its own view, so a mistaken "this
 * slot is empty" is refused rather than acted on.
 *
 * **A refusal is not held against the item.** Silence is all a refused move
 * ever gets, and a bag that merely answered slowly gives exactly the same
 * silence — so treating one lost move as a verdict on the item is how a bag
 * that was perfectly takeable ends up abandoned after a single miss. A move
 * that never arrives is given up on and the item left free to be tried again,
 * paced only by its own retry cooldown and the never-reset spacing floor, which
 * are what keep the retries from becoming a packet a second.
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
  MANUAL_BLOCK_MS,
  MANUAL_PAUSE_MS,
  NOTIFY_RADIUS_TILES,
  ON_TOP_TILES,
  PICKUP_INTERVAL_MS,
  RETRY_ITEM_AFTER_MS,
  STATIONARY_TICK_LIMIT,
} from './constants.js';
import { findBeltDestination, freeSlots, type Destination } from './destination.js';
import { droppedObjectType } from './droppedItems.js';
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
        label: 'Health potions — top up the belt',
        group: taking,
        default: true,
      });
      const magicPotions = context.settings.boolean('magicPotions', {
        label: 'Mana potions — top up the belt',
        group: taking,
        default: true,
      });
      // Topping the belt up and hoarding spares are different wants, and the
      // reference implementation had one switch for both — so anybody who
      // wanted their belt kept full got their inventory filled with the
      // overflow as well. This governs only the quaff potions the belt has no
      // room for; the permanent life/mana ones are stat potions with their own
      // toggle and are not spares.
      const sparePotions = context.settings.boolean('sparePotions', {
        label: 'Also take spare potions into the inventory',
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

      // On, the backpack is overflow behind the main inventory — both fill, main
      // first. Off, only the main inventory is used.
      const useBackpack = context.settings.boolean('useBackpack', {
        label: 'Use the backpack',
        group: behaviour,
        default: true,
      });
      const pauseWhenIdle = context.settings.boolean('pauseWhenIdle', {
        label: 'Stop while standing still',
        group: behaviour,
        default: true,
      });
      // Exposed because where the server's real limit sits is not known: four
      // hundred milliseconds between two moves ends the session and seven
      // seconds plainly does not, and nothing has been measured in between.
      const pickupIntervalMs = context.settings.number('pickupIntervalMs', {
        label: 'Least time between pickups (ms)',
        group: behaviour,
        advanced: true,
        default: PICKUP_INTERVAL_MS,
        min: 400,
        max: 5000,
        step: 100,
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
      const skipDropped = context.settings.boolean('skipDropped', {
        label: "Leave an item alone once you've dropped it",
        group: behaviour,
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
      /** What tells an inventory slot from a stat that is not one at all. */
      const isItem = (objectType: number): boolean => inputs.item(objectType) !== undefined;

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

      /**
       * @param free The slots already known to be free, nearest to being
       *   filled first — worked out before any of this, which is what keeps a
       *   pickup from being the thing that finds out whether a slot was free.
       * @returns true once something has been sent, so the tick stops there.
       */
      const takeFrom = (
        session: SessionView,
        state: LootSession,
        bag: NearbyBag,
        free: readonly Destination[],
        nowMs: number,
      ): boolean => {
        const uniqueData = bag.entity.text(UNIQUE_DATA_STAT);

        for (let slot = 0; slot < bag.facts.slots; slot += 1) {
          const objectType = bagSlotItem(bag.entity, slot);
          if (objectType <= 0) continue;

          const key = bagSlotKey(bag.entity.objectId, slot, objectType);
          if (state.attempts.held(key, nowMs)) continue;
          // Something the player has dropped or dumped back is left where they
          // put it — grabbing it again is the tug-of-war this avoids.
          if (skipDropped.get() && state.droppedTypes.has(objectType)) continue;

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

          const kind = facts?.potion?.kind;
          const quaffable = kind === PotionKind.Heal || kind === PotionKind.Magic;

          // The belt first for a quaff potion: one belt slot holds six, so it
          // is six inventory slots the player keeps, and it is where they are
          // reached for from.
          const belt =
            quaffable && facts !== undefined
              ? findBeltDestination(session.self.inventory, objectType, facts.beltStack, isItem)
              : undefined;

          // A *quaff* potion the belt has no room for is a spare, and spares are
          // a separate question from topping the belt up: filling the inventory
          // with them is what most players do not want, so it is asked for
          // rather than assumed. This is only about quaff potions — a permanent
          // life/mana one raises the cap and is a stat potion wanted in its own
          // right, taken through its own toggle like any other. This is about
          // the item, not the bag, so the rest of the bag is still worth a look.
          if (belt === undefined && quaffable && !sparePotions.get()) continue;

          const destination = belt ?? free[0];
          // Nowhere to put it is a fact about the whole inventory, not about
          // this slot, so there is nothing further in this bag to try.
          if (destination === undefined) return false;

          moveFromBag(session, bag, slot, objectType, destination);

          state.lastActionAtMs = nowMs;
          state.attempts.hold(key, nowMs + RETRY_ITEM_AFTER_MS);
          state.startPending({
            slotId: destination.slotId,
            expectedQuantity: destination.expectedQuantity,
            source: { objectId: bag.entity.objectId, slot, objectType },
            sinceMs: nowMs,
            potion: quaffable,
          });
          // A potion is still the one thing the player's own hands are likely
          // to be doing at the same moment, so it holds their potion packets
          // back for the window in which ours is settling.
          if (quaffable) {
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
          // The client's own clock, never the connection's: a packet stamped
          // with the wrong one is dropped by the server without a word.
          time: Math.trunc(session.world.clientTimeMs),
          slotObject: { objectId: bag.entity.objectId, slotId: slot, objectType },
          itemUsePos: { x: 0, y: 0 },
          useType: USE_TYPE_FROM_BAG,
          unknownInt: 0,
        });
      };

      const moveFromBag = (
        session: SessionView,
        bag: NearbyBag,
        slot: number,
        objectType: number,
        destination: Destination,
      ): void => {
        // **`tickId` is deliberately absent, and the live game said so.**
        // `packet-definitions.json` carries it as a trailing optional, and
        // filling it in was tried: every swap — including the stack join that
        // had been working — came back `FAILURE [0] Bad message received`,
        // which is the server failing to *parse* the packet rather than
        // refusing what it asked for. Four bytes this build does not expect.
        session.sendToServer('INVENTORYSWAP', {
          // The client's own clock, never the connection's: a packet stamped
          // with the wrong one is dropped by the server without a word.
          time: Math.trunc(session.world.clientTimeMs),
          position: { x: session.self.x, y: session.self.y },
          slotObject1: { objectId: bag.entity.objectId, slotId: slot, objectType },
          slotObject2: {
            objectId: session.self.objectId,
            slotId: destination.slotId,
            objectType: destination.objectType,
          },
        });
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

      /**
       * Whether the bag a move came out of has been seen to change.
       *
       * The other half of "did that happen?", and the half that keeps the next
       * swap from being aimed with a picture of the bag from before the last
       * one. A bag that is gone entirely counts — there is nothing left to be
       * stale about.
       */
      const sourceCleared =
        (session: SessionView) =>
        (move: { source: { objectId: number; slot: number; objectType: number } }): boolean => {
          const bag = session.world.entity(move.source.objectId);
          if (bag === undefined) return true;
          return bagSlotItem(bag, move.source.slot) !== move.source.objectType;
        };

      /** Drops what is remembered about bags that are no longer in the world. */
      const forgetGoneBags = (session: SessionView, state: LootSession): void => {
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

        // A move that was never seen to arrive is one the server did not carry
        // out, and it never says why. Clearing it frees the item to be tried
        // again: a refusal is not held against it, because a bag that is only
        // slow to answer looks exactly like one that refused, and the spacing
        // floor plus the per-item cooldown already keep the retries safe.
        state.resolvePending(self.inventory, sourceCleared(session), nowMs);

        const bags = findBags(session.world, self, inputs.container, NOTIFY_RADIUS_TILES);
        if (announceBags.get()) announce(session, state, bags);
        forgetGoneBags(session, state);

        if (nowMs < state.pauseUntilMs) return;

        // Nearest first, so nothing is in reach once the nearest is not.
        const nearest = bags[0];
        const onBag = nearest !== undefined && nearest.distanceTiles <= ON_TOP_TILES;

        // Standing still is how an idle player is told from one at work — but
        // standing on a bag *is* the work. Left to count, waiting there for the
        // next pickup reads as going idle and the looting stops with the bag
        // still half full, which is what "I stood there and it took one and
        // quit" was.
        if (pauseWhenIdle.get() && !onBag && state.stationaryTicks > STATIONARY_TICK_LIMIT) return;
        if (state.pending !== undefined) return;

        // **One floor for everything this sends, and it is never reset.** The
        // reference implementation reset the spacing whenever the player stood
        // on no bag, so the first take from each new bag went out at once — and
        // two moves four hundred milliseconds apart, one per bag, is what the
        // server hangs up on. See `PICKUP_INTERVAL_MS`.
        if (nowMs - state.lastActionAtMs < pickupIntervalMs.get()) return;

        if (!onBag) return;

        // **What is free is settled here, before a bag is read.** A pickup is
        // then aimed at a slot that is already known to be free rather than
        // being the thing that finds out whether it was.
        const free = freeSlots(self.inventory, {
          useBackpack: useBackpack.get(),
          isItem,
        });

        for (const bag of bags) {
          if (bag.distanceTiles > ON_TOP_TILES) break;
          if (takeFrom(session, state, bag, free, nowMs)) return;
        }
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
          } else {
            // Standing down cancels what is in flight as well: whatever the
            // player is doing is a better guide to where their items are than
            // a move we sent before they started.
            state.attempts.clear();
          }
          state.pauseUntilMs = Math.max(state.pauseUntilMs, nowMs + MANUAL_PAUSE_MS);
        });
      }

      // An item the player pushes out of their inventory — dropped on the ground
      // or dumped back into the bag — is one they do not want, so its type is
      // remembered and left alone for the rest of the map.
      for (const packetName of ['INVDROP', 'INVENTORYSWAP']) {
        context.packets.on(packetName, (packet, session) => {
          if (!skipDropped.get()) return;
          const objectType = droppedObjectType(packet, session.self.objectId);
          if (objectType !== undefined) stateFor(session).droppedTypes.add(objectType);
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
