import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import { extractGameData } from '../src/extract.js';
import { describeInstall, findGameInstall } from '../src/install.js';
import { buildManifest, checkStaleness, readManifest, writeManifest } from '../src/manifest.js';
import { SPRITES_FILE, buildSpritesFile } from '../src/sprites.js';
import {
  SerializedFileError,
  findAssetsByName,
  readTextAssets,
  readTexture2D,
} from '../src/unity/SerializedFile.js';
import { SpriteSheetError, readSpriteSheet } from '../src/unity/SpriteSheet.js';

const directories: string[] = [];

afterEach(async () => {
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'brownie-gamedata-'));
  directories.push(dir);
  return dir;
}

// ── A synthetic asset bundle ────────────────────────────────────────────────
//
// Built by hand rather than by shipping a fixture: the real `resources.assets`
// is several hundred megabytes, and every rule the reader has to follow —
// endianness, alignment, the version gate — is a property of the layout rather
// than of any particular game build.

function alignTo4(n: number): number {
  return (n + 3) & ~3;
}

/** A length-prefixed, 4-byte-aligned string or byte array. */
function alignedBlock(payload: Buffer): Buffer {
  const out = Buffer.alloc(alignTo4(4 + payload.length));
  out.writeUInt32LE(payload.length, 0);
  payload.copy(out, 4);
  return out;
}

interface FakeAsset {
  readonly name: string;
  readonly data: string | Buffer;
  /** Defaults to TextAsset (49). */
  readonly classId?: number;
}

function buildSerializedFile(assets: readonly FakeAsset[], version = 22): Buffer {
  // A Texture2D's header and pixels follow its name directly — no length
  // prefix — which is the whole difference between it and a TextAsset here.
  const bodies = assets.map((asset) =>
    asset.classId === 28
      ? Buffer.concat([
          alignedBlock(Buffer.from(asset.name, 'utf8')),
          typeof asset.data === 'string' ? Buffer.from(asset.data, 'utf8') : asset.data,
        ])
      : Buffer.concat([
          alignedBlock(Buffer.from(asset.name, 'utf8')),
          alignedBlock(
            typeof asset.data === 'string' ? Buffer.from(asset.data, 'utf8') : asset.data,
          ),
        ]),
  );

  const classIds = assets.map((asset) => asset.classId ?? 49);
  const unique = [...new Set(classIds)];

  const metadata: Buffer[] = [];
  metadata.push(Buffer.from('2021.3.5f1\0', 'utf8'));
  metadata.push(Buffer.alloc(4)); // target platform
  metadata.push(Buffer.from([0])); // no type tree

  const typeTable = Buffer.alloc(4 + unique.length * 23);
  typeTable.writeInt32LE(unique.length, 0);
  unique.forEach((classId, i) => {
    typeTable.writeInt32LE(classId, 4 + i * 23);
  });
  metadata.push(typeTable);

  // Object count, then the entries — which Unity aligns to 4 bytes, so the
  // builder has to as well or the reader is right and the fixture is wrong.
  const count = Buffer.alloc(4);
  count.writeInt32LE(assets.length, 0);
  metadata.push(count);

  const preambleLength = 48 + metadata.reduce((sum, part) => sum + part.length, 0);
  const padding = alignTo4(preambleLength) - preambleLength;
  if (padding > 0) metadata.push(Buffer.alloc(padding));

  const entries = Buffer.alloc(assets.length * 24);
  let bodyOffset = 0;
  assets.forEach((_asset, i) => {
    const at = i * 24;
    entries.writeBigInt64LE(BigInt(i + 1), at); // path id
    entries.writeBigInt64LE(BigInt(bodyOffset), at + 8);
    entries.writeUInt32LE(bodies[i]!.length, at + 16);
    entries.writeInt32LE(unique.indexOf(classIds[i]!), at + 20);
    bodyOffset += bodies[i]!.length;
  });
  metadata.push(entries);

  const metadataBuffer = Buffer.concat(metadata);
  const header = Buffer.alloc(48);
  header.writeUInt32BE(version, 8);
  const dataOffset = 48 + metadataBuffer.length;
  // A 64-bit big-endian field; the reader takes its low half.
  header.writeUInt32BE(dataOffset, 36);

  return Buffer.concat([header, metadataBuffer, ...bodies]);
}

