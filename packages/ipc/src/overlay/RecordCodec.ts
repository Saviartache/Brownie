/**
 * The overlay record format.
 *
 * The overlay holds no state of its own: the runtime describes what to draw as
 * a stream of records, and interactions come back as actions in the same shape.
 * A record is a `|`-separated field list whose first field is the record kind.
 *
 * ```
 * setting|auto-drink|hpPercent|HP%20percent|range|n|7|1|0|1|14|1|0|
 * kind    plugin     key       label        type  vt v …
 * ```
 *
 * Two rules make this survivable across versions, and both are load-bearing:
 *
 * 1. **Unknown record kinds are ignored, not rejected.** A newer runtime must
 *    never break an older native module.
 * 2. **Fields are read positionally, and new fields are appended.** An older
 *    reader that stops early still decodes everything it knows about.
 *
 * Fields are percent-encoded, so no value can contain a separator or upset the
 * C++ side with non-ASCII text.
 */

export type RecordField = string | number | boolean;

/** Percent-encodes one field so it survives the `|` framing. */
export function encodeField(value: RecordField | null | undefined): string {
  if (typeof value === 'boolean') return value ? '1' : '0';
  return encodeURIComponent(String(value ?? ''));
}

/** Builds a record from a kind and its fields. */
export function buildRecord(kind: string, ...fields: readonly (RecordField | null)[]): string {
  return [kind, ...fields.map(encodeField)].join('|');
}

/**
 * Splits a record into decoded fields.
 *
 * A field that is not valid percent-encoding is returned verbatim rather than
 * throwing: a malformed record is a display problem, and losing the whole
 * interaction because one label was mis-escaped is worse than showing it raw.
 */
export function parseRecord(raw: string): string[] {
  return raw.split('|').map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  });
}

/** The record kind, without decoding the rest. */
export function recordKind(raw: string): string {
  const end = raw.indexOf('|');
  return end === -1 ? raw : raw.slice(0, end);
}

/**
 * Builds the `a;b;c` list used by table rows and combo options.
 *
 * `;` is the list separator and cannot be escaped inside a cell, so it is
 * replaced with a comma. That is a display compromise, not a data loss the
 * caller can detect — which is why it lives here rather than at each call site
 * reinventing it.
 */
export function encodeList(items: readonly RecordField[]): string {
  return items.map((item) => String(item).replace(/;/g, ',')).join(';');
}

export function parseList(raw: string): string[] {
  return raw.length === 0 ? [] : raw.split(';');
}

/** Builds the `Label=value;Label=value` form a combo widget expects. */
export function encodeOptions(options: ReadonlyArray<readonly [string, RecordField]>): string {
  return encodeList(options.map(([label, value]) => `${label}=${String(value)}`));
}

/** Rounds to an integer string; anything non-finite becomes `0`. */
export function intField(value: number): string {
  return Number.isFinite(value) ? String(Math.round(value)) : '0';
}

/** One decimal place; anything non-finite becomes `0`. */
export function decimalField(value: number): string {
  return Number.isFinite(value) ? String(Math.round(value * 10) / 10) : '0';
}
