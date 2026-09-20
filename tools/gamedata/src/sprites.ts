/**
 * Builds `sprites.bin` — the picture side of the game data.
 *
 * The runtime's settings draw a grid of the game's own item art, and the
 * overlay that draws it is a native module inside the game's process: shipping
 * it pixels over the pipe would push megabytes through a link meant for
 * hundred-byte records. So the extraction repacks what the chooser needs into
 * one small atlas — every item, every dungeon portal and every character skin,
 * each addressed by the object type the rest of the data is addressed by; the
 * cloth patterns the dyes wear, addressed by the number a dye carries; and one
 * stand-in for the choices the game has no art for — and the runtime hands the
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
 * The index carries the atlas as a bare number, and the numbers this game uses
 * are three — objects, ground and characters. A future build that invents a
 * fourth leaves its sprites unsliced here, which the overlay shows as the
 * ordinary "no picture for this one" rather than as wrong pixels.
 */
const ATLASES: ReadonlyMap<number, string> = new Map([
  [4, 'mapObjects'],
  [2, 'characters'],
  [1, 'groundTiles'],
]);

/**
 * The textile sheets a dye's cloth number names, by the byte that names them.
 *
 * A dye carries one number: its top byte picks one of the game's textile
 * sheets and the rest is the sprite in it — `0x0a000012` is sprite 18 of
 * `textile10x10`. A `0x01` top byte is not a textile at all but a flat colour
 * in the low three bytes, which is the runtime's to draw and has no pixels to
 * cut here.
 */
const TEXTILE_SHEETS: ReadonlyMap<number, string> = new Map([
  [0x4, 'textile4x4'],
  [0x5, 'textile5x5'],
  [0x9, 'textile9x9'],
  [0xa, 'textile10x10'],
]);

/** The width the packed atlas is laid out to. Sprites are small; 2048 is ample. */
const ATLAS_WIDTH = 2048;
/** Above this, a "sprite" is a misread rectangle — nothing in the game ships one. */
const MAX_SPRITE_PIXELS = 128;

/**
 * The object type the stand-in picture is filed under.
 *
 * Zero, because the game numbers its own objects from one: nothing it ships can
 * collide with it, and the overlay asking for "the picture for a choice with no
 * picture" is asking for exactly that.
 */
export const FALLBACK_TYPE = 0;

/**
 * The art the stand-in is cut from, best first.
 *
 * Some of the game's own items name a sprite the index does not carry — an
 * `<Index>0x00</Index>` into a sheet that starts at one, which is a hole in
 * Deca's data rather than a miss in this reader. The chooser used to draw those
 * as their label clipped into the tile: neither readable nor a picture, and a
 * row of them reads as a fault. One picture that plainly says "no art for this
 * one" is better, and the game draws that itself — a crossed box, in the sheet
 * its own interface is drawn from. The second candidate is the circle-slash
 * from the same sheet, so a patch that moves one entry does not take the
 * stand-in with it; if neither survives, the file simply carries no stand-in
 * and the overlay falls back to the label as before.
 */
const FALLBACK_ART: readonly { readonly file: string; readonly index: number }[] = [
  { file: 'lofiInterfaceBig', index: 2 },
  { file: 'lofiInterfaceBig', index: 8 },
];

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

  const packed = pack(
    [...standIn(groups), ...itemsAndPortals(objectsXml), ...clothTextiles(objectsXml)],
    groups,
    atlases,
  );
  if (packed === undefined) return undefined;
  return serialize(packed);
}

/** The stand-in picture, as one more thing to pack, or nothing if the game moved it. */
function standIn(groups: ReadonlyMap<string, SpriteGroup>): Wanted[] {
  for (const { file, index } of FALLBACK_ART) {
    if (groups.get(file)?.sprites.has(index) === true) {
      return [{ key: FALLBACK_TYPE, file, index }];
    }
  }
  return [];
}

/** One picture the choosers asked for, and the sprite it is cut from. */
interface Wanted {
  /**
   * What the overlay looks the picture up by: an object type for anything the
   * game numbers as an object, and for a dye's cloth its own cloth number —
   * which cannot collide, being a byte of sheet above every object type there
   * is. Zero is the stand-in.
   */
  readonly key: number;
  readonly file: string;
  readonly index: number;
}

/** One `<Object …>…</Object>` of the catalog: its attributes and its body. */
const OBJECT = /<Object\b([^>]*)>([\s\S]*?)<\/Object>/g;