const OBJECTS_A = '<?xml version="1.0"?><Objects><Object type="0x1" id="A" /></Objects>';
const OBJECTS_B = '<?xml version="1.0"?><Objects><Object type="0x2" id="B" /></Objects>';
const TILES = '<?xml version="1.0"?><GroundTypes><Ground type="0x9" id="Lava" /></GroundTypes>';

/**
 * A `Texture2D` shaped the way the reader expects: name, a header whose width
 * and height sit four bytes past the name, and a pixel tail exactly
 * `width * height * 4` long. The pixel bytes are a ramp, so a test can tell
 * which sprite landed where by reading them back.
 */
function fakeAtlas(name: string, width: number, height: number): FakeAsset {
  const pixels = Buffer.alloc(width * height * 4);
  // A visible ramp: every pixel opaque, its blue channel counting up, so a
  // test can tell which sprite landed where by reading pixels back.
  for (let i = 0; i < width * height; i++)
    pixels.writeUInt32LE((0xff000000 | (i + 1)) >>> 0, i * 4);
  const header = Buffer.alloc(16);
  // The layout the reader walks: a leading `int` it skips, then width, height.
  header.writeInt32LE(width, 4);
  header.writeInt32LE(height, 8);
  return { name, data: Buffer.concat([header, pixels]), classId: 28 };
}

// ── A synthetic sprite index ────────────────────────────────────────────────
//
// FlatBuffers by hand: every table is a signed distance back to its vtable,
// every vtable a row of u16 field offsets, every reference a u32 relative to
// itself. Built back-to-front into one buffer, the way the real builder works,
// so the offsets being relative is exercised rather than arranged away.

function buildSpriteIndex(
  sheets: readonly {
    name: string;
    sprites: readonly [
      index: number,
      atlasId: number,
      x: number,
      y: number,
      w: number,
      h: number,
    ][];
  }[],
): Buffer {
  const parts: Buffer[] = [Buffer.alloc(8)]; // room for the root offset
  let at = 8;
  /** Appends a block, 4-aligned, and returns where it landed. */
  const place = (block: Buffer): number => {
    while (at % 4 !== 0) {
      parts.push(Buffer.from([0]));
      at += 1;
    }
    const start = at;
    parts.push(block);
    at += block.length;
    return start;
  };

  // The layout the real builder produces: each table's vtable sits before it,
  // everything it refers to after it — so a vtable soffset and every reference
  // point the same way they do in the game's own index.
  const rootVtable = Buffer.alloc(4 + 2 * 2);
  rootVtable.writeUInt16LE(rootVtable.length, 0);
  rootVtable.writeUInt16LE(8, 2);
  rootVtable.writeUInt16LE(4, 4 + 0 * 2);
  rootVtable.writeUInt16LE(0, 4 + 1 * 2); // animatedSprites: absent
  const rootVtableAt = place(rootVtable);

  const rootTable = Buffer.alloc(4 + 4);
  const rootTableAt = place(rootTable);
  rootTable.writeInt32LE(rootTableAt - rootVtableAt, 0);

  const rootVector = Buffer.alloc(4 + sheets.length * 4);
  rootVector.writeUInt32LE(sheets.length, 0);
  const rootVectorAt = place(rootVector);
  rootTable.writeUInt32LE(rootVectorAt - (rootTableAt + 4), 4);

  sheets.forEach((sheet, i) => {
    const vtable = Buffer.alloc(4 + 3 * 2);
    vtable.writeUInt16LE(vtable.length, 0);
    vtable.writeUInt16LE(12, 2);
    vtable.writeUInt16LE(4, 4 + 0 * 2); // name
    vtable.writeUInt16LE(0, 4 + 1 * 2); // atlasId: absent
    vtable.writeUInt16LE(8, 4 + 2 * 2); // sprites
    const vtableAt = place(vtable);

    const table = Buffer.alloc(4 + 4 + 4);
    const tableAt = place(table);
    table.writeInt32LE(tableAt - vtableAt, 0);

    const name = Buffer.alloc(4 + sheet.name.length);
    name.writeUInt32LE(sheet.name.length, 0);
    name.write(sheet.name, 4, 'utf8');
    const nameAt = place(name);
    table.writeUInt32LE(nameAt - (tableAt + 4), 4);

    const spriteVector = Buffer.alloc(4 + sheet.sprites.length * 4);
    spriteVector.writeUInt32LE(sheet.sprites.length, 0);
    const spriteVectorAt = place(spriteVector);
    table.writeUInt32LE(spriteVectorAt - (tableAt + 8), 8);

    // Sprite: table with slot 0 (position struct, inline), 3 (index), 7 (aId).
    sheet.sprites.forEach(([index, atlasId, x, y, w, h], j) => {
      const spriteVtable = Buffer.alloc(4 + 8 * 2);
      spriteVtable.writeUInt16LE(spriteVtable.length, 0);
      spriteVtable.writeUInt16LE(32, 2);
      spriteVtable.writeUInt16LE(4, 4 + 0 * 2);
      spriteVtable.writeUInt16LE(20, 4 + 3 * 2);
      spriteVtable.writeUInt16LE(24, 4 + 7 * 2);
      const spriteVtableAt = place(spriteVtable);

      const spriteTable = Buffer.alloc(32);
      const spriteTableAt = place(spriteTable);
      spriteTable.writeInt32LE(spriteTableAt - spriteVtableAt, 0);
      spriteTable.writeFloatLE(x, 4);
      spriteTable.writeFloatLE(y, 8);
      spriteTable.writeFloatLE(h, 12);
      spriteTable.writeFloatLE(w, 16);
      spriteTable.writeInt32LE(index, 20);
      spriteTable.writeBigUInt64LE(BigInt(atlasId), 24);
      spriteVector.writeUInt32LE(spriteTableAt - (spriteVectorAt + 4 + j * 4), 4 + j * 4);
    });

    rootVector.writeUInt32LE(tableAt - (rootVectorAt + 4 + i * 4), 4 + i * 4);
  });

  const out = Buffer.concat(parts);
  out.writeUInt32LE(rootTableAt, 0);
  return out;
}

