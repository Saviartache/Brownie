/**
 * A reader for `spritesheetf`, the game's FlatBuffer sprite index.
 *
 * `objects.xml` names a sprite the classic way — a group like `lofiObj3` and an
 * index into it — while the game's own atlases pack every sprite into a handful
 * of big textures. This index is the map between them: one entry per sprite
 * group saying which atlas it lives in, and per sprite the rectangle it
 * occupies there.
 *
 * FlatBuffers is walked rather than parsed: no schema, no build step, just the
 * two primitives the format is made of — a vtable slot saying where in a table
 * a field sits (zero when absent), and a relative offset saying where a
 * referred-to thing sits. Everything is little-endian.
 *
 * The field slots below are a cross-language contract with the game's own
 * builder; they are listed where they are used rather than in one table,
 * because each reader of them reads one kind of object and nothing else.
 */

/** Where a sprite sits in its atlas, in pixels. */
export interface SpriteRect {
  /** Which atlas: the value the index carries, resolved by the caller. */
  readonly atlasId: number;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** One sprite group: its atlas, and its sprites by the index the XML names. */
export interface SpriteGroup {
  readonly atlasId: number;
  readonly sprites: ReadonlyMap<number, SpriteRect>;
}

/** The mutable shape the reader fills before freezing it into groups. */
interface MutableGroup {
  atlasId: number;
  sprites: Map<number, SpriteRect>;
}

export class SpriteSheetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpriteSheetError';
  }
}

/**
 * Reads the index: group name → group.
 *
 * @throws {SpriteSheetError} when the buffer is not a sprite index this reader
 *   can walk. Refusing rather than guessing is the whole point: a wrong offset
 *   here yields plausible rectangles that slice the atlas into noise.
 */
export function readSpriteSheet(buffer: Buffer): Map<string, SpriteGroup> {
  if (buffer.length < 8) {
    throw new SpriteSheetError('the sprite index is too short to read');
  }
  const groups = new Map<string, MutableGroup>();

  // SpriteSheetRoot, field 0: `sprites`, a vector of tables. The buffer's first
  // `u32` is the root table's offset.
  const root = indirect(buffer, 0);
  const sheets = vector(buffer, root + slot(buffer, root, 0));
  for (let i = 0; i < sheets.count; i++) {
    const sheet = indirect(buffer, sheets.at + i * 4);

    // SpriteSheet, field 0: `name`; field 1: `atlasId`; field 2: `sprites`.
    const nameSlot = slot(buffer, sheet, 0);
    const atlasSlot = slot(buffer, sheet, 1);
    const spritesSlot = slot(buffer, sheet, 2);
    if (nameSlot === 0 || spritesSlot === 0) continue;

    const sprites = vector(buffer, sheet + spritesSlot);
    const byIndex = new Map<number, SpriteRect>();
    for (let j = 0; j < sprites.count; j++) {
      const sprite = indirect(buffer, sprites.at + j * 4);
      const entry = readSprite(buffer, sprite);
      if (entry !== undefined) byIndex.set(entry.index, entry.rect);
    }
    groups.set(string(buffer, sheet + nameSlot), {
      atlasId: atlasSlot !== 0 ? Number(buffer.readBigUInt64LE(sheet + atlasSlot)) : 0,
      sprites: byIndex,
    });
  }

  // SpriteSheetRoot, field 1: `animatedSprites`. An animated sprite is one
  // still of it — the frame the game shows at rest — filed under the animated
  // group's own name and index. AnimatedSprite, field 0: `name`; field 1:
  // `index`; field 5: `sprites`, the one frame as an ordinary Sprite.
  const rootAnimatedSlot = slot(buffer, root, 1);
  if (rootAnimatedSlot !== 0) {
    const animated = vector(buffer, root + rootAnimatedSlot);
    for (let i = 0; i < animated.count; i++) {
      const entry = indirect(buffer, animated.at + i * 4);
      const nameSlot = slot(buffer, entry, 0);
      const indexSlot = slot(buffer, entry, 1);
      const frameSlot = slot(buffer, entry, 5);
      if (nameSlot === 0 || indexSlot === 0 || frameSlot === 0) continue;

      const frame = indirect(buffer, entry + frameSlot);
      const sprite = readSprite(buffer, frame);
      if (sprite === undefined) continue;
      const group = groups.get(string(buffer, entry + nameSlot));
      if (group === undefined) continue;
      group.sprites.set(buffer.readInt32LE(entry + indexSlot), sprite.rect);
    }
  }

  if (groups.size === 0) {
    throw new SpriteSheetError('the sprite index holds no sprite groups');
  }
  return new Map(
    [...groups.entries()].map(([name, group]) => [name, { ...group, sprites: group.sprites }]),
  );
}

