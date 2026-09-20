/**
 * Builds `sprites.bin` — the picture side of the game data.
 *
 * The runtime's settings draw a grid of the game's own item art, and the
 * overlay that draws it is a native module inside the game's process: shipping
 * it pixels over the pipe would push megabytes through a link meant for
 * hundred-byte records. So the extraction repacks what the chooser needs into
 * one small atlas — every item and every dungeon portal, each addressed by the
 * object type the rest of the data is addressed by — and the runtime hands the
 * overlay nothing but the file's path.
 */

import {
  findAssetsByName,
  readTextAsset,
  readTexture2D,
  type TextureAsset,
} from './unity/SerializedFile.js';
import { readSpriteSheet, type SpriteGroup, type SpriteRect } from './unity/SpriteSheet.js';

/** The file this builder writes, as the runtime and the manifest name it. */
export const SPRITES_FILE = 'sprites.bin';

/** What the file starts with, and the only layout it has ever had. */
const MAGIC = 'BROWNSPR';
const VERSION = 1;

/**
 * The sprite index's atlas numbers, and the textures they name.
 *
 * The index carries the atlas as a bare number, and the numbers this game has
 * ever used are two — the object atlas and the ground atlas. A future build
 * that invents a third leaves its sprites unsliced here, which the overlay
 * shows as the ordinary "no picture for this one" rather than as wrong pixels.
 */
const ATLASES: ReadonlyMap<number, string> = new Map([
  [4, 'mapObjects'],
  [1, 'groundTiles'],
]);

/** The width the packed atlas is laid out to. Sprites are small; 2048 is ample. */
const ATLAS_WIDTH = 2048;
/** Above this, a "sprite" is a misread rectangle — nothing in the game ships one. */
const MAX_SPRITE_PIXELS = 128;

export function buildSpritesFile(assets: Buffer, objectsXml: string): Buffer | undefined {
  const found = findAssetsByName(assets, new Set(['spritesheetf', ...ATLASES.values()]));
  const indexEntry = found.get('spritesheetf');
  if (indexEntry === undefined) return undefined;
  const groups = readSpriteSheet(readTextAsset(assets, indexEntry).data);

  const atlases = new Map<number, TextureAsset>();
  for (const [id, name] of ATLASES) {
    const entry = found.get(name);
    if (entry !== undefined) atlases.set(id, readTexture2D(assets, entry));
  }

  const packed = pack(itemsAndPortals(objectsXml), groups, atlases);
  if (packed === undefined) return undefined;
  return serialize(packed);
}

/** One object the runtime asked for a picture of, and the sprite it named. */
interface Wanted {
  readonly objectType: number;
  readonly file: string;
  readonly index: number;
}

/**
 * The objects worth a picture: every item (the whole `<Class>Equipment` +
 * `<Item/>` third of the file) and every key-opened portal.
 *
 * A whole-document scan of a 32 MB file, done once per game patch — a plain
 * regular expression over the text, because the tool has no DOM and the
 * elements it wants are flat, with no nesting to get wrong. A later definition
 * of the same type wins over an earlier one, as everywhere else that reads
 * this file.
 */
function itemsAndPortals(objectsXml: string): Wanted[] {
  const wanted: Wanted[] = [];
  for (const match of objectsXml.matchAll(/<Object\b([^>]*)>([\s\S]*?)<\/Object>/g)) {
    const attributes = match[1] ?? '';
    const body = match[2] ?? '';
    const isItem = body.includes('<Class>Equipment</Class>') && /<Item\s*\/>/.test(body);
    // Every portal, not only the key-opened ones: the realm and event portals
    // are what a chooser falls back to when a dungeon's own art is missing.
    const isPortal = /<DungeonPortal\s*\/>/.test(body) || body.includes('<Class>Portal</Class>');
    if (!isItem && !isPortal) continue;

    const type = Number.parseInt(/type="([^"]+)"/.exec(attributes)?.[1] ?? '', 16);
    if (!Number.isInteger(type) || type <= 0) continue;

    // `<Texture>` and `<AnimatedTexture>` carry the same pair, and an object
    // has at most one of its own. Animated art is filed by its still frame —
    // the picture the game itself shows at rest — which the index serves under
    // the same group and index the XML names. The opening tag may carry
    // pixel offsets — `<Texture xOffset="-2" …>` is how a key nudges its art —
    // so the match allows attributes rather than requiring a bare `<Texture>`.
    const texture =
      /<Texture\b[^>]*>([\s\S]*?)<\/Texture>/.exec(body)?.[1] ??
      /<AnimatedTexture\b[^>]*>([\s\S]*?)<\/AnimatedTexture>/.exec(body)?.[1];
    if (texture === undefined) continue;
    const file = /<File>([^<]+)<\/File>/.exec(texture)?.[1];
    const indexText = /<Index>([^<]+)<\/Index>/.exec(texture)?.[1];
    if (file === undefined || indexText === undefined) continue;
    const index = parseGameIndex(indexText);
    if (index === undefined) continue;

    wanted.push({ objectType: type, file, index });
  }
  return wanted;
}