describe('SerializedFile', () => {
  it('reads the text assets and skips everything else', () => {
    const file = buildSerializedFile([
      { name: 'objects1', data: OBJECTS_A },
      { name: 'atlas', data: 'not text', classId: 28 },
      { name: 'tiles1', data: TILES },
    ]);

    const found = [...readTextAssets(file)];
    expect(found.map((a) => a.name)).toEqual(['objects1', 'tiles1']);
    expect(found[0]?.data.toString()).toBe(OBJECTS_A);
  });

  it('refuses a version it does not know rather than guessing past it', () => {
    // A layout change moved these fields before; reading anyway would produce
    // plausible nonsense, which is worse than refusing.
    expect(() => [...readTextAssets(buildSerializedFile([], 21))]).toThrow(SerializedFileError);
    expect(() => [...readTextAssets(Buffer.alloc(8))]).toThrow(/too short/);
  });

  it('reports the Unity version it read', () => {
    const iterator = readTextAssets(buildSerializedFile([{ name: 'x', data: OBJECTS_A }]));
    let step = iterator.next();
    while (step.done !== true) step = iterator.next();
    expect(step.value.unityVersion).toBe('2021.3.5f1');
  });
});

describe('extractGameData', () => {
  it('merges the fragments the game splits its catalogs across', () => {
    const result = extractGameData(
      buildSerializedFile([
        { name: 'a', data: OBJECTS_A },
        { name: 'b', data: OBJECTS_B },
        { name: 'c', data: TILES },
      ]),
    );

    const objects = result.files.find((f) => f.name === 'objects.xml');
    expect(objects?.parts).toBe(2);
    const text = objects!.content.toString();
    expect(text).toContain('id="A"');
    expect(text).toContain('id="B"');
    // One root element, not two documents stuck together.
    expect(text.match(/<Objects>/g)).toHaveLength(1);
    expect(result.files.find((f) => f.name === 'tiles.xml')?.parts).toBe(1);
  });

  it('recognises a catalog by its root element, not by the asset name', () => {
    // The game renames and re-splits these; the content is the only stable
    // thing about them.
    const result = extractGameData(
      buildSerializedFile([{ name: 'some_internal_name_7', data: OBJECTS_A }]),
    );
    expect(result.files.map((f) => f.name)).toEqual(['objects.xml']);
  });

  it('takes the named documents verbatim', () => {
    const result = extractGameData(
      buildSerializedFile([{ name: 'enchantments', data: '<Enchantments />' }]),
    );
    expect(result.files[0]?.name).toBe('enchantments.xml');
    expect(result.files[0]?.content.toString()).toBe('<Enchantments />');
  });

  it('ignores assets that are not XML at all', () => {
    const result = extractGameData(
      buildSerializedFile([
        { name: 'spritesheetf', data: '\u0000\u0001binary' },
        { name: 'readme', data: 'just text' },
      ]),
    );
    expect(result.files).toHaveLength(0);
  });
});

