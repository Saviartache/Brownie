import { LogLevel, parseLogLevel } from '../logging/Logger.js';

/**
 * The resolved configuration.
 *
 * Frozen, validated, and produced once at startup. Nothing downstream reads the
 * environment or a file again — a value that can change under a running
 * subsystem is a value that subsystem cannot reason about.
 */
export interface RuntimeConfig {
  readonly proxy: {
    /** Where the game client is pointed. Loopback: this is not a public proxy. */
    readonly host: string;
    readonly port: number;
  };
  readonly servers: {
    /** Hosts a session may be connected to. Anything else is refused. */
    readonly allow: readonly string[];
    readonly port: number;
  };
  readonly native: {
    /**
     * Whether to listen for the native module at all.
     *
     * True when asked for explicitly, or implied by a configured secret. False
     * by default: the overlay simply stays away.
     */
    readonly enabled: boolean;
    readonly pipeName: string;
    /**
     * Hex, at least 16 bytes.
     *
     * Empty is the normal case and means "mint one for this run", published
     * where the module reads it — see `native/SessionKey.ts`. A secret written
     * into a config file outlives the run it protects, so it exists only for
     * the case where something else has to know it too.
     */
    readonly secretHex: string;
  };
  readonly logging: {
    readonly level: LogLevel;
    /**
     * Where to also write the log, or empty for the terminal only.
     *
     * The terminal is watched while the runtime runs; the file is what can be
     * read afterwards, by somebody who was not there. Truncated on every start,
     * so it always holds exactly one run.
     */
    readonly file: string;
  };
  readonly plugins: { readonly directory: string };
  readonly gameData: {
    /**
     * Where `objects.xml` and `tiles.xml` live.
     *
     * Empty means "none": the runtime then reports no object as a player or an
     * enemy and no tile as damaging, which is the safe direction — a feature
     * built on it does nothing rather than the wrong thing.
     */
    readonly directory: string;
  };
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Everything the runtime does without being told. */
export const DEFAULT_CONFIG: RuntimeConfig = Object.freeze({
  proxy: { host: '127.0.0.1', port: 2050 },
  servers: { allow: [], port: 2050 },
  native: { enabled: false, pipeName: 'brownie-bridge', secretHex: '' },
  logging: { level: LogLevel.Info, file: '' },
  plugins: { directory: 'plugins' },
  gameData: { directory: '' },
});

export interface ConfigSources {
  /** Parsed `config/*.json`, or `undefined` when there is none. */
  readonly file?: unknown;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/**
 * Resolves configuration from its layers: defaults ← file ← environment.
 *
 * Pure — the caller reads the file. That is what lets every rule below be
 * tested without a filesystem, and it keeps "where does this value come from"
 * answerable by reading one function.
 *
 * @throws {ConfigError} naming the offending key. A bad configuration must fail
 *   at startup, not at three in the morning inside a packet handler.
 */
export function resolveConfig(sources: ConfigSources = {}): RuntimeConfig {
  const file = asRecord(sources.file ?? {}, 'config');
  const env = sources.env ?? {};

  const proxy = asRecord(file['proxy'] ?? {}, 'proxy');
  const servers = asRecord(file['servers'] ?? {}, 'servers');
  const native = asRecord(file['native'] ?? {}, 'native');
  const logging = asRecord(file['logging'] ?? {}, 'logging');
  const plugins = asRecord(file['plugins'] ?? {}, 'plugins');
  const gameData = asRecord(file['gameData'] ?? {}, 'gameData');

  const secretHex = firstString(
    env['BROWNIE_NATIVE_SECRET'],
    native['secret'],
    DEFAULT_CONFIG.native.secretHex,
    'native.secret',
  );
  if (secretHex !== '' && !isHex(secretHex, 16)) {
    throw new ConfigError(
      'native.secret must be at least 32 hex characters (16 bytes); a shorter shared secret is not worth having',
    );
  }

  const config: RuntimeConfig = {
    proxy: {
      host: firstString(
        env['BROWNIE_PROXY_HOST'],
        proxy['host'],
        DEFAULT_CONFIG.proxy.host,
        'proxy.host',
      ),
      port: firstPort(
        env['BROWNIE_PROXY_PORT'],
        proxy['port'],
        DEFAULT_CONFIG.proxy.port,
        'proxy.port',
      ),
    },
    servers: {
      allow: hostList(servers['allow'], 'servers.allow'),
      port: firstPort(undefined, servers['port'], DEFAULT_CONFIG.servers.port, 'servers.port'),
    },
    native: {
      // A configured secret still implies enabled — someone who went to the
      // trouble of setting one means to use it — but it is no longer the only
      // way in, because the runtime can now mint its own.
      enabled:
        firstBool(env['BROWNIE_NATIVE'], native['enabled'], false, 'native.enabled') ||
        secretHex !== '',
      pipeName: firstString(
        env['BROWNIE_NATIVE_PIPE'],
        native['pipeName'],
        DEFAULT_CONFIG.native.pipeName,
        'native.pipeName',
      ),
      secretHex,
    },
    logging: {
      level: parseLogLevel(
        firstString(env['BROWNIE_LOG_LEVEL'], logging['level'], 'info', 'logging.level'),
      ),
      file: firstString(
        env['BROWNIE_LOG_FILE'],
        logging['file'],
        DEFAULT_CONFIG.logging.file,
        'logging.file',
      ),
    },
    plugins: {
      directory: firstString(
        env['BROWNIE_PLUGIN_DIR'],
        plugins['directory'],
        DEFAULT_CONFIG.plugins.directory,
        'plugins.directory',
      ),
    },
    gameData: {
      directory: firstString(
        env['BROWNIE_GAME_DATA_DIR'],
        gameData['directory'],
        DEFAULT_CONFIG.gameData.directory,
        'gameData.directory',
      ),
    },
  };

  return deepFreeze(config);
}

function firstString(
  fromEnv: string | undefined,
  fromFile: unknown,
  fallback: string,
  path: string,
): string {
  if (fromEnv !== undefined && fromEnv.trim() !== '') return fromEnv.trim();
  if (fromFile === undefined) return fallback;
  if (typeof fromFile !== 'string') throw new ConfigError(`${path} must be a string`);
  return fromFile;
}

/**
 * A flag from the environment or the file.
 *
 * The environment only carries strings, so the spellings people actually type
 * are accepted there — but only those. A value that is neither true nor false is
 * an error rather than a silent `false`: "I set the flag and nothing happened"
 * is the worst way to learn about a typo.
 */
function firstBool(
  fromEnv: string | undefined,
  fromFile: unknown,
  fallback: boolean,
  path: string,
): boolean {
  if (fromEnv !== undefined && fromEnv.trim() !== '') {
    const normalised = fromEnv.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalised)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalised)) return false;
    throw new ConfigError(`${path} must be true or false`);
  }
  if (fromFile === undefined) return fallback;
  if (typeof fromFile !== 'boolean') throw new ConfigError(`${path} must be true or false`);
  return fromFile;
}

function firstPort(
  fromEnv: string | undefined,
  fromFile: unknown,
  fallback: number,
  path: string,
): number {
  const raw =
    fromEnv !== undefined && fromEnv.trim() !== '' ? Number(fromEnv) : (fromFile ?? fallback);
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0 || raw > 65535) {
    throw new ConfigError(`${path} must be a whole number between 0 and 65535`);
  }
  return raw;
}

function hostList(raw: unknown, path: string): readonly string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new ConfigError(`${path} must be an array of host names`);
  return raw.map((entry, index) => {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new ConfigError(`${path}[${String(index)}] must be a non-empty host name`);
    }
    return entry.trim();
  });
}

function isHex(value: string, minBytes: number): boolean {
  return value.length >= minBytes * 2 && value.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(value);
}

function asRecord(value: unknown, path: string): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ConfigError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
