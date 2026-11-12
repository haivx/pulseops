import { createLogger, type Logger } from './log.ts';
import { createRedactor, readSecret, SecretError, type Secret } from './secrets.ts';

/** Exit codes from the plan: 1 unexpected failure, 2 usage or validation error. */
const EXIT_FAILURE = 1;
const EXIT_USAGE = 2;

/**
 * Entry point for every PulseOps command. Reads the named keys from the
 * environment, and makes sure nothing the command prints or throws, including
 * an uncaught error, leaves the process without going through redaction.
 */
export async function runMain(
  secretNames: string[],
  command: (context: { secrets: Secret[]; log: Logger }) => Promise<void>,
): Promise<void> {
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

  const log = createLogger(createRedactor(secrets), (line) => process.stderr.write(`${line}\n`));
  const fail = (error: unknown, code: number) => {
    log.error('unexpected failure', { error });
    process.exitCode = code;
  };
  process.on('uncaughtException', (error) => fail(error, EXIT_FAILURE));
  process.on('unhandledRejection', (error) => fail(error, EXIT_FAILURE));

  if (configErrors.length > 0) {
    for (const error of configErrors) log.error(error.message, { code: error.code });
    process.exitCode = EXIT_USAGE;
    return;
  }

  try {
    await command({ secrets, log });
  } catch (error) {
    fail(error, EXIT_FAILURE);
  }
}