describe('the sprite index', () => {
  it('reads each group and the rectangles its sprites name', () => {
    const index = buildSpriteIndex([
      {
        name: 'lofiObj3',
        sprites: [
          [0xa3, 4, 10, 20, 8, 8],
          [0x22, 4, 30, 40, 16, 16],
        ],
      },
    ]);

    const groups = readSpriteSheet(index);
    const group = groups.get('lofiObj3');
    expect(group?.sprites.size).toBe(2);
    expect(group?.sprites.get(0xa3)).toEqual({ atlasId: 4, x: 10, y: 20, w: 8, h: 8 });
    expect(group?.sprites.get(0x22)).toEqual({ atlasId: 4, x: 30, y: 40, w: 16, h: 16 });
  });

  it('refuses an index it cannot walk rather than slicing noise', () => {
    expect(() => readSpriteSheet(Buffer.alloc(4))).toThrow(SpriteSheetError);
    // A root offset pointing outside the buffer.
    expect(() => readSpriteSheet(Buffer.from([0xff, 0xff, 0xff, 0x7f, 0, 0, 0, 0]))).toThrow(
      SpriteSheetError,
    );
  });
});

describe('texture reading', () => {
  it('finds the atlases by name and reads their pixels', () => {
    const file = buildSerializedFile([
      fakeAtlas('mapObjects', 4, 2),
      { name: 'objects1', data: OBJECTS_A },
    ]);

    const found = findAssetsByName(file, new Set(['mapObjects']));
    const atlas = readTexture2D(file, found.get('mapObjects')!);
    expect(atlas.width).toBe(4);
    expect(atlas.height).toBe(2);
    // The ramp the fixture wrote: pixel 0 is 1, pixel 1 is 2, both opaque.
    expect(atlas.pixels.readUInt32LE(0)).toBe((0xff000000 | 1) >>> 0);
    expect(atlas.pixels.readUInt32LE(4)).toBe((0xff000000 | 2) >>> 0);
  });

  it('refuses a texture whose bytes do not add up as RGBA32', () => {
    // One byte too few: no uncompressed layout satisfies the arithmetic, and
    // returning pixels anyway would be a guess dressed as a result.
    const truncated = buildSerializedFile([{ name: 'atlas', data: Buffer.alloc(10), classId: 28 }]);
    const found = findAssetsByName(truncated, new Set(['atlas']));
    expect(() => readTexture2D(truncated, found.get('atlas')!)).toThrow(SerializedFileError);
  });
});

