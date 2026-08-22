import { runCli } from './cli.js';

/** Entry point: the CLI itself is a pure function, so it can be tested. */
const result = runCli(process.argv.slice(2));
for (const line of result.output) process.stdout.write(`${line}\n`);
process.exitCode = result.exitCode;
