/**
 * Where the target object id sits in a body no schema describes.
 *
 * `SHOWEFFECT` and `NOTIFICATION` are defined with empty field lists — the
 * project has never worked out their layouts, and the reference implementation
 * did not either (see `docs/protocol.md`). Rather than hardcode an offset the
 * repository has no evidence for, each layout is *learned*: every candidate
 * that decodes to an object id the world currently holds gets a vote, and a
 * candidate is only used once it has won {@link CONFIDENCE} times.
 *
 * **Until then nothing is reported, so nothing is dropped.** A wrong guess can
 * never eat a boss telegraph; it leaves the filter idle. And after a lock the
 * decoded id still has to resolve to a live object before the caller acts on
 * it, so a layout that was right for one build and wrong for the next goes
 * quiet rather than misfiring.
 *
 * One probe per body shape, shared across sessions: a layout is a property of
 * the protocol, not of a connection.
 */

/** The type byte is at offset 0, so an id cannot start before this. */
const MIN_OFFSET = 1;
const MAX_OFFSET = 6;
const OFFSET_COUNT = MAX_OFFSET - MIN_OFFSET + 1;
/** Two encodings per offset: the compressed varint, and a plain big-endian int32. */
const CANDIDATE_COUNT = OFFSET_COUNT * 2;
/** Votes one candidate needs before it is trusted. */
const CONFIDENCE = 4;

const NOT_LOCKED = -1;

export class TargetIdProbe {
  readonly #votes = new Uint16Array(CANDIDATE_COUNT);
  readonly #onLock: (layout: string) => void;
  #locked = NOT_LOCKED;

  /**
   * @param onLock told the layout the one time it is settled. Held rather than
   *   polled: the caller cannot ask "did that read settle it?" without reading
   *   the probe twice per packet.
   */
  constructor(onLock: (layout: string) => void) {
    this.#onLock = onLock;
  }

  /**
   * Reads the target id out of `frame`, whose body starts at `bodyStart`.
   *
   * @param isLive decides which decoded numbers are plausible object ids. It is
   *   called up to twelve times per packet while learning, so callers pass a
   *   function they already hold rather than building one per packet.
   * @returns the id, or `undefined` while the layout is unknown or the decoded
   *   value does not name anything in the world.
   */
  read(
    frame: Buffer,
    bodyStart: number,
    isLive: (objectId: number) => boolean,
  ): number | undefined {
    if (this.#locked !== NOT_LOCKED) {
      const id = decode(frame, bodyStart, this.#locked);
      return id !== undefined && isLive(id) ? id : undefined;
    }

    for (let candidate = 0; candidate < CANDIDATE_COUNT; candidate++) {
      const id = decode(frame, bodyStart, candidate);
      if (id === undefined || id <= 0 || !isLive(id)) continue;

      const votes = (this.#votes[candidate] ?? 0) + 1;
      this.#votes[candidate] = votes;
      // The packet that settles the layout is not one this acts on: it was
      // read under a layout that was still a candidate when the read happened.
      if (votes >= CONFIDENCE) {
        this.#locked = candidate;
        this.#onLock(describe(candidate));
        return undefined;
      }
    }
    return undefined;
  }
}

function describe(candidate: number): string {
  const encoding = isInt32(candidate) ? 'int32' : 'compressed';
  return `offset ${String(offsetOf(candidate))} (${encoding})`;
}

function offsetOf(candidate: number): number {
  return MIN_OFFSET + (candidate >> 1);
}

function isInt32(candidate: number): boolean {
  return (candidate & 1) === 1;
}

function decode(frame: Buffer, bodyStart: number, candidate: number): number | undefined {
  const at = bodyStart + offsetOf(candidate);
  return isInt32(candidate) ? readInt32(frame, at) : readCompressedInt(frame, at);
}

function readInt32(frame: Buffer, at: number): number | undefined {
  if (at < 0 || at + 4 > frame.length) return undefined;
  return frame.readInt32BE(at);
}

/**
 * The game's variable-length integer, read at a speculative offset.
 *
 * `ByteReader.compressedInt` is the same encoding and is the one the codec
 * uses; it is not reused here because it signals a short read by throwing, and
 * during learning a short read is the *expected* outcome for most of the twelve
 * candidates. An exception per miss per packet is the wrong control flow for
 * that, so this returns `undefined` instead. The two are held to the same
 * answer by a test that runs both over the same bytes.
 */
function readCompressedInt(frame: Buffer, at: number): number | undefined {
  if (at < 0 || at >= frame.length) return undefined;

  let position = at;
  let byte = frame[position++] ?? 0;
  const negative = (byte & 0b0100_0000) !== 0;
  let value = byte & 0b0011_1111;
  let shift = 6;

  while ((byte & 0b1000_0000) !== 0) {
    if (shift > 34 || position >= frame.length) return undefined;
    byte = frame[position++] ?? 0;
    value += (byte & 0b0111_1111) * 2 ** shift;
    shift += 7;
  }

  if (value > 0x7fff_ffff) return undefined;
  return negative ? -value : value;
}
