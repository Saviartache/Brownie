import type { Plugin } from '@brownie/plugin-api';
import { watch, type FSWatcher } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { toError, type Logger } from '../core/logging/Logger.js';
import type { PluginHost } from './PluginHost.js';

/** Extensions a plugin file may have. Source is compiled before it gets here. */
const PLUGIN_EXTENSIONS = new Set(['.js', '.mjs']);

/** How a module is brought in. Replaceable so a test can drive reloading. */
export type ModuleImporter = (url: string) => Promise<unknown>;

export interface PluginLoaderOptions {
  readonly host: PluginHost;
  readonly log: Logger;
  readonly directory: string;
  /** How long to wait for an editor to finish writing before reloading. */
  readonly reloadDebounceMs?: number;
  /**
   * Overrides how a module is imported.
   *
   * The default is Node's own `import()`, which treats a URL with a different
   * query as a different module — that is what makes reloading pick up an edit.
   * A test can substitute its own so the loader's behaviour can be checked
   * without depending on a module cache it does not own.
   */
  readonly importModule?: ModuleImporter;
}

interface LoadedFile {
  readonly path: string;
  readonly pluginId: string;
}

/**
 * Finds plugins on disk and keeps them in step with the files.
 *
 * Discovery and hosting are separate on purpose: {@link PluginHost} knows how to
 * run a plugin and nothing about where it came from, which is what lets every
 * lifecycle rule be tested without a filesystem. This class is the only part
 * that touches disk, and the only part that has to reason about a half-written
 * file or a module that throws at import time.
 */
export class PluginLoader {
  readonly #host: PluginHost;
  readonly #log: Logger;
  readonly #directory: string;
  readonly #debounceMs: number;
  readonly #import: ModuleImporter;

  readonly #loaded = new Map<string, LoadedFile>();
  #watcher: FSWatcher | undefined;
  #pending: ReturnType<typeof setTimeout> | undefined;
  #generation = 0;

  constructor(options: PluginLoaderOptions) {
    this.#host = options.host;
    this.#log = options.log.child('plugins');
    this.#directory = resolve(options.directory);
    this.#debounceMs = options.reloadDebounceMs ?? 150;
    this.#import = options.importModule ?? ((url) => import(url) as Promise<unknown>);
  }

  get directory(): string {
    return this.#directory;
  }

