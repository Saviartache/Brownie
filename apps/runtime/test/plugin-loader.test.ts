import { PluginState, type NativeApi, type Plugin, type SessionApi } from '@brownie/plugin-api';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { PluginHost } from '../src/plugins/PluginHost.js';
import { PluginLoader } from '../src/plugins/PluginLoader.js';
import { RecordingSink, testLogger } from './fakes.js';

const NATIVE: NativeApi = {
  connected: false,
  setFeature: () => undefined,
  onConnected: () => () => undefined,
};

const SESSIONS: SessionApi = {
  current: () => undefined,
  all: () => [],
  onConnected: () => () => undefined,
  onDisconnected: () => () => undefined,
};

const directories: string[] = [];
const loaders: PluginLoader[] = [];

afterEach(async () => {
  for (const loader of loaders.splice(0)) loader.stop();
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'brownie-plugins-'));
  directories.push(dir);
  return dir;
}

/** Writes a plugin file that reports the marker it was given. */
async function writePlugin(dir: string, name: string, id: string, marker: string): Promise<string> {
  const file = join(dir, name);
  await writeFile(
    file,
    `export default {
       meta: { id: ${JSON.stringify(id)}, name: ${JSON.stringify(id)}, category: 'utility' },
       setup(ctx) { ctx.settings.text('marker', { default: ${JSON.stringify(marker)} }); },
     };\n`,
    'utf8',
  );
  return file;
}

function harness(
  directory: string,
  importModule?: (url: string) => Promise<unknown>,
): { host: PluginHost; loader: PluginLoader; sink: RecordingSink } {
  const sink = new RecordingSink();
  const log = testLogger(sink);
  const host = new PluginHost({ log, native: NATIVE, sessions: SESSIONS });
  const loader = new PluginLoader({
    host,
    log,
    directory,
    reloadDebounceMs: 5,
    ...(importModule === undefined ? {} : { importModule }),
  });
  loaders.push(loader);
  return { host, loader, sink };
}

/**
 * An importer standing in for Node's module loader.
 *
 * Reloading depends on a URL with a fresh query being a fresh module — which is
 * Node's guarantee, not the loader's, and is not one a test runner's own module
 * graph honours. Substituting the importer keeps these tests about what the
 * loader actually decides: unload, re-import, restore the enabled state.
 */
class FakeModules {
  readonly urls: string[] = [];
  readonly #contents = new Map<string, unknown>();

  /** Sets what a file currently exports. `undefined` makes importing it throw. */
  set(path: string, module: unknown): void {
    if (module === undefined) this.#contents.delete(path);
    else this.#contents.set(path, module);
  }

  importer = (url: string): Promise<unknown> => {
    this.urls.push(url);
    // Strip the cache-busting query, then map back to the path it names.
    const path = fileURLToPath(new URL(url).href.split('?')[0] ?? url);
    const module = this.#contents.get(path);
    if (module === undefined) return Promise.reject(new Error('syntax error'));
    return Promise.resolve(module);
  };
}

/** A plugin module whose `marker` setting reports which version it is. */
function markerModule(id: string, marker: string, onDispose?: () => void): { default: Plugin } {
  return {
    default: {
      meta: { id, name: id, category: 'utility' as const },
      setup(ctx) {
        ctx.settings.text('marker', { default: marker });
        if (onDispose !== undefined) ctx.onDispose(onDispose);
      },
    },
  };
}

