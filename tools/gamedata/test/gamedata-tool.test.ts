import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import { extractGameData } from '../src/extract.js';
import { describeInstall, findGameInstall } from '../src/install.js';
import { buildManifest, checkStaleness, readManifest, writeManifest } from '../src/manifest.js';
import { SerializedFileError, readTextAssets } from '../src/unity/SerializedFile.js';

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
  readonly data: string;
  /** Defaults to TextAsset (49). */
  readonly classId?: number;
}

function buildSerializedFile(assets: readonly FakeAsset[], version = 22): Buffer {
  const bodies = assets.map((asset) =>
    Buffer.concat([
      alignedBlock(Buffer.from(asset.name, 'utf8')),
      alignedBlock(Buffer.from(asset.data, 'utf8')),
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
