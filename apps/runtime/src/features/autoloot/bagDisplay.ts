/**
 * Auto-loot's other half: making bags easy to find, whether or not anything is
 * being taken out of them.
 *
 * **None of it is behind the plugin's switch.** The switch, and the key bound
 * to it, is the *taking* — a player may hold the key down only while standing
 * on a bag — while a bag drawn larger, a quest arrow turned towards the white
 * one and a line saying one appeared are what get them to the bag in the first
 * place, so they are wanted the whole time. Each answers to a setting of its
 * own instead, and every subscription here is made `whileDisabled`.
 */

import type { PluginContext, SessionView } from '@brownie/plugin-api';
import { isSafeZone } from '../../constants/SafeZones.js';
import type { ContainerFacts } from '../../gamedata/items.js';
import { describeBag } from './announce.js';
import { findBags } from './bags.js';
import { enlargeBags } from './bigBags.js';
import { NOTIFY_RADIUS_TILES } from './constants.js';
import { pickQuestBag, QuestArrow } from './questArrow.js';

/** The game's own data, as far as showing a bag needs it. */
export interface BagDisplayInputs {
  readonly container: (objectType: number) => ContainerFacts | undefined;
  readonly displayName: (objectType: number) => string | undefined;
}

/** What showing bags remembers about one connection. */
interface ShownBags {
  /** Bags already announced, so each is announced once. */
  readonly announced: Set<number>;
  readonly arrow: QuestArrow;
}

/**
 * Declares the display settings and subscribes everything they drive.
 *
 * Called from auto-loot's `setup` once its own settings are declared, so these
 * come after them in its panel, under a heading of their own.
 */
export function registerBagDisplay(context: PluginContext, inputs: BagDisplayInputs): void {
  const display = 'Display';
  const announceBags = context.settings.boolean('announceBags', {
    label: 'Say when a bag appears',
    group: display,
    default: false,
  });
  const bigBags = context.settings.boolean('bigBags', {
    label: 'Draw loot bags larger',
    group: display,
    default: false,
  });
  const questBags = context.settings.boolean('questBags', {
    label: 'Point the quest arrow at white and orange bags',
    group: display,
    default: true,
  });

  const bySession = new Map<string, ShownBags>();
  const shownFor = (session: SessionView): ShownBags => {
    let shown = bySession.get(session.id);
    if (shown === undefined) {
      shown = { announced: new Set(), arrow: new QuestArrow() };
      bySession.set(session.id, shown);
    }
    return shown;
  };

  // ── Saying when a bag appears ────────────────────────────────────────

  const announce = (session: SessionView, shown: ShownBags): void => {
    const self = session.self;
    // A bag is announced so the player can decide whether to walk back for it,
    // and where nothing is looted there is nothing to walk back for.
    if (!self.alive || isSafeZone(session.world.mapName)) return;

    for (const bag of findBags(session.world, self, inputs.container, NOTIFY_RADIUS_TILES)) {
      if (shown.announced.has(bag.entity.objectId)) continue;
      shown.announced.add(bag.entity.objectId);
      const name = inputs.displayName(bag.entity.objectType) ?? 'Bag';
      session.notify(
        `${name} (${bag.distanceTiles.toFixed(1)}t): ${describeBag(bag, inputs.displayName)}`,
        'Auto Loot',
      );
    }
  };

  /** Drops what is remembered about bags that are no longer in the world. */
  const forgetGoneBags = (session: SessionView, shown: ShownBags): void => {
    for (const objectId of shown.announced) {
      if (session.world.entity(objectId) === undefined) shown.announced.delete(objectId);
    }
  };

  // ── Pointing the quest arrow at a bag ────────────────────────────────

  /**
   * Tells the client what its quest arrow points at, when that changes.
   *
   * Straight down the link rather than through the pipeline, so the world
   * model keeps the server's own quest — which is exactly what the arrow is
   * pointed back at. See `questArrow.ts`.
   */
  const pointArrow = (session: SessionView, bagId: number | undefined): void => {
    const world = session.world;
    const objectId = shownFor(session).arrow.next(bagId, world.questObjectId, world.gameTimeMs);
    if (objectId === undefined) return;
    // The list, empty, because the client reads one after the id whether or
    // not anything is in it — a packet that stops at the id is one it reads
    // past the end of. Its quest arrow never looks at the list.
    session.sendToClient('QUESTOBJECTID', { objectId, questList: [] });
  };

  // Its own tick rather than a step of the looting one: that one stands down
  // in safe zones, while idle, while a move is pending and whenever the switch
  // is off, and none of those is a reason to stop showing a bag.
  context.packets.on(
    'NEWTICK',
    (_packet, session) => {
      const shown = shownFor(session);
      if (announceBags.get()) announce(session, shown);
      forgetGoneBags(session, shown);

      const bag =
        questBags.get() && session.self.alive
          ? pickQuestBag(
              findBags(session.world, session.self, inputs.container, Number.POSITIVE_INFINITY),
            )
          : undefined;
      pointArrow(session, bag?.entity.objectId);
    },
    { whileDisabled: true },
  );

  // The server moving its quest while the arrow is on a bag. Held back rather
  // than passed on, or the arrow would leave the bag; the world model has
  // already recorded it, and it is named again once no bag is wanted.
  context.packets.on(
    'QUESTOBJECTID',
    (packet, session) => {
      if (bySession.get(session.id)?.arrow.pointingAtBag === true) packet.drop();
    },
    { whileDisabled: true },
  );

  // Pointed back the moment the setting goes off rather than on the next tick.
  context.onDispose(
    questBags.onChange((on) => {
      if (on) return;
      for (const session of context.sessions.all()) pointArrow(session, undefined);
    }),
  );

  // ── Drawing bags larger ──────────────────────────────────────────────

  context.packets.on(
    'UPDATE',
    (packet) => {
      if (!bigBags.get() || packet.opaque) return;
      enlargeBags(packet, (objectType) => inputs.container(objectType) !== undefined);
    },
    { whileDisabled: true },
  );

  // ── Lifecycle ────────────────────────────────────────────────────────

  // An object id is only unique within a map, so a bag remembered across one
  // is a different object wearing the same number — and a bag the arrow is on
  // is one the client must stop looking for, before it has a map in which that
  // id is something else.
  context.packets.on(
    'MAPINFO',
    (_packet, session) => {
      shownFor(session).announced.clear();
      pointArrow(session, undefined);
    },
    { whileDisabled: true },
  );

  context.onDispose(
    context.sessions.onDisconnected((session) => {
      bySession.delete(session.id);
    }),
  );

  // Switching the plugin off leaves all of this running, so unloading it is
  // the one moment besides the setting that the arrow has to be handed back.
  context.onDispose(() => {
    for (const session of context.sessions.all()) pointArrow(session, undefined);
    bySession.clear();
  });
}