/** The file's sprite indexes: hex like `0xa3`, or decimal. */
function parseGameIndex(text: string): number | undefined {
  const trimmed = text.trim();
  const value = /^0x[0-9a-f]+$/i.test(trimmed)
    ? Number.parseInt(trimmed.slice(2), 16)
    : /^\d+$/.test(trimmed)
      ? Number.parseInt(trimmed, 10)
      : NaN;
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

/**
 * Whether the atlas holds anything visible inside the rect.
 *
 * The index names a handful of rectangles the atlas carries nothing at — holes
 * in the game's own data, not in this reader — and a sprite without one
 * visible pixel is no picture at all. Left out of the file, the type simply
 * reads as "no sprite", which is what lets a chooser fall back to the next
 * face in its chain instead of drawing an empty tile.
 */
function hasVisiblePixels(atlas: TextureAsset, rect: SpriteRect): boolean {
  for (let y = 0; y < rect.h; y++) {
    for (let x = 0; x < rect.w; x++) {
      if (atlas.pixels[((rect.y + y) * atlas.width + rect.x + x) * 4 + 3] !== 0) return true;
    }
  }
  return false;
}

/** One distinct sprite: where it came from, and where it was shelved. */
interface PackedSprite {
  readonly atlasId: number;
  readonly sourceX: number;
  readonly sourceY: number;
  readonly width: number;
  readonly height: number;
  slotX: number;
  slotY: number;
}

interface Packed {
  readonly width: number;
  readonly height: number;
  readonly pixels: Buffer;
  /** One per object type, pointing at its sprite's slot. */
  readonly entries: readonly { objectType: number; sprite: PackedSprite }[];
}

/**
 * Slices every wanted sprite out of its atlas and shelves them into one.
 *
 * Two objects naming the same group and index share one shelf slot — the
 * picture is the same, and the file is smaller for it. Shelves are filled
 * tallest-first, which for sprites this uniform wastes almost nothing.
 */
function pack(
  wanted: readonly Wanted[],
  groups: ReadonlyMap<string, SpriteGroup>,
  atlases: ReadonlyMap<number, TextureAsset>,
): Packed | undefined {
  const bySprite = new Map<string, PackedSprite>();
  const entries = new Map<number, PackedSprite>();
  for (const { objectType, file, index } of wanted) {
    const rect = groups.get(file)?.sprites.get(index);
    if (rect === undefined) continue;
    const atlas = atlases.get(rect.atlasId);
    if (atlas === undefined) continue;
    if (
      rect.w <= 0 ||
      rect.h <= 0 ||
      rect.w > MAX_SPRITE_PIXELS ||
      rect.h > MAX_SPRITE_PIXELS ||
      rect.x < 0 ||
      rect.y < 0 ||
      rect.x + rect.w > atlas.width ||
      rect.y + rect.h > atlas.height
    ) {
      continue;
    }
    const key = `${file}\0${String(index)}`;
    let sprite = bySprite.get(key);
    if (sprite === undefined) {
      if (!hasVisiblePixels(atlas, rect)) continue;
      sprite = {
        atlasId: rect.atlasId,
        sourceX: rect.x,
        sourceY: rect.y,
        width: rect.w,
        height: rect.h,
        slotX: 0,
        slotY: 0,
      };
      bySprite.set(key, sprite);
    }
    entries.set(objectType, sprite);
  }
  if (entries.size === 0) return undefined;

  // Shelf packing, tallest first.
  const sprites = [...bySprite.values()];
  sprites.sort((a, b) => b.height - a.height || b.width - a.width);
  let shelfY = 0;
  let shelfX = 0;
  let shelfHeight = 0;
  for (const sprite of sprites) {
    if (shelfX + sprite.width > ATLAS_WIDTH) {
      shelfY += shelfHeight;
      shelfX = 0;
      shelfHeight = 0;
    }
    sprite.slotX = shelfX;
    sprite.slotY = shelfY;
    shelfX += sprite.width;
    shelfHeight = Math.max(shelfHeight, sprite.height);
  }
  const height = shelfY + shelfHeight;

  const pixels = Buffer.alloc(ATLAS_WIDTH * height * 4, 0);
  for (const sprite of sprites) {
    const atlas = atlases.get(sprite.atlasId);
    if (atlas === undefined) continue;
    for (let y = 0; y < sprite.height; y++) {
      const from = ((sprite.sourceY + y) * atlas.width + sprite.sourceX) * 4;
      atlas.pixels.copy(
        pixels,
        (sprite.slotY + y) * ATLAS_WIDTH * 4 + sprite.slotX * 4,
        from,
        from + sprite.width * 4,
      );
    }
  }

  return {
    width: ATLAS_WIDTH,
    height,
    pixels,
    entries: [...entries.entries()].map(([objectType, sprite]) => ({ objectType, sprite })),
  };
}

/**
 * The file: magic, version, atlas size, entries, then the atlas pixels — all
 * little-endian, all fixed-width, so the reader is one walk of the header and
 * a texture upload of the tail.
 */
function serialize(packed: Packed): Buffer {
  const headerBytes = 8 + 4 * 4 + packed.entries.length * 20;
  const out = Buffer.alloc(headerBytes + packed.pixels.length);
  let at = 0;
  out.write(MAGIC, at, 'ascii');
  at += 8;
  out.writeUInt32LE(VERSION, at);
  at += 4;
  out.writeUInt32LE(packed.width, at);
  at += 4;
  out.writeUInt32LE(packed.height, at);
  at += 4;
  out.writeUInt32LE(packed.entries.length, at);
  at += 4;
  for (const entry of packed.entries) {
    out.writeUInt32LE(entry.objectType, at);
    at += 4;
    out.writeUInt32LE(entry.sprite.slotX, at);
    at += 4;
    out.writeUInt32LE(entry.sprite.slotY, at);
    at += 4;
    out.writeUInt32LE(entry.sprite.width, at);
    at += 4;
    out.writeUInt32LE(entry.sprite.height, at);
    at += 4;
  }
  packed.pixels.copy(out, at);
  return out;
}