describe('sprites.bin', () => {
  const OBJECTS_WITH_SPRITES = `<?xml version="1.0"?><Objects>
<Object type="0x7b" id="Snake Pit Key"><Class>Equipment</Class><Item /><Texture><File>lofiObj3</File><Index>0xa3</Index></Texture></Object>
<Object type="0x7c" id="Same Art"><Class>Equipment</Class><Item /><Texture><File>lofiObj3</File><Index>0xa3</Index></Texture></Object>
<Object type="0x1823" id="Pirate Portal"><DungeonPortal /><AnimatedTexture><File>portals</File><Index>5</Index></AnimatedTexture></Object>
<Object type="0x9" id="No Art"><Class>Equipment</Class><Item /></Object>
<Object type="0xa" id="Unknown Group"><Class>Equipment</Class><Item /><Texture><File>nowhere</File><Index>0x1</Index></Texture></Object>
</Objects>`;

  function spriteInstall(): Buffer {
    return buildSerializedFile([
      fakeAtlas('mapObjects', 4, 2),
      {
        name: 'spritesheetf',
        data: buildSpriteIndex([
          { name: 'lofiObj3', sprites: [[0xa3, 4, 1, 0, 2, 2]] },
          { name: 'portals', sprites: [[5, 4, 0, 0, 2, 1]] },
        ]),
      },
      { name: 'objects1', data: OBJECTS_WITH_SPRITES },
    ]);
  }

  it('packs every item and portal that names a sprite the index knows', () => {
    const assets = spriteInstall();
    const objects = extractGameData(assets).files.find((f) => f.name === 'objects.xml')!;
    const sprites = buildSpritesFile(assets, objects.content.toString('utf8'));
    expect(sprites).toBeDefined();

    expect(sprites!.subarray(0, 8).toString('ascii')).toBe('BROWNSPR');
    expect(sprites!.readUInt32LE(8)).toBe(1);
    const atlasWidth = sprites!.readUInt32LE(12);
    const count = sprites!.readUInt32LE(20);
    // The two items share art, so three object types fill two slots.
    expect(count).toBe(3);

    const entries = new Map<number, { x: number; y: number; w: number; h: number }>();
    for (let i = 0; i < count; i++) {
      const at = 24 + i * 20;
      entries.set(sprites!.readUInt32LE(at), {
        x: sprites!.readUInt32LE(at + 4),
        y: sprites!.readUInt32LE(at + 8),
        w: sprites!.readUInt32LE(at + 12),
        h: sprites!.readUInt32LE(at + 16),
      });
    }
    expect(entries.has(0x7b)).toBe(true);
    expect(entries.has(0x7c)).toBe(true);
    expect(entries.has(0x1823)).toBe(true);
    // No art and unknown group produce nothing.
    expect(entries.has(0x9)).toBe(false);
    expect(entries.has(0xa)).toBe(false);

    // Shared art shares a slot.
    expect(entries.get(0x7b)).toEqual(entries.get(0x7c));

    // The pixel the entry points at is the pixel the atlas held: the fixture's
    // ramp writes y * width + x + 1, and the 2x2 sprite sits at (1, 0).
    const key = entries.get(0x7b)!;
    const pixels = sprites!.subarray(24 + count * 20);
    const first = pixels.readUInt32LE((key.y * atlasWidth + key.x) * 4);
    expect(first).toBe((0xff000000 | (0 * 4 + 1 + 1)) >>> 0);
  });

  it('is extracted alongside the documents it illustrates', () => {
    const result = extractGameData(spriteInstall());
    expect(result.files.map((f) => f.name)).toContain(SPRITES_FILE);
    expect(result.spritesTrouble).toBeUndefined();
  });

  it('extracts the documents without sprites when there is no index', () => {
    const result = extractGameData(
      buildSerializedFile([fakeAtlas('mapObjects', 4, 2), { name: 'objects1', data: OBJECTS_A }]),
    );
    expect(result.files.map((f) => f.name)).not.toContain(SPRITES_FILE);
    expect(result.spritesTrouble).toBeUndefined();
  });
});

describe('staleness', () => {
  const install = {
    dataDirectory: 'C:/game/Data',
    assetsPath: 'C:/game/Data/resources.assets',
    sizeBytes: 1000,
    modifiedMs: 1_700_000_000_000,
  };

  it('says so when nothing has been extracted', () => {
    expect(checkStaleness(undefined, install)).toEqual({
      stale: true,
      reason: 'no game data has been extracted yet',
    });
  });

  it('is current while the install is unchanged', () => {
    const manifest = buildManifest(install, '2021.3', [], new Date());
    expect(checkStaleness(manifest, install).stale).toBe(false);
  });

  it('goes stale when the game is patched', () => {
    const manifest = buildManifest(install, '2021.3', [], new Date());
    const patched = { ...install, sizeBytes: 2000, modifiedMs: 1_800_000_000_000 };
    const staleness = checkStaleness(manifest, patched);

    expect(staleness.stale).toBe(true);
    expect(staleness.reason).toMatch(/no longer matches/);
  });

  it('makes no claim when there is no install to compare against', () => {
    // The data may be perfectly current — extracted from a machine that no
    // longer has the game — so this is not evidence of staleness.
    const manifest = buildManifest(install, '2021.3', [], new Date());
    expect(checkStaleness(manifest, undefined).stale).toBe(false);
  });

  it('treats an unreadable manifest as an absent one', async () => {
    const dir = await workspace();
    await writeFile(join(dir, 'manifest.json'), 'not json', 'utf8');
    expect(readManifest(dir)).toBeUndefined();

    await writeFile(join(dir, 'manifest.json'), '{"version":99}', 'utf8');
    expect(readManifest(dir)).toBeUndefined();
  });

  it('round-trips through disk', async () => {
    const dir = await workspace();
    const manifest = buildManifest(install, '2021.3', [], new Date('2026-01-01'));
    writeManifest(dir, manifest);
    expect(readManifest(dir)).toEqual(manifest);
  });
});

