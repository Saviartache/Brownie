import { LOG_LEVEL_NAMES, type LogRecord } from './Logger.js';

/**
 * One log record as a line of text, newline included.
 *
 * Shared by every sink that writes text, so the terminal and the file cannot
 * drift into two different formats — which matters more than it sounds: the
 * file exists to be read by somebody who is not watching the terminal, and a
 * line they were told to look for has to be the line that is there.
 */
export function formatRecord(record: LogRecord): string {
  const time = new Date(record.timeMs).toISOString().slice(11, 23);
  const level = (LOG_LEVEL_NAMES[record.level] ?? '?').padEnd(5);
  const session = record.sessionId === undefined ? '' : ` [${record.sessionId}]`;
  let line = `${time} ${level} ${record.component}${session}  ${record.message}\n`;
  if (record.error !== undefined) {
    line += `${record.error.stack ?? record.error.message}\n`;
  }
  return line;
}
