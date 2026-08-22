/**
 * A scanner for the game's data files.
 *
 * **Why not an XML parser.** `objects.xml` is 32 MB and describes 35 000
 * objects; the runtime keeps four fields from each. A general parser builds a
 * document tree first, which costs a few hundred megabytes to produce a catalog
 * of a few. That is a measured reason, not a preference: the alternative was
 * tried in the reference implementation and is why its loader is followed by a
 * "smart trim" scheduler whose job is to free the memory afterwards.
 *
 * What makes this safe is the narrowness. It reads one machine-generated
 * document shape — flat elements with attributes and scalar children, no
 * namespaces, no CDATA, no mixed content — and every helper below states what
 * it does *not* handle. It is not, and must not become, an XML parser.
 */

/** Largest single element we will assemble, so a malformed file cannot grow one without bound. */
const MAX_ELEMENT_BYTES = 1024 * 1024;

export class GameDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GameDataError';
  }
}

/**
 * Yields the source text of every top-level `<tag …>…</tag>`, streaming.
 *
 * Self-closing elements (`<tag … />`) are yielded too. Elements are assumed not
 * to nest inside themselves — true of `<Object>` and `<Ground>`, and the reason
 * this can look for the next `</tag>` rather than counting depth.
 *
 * @throws {GameDataError} if an element never closes, which means the file is
 *   truncated and anything read after it would be invented.
 */
export async function* scanElements(
  chunks: AsyncIterable<string | Buffer>,
  tag: string,
): AsyncGenerator<string> {
  const open = `<${tag}`;
  const close = `</${tag}>`;
  let buffer = '';

  for await (const chunk of chunks) {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');

    for (;;) {
      const start = findOpenTag(buffer, open);
      if (start === -1) {
        // Keep a tail long enough that an opening tag split across chunks is
        // still found once the rest arrives.
        buffer = buffer.slice(Math.max(0, buffer.length - open.length));
        break;
      }

      const selfClosing = findSelfClosing(buffer, start);
      const end = buffer.indexOf(close, start);
      if (selfClosing !== -1 && (end === -1 || selfClosing < end)) {
        yield buffer.slice(start, selfClosing);
        buffer = buffer.slice(selfClosing);
        continue;
      }
      if (end === -1) {
        if (buffer.length - start > MAX_ELEMENT_BYTES) {
          throw new GameDataError(`<${tag}> element exceeds ${String(MAX_ELEMENT_BYTES)} bytes`);
        }
        buffer = buffer.slice(start);
        break;
      }

      yield buffer.slice(start, end + close.length);
      buffer = buffer.slice(end + close.length);
    }
  }

  if (findOpenTag(buffer, open) !== -1) {
    throw new GameDataError(`the file ends inside a <${tag}> element`);
  }
}

/**
 * The same scan over a string already in hand.
 *
 * Used for elements nested inside one the streaming scan produced — a
 * `<Projectile>` inside an `<Object>` — where the enclosing element is already
 * small and streaming would buy nothing.
 */
export function scanElementsIn(source: string, tag: string): string[] {
  const open = `<${tag}`;
  const close = `</${tag}>`;
  const elements: string[] = [];

  let from = 0;
  for (;;) {
    const start = findOpenTag(source.slice(from), open);
    if (start === -1) return elements;
    const at = from + start;

    const selfClosing = findSelfClosing(source, at);
    const end = source.indexOf(close, at);
    if (selfClosing !== -1 && (end === -1 || selfClosing < end)) {
      elements.push(source.slice(at, selfClosing));
      from = selfClosing;
      continue;
    }
    if (end === -1) return elements;
    elements.push(source.slice(at, end + close.length));
    from = end + close.length;
  }
}

/**
 * Finds `<tag` where `tag` is the whole name, not a prefix of a longer one.
 *
 * The root element of `objects.xml` is `<Objects>`, so a plain substring search
 * for `<Object` matches the wrapper on the very first line — and every element
 * after it is then read from the wrong offset.
 */
function findOpenTag(source: string, open: string): number {
  let from = 0;
  for (;;) {
    const at = source.indexOf(open, from);
    if (at === -1) return -1;
    const next = source[at + open.length];
    // End of buffer: undecidable yet, so treat it as a match and let the caller
    // wait for more input rather than skipping past a real element.
    if (next === undefined || next === '>' || next === '/' || /\s/.test(next)) return at;
    from = at + 1;
  }
}

/**
 * Finds the end of a self-closing tag that starts at `from`, or -1.
 *
 * Only counts when the `/>` falls inside the *opening* tag: `<Object …/>` is
 * self-closing, `<Object …><Item /></Object>` is not.
 */
function findSelfClosing(source: string, from: number): number {
  const tagEnd = source.indexOf('>', from);
  if (tagEnd === -1) return -1;
  return source[tagEnd - 1] === '/' ? tagEnd + 1 : -1;
}

/** Reads `name="value"` from an element's opening tag. Does not decode entities beyond the common five. */
export function attribute(element: string, name: string): string | undefined {
  const match = new RegExp(`\\s${escapeForPattern(name)}\\s*=\\s*"([^"]*)"`).exec(element);
  return match?.[1] === undefined ? undefined : decodeEntities(match[1]);
}

/**
 * Reads the text of the first `<name>…</name>` child.
 *
 * Scalar children only: a child that itself contains elements comes back as its
 * raw inner text, which is a caller error rather than something to interpret.
 */
export function childText(element: string, name: string): string | undefined {
  const tag = escapeForPattern(name);
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`).exec(element);
  return match?.[1] === undefined ? undefined : decodeEntities(match[1].trim());
}

/**
 * The text an element holds between its own tags.
 *
 * For an element the scanners produced, when what is wanted is both its text
 * and its attributes — `<Activate stat="ATT">IncrementStat</Activate>` is the
 * case this exists for, and {@link childText} cannot answer it because the
 * element *is* the child. Scalar content only, on the same terms.
 *
 * @returns `undefined` for a self-closing element, which holds nothing.
 */
export function elementText(element: string): string | undefined {
  const openEnd = element.indexOf('>');
  if (openEnd === -1 || element[openEnd - 1] === '/') return undefined;
  const closeStart = element.lastIndexOf('</');
  if (closeStart <= openEnd) return undefined;
  return decodeEntities(element.slice(openEnd + 1, closeStart).trim());
}

/** Whether a marker child such as `<Enemy />` is present. */
export function hasChild(element: string, name: string): boolean {
  // The boundary matters: `<Enemy />` must not be found by looking for `<Enem`,
  // and `<EnemyOccupySquare />` must not answer for `<Enemy />`.
  return new RegExp(`<${escapeForPattern(name)}(\\s[^>]*)?/?>`).test(element);
}

/**
 * Reads a number written either as decimal or as `0x…`.
 *
 * Object and ground types are hexadecimal in these files; almost everything
 * else is decimal, and the file does not say which is which.
 */
export function parseGameNumber(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const text = raw.trim();
  const value = /^0x[0-9a-f]+$/i.test(text) ? Number.parseInt(text.slice(2), 16) : Number(text);
  return Number.isFinite(value) ? value : undefined;
}

function escapeForPattern(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