describe('the command line', () => {
  /** Writes a fake install and returns the paths the CLI needs. */
  async function fakeInstall(assets: FakeAsset[]): Promise<{ game: string; out: string }> {
    const root = await workspace();
    const game = join(root, 'RotMG Exalt_Data');
    const out = join(root, 'game-data');
    await writeFile(join(root, 'placeholder'), '', 'utf8');
    await rm(game, { recursive: true, force: true });
    await (await import('node:fs/promises')).mkdir(game, { recursive: true });
    await writeFile(join(game, 'resources.assets'), buildSerializedFile(assets));
    return { game, out };
  }

  it('extracts, then reports itself current, then does nothing', async () => {
    const { game, out } = await fakeInstall([
      { name: 'a', data: OBJECTS_A },
      { name: 'b', data: TILES },
    ]);

    const extract = runCli(['extract', '--game', game, '--out', out]);
    expect(extract.exitCode).toBe(0);
    expect(extract.output.join('\n')).toContain('objects.xml');
    expect((await readFile(join(out, 'objects.xml'), 'utf8')).includes('id="A"')).toBe(true);

    const check = runCli(['check', '--game', game, '--out', out]);
    expect(check.exitCode).toBe(0);
    expect(check.output.join('\n')).toContain('current');

    const again = runCli(['extract', '--game', game, '--out', out]);
    expect(again.output.join('\n')).toContain('already current');
  });

  it('extracts anyway when told to', async () => {
    const { game, out } = await fakeInstall([{ name: 'a', data: OBJECTS_A }]);
    runCli(['extract', '--game', game, '--out', out]);

    const forced = runCli(['extract', '--game', game, '--out', out, '--force']);
    expect(forced.output.join('\n')).toContain('wrote 1 file');
  });

  it('exits non-zero when the data is out of date, so a script can act on it', async () => {
    const { game, out } = await fakeInstall([{ name: 'a', data: OBJECTS_A }]);
    const check = runCli(['check', '--game', game, '--out', out]);

    expect(check.exitCode).toBe(1);
    expect(check.output.join('\n')).toContain('out of date');
  });

  it('says where it looked when it cannot find the game', () => {
    const result = runCli(['extract', '--game', join(tmpdir(), 'nowhere-at-all')]);
    expect(result.exitCode).toBe(1);
    expect(result.output.join('\n')).toContain('could not find');
    expect(result.output.join('\n')).toContain('--game');
  });

  it('refuses an install with no data documents in it', async () => {
    const { game, out } = await fakeInstall([{ name: 'nothing', data: 'plain text' }]);
    const result = runCli(['extract', '--game', game, '--out', out]);
    expect(result.exitCode).toBe(1);
    expect(result.output.join('\n')).toContain('found no data documents');
  });

  it('prints usage, and rejects a command it does not have', () => {
    expect(runCli(['help']).exitCode).toBe(0);
    expect(runCli(['nonsense']).exitCode).toBe(2);
  });

  it('accepts the assets file itself, not just the directory', async () => {
    const { game } = await fakeInstall([{ name: 'a', data: OBJECTS_A }]);
    expect(describeInstall(join(game, 'resources.assets'))).toBeDefined();
    expect(findGameInstall(join(game, 'resources.assets'))).toBeDefined();
  });

  it('accepts the folder the executable is in, which is what "the game folder" means', async () => {
    // The real layout: a root holding the executable, with the assets one level
    // down in `<name>_Data`. Rejecting the root while naming the `_Data` path in
    // the error is the kind of near-miss that costs someone ten minutes.
    const { game } = await fakeInstall([{ name: 'a', data: OBJECTS_A }]);
    const root = await mkdtemp(join(tmpdir(), 'brownie-root-'));
    directories.push(root);
    const data = join(root, 'RotMG Exalt_Data');
    await mkdir(data, { recursive: true });
    await copyFile(join(game, 'resources.assets'), join(data, 'resources.assets'));

    const install = describeInstall(root);
    expect(install).toBeDefined();
    expect(install?.assetsPath).toBe(join(data, 'resources.assets'));
  });

  it('does not mistake an unrelated folder for an install', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'brownie-empty-'));
    directories.push(empty);
    expect(describeInstall(empty)).toBeUndefined();
    expect(describeInstall(join(empty, 'does-not-exist'))).toBeUndefined();
  });
});
