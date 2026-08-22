/**
 * Levelled logging.
 *
 * Two properties the reference implementation lacked and paid for:
 *
 * 1. **A record, not a string.** A log line carries its component, level and
 *    optional session id as fields, so the sink decides the format. The old
 *    logger baked `[HH:MM:SS] [Component] text` into every call site, which is
 *    why adding a session id would have meant touching all of them.
 * 2. **A cheap disabled path.** `isEnabled` exists so a hot path can skip
 *    building a string it will not use. This is the documented idiom rather
 *    than a lazy-thunk API, because a closure allocated per call is its own
 *    cost — and one that is invisible at the call site.
 *
 * ```ts
 * if (log.isEnabled(LogLevel.Trace)) log.trace(`forwarded ${packet.name}`);
 * ```
 */

export const LogLevel = {
  Trace: 10,
  Debug: 20,
  Info: 30,
  Warn: 40,
  Error: 50,
  Fatal: 60,
  /** Nothing is written. */
  Off: 100,
} as const;

export type LogLevel = (typeof LogLevel)[keyof typeof LogLevel];

export const LOG_LEVEL_NAMES: Readonly<Record<number, string>> = {
  [LogLevel.Trace]: 'trace',
  [LogLevel.Debug]: 'debug',
  [LogLevel.Info]: 'info',
  [LogLevel.Warn]: 'warn',
  [LogLevel.Error]: 'error',
  [LogLevel.Fatal]: 'fatal',
};

export interface LogRecord {
  readonly level: LogLevel;
  /** Which subsystem: `proxy`, `proxy:session`, `plugin:auto-nexus`, … */
  readonly component: string;
  readonly message: string;
  /** Set on anything that happens inside a session, so lines can be grouped. */
  readonly sessionId?: string;
  readonly error?: Error;
  readonly timeMs: number;
}

export interface LogSink {
  write(record: LogRecord): void;
}

/** Parses a level name, for configuration. Unknown names fall back to `info`. */
export function parseLogLevel(name: string): LogLevel {
  const wanted = name.trim().toLowerCase();
  if (wanted === 'off') return LogLevel.Off;
  for (const [value, label] of Object.entries(LOG_LEVEL_NAMES)) {
    if (label === wanted) return Number(value) as LogLevel;
  }
  return LogLevel.Info;
}

/**
 * The level is shared, not copied: `child()` and `forSession()` hand out views
 * over one mutable holder, so raising the level at runtime reaches loggers that
 * were created before the change. A per-instance copy would leave every
 * long-lived session logging at whatever level it was born with.
 */
interface LevelHolder {
  value: LogLevel;
}

export class Logger {
  readonly #sink: LogSink;
  readonly #component: string;
  readonly #sessionId: string | undefined;
  readonly #level: LevelHolder;

  private constructor(
    sink: LogSink,
    component: string,
    level: LevelHolder,
    sessionId: string | undefined,
  ) {
    this.#sink = sink;
    this.#component = component;
    this.#level = level;
    this.#sessionId = sessionId;
  }

  /** Creates the root logger. Everything else descends from it. */
  static create(sink: LogSink, component = 'app', minLevel: LogLevel = LogLevel.Info): Logger {
    return new Logger(sink, component, { value: minLevel }, undefined);
  }

  /** A logger for a sub-component, sharing the sink and the level. */
  child(component: string): Logger {
    return new Logger(this.#sink, `${this.#component}:${component}`, this.#level, this.#sessionId);
  }

  /** A logger that tags every record with a session id. */
  forSession(sessionId: string): Logger {
    return new Logger(this.#sink, this.#component, this.#level, sessionId);
  }

  /** Changes the level for this logger and every logger sharing its root. */
  setLevel(level: LogLevel): void {
    this.#level.value = level;
  }

  get level(): LogLevel {
    return this.#level.value;
  }

  isEnabled(level: LogLevel): boolean {
    return level >= this.#level.value;
  }

  trace(message: string): void {
    this.#write(LogLevel.Trace, message);
  }

  debug(message: string): void {
    this.#write(LogLevel.Debug, message);
  }

  info(message: string): void {
    this.#write(LogLevel.Info, message);
  }

  warn(message: string): void {
    this.#write(LogLevel.Warn, message);
  }

  error(message: string, cause?: unknown): void {
    this.#write(LogLevel.Error, message, toError(cause));
  }

  fatal(message: string, cause?: unknown): void {
    this.#write(LogLevel.Fatal, message, toError(cause));
  }

  #write(level: LogLevel, message: string, error?: Error): void {
    if (level < this.#level.value) return;
    this.#sink.write({
      level,
      component: this.#component,
      message,
      ...(this.#sessionId === undefined ? {} : { sessionId: this.#sessionId }),
      ...(error === undefined ? {} : { error }),
      timeMs: Date.now(),
    });
  }
}

/**
 * Normalises anything thrown into an `Error`.
 *
 * `String(cause)` is not enough: a thrown plain object stringifies to
 * `[object Object]`, which is the least useful thing a log line can say about
 * a failure. Anything that is not already an `Error` is described as precisely
 * as it can be without throwing a second time.
 */
export function toError(cause: unknown): Error | undefined {
  if (cause === undefined) return undefined;
  if (cause instanceof Error) return cause;
  return new Error(describeThrown(cause));
}

function describeThrown(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null) return 'null';
  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint' ||
    typeof value === 'symbol'
  ) {
    return value.toString();
  }
  try {
    // Declared as returning `string`, but genuinely returns undefined for a
    // function or a symbol. The check is a runtime fact the types do not admit.
    const json: unknown = JSON.stringify(value);
    return typeof json === 'string' ? json : 'a value that is not serialisable';
  } catch {
    // A circular object, or a getter that throws.
    return 'a value that could not be described';
  }
}
