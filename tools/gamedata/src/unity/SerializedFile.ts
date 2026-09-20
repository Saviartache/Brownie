/**
 * A reader for Unity's `SerializedFile` container, narrowed to what the game's
 * data lives in.
 *
 * `resources.assets` is where Realm ships `objects.xml`, `tiles.xml` and the
 * rest: they are `TextAsset` objects inside a Unity asset bundle. The sprite
 * atlases live in the same file as `Texture2D` objects, uncompressed, which is
 * what keeps this reader from needing a block-compression decoder.
 *
 * Layout facts, all of them Unity's rather than ours:
 *
 * - **The header is big-endian; the metadata is not.** The header states the
 *   metadata's endianness, and for every build the game ships it is little.
 *   Reading the whole file one way is the first thing that goes wrong here.
 * - Version 22 moved the size fields to 64-bit and pushed the metadata to
 *   offset 48. Earlier versions are a different layout, which is why an
 *   unexpected version is refused rather than guessed at.
 * - Every string and byte array is length-prefixed and padded to a 4-byte
 *   boundary. Forgetting the padding desynchronises the whole object table.
 */

/** `TextAsset` — what the XML is stored as. */
export const CLASS_TEXT_ASSET = 49;
/** `Texture2D` — the sprite atlases. */
export const CLASS_TEXTURE_2D = 28;
/** `MonoBehaviour` — carries an extra 16-byte script-id in the type table. */
const CLASS_MONO_BEHAVIOUR = 114;

const SUPPORTED_VERSION = 22;
const METADATA_OFFSET = 48;

export class SerializedFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SerializedFileError';
  }
}

export interface TextAsset {
  readonly name: string;
  readonly data: Buffer;
}

export interface SerializedFileInfo {
  readonly unityVersion: string;
  readonly objectCount: number;
}

/** One object in the file's table, located but not decoded. */
export interface AssetEntry {
  readonly classId: number;
  /** Where the object's bytes start, relative to the data offset. */
  readonly byteStart: number;
  readonly byteSize: number;
}

/**
 * Yields every `TextAsset` in the file.
 *
 * A generator so the caller decides what to keep: the file is hundreds of
 * megabytes and holds thousands of assets, of which the runtime wants about
 * five.
 *
 * @throws {SerializedFileError} if the file is not a serialized file this
 *   reader understands. Guessing past a version change would produce plausible
 *   nonsense, which is worse than refusing.
 */
export function* readTextAssets(buffer: Buffer): Generator<TextAsset, SerializedFileInfo> {
  const walk = walkObjectTable(buffer);
  for (const entry of walk.entries) {
    if (entry.classId !== CLASS_TEXT_ASSET) continue;
    const at = dataOffsetOf(buffer) + entry.byteStart;
    const name = readAlignedString(buffer, at);
    const data = readAlignedBytes(buffer, name.next);
    yield { name: name.value, data: data.value };
  }
  return walk.info;
}

/** Both the classes whose first field is an aligned name string. */
const NAMED_CLASSES = new Set([CLASS_TEXT_ASSET, CLASS_TEXTURE_2D]);

/**
 * Finds the objects that carry one of the given names.
 *
 * `TextAsset` and `Texture2D` both begin with `m_Name`, so one lookup serves
 * the sprite index and the atlases it points into. Names are matched exactly:
 * they are the game's own identifiers, not a person's guess at a file name.
 *
 * @throws {SerializedFileError} on a file this reader cannot walk.
 */
export function findAssetsByName(
  buffer: Buffer,
  wanted: ReadonlySet<string>,
): Map<string, AssetEntry> {
  const found = new Map<string, AssetEntry>();
  const dataOffset = dataOffsetOf(buffer);
  for (const entry of walkObjectTable(buffer).entries) {
    if (!NAMED_CLASSES.has(entry.classId)) continue;
    const at = dataOffset + entry.byteStart;
    if (at < 0 || at >= buffer.length) {
      throw new SerializedFileError('an object points outside the file');
    }
    const name = readAlignedString(buffer, at);
    if (wanted.has(name.value)) found.set(name.value, entry);
  }
  return found;
}

export interface TextureAsset {
  readonly width: number;
  readonly height: number;
  /**
   * The pixels, RGBA, four bytes each — a view into `buffer`, not a copy.
   *
   * The game ships its sprite atlases uncompressed, so there is nothing to
   * decode: the pixels are the tail of the object, exactly `width * height * 4`
   * bytes of it. That arithmetic is the whole validation — if it does not hold,
   * the texture is not the RGBA32 this reader knows how to slice, and guessing
   * at another layout would return plausible noise.
   */
  readonly pixels: Buffer;
}

/**
 * Reads one `Texture2D` as raw RGBA pixels.
 *
 * @throws {SerializedFileError} when the texture is compressed or its header
 *   does not match the size the object carries, rather than returning pixels
 *   this reader cannot vouch for.
 */
