import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { ConsoleSink } from '../src/core/logging/ConsoleSink.js';
import { FileSink, writeToAll } from '../src/core/logging/FileSink.js';
import { LogLevel, type LogRecord, type LogSink } from '../src/core/logging/Logger.js';
import { formatRecord } from '../src/core/logging/formatRecord.js';

const directories: string[] = [];

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), 'brownie-log-'));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const record = (over: Partial<LogRecord> = {}): LogRecord => ({
  level: LogLevel.Info,
  component: 'proxy',
  message: 'listening',
  timeMs: Date.UTC(2026, 0, 2, 3, 4, 5, 678),
  ...over,
});

describe('the shared line format', () => {
  it('puts the time, level, component and message on one line', () => {
    expect(formatRecord(record())).toBe('03:04:05.678 info  proxy  listening\n');
  });

  it('names the session so lines can be grouped', () => {
    expect(formatRecord(record({ sessionId: 's7' }))).toContain('proxy [s7]  listening');
  });

  it('follows an error with its stack, which is the reason it was logged', () => {
    const error = new Error('boom');
    error.stack = 'Error: boom\n    at nowhere';
    expect(formatRecord(record({ error }))).toContain('at nowhere');
  });

  it('is the format the console writes, not a second one', () => {
    // The file exists so somebody who was not watching can read what happened.
    // A line they were told to look for has to be the line that is there.
    const written: string[] = [];
    const stream = { write: (line: string): boolean => (written.push(line), true) };
    new ConsoleSink(stream as unknown as NodeJS.WritableStream).write(record());

    expect(written[0]).toBe(formatRecord(record()));
  });
});

describe('the log file', () => {
  it('writes the lines it is given, creating the directory', async () => {
    const path = join(scratch(), 'nested', 'runtime.log');
    const sink = FileSink.open(path);
    sink.write(record());
    sink.write(record({ level: LogLevel.Warn, message: 'game data is out of date' }));
    await sink.close();

    const contents = readFileSync(path, 'utf8');
    expect(contents).toContain('listening');
    expect(contents).toContain('warn  proxy  game data is out of date');
  });

  it('holds one run, not every run that ever happened', async () => {
    const path = join(scratch(), 'runtime.log');

    const first = FileSink.open(path);
    first.write(record({ message: 'the previous run' }));
    await first.close();

    const second = FileSink.open(path);
    second.write(record({ message: 'this run' }));
    await second.close();

    const contents = readFileSync(path, 'utf8');
    expect(contents).toContain('this run');
    expect(contents).not.toContain('the previous run');
  });

  it('drops what is written after it closes rather than throwing', async () => {
    const path = join(scratch(), 'runtime.log');
    const sink = FileSink.open(path);
    await sink.close();
    await sink.close(); // idempotent

    expect(() => {
      sink.write(record());
    }).not.toThrow();
  });
});

describe('writing to several sinks', () => {
  it('gives every sink the same record', () => {
    const first: LogRecord[] = [];
    const second: LogRecord[] = [];
    const sink = writeToAll([
      { write: (r): void => void first.push(r) },
      { write: (r): void => void second.push(r) },
    ]);

    sink.write(record());

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
  });

  it('does not let one sink failing take out the others, or the caller', () => {
    // Logging is what a caller does *about* a failure. A failure inside it that
    // propagates turns a bad moment into a worse one, and there is nowhere left
    // to report it.
    const survived: LogRecord[] = [];
    const broken: LogSink = {
      write: (): void => {
        throw new Error('the disk is full');
      },
    };
    const sink = writeToAll([broken, { write: (r): void => void survived.push(r) }]);

    expect(() => {
      sink.write(record());
    }).not.toThrow();
    expect(survived).toHaveLength(1);
  });
});