describe('PluginLoader', () => {
  it('loads every plugin file in the directory', async () => {
    const dir = await workspace();
    await writePlugin(dir, 'a.mjs', 'alpha', 'one');
    await writePlugin(dir, 'b.js', 'beta', 'two');
    const h = harness(dir);

    await h.loader.loadAll();

    expect(
      h.host
        .statuses()
        .map((s) => s.meta.id)
        .sort(),
    ).toEqual(['alpha', 'beta']);
    expect(h.host.settingsOf('alpha')?.values()['marker']).toBe('one');
  });

  it('ignores files that are not plugins', async () => {
    const dir = await workspace();
    await writeFile(join(dir, 'notes.txt'), 'not a plugin', 'utf8');
    await writeFile(join(dir, 'data.json'), '{}', 'utf8');
    await writeFile(join(dir, 'empty.mjs'), 'export const nothing = 1;\n', 'utf8');
    const h = harness(dir);

    await h.loader.loadAll();

    expect(h.host.statuses()).toHaveLength(0);
    expect(h.sink.messages().join(' ')).toMatch(/no plugin as its default export/);
  });

  it('treats a missing directory as "no plugins", not as a failure', async () => {
    const h = harness(join(tmpdir(), 'brownie-does-not-exist-' + String(Date.now())));
    await expect(h.loader.loadAll()).resolves.toBeUndefined();
    expect(h.host.statuses()).toHaveLength(0);
  });

  it('keeps loading after one file fails to import', async () => {
    const dir = await workspace();
    await writeFile(join(dir, 'broken.mjs'), 'this is not valid javascript {{{\n', 'utf8');
    await writePlugin(dir, 'good.mjs', 'good', 'x');
    const h = harness(dir);

    await h.loader.loadAll();

    expect(h.host.statuses().map((s) => s.meta.id)).toEqual(['good']);
    expect(h.sink.messages().join(' ')).toMatch(/could not import broken.mjs/);
  });

  it('records a plugin that throws in setup as failed, and carries on', async () => {
    const dir = await workspace();
    await writeFile(
      join(dir, 'throws.mjs'),
      `export default {
         meta: { id: 'throws', name: 'Throws', category: 'utility' },
         setup() { throw new Error('bad setup'); },
       };\n`,
      'utf8',
    );
    await writePlugin(dir, 'fine.mjs', 'fine', 'x');
    const h = harness(dir);

    await h.loader.loadAll();

    expect(h.host.status('throws')?.state).toBe(PluginState.Failed);
    expect(h.host.status('fine')?.state).toBe(PluginState.Loaded);
  });

  describe('reloading', () => {
    it('imports a fresh URL each time, which is what picks up an edit', async () => {
      const dir = await workspace();
      const file = await writePlugin(dir, 'p.mjs', 'p', 'ignored');
      const modules = new FakeModules();
      modules.set(file, markerModule('p', 'before'));
      const h = harness(dir, modules.importer);

      await h.loader.loadAll();
      expect(h.host.settingsOf('p')?.values()['marker']).toBe('before');

      modules.set(file, markerModule('p', 'after'));
      await h.loader.reload(file);

      expect(h.host.settingsOf('p')?.values()['marker']).toBe('after');
      expect(h.host.statuses()).toHaveLength(1);
      // Two imports, two different URLs: a repeated URL would be a cache hit.
      expect(modules.urls).toHaveLength(2);
      expect(modules.urls[0]).not.toBe(modules.urls[1]);
    });

    it('keeps a plugin enabled across a reload', async () => {
      const dir = await workspace();
      const file = await writePlugin(dir, 'p.mjs', 'p', 'ignored');
      const modules = new FakeModules();
      modules.set(file, markerModule('p', 'v1'));
      const h = harness(dir, modules.importer);
      await h.loader.loadAll();
      h.host.setEnabled('p', true);

      modules.set(file, markerModule('p', 'v2'));
      await h.loader.reload(file);

      expect(h.host.isEnabled('p')).toBe(true);
      expect(h.host.settingsOf('p')?.values()['marker']).toBe('v2');
    });

    it('leaves a broken plugin unloaded rather than running stale code', async () => {
      const dir = await workspace();
      const file = await writePlugin(dir, 'p.mjs', 'p', 'ignored');
      const modules = new FakeModules();
      modules.set(file, markerModule('p', 'good'));
      const h = harness(dir, modules.importer);
      await h.loader.loadAll();

      modules.set(file, undefined); // the file no longer parses
      await h.loader.reload(file);

      // The file on disk is the truth. Pretending otherwise is how a "fixed"
      // plugin keeps failing for reasons nobody can see.
      expect(h.host.statuses()).toHaveLength(0);
      expect(h.loader.files).toHaveLength(0);
    });

    it('runs the disposers of what it replaces', async () => {
      const dir = await workspace();
      const file = await writePlugin(dir, 'p.mjs', 'p', 'ignored');
      const disposals: string[] = [];
      const modules = new FakeModules();
      modules.set(
        file,
        markerModule('p', 'v1', () => disposals.push('v1')),
      );
      const h = harness(dir, modules.importer);
      await h.loader.loadAll();

      modules.set(file, markerModule('p', 'v2'));
      await h.loader.reload(file);

      expect(disposals).toEqual(['v1']);
    });

    it('does nothing for a file it never loaded', async () => {
      const dir = await workspace();
      const h = harness(dir);
      await expect(h.loader.reload(join(dir, 'ghost.mjs'))).resolves.toBeUndefined();
      expect(h.host.statuses()).toHaveLength(0);
    });
  });

  describe('watching', () => {
    it('reloads a plugin when its file changes', async () => {
      const dir = await workspace();
      const file = await writePlugin(dir, 'p.mjs', 'p', 'ignored');
      const modules = new FakeModules();
      modules.set(file, markerModule('p', 'first'));
      const h = harness(dir, modules.importer);
      await h.loader.loadAll();
      h.loader.watch();

      modules.set(file, markerModule('p', 'second'));
      await writePlugin(dir, 'p.mjs', 'p', 'touched');

      for (let attempt = 0; attempt < 200; attempt++) {
        if (h.host.settingsOf('p')?.values()['marker'] === 'second') break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(h.host.settingsOf('p')?.values()['marker']).toBe('second');
    });

    it('is safe to start twice and to stop without starting', () => {
      const h = harness(tmpdir());
      h.loader.watch();
      h.loader.watch();
      h.loader.stop();
      h.loader.stop();
    });
  });
});
