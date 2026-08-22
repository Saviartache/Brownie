/**
 * Errors are split by what the caller must do, exactly as in
 * `@brownie/protocol`: a link error means "close this connection", a payload
 * error means "drop this message".
 */
export class IpcError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * The framing itself is broken — bad magic, impossible length, a sequence gap,
 * an unsupported protocol version. The stream cannot be resynchronised, so the
 * connection must close.
 */
export class LinkError extends IpcError {}

/** One message's payload was malformed. The link is fine; drop the message. */
export class MessageError extends IpcError {}

/** The peer failed to prove it holds the shared secret. */
export class AuthError extends IpcError {}
