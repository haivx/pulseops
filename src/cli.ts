// `pulseops note --dry-run [--fleet <path>]`: reads healthchecks.io for the
// checks in fleet.yaml and prints the note. Sending is not built yet.
import { parseArgs } from 'node:util';
import { ConfigError } from './config-error.ts';
import { loadFleet } from './fleet.ts';
import { runMain, EXIT_USAGE } from './run-main.ts';
import { assertNoSecrets } from './secrets.ts';
import { classify } from './note/classify.ts';
import { renderNote } from './note/render.ts';
import { readChecks, healthchecksBaseUrl, checksOrUnavailable } from './sources/healthchecks.ts';

const USAGE = 'usage: pulseops note --dry-run [--fleet <path>]';

await runMain(['HEALTHCHECKS_API_KEY'], async ({ secrets, log, redact }) => {
  const usage = (message: string) => {
    log.error(`pulseops E_USAGE: ${message}; ${USAGE}`, { code: 'E_USAGE' });
    process.exitCode = EXIT_USAGE;
  };

  let args;
  try {
    args = parseArgs({ allowPositionals: true, options: { 'dry-run': { type: 'boolean' }, fleet: { type: 'string' } } });
  } catch {
    // parseArgs quotes the bad argument in its message, so it is not written.
    return usage('invalid arguments');
  }
  if (args.positionals.length !== 1 || args.positionals[0] !== 'note') return usage('unknown command');
  if (args.values['dry-run'] !== true) return usage('sending is not built yet; fix: use --dry-run');

  let fleet;
  let baseUrl;
  try {
    fleet = loadFleet(args.values.fleet ?? 'fleet.yaml');
    baseUrl = healthchecksBaseUrl(process.env.HEALTHCHECKS_API_URL);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    log.error(error.message, { code: error.code });
    process.exitCode = EXIT_USAGE;
    return;
  }

  const key = secrets.find((secret) => secret.name === 'HEALTHCHECKS_API_KEY')!.value;
  const checks = await checksOrUnavailable(() => readChecks(key, redact, baseUrl), log);

  const note = renderNote(classify(fleet, checks), new Date(), fleet.timezone);
  assertNoSecrets(note, secrets, 'note text');
  process.stdout.write(note);
});
