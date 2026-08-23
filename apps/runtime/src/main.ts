import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Application } from './Application.js';
import { ConfigError, resolveConfig } from './core/config/Config.js';
import { ConsoleSink } from './core/logging/ConsoleSink.js';
import { FileSink, writeToAll } from './core/logging/FileSink.js';

/**
 * The entry point, and deliberately almost nothing.
 *
 * Everything it does is: read the configuration file, build the application,
 * start it, and arrange for it to stop once. The reference implementation's
 * equivalent was 647 lines that also deployed DLLs, mirrored files into Steam
 * installs, installed crash handlers and discovered plugins — which meant none
 * of that could be exercised without starting a proxy, and the proxy could not
 * be started without all of it.
 */

const CONFIG_PATH = process.env['BROWNIE_CONFIG'] ?? resolve('config', 'runtime.json');

/**
 * Where what the user configured from the overlay is kept.
 *
 * Beside the configuration file rather than in a directory of its own, because
 * it is configuration — just the half written by clicking rather than by
 * editing. Following `CONFIG_PATH` means pointing the runtime at a different
 * configuration takes its preferences with it.
 */
const PREFERENCES_PATH = join(dirname(CONFIG_PATH), 'plugins.json');

/**
 * Where everything learned about the game is written.
 *
 * The same directory the game's own extracted data lands in, because it is the
 * same kind of thing and goes stale on the same event — a game patch. One
 * directory to look in, and one to delete.
 */
const GAME_DATA_DIR = 'game-data';

async function readConfigFile(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (cause) {
    // A missing file is the normal case: defaults plus the environment are a
    // complete configuration. Anything else is a real problem and must be said.
    if (isNotFound(cause)) return undefined;
    throw new ConfigError(`could not read ${path}: ${describe(cause)}`);
  }
}

function isNotFound(cause: unknown): boolean {
  return typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'ENOENT';
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

async function main(): Promise<void> {
  // Configuration first: it is what says whether there is a file to open, and
  // a failure to read it has to be reportable before any sink exists.
  const config = resolveConfig({ file: await readConfigFile(CONFIG_PATH), env: process.env });

  // The file is opened here and closed here. Nothing downstream knows it
  // exists — the application is handed one sink and does not care how many
  // places it lands in.
  const logFile = config.logging.file === '' ? undefined : FileSink.open(config.logging.file);
  const sink = logFile === undefined ? new ConsoleSink() : writeToAll([new ConsoleSink(), logFile]);
  // The capture lands beside whatever the operator started the runtime in.
  // Only this file makes that choice: an application that picks its own output
  // path writes one wherever it happens to be constructed, tests included.
  const app = new Application({
    config,
    sink,
    // Everything this run learns about the game goes in one place, beside what
    // was extracted from the game's own files. They answer the same kind of
    // question and go stale together, on the same event: a game patch.
    censusPath: join(process.cwd(), GAME_DATA_DIR, 'packet-census.json'),
    // Written once per game build and kept: the metadata does not move while
    // the build does not, so walking it again would answer the same question.
    classDumpPath: join(process.cwd(), GAME_DATA_DIR, 'game-classes.txt'),
    // The one file this runtime writes on the user's behalf rather than for a
    // reader: every switch and knob they set, so a restart is not a re-setup.
    preferencesPath: PREFERENCES_PATH,
    // An argument, not an environment variable: the environment is not where
    // anyone looks, and this one decides whether bytes from a real session end
    // up in a file.
    sampleBodies: process.argv.includes('--samples'),
  });

  // One shutdown, whatever asks for it. Signals arrive more than once when a
  // user is impatient, and a second teardown running over the first is how a
  // clean exit turns into a crash.
  let stopping: Promise<void> | undefined;
  const stop = (reason: string): void => {
    app.log.info(`stopping: ${reason}`);
    stopping ??= app
      .stop()
      .catch((cause: unknown) => {
        app.log.error('shutdown failed', cause);
      })
      // Last, and after the failure path: the file has to still be open while
      // anything is being said, including what went wrong shutting down.
      .finally(async () => {
        await logFile?.close();
      });
  };

  process.once('SIGINT', () => {
    stop('SIGINT');
  });
  process.once('SIGTERM', () => {
    stop('SIGTERM');
  });

  // A rejection nobody handled is a bug, and the honest response is to say so
  // loudly and shut down rather than to keep running in an unknown state.
  process.on('unhandledRejection', (reason) => {
    app.log.fatal('unhandled promise rejection', reason);
    stop('unhandled rejection');
  });
  process.on('uncaughtException', (error) => {
    app.log.fatal('uncaught exception', error);
    stop('uncaught exception');
  });

  await app.start();
}

main().catch((cause: unknown) => {
  const message = cause instanceof ConfigError ? cause.message : describe(cause);
  process.stderr.write(`brownie failed to start: ${message}\n`);
  process.exitCode = 1;
});
