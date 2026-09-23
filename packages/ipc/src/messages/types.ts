/**
 * The message set. Adding one is a matter of a code, a payload interface and a
 * validator — no switch elsewhere has to learn about it, because unknown types
 * decode to {@link UnknownMessage} rather than failing.
 *
 * Numbers are grouped so a reader can tell at a glance what a raw code is:
 * `0x00xx` handshake, `0x01xx` liveness, `0x02xx` control, `0x03xx` events,
 * `0x04xx` telemetry.
 */
export const MessageType = {
  Hello: 0x0001,
  AuthChallenge: 0x0002,
  AuthResult: 0x0003,

  Ping: 0x0100,
  Pong: 0x0101,

  SetFeature: 0x0200,
  ControlRecord: 0x0201,
  ControlAction: 0x0202,

  HotkeyEvent: 0x0300,
  OffsetHealth: 0x0301,
  ServerTarget: 0x0302,

  // `0x0400` was a player telemetry message that nothing ever sent. Retired
  // rather than reused, so no build can read one as the other.
  ClientFrame: 0x0401,
} as const;

export type MessageType = (typeof MessageType)[keyof typeof MessageType];

/** Which side may originate a message. Enforced on receipt. */
export const Origin = {
  /** The injected native module. */
  Native: 'native',
  /** The Node runtime. */
  Runtime: 'runtime',
  Either: 'either',
} as const;

export type Origin = (typeof Origin)[keyof typeof Origin];

export const MESSAGE_ORIGIN: Readonly<Record<number, Origin>> = {
  [MessageType.Hello]: Origin.Native,
  [MessageType.AuthChallenge]: Origin.Runtime,
  [MessageType.AuthResult]: Origin.Native,
  [MessageType.Ping]: Origin.Either,
  [MessageType.Pong]: Origin.Either,
  [MessageType.SetFeature]: Origin.Runtime,
  [MessageType.ControlRecord]: Origin.Runtime,
  [MessageType.ControlAction]: Origin.Native,
  [MessageType.HotkeyEvent]: Origin.Native,
  [MessageType.OffsetHealth]: Origin.Native,
  [MessageType.ServerTarget]: Origin.Native,
  [MessageType.ClientFrame]: Origin.Native,
};

// ── Payloads ────────────────────────────────────────────────────────────────

/** First frame on a new connection: the native module states who it is. */
export interface HelloMessage {
  readonly kind: 'hello';
  /** Process id of the game the module is injected into. */
  readonly pid: number;
  /** 32-byte hex nonce the runtime must sign. */
  readonly challenge: string;
}

/** The runtime answers the native module's challenge and poses its own. */
export interface AuthChallengeMessage {
  readonly kind: 'authChallenge';
  readonly userId: string;
  readonly pid: number;
  /** HMAC over the native module's challenge. */
  readonly response: string;
  /** 32-byte hex nonce the native module must sign back. */
  readonly challenge: string;
}

/** The native module's verdict, plus its answer to the runtime's challenge. */
export interface AuthResultMessage {
  readonly kind: 'authResult';
  readonly ok: boolean;
  readonly response: string;
}

export interface PingMessage {
  readonly kind: 'ping';
  readonly nonce: string;
}

export interface PongMessage {
  readonly kind: 'pong';
  readonly response: string;
}

/**
 * One gameplay setting. The native module stores nothing across connections, so
 * the runtime re-sends every key it owns on connect, on enable and on cleanup.
 */
export interface SetFeatureMessage {
  readonly kind: 'setFeature';
  readonly key: string;
  readonly value: boolean | number | string;
}

/** One overlay record; see {@link ../overlay/RecordCodec}. */
export interface ControlRecordMessage {
  readonly kind: 'controlRecord';
  readonly record: string;
}

/** One overlay interaction travelling back. */
export interface ControlActionMessage {
  readonly kind: 'controlAction';
  readonly action: string;
}

