/**
 * One error hierarchy for the whole protocol layer, split by *what the caller
 * must do about it* rather than by where it was thrown:
 *
 * - {@link FrameError}  — the byte stream is desynchronised. Nothing after this
 *   point is meaningful; the session must close.
 * - {@link DecodeError} — one packet body did not match its schema. The stream
 *   is still aligned, so the packet forwards opaquely and the session lives.
 * - {@link EncodeError} — a caller handed us values that cannot be written.
 * - {@link SchemaError}  — the definition file is wrong. Fails at startup.
 */
export class ProtocolError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Unrecoverable: the TCP stream no longer starts at a packet boundary. */
export class FrameError extends ProtocolError {}

/** Recoverable: one packet body could not be read. Context aids diagnosis. */
export class DecodeError extends ProtocolError {
  constructor(
    message: string,
    readonly context: {
      readonly packetId?: number;
      readonly packetName?: string;
      /** Dotted field path, e.g. `stats[3].value`. */
      readonly path?: string;
      /** Byte offset within the frame at which reading failed. */
      readonly offset?: number;
    } = {},
  ) {
    super(formatWithContext(message, context));
  }
}

/** A packet could not be serialised from the values it holds. */
export class EncodeError extends ProtocolError {}

/** The packet definitions themselves are invalid. */
export class SchemaError extends ProtocolError {}

function formatWithContext(
  message: string,
  context: { packetId?: number; packetName?: string; path?: string; offset?: number },
): string {
  const parts: string[] = [];
  if (context.packetName !== undefined) parts.push(context.packetName);
  else if (context.packetId !== undefined) parts.push(`id=${String(context.packetId)}`);
  if (context.path !== undefined && context.path !== '') parts.push(context.path);
  if (context.offset !== undefined) parts.push(`@${String(context.offset)}`);
  return parts.length > 0 ? `${message} (${parts.join(' ')})` : message;
}
