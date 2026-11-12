import { createLogger, type Logger } from './log.ts';
import { formatError } from './format-error.ts';
import { createRedactor, readSecret, SecretError, type Secret } from './secrets.ts';

/** Exit codes from the plan: 1 unexpected failure, 2 usage or validation error. */
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;

/** How long a failing run waits for stderr to flush before it exits anyway. */
const EXIT_FLUSH_LIMIT_MS = 2000;

let handlersInstalled = false;
let activeFail: ((error: unknown) => void) | undefined;

export type CommandContext = { secrets: Secret[]; log: Logger; redact: (text: string) => string };

/**
 * Entry point for every PulseOps command. Reads the named keys from the
 * environment. Everything written through the `log` it passes in, and every
 * error the command throws or leaves uncaught, goes through redaction. Direct
 * `console` or `process.stdout` writes do not: a command may write its output
 * to stdout only after that output has passed `assertNoSecrets`.
 *
 * An unexpected failure (thrown, rejected or uncaught) ends the process with
 * exit code 1 once the log line is written, even if a socket or timer is still
 * open, so a scheduled run never hangs. A missing or invalid key sets exit
 * code 2 before the command runs.
 */
export async function runMain(secretNames: string[], command: (context: CommandContext) => Promise<void>): Promise<void> {
  const secrets: Secret[] = [];
  const configErrors: SecretError[] = [];
  for (const name of secretNames) {
    try {
      secrets.push(readSecret(process.env, name));
    } catch (error) {
      if (error instanceof SecretError) configErrors.push(error);
      else throw error;
    }
  }

  const redact = createRedactor(secrets);
  const log = createLogger(redact, (line) => process.stderr.write(`${line}\n`));
  let failing = false;
  const fail = (error: unknown) => {
    // A second failure while exiting (such as a broken stderr pipe) must not loop.
    if (failing) return;
    failing = true;
    process.exitCode = EXIT_FAILURE;
    log.error('unexpected failure', formatError(error));
    // Exit after stderr has taken the line; the callback runs once it is flushed.
    process.stderr.write('', () => process.exit(EXIT_FAILURE));
    // If stderr never drains (a reader that stopped reading), exit anyway.
    // Where pipe writes are synchronous (Linux), a full pipe blocks before
    // this timer can run; that case needs the reader to drain the pipe.
    setTimeout(() => process.exit(EXIT_FAILURE), EXIT_FLUSH_LIMIT_MS).unref();
  };
  activeFail = fail;
  if (!handlersInstalled) {
    // Installed once per process; each runMain call points them at its own fail.
    handlersInstalled = true;
    process.on('uncaughtException', (error) => activeFail?.(error));
    process.on('unhandledRejection', (error) => activeFail?.(error));
  }

  if (configErrors.length > 0) {
    for (const error of configErrors) log.error(error.message, { code: error.code });
    process.exitCode = EXIT_USAGE;
    return;
  }

  try {
    await command({ secrets, log, redact });
  } catch (error) {
    fail(error);
  }
}
