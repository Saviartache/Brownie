/**
 * A reader for Unity's `SerializedFile` container, narrowed to what the game's
 * data lives in.
 *
 * `resources.assets` is where Realm ships `objects.xml`, `tiles.xml` and the
 * rest: they are `TextAsset` objects inside a Unity asset bundle. Nothing else
 * in the file is of interest, so this walks the object table, reads the ones
 * with the right class id, and skips the rest without decoding them.
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
/** `MonoBehaviour` — carries an extra 16-byte script id in the type table. */
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
  if (buffer.length < METADATA_OFFSET) {
    throw new SerializedFileError('file is too short to be a Unity serialized file');
  }

  const version = buffer.readUInt32BE(8);
  if (version !== SUPPORTED_VERSION) {
    throw new SerializedFileError(
      `Unity serialized file version ${String(version)} is not supported (expected ${String(SUPPORTED_VERSION)})`,
    );
  }
  // The 64-bit data offset, read as its low half: the file is big-endian here,
  // and no asset bundle the game ships approaches 4 GiB.
  const dataOffset = buffer.readUInt32BE(36);

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

  for (let i = 0; i < objectCount; i++) {
    pos = alignTo4(pos);
    pos += 8; // path id
    const byteStart = Number(buffer.readBigInt64LE(pos));
    pos += 8;
    pos += 4; // byte size
    const typeIndex = buffer.readInt32LE(pos);
    pos += 4;

    const classId = classIds[typeIndex];
    if (classId !== CLASS_TEXT_ASSET) continue;

    const at = dataOffset + byteStart;
    if (at < 0 || at >= buffer.length) {
      throw new SerializedFileError(`object ${String(i)} points outside the file`);
    }
    const name = readAlignedString(buffer, at);
    const data = readAlignedBytes(buffer, name.next);
    yield { name: name.value, data: data.value };
  }

  return { unityVersion, objectCount };
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
