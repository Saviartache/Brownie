import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { dirname } from 'node:path';
import { formatRecord } from './formatRecord.js';
import type { LogRecord, LogSink } from './Logger.js';

/**
 * Writes log records to a file, alongside the terminal.
 *
 * The terminal is where somebody watches the runtime while it runs; the file is
 * where anyone reads it afterwards — a second person, a later session, or
 * anything that greps. Without one, "what did it say when it happened?" can
 * only be answered by having been there.
 *
 * **Truncated on open, not appended to.** The question this file answers is
 * "what did *this run* do", and an append-only log answers it by making the
 * reader find where the run started, in a file that grows without bound across
 * runs. One run, one file, no rotation to get wrong.
 */
export class FileSink implements LogSink {
  readonly #stream: WriteStream;
  #closed = false;

  private constructor(stream: WriteStream) {
    this.#stream = stream;
  }

  /**
   * Opens the file, creating its directory.
   *
   * @throws if the path cannot be opened — a log file that was asked for and
   *   silently is not there is worse than a startup failure that says why.
   */
  static open(path: string): FileSink {
    mkdirSync(dirname(path), { recursive: true });
    return new FileSink(createWriteStream(path, { flags: 'w', encoding: 'utf8' }));
  }

  write(record: LogRecord): void {
    if (this.#closed) return;
    // Backpressure is deliberately not respected here. A log line is small and
    // its volume is bounded by the level; blocking the runtime on the disk, or
    // dropping lines when it is slow, would both be worse than letting Node
    // buffer — and a dropped line is exactly the one somebody went looking for.
    this.#stream.write(formatRecord(record));
  }

  /** Flushes and closes, once. Anything written after this is dropped. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await new Promise<void>((resolve) => {
      this.#stream.end(resolve);
    });
  }
}

/**
 * One sink that writes to several.
 *
 * A function rather than a class because it holds nothing: the list is fixed at
 * the call, and there is no lifecycle here to get wrong — each sink owns its
 * own.
 *
 * A sink that throws must not stop the others, and must not propagate: logging
 * is what the caller does *about* a failure, and a failure inside it that takes
 * down the caller turns a bad moment into a worse one. There is nowhere left to
 * report it, so it is swallowed — the one place in this runtime where that is
 * the right answer.
 */
export function writeToAll(sinks: readonly LogSink[]): LogSink {
  return {
    write(record: LogRecord): void {
      for (const sink of sinks) {
        try {
          sink.write(record);
        } catch {
          // Deliberately nothing. See above.
        }
      }
    },
  };
}
