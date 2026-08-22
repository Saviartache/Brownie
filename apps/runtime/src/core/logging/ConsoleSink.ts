import { formatRecord } from './formatRecord.js';
import type { LogRecord, LogSink } from './Logger.js';

/**
 * Writes log records to the terminal.
 *
 * The only place in the runtime that is allowed to touch `console`, which is
 * why the lint rule banning it elsewhere can stay on: a stray `console.log` in
 * a packet handler is invisible in production and unbounded in cost.
 */
export class ConsoleSink implements LogSink {
  readonly #stream: NodeJS.WritableStream;

  constructor(stream: NodeJS.WritableStream = process.stdout) {
    this.#stream = stream;
  }

  write(record: LogRecord): void {
    this.#stream.write(formatRecord(record));
  }
}
