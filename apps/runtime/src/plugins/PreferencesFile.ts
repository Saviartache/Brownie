import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Logger } from '../core/logging/Logger.js';
import { PluginPreferences, readDocument } from './PluginPreferences.js';
import type { PluginStore } from './PluginStore.js';

export interface PreferencesFileOptions {
  readonly path: string;
  readonly log: Logger;
  /** How long to wait for further changes before writing. */
  readonly debounceMs?: number;
}

/**
 * Long enough that dragging a slider is one write rather than one per pixel,
 * short enough that a run killed rather than stopped loses nothing a user would
 * notice they had done.
 */
const DEFAULT_DEBOUNCE_MS = 250;

/**
 * Plugin preferences, backed by a file.
 *
 * Reading happens once, before any plugin is loaded — a plugin reads its
 * persisted values while it is declaring them, so there is nothing to replay
 * afterwards. Writing is coalesced and never blocks: a slider is dragged across
 * a hundred frames, and a file written per frame is a syscall storm in the
 * middle of a game.
 *
 * The write is a rename over the file rather than a truncate of it. The process
 * being written from is one injected into a running game, and a crash mid-write
 * must not be able to turn a working configuration into half a file.
 */
export class PreferencesFile {
  readonly #path: string;
  readonly #log: Logger;
  readonly #debounceMs: number;
  readonly #preferences: PluginPreferences;

  #timer: NodeJS.Timeout | undefined;
  /** The write in flight, so two never interleave over the same path. */
  #writing: Promise<void> = Promise.resolve();
  #dirty = false;
  #closed = false;

  constructor(options: PreferencesFileOptions) {
    this.#path = options.path;
    this.#log = options.log.child('preferences');
    this.#debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.#preferences = new PluginPreferences(() => {
      this.#schedule();
    });
  }

  /** What the plugin host reads and writes through. */
  get store(): PluginStore {
    return this.#preferences;
  }

  /**
   * Reads the file, if there is one.
   *
   * A missing file is the normal case on a first run, and an unreadable one is
   * a warning rather than a failure: the runtime works on defaults, and
   * refusing to start over a preferences file would be the worst possible
   * moment to find out it had been hand-edited.
   */
  async load(): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.#path, 'utf8');
    } catch (cause) {
      if (!isNotFound(cause)) {
        this.#log.warn(`could not read ${this.#path}: ${describe(cause)}`);
      }
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch (cause) {
      this.#log.warn(`${this.#path} is not valid JSON and was ignored: ${describe(cause)}`);
      return;
    }

    const document = readDocument(parsed);
    if (document === undefined) {
      this.#log.warn(`${this.#path} is not a preferences file this build understands; ignoring it`);
      return;
    }
    this.#preferences.load(document.plugins);
  }

  /** Cancels the pending write and performs it. Safe to call more than once. */
  async close(): Promise<void> {
    this.#closed = true;
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    await this.#flush();
  }

  #schedule(): void {
    this.#dirty = true;
    if (this.#closed || this.#timer !== undefined) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.#flush();
    }, this.#debounceMs);
    // Nothing here is worth holding the event loop open for: `close` is what
    // guarantees the last change reaches the disk.
    this.#timer.unref();
  }

  /** Writes if anything changed, behind whatever write is already running. */
  #flush(): Promise<void> {
    if (!this.#dirty) return this.#writing;
    this.#dirty = false;
    // Serialised now rather than inside the write, so what lands is the state
    // that was dirty rather than whatever it has become by the time its turn
    // comes round.
    const text = `${JSON.stringify(this.#preferences.toDocument(), undefined, 2)}\n`;
    this.#writing = this.#writing.then(() => this.#write(text));
    return this.#writing;
  }

  async #write(text: string): Promise<void> {
    const temporary = `${this.#path}.tmp`;
    try {
      // Created rather than assumed: the caller names a path, and on a fresh
      // clone the directory it names does not exist yet.
      await mkdir(dirname(this.#path), { recursive: true });
      await writeFile(temporary, text, 'utf8');
      await rename(temporary, this.#path);
      this.#log.debug(`wrote ${this.#path}`);
    } catch (cause) {
      this.#log.warn(`could not save plugin preferences: ${describe(cause)}`);
    }
  }
}

function isNotFound(cause: unknown): boolean {
  return typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'ENOENT';
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
