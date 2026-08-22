/**
 * The two lists of names the player keeps: never hide this one, always hide
 * that one.
 *
 * A line is either a plain substring or a `/pattern/flags` regular expression,
 * which is what the reference implementation offered and what people already
 * have written down. What is different is when the line is *read*: there, both
 * lists were split and every regular expression recompiled inside the packet
 * handler, so a nexus full of chat recompiled them several times a second. Here
 * a list is compiled when it changes, and the handler only runs the result.
 *
 * Two things that silently did not work there, and do here:
 *
 * A pattern that does not compile is reported. It used to be swallowed, leaving
 * a line in the box that matched nothing and no way to find out why.
 *
 * `g` and `y` are refused as flags. `RegExp.test` on a global expression
 * advances `lastIndex` and resumes from there on the next call, so `/spam/g`
 * matched every other message — the kind of fault that reads as "the filter is
 * unreliable" and never as a bug.
 */

/** One line of a list, compiled. */
export interface SenderRule {
  /** The line as it was written, for the message that reports a problem. */
  readonly source: string;
  matches(sender: string): boolean;
}

export interface SenderRules {
  readonly rules: readonly SenderRule[];
  /** Lines that could not be compiled, as they were written. */
  readonly invalid: readonly string[];
}

/** Anything but the flags that leave a pattern stateless. */
const UNSUPPORTED_FLAGS = /[^imsu]/g;

/**
 * Compiles a list of lines.
 *
 * Blank lines and `#` comments are dropped, so a list can be annotated and a
 * rule can be commented out rather than deleted.
 */
export function parseSenderRules(text: string): SenderRules {
  const rules: SenderRule[] = [];
  const invalid: string[] = [];

  for (const line of text.split(/[\r\n]+/)) {
    const trimmed = stripComment(line);
    if (trimmed === '') continue;

    // Anything starting with a slash is meant as a pattern — no name in this
    // game contains one — so a malformed pattern is reported rather than
    // quietly taken as a substring nothing will ever match.
    if (trimmed.startsWith('/')) {
      const pattern = compileRegex(trimmed);
      if (pattern === undefined) {
        invalid.push(trimmed);
        continue;
      }
      // Against the name as the server spelled it, not a lower-cased copy: a
      // pattern carries its own `i` flag if it wants one, and anchors like
      // `/^Xx/` are unusable when the subject has already been folded.
      rules.push({ source: trimmed, matches: (sender) => pattern.test(sender) });
      continue;
    }

    const needle = trimmed.toLowerCase();
    rules.push({ source: trimmed, matches: (sender) => sender.toLowerCase().includes(needle) });
  }

  return { rules, invalid };
}

/** Whether any rule claims this sender. */
export function matchesAnyRule(rules: readonly SenderRule[], sender: string): boolean {
  return rules.some((rule) => rule.matches(sender));
}

/** Drops a trailing `# comment`, and a line that is only a comment. */
function stripComment(line: string): string {
  if (line.trimStart().startsWith('#')) return '';
  return line.replace(/\s+#.*$/, '').trim();
}

/** `/pattern/flags` — the shortest useful one is `/x/`. */
function compileRegex(line: string): RegExp | undefined {
  const end = closingSlash(line);
  if (end <= 1) return undefined;

  const body = line.slice(1, end);
  const flags = line.slice(end + 1).replace(UNSUPPORTED_FLAGS, '');
  try {
    return new RegExp(body, flags);
  } catch {
    return undefined;
  }
}

/**
 * Where the pattern ends.
 *
 * A backslash escapes whatever follows it, so `/a\/b/` is one pattern and not
 * two — the same rule the language uses for its own literals.
 *
 * @returns the index of the closing slash, or -1 when there is not one.
 */
function closingSlash(line: string): number {
  for (let index = 1; index < line.length; index++) {
    const character = line[index];
    if (character === '\\') {
      index++;
      continue;
    }
    if (character === '/') return index;
  }
  return -1;
}
