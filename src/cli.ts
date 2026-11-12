// `pulseops note --dry-run [--fleet <path>]`: reads healthchecks.io for the
// checks in fleet.yaml and prints the note. Sending is not built yet.
import { parseArgs } from 'node:util';
import { loadFleet, FleetError } from './fleet.ts';
import { runMain } from './run-main.ts';
import { assertNoSecrets } from './secrets.ts';
import { classify } from './note/classify.ts';
import { renderNote } from './note/render.ts';
import { readChecks, HEALTHCHECKS_DEFAULT_URL } from './sources/healthchecks.ts';

const USAGE = 'usage: pulseops note --dry-run [--fleet <path>]';
const EXIT_USAGE = 2;

let args: ReturnType<typeof parseArgs>;
try {
  args = parseArgs({ allowPositionals: true, options: { 'dry-run': { type: 'boolean' }, fleet: { type: 'string' } } });
} catch (error) {
  process.stderr.write(`pulseops E_USAGE: ${(error as Error).message}; ${USAGE}\n`);
  process.exit(EXIT_USAGE);
}

await runMain(['HEALTHCHECKS_API_KEY'], async ({ secrets, log, redact }) => {
  const [command] = args.positionals;
  if (command !== 'note' || args.positionals.length > 1) {
    log.error(`pulseops E_USAGE: unknown command; ${USAGE}`, { code: 'E_USAGE' });
    process.exitCode = EXIT_USAGE;
    return;
  }
  if (args.values['dry-run'] !== true) {
    log.error('pulseops E_USAGE: sending is not built yet; fix: use --dry-run', { code: 'E_USAGE' });
    process.exitCode = EXIT_USAGE;
    return;
  }

  let fleet;
  try {
    fleet = loadFleet(typeof args.values.fleet === 'string' ? args.values.fleet : 'fleet.yaml');
  } catch (error) {
    if (!(error instanceof FleetError)) throw error;
    log.error(error.message, { code: error.code });
    process.exitCode = EXIT_USAGE;
    return;
  }

  const key = secrets.find((secret) => secret.name === 'HEALTHCHECKS_API_KEY')!.value;
  const baseUrl = process.env.HEALTHCHECKS_API_URL ?? HEALTHCHECKS_DEFAULT_URL;
  let checks: Map<string, string> | 'unavailable';
  try {
    checks = await readChecks(key, redact, baseUrl);
  } catch (error) {
    // An enabled source that fails is one problem in the note, which still prints.
    log.error('healthchecks.io read failed', { source: 'healthchecks.io', error });
    checks = 'unavailable';
  }

  const note = renderNote(classify(fleet, checks), new Date(), fleet.timezone);
  assertNoSecrets(note, secrets, 'note text');
  process.stdout.write(note);
});
