/**
 * How many enchants an item in a bag slot carries.
 *
 * A container states every slot's enchants in one string stat, as a
 * comma-separated list of base64 blobs — one per slot, in slot order. Inside a
 * blob: three bytes of header, then enchant ids as little-endian pairs, ending
 * at 0xFFFD. 0xFFFE stands for an empty position rather than an enchant.
 *
 * **This format is reverse-engineered and the only thing built on it is a
 * filter that defaults to off.** A blob that does not parse counts as no
 * enchants, so a build that changes the encoding makes an enchant threshold
 * refuse items rather than accept them — the direction that leaves loot on the
 * floor instead of filling the backpack with what the player asked to skip.
 */

/** `UniqueDataStr`, which `stat-types.json` lists among the string stats. */
export const UNIQUE_DATA_STAT = 80;

/** Ends the list of enchant ids in a blob. */
const TERMINATOR = 0xfffd;
/** Stands in for a position with no enchant in it. */
const EMPTY_SLOT = 0xfffe;
/** Header bytes before the first id. */
const HEADER_BYTES = 3;

/**
 * How many enchants the item in one slot of a container carries.
 *
 * @param uniqueData The container's unique-data stat, or `undefined` when it
 *   has not sent one — which is the ordinary case for a bag of unenchanted
 *   items and reads, correctly, as none.
 */
export function enchantCount(uniqueData: string | undefined, slot: number): number {
  if (uniqueData === undefined || uniqueData.trim() === '' || slot < 0) return 0;

  // `split` builds the whole list to reach one element, which is eight strings
  // for a bag; the alternative is an index walk that is longer to read than it
  // is to run, on a path that sees a bag every few seconds.
  const blob = uniqueData.split(',')[slot];
  if (blob === undefined) return 0;
  return countEnchants(blob.trim());
}

function countEnchants(blob: string): number {
  if (blob === '') return 0;

  const bytes = decodeBase64(blob);
  if (bytes === undefined || bytes.length <= HEADER_BYTES) return 0;

  let enchants = 0;
  for (let at = HEADER_BYTES; at + 1 < bytes.length; at += 2) {
    const id = bytes.readUInt16LE(at);
    if (id === TERMINATOR) break;
    if (id !== EMPTY_SLOT && id > 0) enchants += 1;
  }
  return enchants;
}

/** What a blob may contain: base64, in either alphabet, padded or not. */
const BASE64 = /^[A-Za-z0-9+/\-_]+={0,2}$/;

/**
 * Decodes a blob, accepting the URL-safe alphabet and missing padding.
 *
 * **The alphabet is checked first, and that check is the only thing standing
 * between this and inventing enchants.** Node's decoder does not fail on
 * rubbish — it discards every character it does not recognise and returns
 * whatever the rest happened to spell — so a stat that is not a blob at all
 * decodes to bytes that read as perfectly good enchant ids. Refusing anything
 * outside the alphabet is what makes "this is not one of these" an answer.
 */
function decodeBase64(blob: string): Buffer | undefined {
  if (!BASE64.test(blob)) return undefined;
  const buffer = Buffer.from(blob.replaceAll('-', '+').replaceAll('_', '/'), 'base64');
  return buffer.length === 0 ? undefined : buffer;
}
