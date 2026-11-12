// `pulseops note --dry-run [--fleet <path>]`: reads healthchecks.io for the
// checks in fleet.yaml and prints the note. Sending is not built yet.
import { parseArgs } from 'node:util';
import { ConfigError } from './config-error.ts';
import { loadFleet } from './fleet.ts';
import { runMain, EXIT_USAGE } from './run-main.ts';
import { assertNoSecrets } from './secrets.ts';
import { classify } from './note/classify.ts';
import { renderNote } from './note/render.ts';
import { readChecks, healthchecksBaseUrl } from './sources/healthchecks.ts';
import { VendorHttpError } from './vendor-http.ts';

const USAGE = 'usage: pulseops note --dry-run [--fleet <path>]';

await runMain(['HEALTHCHECKS_API_KEY'], async ({ secrets, log, redact }) => {
  const usage = (message: string) => {
    log.error(`pulseops E_USAGE: ${message}; ${USAGE}`, { code: 'E_USAGE' });
    process.exitCode = EXIT_USAGE;
  };

  // Parsed here, not before runMain, so even an argument error is redacted.
  let args;
  try {
    args = parseArgs({ allowPositionals: true, options: { 'dry-run': { type: 'boolean' }, fleet: { type: 'string' } } });
  } catch (error) {
    return usage((error as Error).message);
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
  let checks: Map<string, string> | 'unavailable';
  try {
    checks = await readChecks(key, redact, baseUrl);
  } catch (error) {
    // A vendor failure is one problem in the note, which still prints. Any
    // other error is a bug and exits 1 instead of reading as an outage.
    if (!(error instanceof VendorHttpError)) throw error;
    log.error('healthchecks.io read failed', { source: 'healthchecks.io', error });
    checks = 'unavailable';
  }

  const note = renderNote(classify(fleet, checks), new Date(), fleet.timezone);
  assertNoSecrets(note, secrets, 'note text');
  process.stdout.write(note);
});