  /** Files currently loaded, by absolute path. */
  get files(): readonly string[] {
    return [...this.#loaded.keys()];
  }

  /**
   * Loads every plugin in the directory.
   *
   * A missing directory is not an error — running with no plugins is a normal
   * way to run. One plugin failing does not stop the others: they are
   * independent, and the useful outcome is "everything that works, works".
   */
  async loadAll(): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(this.#directory);
    } catch (cause) {
      if (isNotFound(cause)) {
        this.#log.info(`no plugin directory at ${this.#directory}`);
        return;
      }
      throw cause;
    }

    const files = entries
      .filter((entry) => PLUGIN_EXTENSIONS.has(extname(entry)))
      .map((entry) => join(this.#directory, entry))
      .sort();

    for (const file of files) await this.#load(file);
    this.#log.info(`loaded ${String(this.#loaded.size)} of ${String(files.length)} plugin file(s)`);
  }

  /**
   * Watches the directory and reloads a plugin when its file changes.
   *
   * Debounced, because an editor saving a file produces several events and the
   * first of them can arrive while the file is still half-written — which would
   * load a plugin that is a syntax error through no fault of the author.
   */
  watch(): void {
    if (this.#watcher !== undefined) return;
    try {
      this.#watcher = watch(this.#directory, (_event, filename) => {
        if (filename === null || !PLUGIN_EXTENSIONS.has(extname(filename))) return;
        this.#scheduleReload(join(this.#directory, filename));
      });
      this.#log.info(`watching ${this.#directory} for changes`);
    } catch (cause) {
      // Not being able to watch is a lost convenience, not a failure to run.
      this.#log.warn(`cannot watch ${this.#directory}: ${toError(cause)?.message ?? 'unknown'}`);
    }
  }

  /** Stops watching. Loaded plugins stay loaded. */
  stop(): void {
    if (this.#pending !== undefined) {
      clearTimeout(this.#pending);
      this.#pending = undefined;
    }
    this.#watcher?.close();
    this.#watcher = undefined;
  }

  /**
   * Reloads one file: unload what it produced, then load it again.
   *
   * A plugin that has become broken leaves the previous one unloaded rather
   * than running stale code — the file on disk is the truth, and pretending
   * otherwise is how a "fixed" plugin keeps failing.
   */
  async reload(path: string): Promise<void> {
    const file = resolve(path);
    const wasEnabled = this.#unload(file);
    const loaded = await this.#load(file);
    if (loaded !== undefined && wasEnabled) this.#host.setEnabled(loaded, true);
  }

  #scheduleReload(path: string): void {
    if (this.#pending !== undefined) clearTimeout(this.#pending);
    this.#pending = setTimeout(() => {
      this.#pending = undefined;
      void this.reload(path).catch((cause: unknown) => {
        this.#log.error(`reloading ${basename(path)} failed`, cause);
      });
    }, this.#debounceMs);
    this.#pending.unref();
  }

  /** @returns the plugin id, or `undefined` if the file produced none. */
  async #load(file: string): Promise<string | undefined> {
    try {
      if (!(await stat(file)).isFile()) return undefined;
    } catch {
      // Deleted between the directory listing and now.
      return undefined;
    }

    let module: unknown;
    try {
      // The query string defeats the ES module cache, which has no eviction:
      // without it a reloaded file would import to the code it had at startup.
      // The old module object stays reachable for the life of the process —
      // a leak we accept for a developer convenience, and one reason hot reload
      // is a development feature rather than something a long run relies on.
      module = await this.#import(`${pathToFileURL(file).href}?v=${String(++this.#generation)}`);
    } catch (cause) {
      this.#log.error(`could not import ${basename(file)}`, cause);
      return undefined;
    }

    const plugin = asPlugin(module);
    if (plugin === undefined) {
      this.#log.warn(`${basename(file)} has no plugin as its default export — ignoring it`);
      return undefined;
    }

    const status = this.#host.load(plugin);
    this.#loaded.set(file, { path: file, pluginId: plugin.meta.id });
    this.#log.debug(`${basename(file)} provides "${plugin.meta.id}" (${status.state})`);
    return plugin.meta.id;
  }

  /** @returns whether the plugin it unloaded had been enabled. */
  #unload(file: string): boolean {
    const loaded = this.#loaded.get(file);
    if (loaded === undefined) return false;
    const wasEnabled = this.#host.isEnabled(loaded.pluginId);
    this.#host.unload(loaded.pluginId);
    this.#loaded.delete(file);
    return wasEnabled;
  }
}

/**
 * Checks that a module really exports a plugin.
 *
 * A module can export anything; `definePlugin` validated the metadata at the
 * point of definition, but nothing guarantees the file called it. This is the
 * boundary where that stops being an assumption.
 */
function asPlugin(module: unknown): Plugin | undefined {
  if (typeof module !== 'object' || module === null) return undefined;
  const candidate = (module as { default?: unknown }).default;
  if (typeof candidate !== 'object' || candidate === null) return undefined;

  const record = candidate as { meta?: unknown; setup?: unknown };
  if (typeof record.setup !== 'function') return undefined;
  if (typeof record.meta !== 'object' || record.meta === null) return undefined;
  const meta = record.meta as { id?: unknown };
  if (typeof meta.id !== 'string' || meta.id === '') return undefined;

  return candidate as Plugin;
}

function isNotFound(cause: unknown): boolean {
  return typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'ENOENT';
}
