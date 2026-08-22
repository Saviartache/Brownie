/**
 * Push tiles, spoofed: conveyors, whirlpools and sludge reach the client as
 * ordinary ground.
 *
 * **The push is the client's, and it reads it off the tile type.** `<Push />`
 * in `tiles.xml` is the whole of what marks one, and the client applies it to
 * the ground it was told about — so telling it a different ground type is the
 * entire feature. Nothing is sent, nothing is dropped, and no native write is
 * involved: one field of one array on its way past.
 *
 * **Which tiles push comes from the game's own data, not from a list here.**
 * The implementation this came from carried 36 tile *names*, normalised each
 * one and looked it up in a string set for every tile of ground the server
 * revealed. Those 36 names are exactly the 36 grounds `tiles.xml` marks with
 * `<Push />` — so the marker is read instead, which costs one integer lookup
 * per tile and stays right when the game adds the 37th.
 *
 * **The world model keeps the truth.** The state stage runs ahead of every
 * plugin, so the runtime's tile map records the conveyor that actually arrived
 * while the client is told about plain ground. That is the direction that
 * matters: the dodge planner and anything else reading `world.tileAt` go on
 * seeing the map the server sent.
 *
 * **Ground is announced once.** The server sends a tile when it comes into
 * view and never again for that map, so switching this on mid-run affects only
 * ground not yet revealed, and switching it off leaves what was already
 * spoofed spoofed until the next map. Same caveat as anti-lag's removals, for
 * the same reason.
 */

import { PluginCategory, definePlugin, type Plugin } from '@brownie/plugin-api';
import type { FieldValue } from '@brownie/protocol';

/**
 * What the composition root hands over.
 *
 * Whether a ground type pushes lives in the game's own `tiles.xml`, which is
 * not on the plugin surface — the same reason anti-lag is handed its pet
 * lookup. Without game data every answer is "no" and this plugin replaces
 * nothing, rather than replacing tiles it guessed at.
 */
export interface PushTileGameData {
  isPushing(tileType: number): boolean;
}

/**
 * What the client is told instead: `Abyss Fort Tile`, which is plain ground —
 * it does not push, block or hurt.
 *
 * The same default the reference implementation used. Any inert ground would
 * do, and which one is a setting, because the one that looks least out of
 * place depends on the map.
 */
const DEFAULT_REPLACEMENT = 0xb003;

/** `Tile.type` is a `uint16` on the wire; the encoder cannot write more. */
const MAX_TILE_TYPE = 0xffff;

export function createPushTileSpoofPlugin(gameData: PushTileGameData): Plugin {
  return definePlugin({
    meta: {
      id: 'push-tile-spoof',
      name: 'Push Tile Spoof',
      category: PluginCategory.Movement,
      description: 'Replaces conveyors, whirlpools and sludge with ordinary ground.',
    },

    setup(context) {
      const replacementType = context.settings.number('replacementType', {
        label: 'Ground to replace them with (tile type)',
        default: DEFAULT_REPLACEMENT,
        min: 0,
        max: MAX_TILE_TYPE,
        step: 1,
        // The default works everywhere; this is here for somebody who wants
        // the substitute to match the floor around it.
        advanced: true,
      });

      /** The last value refused, so a bad setting says so once and not per packet. */
      let refused: number | undefined;

      /**
       * The ground to substitute, or `undefined` when the setting names one
       * that pushes as well — which would trade a whirlpool for a conveyor.
       *
       * Resolved per packet rather than when the setting moves: the catalogs
       * load asynchronously, so a value checked at setup would have been
       * checked against a catalog that answers "no" to everything.
       */
      const substitute = (): number | undefined => {
        // Rounded rather than trusted. The declared bounds keep the value
        // inside what the encoder can write, but a drag field can still hold
        // 45059.5, and the number reaches the wire as a tile type.
        const wanted = Math.round(replacementType.get());
        if (!gameData.isPushing(wanted)) return wanted;

        if (refused !== wanted) {
          refused = wanted;
          context.log.warn(`tile type ${String(wanted)} pushes too — replacing nothing`);
        }
        return undefined;
      };

      context.packets.on('UPDATE', (packet) => {
        // `set` refuses an opaque packet, and rightly: rebuilding a body from
        // fields that were never read would send something other than what
        // arrived.
        if (packet.opaque) return;

        const tiles = packet.get('tiles');
        if (!Array.isArray(tiles)) return;

        const replacement = substitute();
        if (replacement === undefined) return;
        if (replacePushTiles(tiles, gameData, replacement) === 0) return;

        // The array is the one that arrived, edited in place — so this says
        // "re-encode", not "here is a new value". Said once for the packet
        // rather than once per tile.
        packet.set('tiles', tiles);
      });
    },
  });
}

/**
 * Rewrites every push tile in a decoded `UPDATE.tiles`, in place.
 *
 * In place because a tile keeps its position in the array and only its type
 * changes: rebuilding would allocate an object per tile of ground revealed to
 * say what one field write already says, and a map change reveals thousands.
 *
 * @returns how many tiles were changed, so the caller can leave an untouched
 *   packet to be forwarded from its original bytes.
 */
export function replacePushTiles(
  tiles: readonly FieldValue[],
  gameData: PushTileGameData,
  replacement: number,
): number {
  let changed = 0;
  for (const entry of tiles) {
    const tile = asTile(entry);
    if (tile === undefined) continue;

    const type = tile.type;
    if (typeof type !== 'number' || !gameData.isPushing(type)) continue;

    tile.type = replacement;
    changed++;
  }
  return changed;
}

/**
 * A `Tile` element, as something this module may rewrite.
 *
 * Decoded field values are deeply readonly because *reading* a packet should
 * not imply the right to rewrite it; this module is one of the few that has
 * decided to. Same shape, and same reasoning, as anti-lag's `MutableStatus`.
 */
interface MutableTile {
  type?: FieldValue;
}

function asTile(value: FieldValue | undefined): MutableTile | undefined {
  if (typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as unknown as MutableTile;
}