/**
 * The objects worth a picture: every item (the whole `<Class>Equipment` +
 * `<Item/>` third of the file), every portal, every character skin, and the
 * character classes themselves — what the choosers offer by picture.
 *
 * A whole-document scan of a 32 MB file, done once per game patch — a plain
 * regular expression over the text, because the tool has no DOM and the
 * elements it wants are flat, with no nesting to get wrong. A later definition
 * of the same type wins over an earlier one, as everywhere else that reads
 * this file.
 */
function itemsAndPortals(objectsXml: string): Wanted[] {
  const wanted: Wanted[] = [];
  for (const match of objectsXml.matchAll(OBJECT)) {
    const attributes = match[1] ?? '';
    const body = match[2] ?? '';
    const isItem = body.includes('<Class>Equipment</Class>') && /<Item\s*\/>/.test(body);
    // Every portal, not only the key-opened ones: the realm and event portals
    // are what a chooser falls back to when a dungeon's own art is missing.
    const isPortal = /<DungeonPortal\s*\/>/.test(body) || body.includes('<Class>Portal</Class>');
    // A skin is animated art, filed by its standing frame — see the sprite
    // index's reader. The skin chooser is a grid of characters, so a class's
    // hundred skins read as the little people they are.
    const isSkin = body.includes('<Class>Skin</Class>');
    // The classes themselves, so the skin chooser can draw "Default" as the
    // character in its own clothes rather than as no picture at all.
    const isPlayer = body.includes('<Class>Player</Class>');
    if (!isItem && !isPortal && !isSkin && !isPlayer) continue;

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

    wanted.push({ key: type, file, index });
  }
  return wanted;
}

/**
 * The cloth patterns the dyes name, keyed by the number the dye carries.
 *
 * A dye is an object like any other, but its own art is the little bottle —
 * the same bottle for all four hundred of them, because the game tints or
 * patterns the character rather than the icon. What tells two dyes apart is
 * what they put on the cloth, so that is what the chooser shows: the textile
 * itself, filed under the number the setting holds. The flat-colour dyes have
 * no textile and are not here; the runtime knows their colour and the overlay
 * fills the tile with it.
 */
function clothTextiles(objectsXml: string): Wanted[] {
  const wanted: Wanted[] = [];
  for (const match of objectsXml.matchAll(OBJECT)) {
    const body = match[2] ?? '';
    if (!body.includes('<Class>Dye</Class>')) continue;

    // `Tex1` dyes the clothing, `Tex2` the accessory; one dye carries one of
    // them, and the same cloth appears under both across the catalog.
    for (const tag of ['Tex1', 'Tex2']) {
      const text = new RegExp(`<${tag}>([^<]+)</${tag}>`).exec(body)?.[1];
      if (text === undefined) continue;
      const cloth = parseGameIndex(text);
      if (cloth === undefined) continue;
      const file = TEXTILE_SHEETS.get(cloth >>> 24);
      if (file === undefined) continue;
      wanted.push({ key: cloth, file, index: cloth & 0xffffff });
    }
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
    const row = atlasRow(atlas, rect.y + y);
    for (let x = 0; x < rect.w; x++) {
      if (atlas.pixels[(row * atlas.width + rect.x + x) * 4 + 3] !== 0) return true;
    }
  }
  return false;
}

/**
 * Which row of the texture's pixels holds row `y` of the picture.
 *
 * Unity stores a texture bottom row first; the sprite index counts rows from
 * the top. Every read of an atlas here goes through this, because a slice that
 * forgets it lands the same distance from the wrong edge — a rectangle of some
 * other sprite, opaque and colourful and completely unrelated to the item it
 * is filed under.
 */
function atlasRow(atlas: TextureAsset, y: number): number {
  return atlas.height - 1 - y;
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
  /** One per key — an object type, a cloth number, the stand-in's zero. */
  readonly entries: readonly { key: number; sprite: PackedSprite }[];
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
  for (const { key: wantedKey, file, index } of wanted) {
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
    entries.set(wantedKey, sprite);
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
      const from = (atlasRow(atlas, sprite.sourceY + y) * atlas.width + sprite.sourceX) * 4;
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
    entries: [...entries.entries()].map(([key, sprite]) => ({ key, sprite })),
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
    out.writeUInt32LE(entry.key, at);
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