/** The native module polls the keyboard; this is an edge-triggered press. */
export interface HotkeyEventMessage {
  readonly kind: 'hotkeyEvent';
  readonly pluginId: string;
  /**
   * Which of that plugin's switches the key moves — the setting it names, or
   * empty for the plugin's own.
   *
   * Empty for a module built before a plugin could offer more than one key,
   * which is exactly what that module meant by it.
   */
  readonly slot: string;
  readonly action: string;
  readonly value: boolean;
}

/** IL2CPP classes whose offsets could not be resolved, for the health panel. */
export interface OffsetHealthMessage {
  readonly kind: 'offsetHealth';
  readonly unresolved: readonly string[];
}

/**
 * Where the game was actually trying to connect, before the module sent it to
 * the proxy instead.
 *
 * This is how the proxy learns which server a session belongs to. The game gets
 * its server list over HTTPS, which the proxy never sees, so without this the
 * runtime knows a client connected and nothing about where it wanted to go —
 * and `AllowlistTargets` refuses the session rather than guess.
 *
 * **Reported, never obeyed.** It names a host; the allowlist decides whether we
 * go there. A module that has been tampered with could name anything, and the
 * one thing it must not be able to do is turn the proxy into an open relay.
 */
export interface ServerTargetMessage {
  readonly kind: 'serverTarget';
  /** IPv4, dotted quad. */
  readonly host: string;
  readonly port: number;
}

/** An enemy shot the client has made, as it made it. */
export interface BornShot {
  readonly ownerId: number;
  /** The client's own number for it — the one every acknowledgement names. */
  readonly bulletId: number;
  /** How long before the frame the client started it, on its frame clock. */
  readonly ageMs: number;
  /** Where it started. */
  readonly x: number;
  readonly y: number;
  /** Which way it was fired, in radians. */
  readonly angle: number;
  /** What its owner's stat made of its speed. */
  readonly speedMultiplier: number;
  /** How long it lives, the owner's multiplier already applied. */
  readonly lifetimeMs: number;
  /** Half the side of the square the client hits with, in tiles. */
  readonly halfTiles: number;
}

/** An enemy shot the client had and has destroyed. */
export interface GoneShot {
  readonly ownerId: number;
  readonly bulletId: number;
}

/**
 * One frame of what the client sees, packed binary. See `clientFrame.ts`.
 *
 * Sent while the runtime claims `dodge.track`, because the runtime's own idea
 * of where the player is — five packets a second — is a moment behind a
 * character that walks every frame, and its idea of when a shot started is the
 * packet passing through rather than the frame the client read it on.
 */
export interface ClientFrameMessage {
  readonly kind: 'clientFrame';
  /** Where the player is on this frame, or nothing when there is no player. */
  readonly player: { readonly x: number; readonly y: number } | undefined;
  /** The client's frame clock, in milliseconds, when it could be read. */
  readonly frameTimeMs: number | undefined;
  /**
   * Whether the shots were scanned this frame. `false` means the two lists say
   * nothing — not that nothing happened.
   */
  readonly scanned: boolean;
  /** Shots the client made since the last frame. */
  readonly born: readonly BornShot[];
  /** Shots the client destroyed since the last frame. */
  readonly gone: readonly GoneShot[];
}

/**
 * A message type this build does not know.
 *
 * Kept rather than rejected, for the same reason unknown overlay records are
 * ignored: a newer peer on either side must never break an older one.
 */
export interface UnknownMessage {
  readonly kind: 'unknown';
  readonly type: number;
  readonly payload: Buffer;
}

export type IpcMessage =
  | HelloMessage
  | AuthChallengeMessage
  | AuthResultMessage
  | PingMessage
  | PongMessage
  | SetFeatureMessage
  | ControlRecordMessage
  | ControlActionMessage
  | HotkeyEventMessage
  | OffsetHealthMessage
  | ServerTargetMessage
  | ClientFrameMessage
  | UnknownMessage;