/** Sprite, field 3: `index`; field 7: `aId`; field 0: `position`. */
function readSprite(
  buffer: Buffer,
  sprite: number,
): { readonly index: number; readonly rect: SpriteRect } | undefined {
  const indexSlot = slot(buffer, sprite, 3);
  const positionSlot = slot(buffer, sprite, 0);
  if (indexSlot === 0 || positionSlot === 0) return undefined;

  // `position` is a struct, laid out inline as four floats — x, y, h, w.
  const aidSlot = slot(buffer, sprite, 7);
  const position = sprite + positionSlot;
  return {
    index: buffer.readInt32LE(sprite + indexSlot),
    rect: {
      atlasId: aidSlot !== 0 ? Number(buffer.readBigUInt64LE(sprite + aidSlot)) : 0,
      x: Math.round(buffer.readFloatLE(position)),
      y: Math.round(buffer.readFloatLE(position + 4)),
      w: Math.round(buffer.readFloatLE(position + 8)),
      h: Math.round(buffer.readFloatLE(position + 12)),
    },
  };
}

/**
 * The target of a relative `u32` offset stored at `at`.
 *
 * FlatBuffers offsets are relative to the position of the offset itself — not
 * to the table it sits in, not to the buffer — which is the one fact about the
 * format that every reader here rests on.
 */
function indirect(buffer: Buffer, at: number): number {
  if (at < 0 || at + 4 > buffer.length) {
    throw new SpriteSheetError('the sprite index holds an offset outside itself');
  }
  const target = at + buffer.readUInt32LE(at);
  if (target < 0 || target + 8 > buffer.length) {
    throw new SpriteSheetError('the sprite index holds an offset outside itself');
  }
  return target;
}

/**
 * Where in table `table` field number `index` sits — an offset from the table's
 * own position — or zero when the table has no such field.
 *
 * A table starts with a signed distance back to its vtable; the vtable is its
 * own length, the table's size, then one `u16` per field.
 */
function slot(buffer: Buffer, table: number, index: number): number {
  const vtable = table - buffer.readInt32LE(table);
  const at = vtable + 4 + index * 2;
  if (vtable < 0 || at < 0 || at + 2 > buffer.length) {
    throw new SpriteSheetError('the sprite index holds a vtable outside itself');
  }
  return buffer.readUInt16LE(at);
}

/** A vector's element storage and length, from the field position holding it. */
function vector(buffer: Buffer, at: number): { at: number; count: number } {
  const start = indirect(buffer, at);
  const count = buffer.readUInt32LE(start);
  if (start + 4 + count * 4 > buffer.length) {
    throw new SpriteSheetError('a sprite vector runs outside the index');
  }
  return { at: start + 4, count };
}

/** The string a field position refers to. */
function string(buffer: Buffer, at: number): string {
  const start = indirect(buffer, at);
  const length = buffer.readUInt32LE(start);
  if (start + 4 + length > buffer.length) {
    throw new SpriteSheetError('a sprite group name runs outside the index');
  }
  return buffer.toString('utf8', start + 4, start + 4 + length);
}
