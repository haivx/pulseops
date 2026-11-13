// `pulseops note [--dry-run] [--fleet <path>]`: reads healthchecks.io for the
// checks in fleet.yaml, builds the note, and sends it to Telegram (or, with
// --dry-run, prints it). After a delivery it pings the note job's check.
import { parseArgs } from 'node:util';
import { setTimeout as wait } from 'node:timers/promises';
import { ConfigError } from './config-error.ts';
import { loadFleet } from './fleet.ts';
import { runMain, EXIT_USAGE, type SecretSource } from './run-main.ts';
import { assertNoSecrets } from './secrets.ts';
import { classify } from './note/classify.ts';
import { renderNote } from './note/render.ts';
import { readChecks, healthchecksBaseUrl, checksOrUnavailable } from './sources/healthchecks.ts';
import { readTelegramToken, readPingUuid, telegramBotId, telegramChatId, sendNote, deliveryReport, pingReport, SEND_BUDGET_MS, TELEGRAM_DEFAULT_URL } from './telegram.ts';
import { getOk, vendorBaseUrl, VendorHttpError } from './vendor-http.ts';

const USAGE = 'usage: pulseops note [--dry-run] [--fleet <path>]';
const PING_DEFAULT_URL = 'https://hc-ping.com';

// Parsed before runMain so it knows which keys this run needs. A parse error is
// reported inside runMain, and never with parseArgs' own message (it quotes argv).
function parse() {
  return parseArgs({ allowPositionals: true, options: { 'dry-run': { type: 'boolean' }, fleet: { type: 'string' } } });
}
let args: ReturnType<typeof parse> | undefined;
try {
  args = parse();
} catch {
  args = undefined;
}
const dryRun = args?.values['dry-run'] === true;
const isNote = args !== undefined && args.positionals.length === 1 && args.positionals[0] === 'note';
// Keys are read only for a command that uses them; a usage error needs none.
const sources: SecretSource[] = !isNote ? [] : dryRun ? ['HEALTHCHECKS_API_KEY'] : ['HEALTHCHECKS_API_KEY', readTelegramToken, readPingUuid];

await runMain(sources, async ({ secrets, log, redact }) => {
  const usage = (message: string) => {
    log.error(`pulseops E_USAGE: ${message}; ${USAGE}`, { code: 'E_USAGE' });
    process.exitCode = EXIT_USAGE;
  };
  if (args === undefined) return usage('invalid arguments');
  if (!isNote) return usage('unknown command');

  let fleet;
  let baseUrl;
  let telegram: { botId: string; chatId: string; baseUrl: string } | undefined;
  let pingBase: string | undefined;
  try {
    fleet = loadFleet(args.values.fleet ?? 'fleet.yaml');
    baseUrl = healthchecksBaseUrl(process.env.HEALTHCHECKS_API_URL);
    if (!dryRun) {
      telegram = {
        botId: telegramBotId(process.env),
        chatId: telegramChatId(process.env),
        baseUrl: vendorBaseUrl('TELEGRAM_API_URL', process.env.TELEGRAM_API_URL, TELEGRAM_DEFAULT_URL),
      };
      pingBase = vendorBaseUrl('HEALTHCHECKS_PING_URL_BASE', process.env.HEALTHCHECKS_PING_URL_BASE, PING_DEFAULT_URL);
    }
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    log.error(error.message, { code: error.code });
    process.exitCode = EXIT_USAGE;
    return;
  }

  const secret = (name: string) => secrets.find((s) => s.name === name)!.value;
  const checks = await checksOrUnavailable(() => readChecks(secret('HEALTHCHECKS_API_KEY'), redact, baseUrl), log);
  const note = renderNote(classify(fleet, checks), new Date(), fleet.timezone);

  if (telegram === undefined || pingBase === undefined) {
    assertNoSecrets(note, secrets, 'note text');
    process.stdout.write(note);
    return;
  }

  assertNoSecrets(note, secrets, 'Telegram message');
  const result = await sendNote({
    ...telegram,
    secret: secret('TELEGRAM_BOT_TOKEN'),
    text: note,
    redact,
    sleep: (ms) => wait(ms),
    now: () => Date.now(),
    budgetMs: SEND_BUDGET_MS,
  });
  const report = deliveryReport(result, { apiUrlOverride: process.env.TELEGRAM_API_URL !== undefined });
  log[report.level](report.message, report.fields);
  if (result.kind !== 'delivered') {
    // No ping: the note job's check then alerts through healthchecks.io's own channel.
    process.exitCode = report.exit;
    return;
  }

  try {
    await getOk(`${pingBase}/${secret('HEALTHCHECKS_PING_UUID')}`, redact);
  } catch (error) {
    if (!(error instanceof VendorHttpError)) throw error;
    const ping = pingReport(error, { pingUrlOverride: process.env.HEALTHCHECKS_PING_URL_BASE !== undefined });
    log[ping.level](ping.message, ping.fields);
  }
});
