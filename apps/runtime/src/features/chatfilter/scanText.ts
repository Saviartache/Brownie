/**
 * Turning one line of chat into the few forms the spam signals ask about.
 *
 * Every signal needs the message in a slightly different shape — one wants it
 * with punctuation gone, one wants word boundaries, one wants the runs of
 * spaces that `h  t  t  p` hides behind. Preparing them once per message, here,
 * is what stops a dozen signals each rebuilding their own copy: the reference
 * implementation re-derived four of these inside its matcher and then ran the
 * same regex list twice, against the folded text *and* the raw text.
 *
 * The folding matters as much as the shapes. Spam in this game is written to
 * survive a substring search: a Cyrillic letter standing in for its Latin twin,
 * a zero-width space inside `paypal`, fullwidth punctuation. Stripping the
 * invisible characters, normalising compatibility forms and mapping the
 * lookalikes back to ASCII is what makes a needle list worth having at all.
 *
 * The tables below are written as code points rather than as the characters
 * themselves, and that is not a style choice: a table of lookalikes is
 * unreviewable when the lookalikes are pasted in literally, because telling one
 * from its Latin twin by eye is exactly the thing they are built to defeat.
 */

/**
 * How much of a message is examined.
 *
 * The peer chooses this length, and everything below is regular-expression work
 * over it. A banner long enough to be a denial-of-service is also long enough
 * to have been recognised in its first kilobyte.
 */
const MAX_SCANNED_CHARS = 1024;

/**
 * Characters with no glyph, used to break up a word without showing a seam.
 *
 * Soft hyphen, combining grapheme joiner, Mongolian vowel separator, the
 * zero-width and bidirectional marks, the invisible operators, and the byte
 * order mark.
 */
const INVISIBLE = new Set<number>([
  0x00ad, 0x034f, 0x180e, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x2060, 0x2061, 0x2062, 0x2063,
  0x2064, 0xfeff,
]);

/**
 * Lookalikes, and the ASCII character each one is standing in for.
 *
 * Lower case only: folding happens after `toLowerCase`, so an upper-case
 * Cyrillic letter has already become its lower-case form by the time the table
 * is consulted. The bars at the end are the ones a shop banner uses so its
 * columns do not read as `|` — fullwidth `｜` is absent because NFKC has
 * already turned it into one.
 */
const HOMOGLYPHS = new Map<number, string>([
  // Cyrillic.
  [0x0430, 'a'],
  [0x044c, 'b'],
  [0x0441, 'c'],
  [0x0435, 'e'],
  [0x0454, 'e'],
  [0x044d, 'e'],
  [0x043d, 'h'],
  [0x0456, 'i'],
  [0x0457, 'i'],
  [0x043a, 'k'],
  [0x04cf, 'l'],
  [0x043c, 'm'],
  [0x043f, 'n'],
  [0x043e, 'o'],
  [0x0440, 'p'],
  [0x0455, 's'],
  [0x0442, 't'],
  [0x0445, 'x'],
  [0x0443, 'y'],
  // Greek.
  [0x03b1, 'a'],
  [0x03b2, 'b'],
  [0x03f2, 'c'],
  [0x03b5, 'e'],
  [0x03b7, 'h'],
  [0x03b9, 'i'],
  [0x03ba, 'k'],
  [0x03bf, 'o'],
  [0x03c1, 'p'],
  [0x03c4, 't'],
  [0x03bd, 'v'],
  [0x03c7, 'x'],
  [0x03b3, 'y'],
  // Latin.
  [0x0131, 'i'],
  // Bars.
  [0x00a6, '|'],
  [0x01c0, '|'],
  [0x2502, '|'],
  [0x2503, '|'],
  [0x2223, '|'],
]);

/**
 * One message, in the shapes the signals read it in.
 *
 * All of them but {@link raw} are folded and lower-cased, so a signal never has
 * to ask for a case-insensitive match and never sees a homoglyph.
 */
export interface ScannedText {
  /**
   * Exactly what arrived, truncated and nothing else.
   *
   * The one form that still contains the invisible characters — which is the
   * point: a flood of two hundred zero-width spaces is spam, and it has been
   * folded out of every other form here.
   */
  readonly raw: string;
  /** Folded and lower-cased, with the original spacing left alone. */
  readonly lower: string;
  /** {@link lower} with every non-alphanumeric character removed. */
  readonly compact: string;
  /** {@link lower} as space-separated words, padded, so ` wts ` is a word. */
  readonly loose: string;
  /** {@link lower} with runs of whitespace collapsed to one space. */
  readonly flat: string;
}

/** Prepares a message for the signals that read {@link ScannedText}. */
export function scanText(message: string): ScannedText {
  const raw = message.length > MAX_SCANNED_CHARS ? message.slice(0, MAX_SCANNED_CHARS) : message;
  const lower = fold(normalise(raw).toLowerCase());
  return {
    raw,
    lower,
    compact: lower.replace(/[^a-z0-9]+/g, ''),
    loose: ` ${lower.replace(/[^a-z0-9]+/g, ' ').trim()} `,
    flat: lower.replace(/\s+/g, ' '),
  };
}

/**
 * Drops the invisible characters and folds compatibility forms.
 *
 * `normalize` throws on nothing a decoded string can hold, but it is the one
 * call here that depends on the platform's Unicode tables; a message is worth
 * scanning unnormalised rather than not at all.
 */
function normalise(text: string): string {
  const stripped = mapCodePoints(text, (codePoint, character) =>
    INVISIBLE.has(codePoint) ? '' : character,
  );
  try {
    return stripped.normalize('NFKC');
  } catch {
    return stripped;
  }
}

/** Maps lookalike letters and bars back to ASCII. */
function fold(text: string): string {
  return mapCodePoints(text, (codePoint, character) => HOMOGLYPHS.get(codePoint) ?? character);
}

/**
 * Rewrites a string one code point at a time.
 *
 * The ASCII test first is not a micro-optimisation to taste: nearly every
 * message is ASCII, neither table holds an ASCII code point, and this runs on a
 * packet the game sends several times a second in a crowded nexus.
 */
function mapCodePoints(
  text: string,
  replace: (codePoint: number, character: string) => string,
): string {
  if (!hasNonAscii(text)) return text;
  let mapped = '';
  for (const character of text) {
    // Every character of a string iterated this way has a code point.
    const codePoint = character.codePointAt(0) ?? 0;
    mapped += replace(codePoint, character);
  }
  return mapped;
}

function hasNonAscii(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) > 127) return true;
  }
  return false;
}