export function readTexture2D(buffer: Buffer, entry: AssetEntry): TextureAsset {
  const objectStart = dataOffsetOf(buffer) + entry.byteStart;
  const name = readAlignedString(buffer, objectStart);

  // The width and height follow the name, four bytes in — past one `int` this
  // reader has no use for. Everything between them and the pixel tail is header
  // it skips the same way, and the object's own size is what proves the layout:
  // an RGBA32 texture's bytes are exactly its header plus `width * height * 4`,
  // and no other reading of these numbers satisfies that for every atlas the
  // game ships. (`name.next` is already absolute — the width sits at it, four
  // bytes on.)
  if (name.next + 12 > buffer.length) {
    throw new SerializedFileError(`texture "${name.value}" is too short to carry a size`);
  }
  const width = buffer.readInt32LE(name.next + 4);
  const height = buffer.readInt32LE(name.next + 8);
  const pixelBytes = width * height * 4;
  if (
    width <= 0 ||
    height <= 0 ||
    pixelBytes / 4 !== width * height ||
    entry.byteSize <= pixelBytes ||
    entry.byteSize - pixelBytes > 4096
  ) {
    throw new SerializedFileError(
      `texture "${name.value}" is not an uncompressed RGBA32 atlas this reader can slice ` +
        `(w=${String(width)} h=${String(height)} size=${String(entry.byteSize)} header=${String(entry.byteSize - pixelBytes)})`,
    );
  }
  const start = objectStart + entry.byteSize - pixelBytes;
  return { width, height, pixels: buffer.subarray(start, start + pixelBytes) };
}

/**
 * Reads one `TextAsset`'s name and bytes.
 *
 * @throws {SerializedFileError} when the entry is not a `TextAsset`.
 */
export function readTextAsset(buffer: Buffer, entry: AssetEntry): TextAsset {
  if (entry.classId !== CLASS_TEXT_ASSET) {
    throw new SerializedFileError('the entry is not a TextAsset');
  }
  const at = dataOffsetOf(buffer) + entry.byteStart;
  const name = readAlignedString(buffer, at);
  const data = readAlignedBytes(buffer, name.next);
  return { name: name.value, data: data.value };
}

interface ObjectTable {
  readonly entries: readonly AssetEntry[];
  readonly info: SerializedFileInfo;
}

/**
 * The one walk of the metadata, shared by every reader above.
 *
 * Returns the whole table rather than yielding it, so a caller that wants two
 * passes over the same objects — find the sprite index, then the atlases it
 * names — walks the metadata once instead of twice.
 *
 * @throws {SerializedFileError} on a file this reader cannot walk.
 */
function walkObjectTable(buffer: Buffer): ObjectTable {
  if (buffer.length < METADATA_OFFSET) {
    throw new SerializedFileError('file is too short to be a Unity serialized file');
  }

  const version = buffer.readUInt32BE(8);
  if (version !== SUPPORTED_VERSION) {
    throw new SerializedFileError(
      `Unity serialized file version ${String(version)} is not supported (expected ${String(SUPPORTED_VERSION)})`,
    );
  }
  const dataOffset = dataOffsetOf(buffer);

  let pos = METADATA_OFFSET;

  const versionEnd = buffer.indexOf(0, pos);
  if (versionEnd === -1) throw new SerializedFileError('unterminated Unity version string');
  const unityVersion = buffer.toString('utf8', pos, versionEnd);
  pos = versionEnd + 1;

  pos += 4; // target platform
  const hasTypeTree = buffer.readUInt8(pos) !== 0;
  pos += 1;

  // ── Type table ────────────────────────────────────────────────────────────
  // Only the class id of each entry matters; everything else is skipped by
  // width. An entry's size depends on its class, which is why this cannot be a
  // fixed stride.
  const typeCount = buffer.readInt32LE(pos);
  pos += 4;
  const classIds: number[] = [];
  for (let i = 0; i < typeCount; i++) {
    const classId = buffer.readInt32LE(pos);
    pos += 4;
    pos += 1; // isStripped
    pos += 2; // scriptTypeIndex
    if (classId === CLASS_MONO_BEHAVIOUR) pos += 16; // script id
    pos += 16; // old type hash
    if (hasTypeTree) {
      const nodeCount = buffer.readInt32LE(pos);
      pos += 4;
      const stringBufferSize = buffer.readInt32LE(pos);
      pos += 4;
      pos += nodeCount * 32 + stringBufferSize;
    }
    classIds.push(classId);
  }

  // ── Object table ──────────────────────────────────────────────────────────
  const objectCount = buffer.readInt32LE(pos);
  pos += 4;

  const entries: AssetEntry[] = [];
  for (let i = 0; i < objectCount; i++) {
    pos = alignTo4(pos);
    pos += 8; // path id
    const byteStart = Number(buffer.readBigInt64LE(pos));
    pos += 8;
    const byteSize = buffer.readInt32LE(pos);
    pos += 4;
    const typeIndex = buffer.readInt32LE(pos);
    pos += 4;
    const classId = classIds[typeIndex];

    if (
      classId === undefined ||
      dataOffset + byteStart < 0 ||
      dataOffset + byteStart >= buffer.length ||
      byteSize < 0
    ) {
      throw new SerializedFileError(`object ${String(i)} points outside the file`);
    }
    entries.push({ classId, byteStart, byteSize });
  }

  return { entries, info: { unityVersion, objectCount } };
}

/** The file's data offset, read where the big-endian header keeps it. */
function dataOffsetOf(buffer: Buffer): number {
  // The 64-bit data offset, read as its low half: the file is big-endian here,
  // and no asset bundle the game ships approaches 4 GiB.
  return buffer.readUInt32BE(36);
}

function alignTo4(position: number): number {
  return (position + 3) & ~3;
}

function readAlignedString(buffer: Buffer, position: number): { value: string; next: number } {
  const length = buffer.readUInt32LE(position);
  const start = position + 4;
  return {
    value: buffer.toString('utf8', start, start + length),
    next: alignTo4(start + length),
  };
}

function readAlignedBytes(buffer: Buffer, position: number): { value: Buffer; next: number } {
  const length = buffer.readUInt32LE(position);
  const start = position + 4;
  return {
    value: Buffer.from(buffer.subarray(start, start + length)),
    next: alignTo4(start + length),
  };
}
