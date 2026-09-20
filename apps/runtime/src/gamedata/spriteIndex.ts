/**
 * Which object types the sprite file carries a picture of.
 *
 * The overlay resolves sprite keys against the file the runtime named, so
 * whether a key exists is a fact about the file - and the runtime needs that
 * fact before it publishes a chooser, to fall back from a picture that is not
 * there to one that is. Only the entry table is read: the pixel tail is the
 * overlay's business, not this side's.
 */

/** The magic the extraction writes at the start of `sprites.bin`. */
const MAGIC = 'BROWNSPR';
/** The version this reader understands. */
const VERSION = 1;
const HEADER_BYTES = 24;
const ENTRY_BYTES = 20;

/**
 * The object types the file carries, or nothing when the buffer is not a
 * sprite file this reader understands - which is a warning, not a failure:
 * the choosers fall back to their checkbox lists.
 */
export function readSpriteTypes(buffer: Buffer): ReadonlySet<number> | undefined {
  if (buffer.length < HEADER_BYTES || buffer.subarray(0, 8).toString('ascii') !== MAGIC) {
    return undefined;
  }
  if (buffer.readUInt32LE(8) !== VERSION) return undefined;

  const width = buffer.readUInt32LE(12);
  const height = buffer.readUInt32LE(16);
  const count = buffer.readUInt32LE(20);
  const pixels = width * height * 4;
  if (width === 0 || height === 0) return undefined;
  if (HEADER_BYTES + count * ENTRY_BYTES + pixels !== buffer.length) return undefined;

  const types = new Set<number>();
  for (let i = 0; i < count; i++) {
    types.add(buffer.readUInt32LE(HEADER_BYTES + i * ENTRY_BYTES));
  }
  return types;
}
