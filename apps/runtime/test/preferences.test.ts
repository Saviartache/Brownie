import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PluginPreferences, readDocument } from '../src/plugins/PluginPreferences.js';
import { PreferencesFile } from '../src/plugins/PreferencesFile.js';
import { RecordingSink, testLogger } from './fakes.js';

describe('PluginPreferences', () => {
  it('remembers settings and the switch, and reports only real changes', () => {
    let changes = 0;
    const preferences = new PluginPreferences(() => changes++);

    preferences.write('p', { hp: 40 });
    preferences.write('p', { hp: 40 });
    preferences.writeEnabled('p', true);
    preferences.writeEnabled('p', true);

    expect(preferences.read('p')).toEqual({ hp: 40 });
    expect(preferences.readEnabled('p')).toBe(true);
    expect(changes).toBe(2);

    // A key removed from the map is a change even though the rest matches.
    preferences.write('p', {});
    expect(changes).toBe(3);
  });

  it('knows nothing about a plugin it has never been told about', () => {
    const preferences = new PluginPreferences();
    expect(preferences.read('missing')).toBeUndefined();
    expect(preferences.readEnabled('missing')).toBeUndefined();
  });

  it('drops the parts of a document it cannot use and keeps the rest', () => {
    const preferences = new PluginPreferences();
    const restored = preferences.load({
      good: { enabled: true, settings: { a: 1, b: 'two', c: false } },
      shapes: {
        enabled: 'yes',
        settings: { object: {}, list: [], nothing: null, infinite: Number.POSITIVE_INFINITY },
      },
      notAnObject: 7,
      '': { enabled: true },
    });

    expect(restored).toBe(2);
    expect(preferences.read('good')).toEqual({ a: 1, b: 'two', c: false });
    // `enabled` that is not a boolean is absent, not false: the difference is
    // whether the plugin's own default still applies.
    expect(preferences.readEnabled('shapes')).toBeUndefined();
    expect(preferences.read('shapes')).toEqual({});
    expect(preferences.read('notAnObject')).toBeUndefined();
  });

  it('survives a round trip through its document', () => {
    const preferences = new PluginPreferences();
    preferences.writeEnabled('p', true);
    preferences.write('p', { hp: 40 });

    const restored = new PluginPreferences();
    const document = readDocument(JSON.parse(JSON.stringify(preferences.toDocument())) as unknown);
    restored.load(document?.plugins);

    expect(restored.readEnabled('p')).toBe(true);
    expect(restored.read('p')).toEqual({ hp: 40 });
  });

  it('refuses a document at a version it does not know', () => {
    expect(readDocument({ version: 99, plugins: { p: {} } })).toBeUndefined();
    expect(readDocument([])).toBeUndefined();
    expect(readDocument('nope')).toBeUndefined();
  });
});

describe('PreferencesFile', () => {
  let directory = '';
  let path = '';

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'brownie-preferences-'));
    // A subdirectory that does not exist yet: the first save has to create it.
    path = join(directory, 'config', 'plugins.json');
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  function open(): PreferencesFile {
    return new PreferencesFile({ path, log: testLogger(new RecordingSink()), debounceMs: 0 });
  }

  it('writes what changed and reads it back', async () => {
    const file = open();
    file.store.writeEnabled('p', true);
    file.store.write('p', { hp: 40 });
    await file.close();

    const reopened = open();
    await reopened.load();

    expect(reopened.store.readEnabled('p')).toBe(true);
    expect(reopened.store.read('p')).toEqual({ hp: 40 });
    await reopened.close();
  });

  it('writes nothing when nothing changed', async () => {
    const file = open();
    await file.close();

    await expect(readFile(path, 'utf8')).rejects.toThrow(/ENOENT/);
  });

  it('starts empty when there is no file, and when there is an unusable one', async () => {
    const missing = open();
    await missing.load();
    expect(missing.store.readEnabled('p')).toBeUndefined();

    const sink = new RecordingSink();
    await writeFile(join(directory, 'broken.json'), '{ not json', 'utf8');
    const broken = new PreferencesFile({
      path: join(directory, 'broken.json'),
      log: testLogger(sink),
      debounceMs: 0,
    });
    await broken.load();

    expect(broken.store.readEnabled('p')).toBeUndefined();
    expect(sink.messages().some((message) => message.includes('not valid JSON'))).toBe(true);
  });

  it('coalesces a burst into one write', async () => {
    const file = open();
    for (let value = 0; value < 50; value++) file.store.write('p', { radius: value });
    await file.close();

    const document = JSON.parse(await readFile(path, 'utf8')) as {
      plugins: Record<string, object>;
    };
    expect(document.plugins['p']).toEqual({ settings: { radius: 49 } });
  });
});
