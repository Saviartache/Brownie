import type { DecodedPacket, FieldValue, PacketDirection, PacketFields } from '@brownie/protocol';

/** What the pipeline should do with a packet once every stage has seen it. */
export const Verdict = {
  /** Send it on to the other side. */
  Forward: 'forward',
  /** Do not send it. The peer never learns it existed. */
  Drop: 'drop',
} as const;

export type Verdict = (typeof Verdict)[keyof typeof Verdict];

/**
 * A packet as a handler sees it.
 *
 * Reading is free; writing is explicit. That asymmetry is the point: the
 * pipeline forwards an untouched packet from its original bytes and only
 * re-encodes one that was actually changed, so it needs to *know* whether a
 * change happened. The reference implementation exposed a mutable `data`
 * object and a separate `modified` flag that handlers had to remember to set —
 * and one that forgot corrupted traffic in a way that only showed up on a
 * live connection after a game patch.
 *
 * A packet whose body could not be decoded is {@link opaque}: its fields are
 * empty and `set` refuses, because rebuilding it from half-read fields would
 * produce bytes that mean something other than what arrived.
 */
export class MutablePacket {
  readonly #packet: DecodedPacket;
  #modified = false;
  #verdict: Verdict = Verdict.Forward;

  constructor(packet: DecodedPacket) {
    this.#packet = packet;
  }

  get id(): number {
    return this.#packet.id;
  }

  get name(): string {
    return this.#packet.name;
  }

  get direction(): PacketDirection | undefined {
    return this.#packet.direction;
  }

  /** True when there is no usable schema — forward as bytes, do not rebuild. */
  get opaque(): boolean {
    return this.#packet.schema === undefined;
  }

  /** Why the body could not be decoded, when it could not. */
  get decodeError(): Error | undefined {
    return this.#packet.error;
  }

  get fields(): Readonly<PacketFields> {
    return this.#packet.fields;
  }

  get modified(): boolean {
    return this.#modified;
  }

  get verdict(): Verdict {
    return this.#verdict;
  }

  /** The exact deciphered bytes that arrived, header included. */
  get frame(): Buffer {
    return this.#packet.frame;
  }

  /** The packet the pipeline will encode. Not for handlers. */
  get decoded(): DecodedPacket {
    return this.#packet;
  }

  get(field: string): FieldValue | undefined {
    return this.#packet.fields[field];
  }

  // Typed accessors rather than `get<T>(...)`: a generic there would be an
  // unchecked assertion wearing a type parameter, and a field that turned out
  // to hold a string would flow on as a number until something far away broke.

  /** @returns the field if it holds a number, otherwise `undefined`. */
  number(field: string): number | undefined {
    const value = this.#packet.fields[field];
    return typeof value === 'number' ? value : undefined;
  }

  /** @returns the field if it holds a string, otherwise `undefined`. */
  string(field: string): string | undefined {
    const value = this.#packet.fields[field];
    return typeof value === 'string' ? value : undefined;
  }

  /** @returns the field if it holds a boolean, otherwise `undefined`. */
  boolean(field: string): boolean | undefined {
    const value = this.#packet.fields[field];
    return typeof value === 'boolean' ? value : undefined;
  }

  /**
   * Sets a field and marks the packet for re-encoding.
   *
   * @throws {Error} if the packet is opaque, or if the field is not in its
   *   schema — a typo would otherwise be written into `fields`, ignored by the
   *   encoder, and silently do nothing.
   */
  set(field: string, value: FieldValue): void {
    if (this.opaque) {
      throw new Error(`cannot modify ${this.name}: its body did not decode`);
    }
    const schema = this.#packet.schema;
    if (schema !== undefined && !schema.fields.some((f) => f.name === field)) {
      throw new Error(`${this.name} has no field "${field}"`);
    }
    this.#packet.fields[field] = value;
    this.#modified = true;
  }

  /** Stops the packet from reaching the other side. */
  drop(): void {
    this.#verdict = Verdict.Drop;
  }

  /** Undoes a {@link drop} — for a stage that decided to allow it after all. */
  forward(): void {
    this.#verdict = Verdict.Forward;
  }
}
