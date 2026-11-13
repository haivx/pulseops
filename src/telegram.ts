// Sends the note to the owner's Telegram chat (open question 1, decided
// 2026-11-12). See docs/rules/secrets.md for how the bot token is a secret.
import { ConfigError } from './config-error.ts';
import { checkSecretValue, readSecret, SecretError, type Secret } from './secrets.ts';
import { formatError } from './format-error.ts';
import type { Field } from './log.ts';
import { EXIT_DEPENDENCY, EXIT_USAGE } from './run-main.ts';
import { postJson, VendorHttpError, VENDOR_TIMEOUT_MS } from './vendor-http.ts';

export const TELEGRAM_DEFAULT_URL = 'https://api.telegram.org';

/** Telegram's limit for one message. */
const MAX_MESSAGE = 4096;
const TOKEN_SHAPE = /^(\d{1,20}):(.+)$/;

function rawToken(env: Record<string, string | undefined>): { id: string; secret: string } {
  const value = env.TELEGRAM_BOT_TOKEN;
  if (value === undefined || value === '') {
    throw new SecretError(
      'E_CONFIG_MISSING',
      'pulseops E_CONFIG_MISSING: environment variable TELEGRAM_BOT_TOKEN is not set; fix: set it to the token @BotFather gave you',
    );
  }
  const match = TOKEN_SHAPE.exec(value);
  if (match === null) {
    throw new SecretError(
      'E_CONFIG_INVALID',
      'pulseops E_CONFIG_INVALID: TELEGRAM_BOT_TOKEN must look like <digits>:<secret>; fix: copy the full token from @BotFather again',
    );
  }
  return { id: match[1]!, secret: match[2]! };
}

/**
 * A bot token is `<bot id>:<secret>`. The bot id is public; only the part after
 * the colon is a Secret, and it must pass the same character rule as every key.
 * The redactor then also covers the full token, since the secret is inside it.
 */
export function readTelegramToken(env: Record<string, string | undefined>): Secret {
  return checkSecretValue('TELEGRAM_BOT_TOKEN', rawToken(env).secret);
}

/** The public bot id in front of the colon. */
export function telegramBotId(env: Record<string, string | undefined>): string {
  return rawToken(env).id;
}

/** The chat id is config, not a key: a (possibly negative) number. */
export function telegramChatId(env: Record<string, string | undefined>): string {
  const value = env.TELEGRAM_CHAT_ID;
  if (value === undefined || !/^-?\d{1,20}$/.test(value)) {
    throw new ConfigError(
      'pulseops E_CONFIG_INVALID: TELEGRAM_CHAT_ID must be a numeric chat id; fix: send your bot a message and read the id from getUpdates',
    );
  }
  return value;
}

const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });

/** Cuts one line into pieces of at most `limit` units, only between visible characters (graphemes). */
function cutLine(line: string, limit: number): string[] {
  const pieces: string[] = [];
  let piece = '';
  for (const { segment } of graphemes.segment(line)) {
    // A single grapheme longer than the limit (a long run of combining marks) is cut by code point.
    const units = segment.length > limit ? Array.from(segment) : [segment];
    for (const unit of units) {
      if (piece.length + unit.length > limit) {
        pieces.push(piece);
        piece = '';
      }
      piece += unit;
    }
  }
  pieces.push(piece);
  return pieces;
}

/**
 * Splits text into parts of at most `limit` UTF-16 units, at line breaks where
 * it can, keeping blank lines. A line longer than the limit is cut only between
 * visible characters, so an emoji (a surrogate pair or a ZWJ sequence) stays whole.
 */
export function splitMessage(text: string, limit = MAX_MESSAGE): string[] {
  // Below 2 a surrogate pair cannot fit, and the cut could never move forward.
  if (!Number.isInteger(limit) || limit < 2) throw new RangeError('splitMessage: limit must be an integer of at least 2');
  const parts: string[] = [];
  let current: string | undefined;
  for (const line of text.split('\n')) {
    const candidate = current === undefined ? line : `${current}\n${line}`;
    if (candidate.length <= limit) {
      current = candidate;
      continue;
    }
    if (current !== undefined) parts.push(current);
    const pieces = line.length > limit ? cutLine(line, limit) : [line];
    parts.push(...pieces.slice(0, -1));
    current = pieces.at(-1)!;
  }
  parts.push(current ?? '');
  return parts;
}

/** Room kept in each part for the "\n(i/n)" marker of a note sent in several parts. */
const MARKER_ROOM = 16;

/** The parts to send: one as is, or several each ending in "(i/n)", every one within Telegram's limit. */
export function messageParts(text: string): string[] {
  if (text.length <= MAX_MESSAGE) return [text];
  const parts = splitMessage(text, MAX_MESSAGE - MARKER_ROOM);
  return parts.map((part, i) => `${part}\n(${i + 1}/${parts.length})`);
}

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The note job's healthchecks.io ping UUID, the secret part of its ping URL.
 * Checked for shape at startup, so a slug or a typo fails before anything is sent.
 */
export function readPingUuid(env: Record<string, string | undefined>): Secret {
  const secret = readSecret(env, 'HEALTHCHECKS_PING_UUID');
  if (!UUID_SHAPE.test(secret.value)) {
    throw new SecretError(
      'E_CONFIG_INVALID',
      'pulseops E_CONFIG_INVALID: HEALTHCHECKS_PING_UUID must be a UUID; fix: copy the UUID from the note check\'s ping URL in healthchecks.io',
    );
  }
  return secret;
}

const MAX_TRIES = 3;
const BACKOFF_MS = [1000, 2000];
const MAX_RETRY_AFTER_S = 30;

/**
 * The whole send must end within this: 90 s, plus the healthchecks.io read and
 * the ping (one request timeout each), fits a `timeout 120` watchdog and the
 * note check's grace period of 3 minutes or more.
 */
export const SEND_BUDGET_MS = 90_000;

/** Why Telegram refused a request, from its status alone (its body is never read). */
export type Refusal = 'token' | 'chat' | 'request' | 'redirect';

/** What happened to a note. sendNote returns one of these and never throws a vendor error. */
export type DeliveryResult =
  | { kind: 'delivered'; total: number }
  | { kind: 'refused'; reason: Refusal; cause: VendorHttpError }
  | { kind: 'unavailable'; cause: VendorHttpError }
  | { kind: 'partial'; sent: number; total: number; cause: VendorHttpError }
  | { kind: 'over-budget'; sent: number; total: number };

/** Temporary: worth another try. 408, 429, 5xx, or no answer at all. */
function isTemporary(error: VendorHttpError): boolean {
  const status = error.status;
  return error.code !== 'E_VENDOR_HTTP' || status === undefined || status === 408 || status === 429 || status >= 500;
}

/** The one place a status becomes a reason. Anything temporary is not a refusal. */
function refusal(error: VendorHttpError): Refusal | undefined {
  if (isTemporary(error)) return undefined;
  const status = error.status!;
  if (status >= 300 && status < 400) return 'redirect';
  if (status === 401 || status === 404) return 'token';
  if (status === 403) return 'chat';
  return 'request';
}

class OverBudget extends Error {}

/**
 * Delivery retries from the design ("Run once per day", step 2): up to 3 tries
 * on a temporary error, waiting 1 s then 2 s, or a 429's retry_after capped at
 * 30 seconds. A refusal is not retried. With a deadline, a try starts only if a
 * full request timeout is left, and a wait only if it ends before that point.
 */
export async function withRetries(
  attempt: () => Promise<void>,
  sleep: (ms: number) => Promise<void>,
  deadline: { now: () => number; at: number } = { now: () => 0, at: Infinity },
): Promise<void> {
  for (let tryNumber = 1; ; tryNumber += 1) {
    if (deadline.now() + VENDOR_TIMEOUT_MS > deadline.at) throw new OverBudget();
    try {
      await attempt();
      return;
    } catch (error) {
      if (!(error instanceof VendorHttpError) || tryNumber >= MAX_TRIES || !isTemporary(error)) throw error;
      const wait = error.status === 429 && error.retryAfter !== undefined ? Math.min(error.retryAfter, MAX_RETRY_AFTER_S) * 1000 : BACKOFF_MS[tryNumber - 1]!;
      if (deadline.now() + wait + VENDOR_TIMEOUT_MS > deadline.at) throw new OverBudget();
      await sleep(wait);
    }
  }
}

export type NoteDelivery = {
  botId: string;
  secret: string;
  chatId: string;
  text: string;
  redact: (text: string) => string;
  baseUrl: string;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  budgetMs: number;
};

/**
 * Sends the note as plain text (no parse_mode), so nothing in it can become
 * markup. A long note goes in several parts marked (i/n); each is retried on
 * its own, and the whole send stops at the budget. It reports how far it got.
 */
export async function sendNote(delivery: NoteDelivery): Promise<DeliveryResult> {
  const url = `${delivery.baseUrl}/bot${delivery.botId}:${delivery.secret}/sendMessage`;
  const parts = messageParts(delivery.text);
  const deadline = { now: delivery.now, at: delivery.now() + delivery.budgetMs };
  let sent = 0;
  for (const part of parts) {
    try {
      await withRetries(async () => {
        const reply = await postJson(url, { chat_id: delivery.chatId, text: part, disable_web_page_preview: true }, delivery.redact);
        if (typeof reply !== 'object' || reply === null || (reply as { ok?: unknown }).ok !== true) {
          const shown = delivery.redact(url);
          throw new VendorHttpError('E_VENDOR_BAD_JSON', `pulseops E_VENDOR_BAD_JSON: POST ${shown} did not confirm the message`, { url: shown });
        }
      }, delivery.sleep, deadline);
    } catch (error) {
      if (error instanceof OverBudget) return { kind: 'over-budget', sent, total: parts.length };
      if (!(error instanceof VendorHttpError)) throw error;
      // Once a part went out, the token and the chat are proven to work.
      if (sent > 0) return { kind: 'partial', sent, total: parts.length, cause: error };
      const reason = refusal(error);
      return reason === undefined ? { kind: 'unavailable', cause: error } : { kind: 'refused', reason, cause: error };
    }
    sent += 1;
  }
  return { kind: 'delivered', total: parts.length };
}

export type Report = { exit: 0 | typeof EXIT_USAGE | typeof EXIT_DEPENDENCY; level: 'info' | 'error'; message: string; fields: Record<string, Field> };

const REFUSAL_HINTS: Record<Refusal, string> = {
  token: 'Telegram refused the bot token; fix: check TELEGRAM_BOT_TOKEN against @BotFather',
  chat: 'Telegram refused the chat (the bot is blocked or not in it); fix: check TELEGRAM_CHAT_ID and send the bot a message from that chat',
  request: 'Telegram refused the message; fix: check TELEGRAM_CHAT_ID, then run note --dry-run to see the text',
  redirect: 'Telegram answered with a redirect; fix: check TELEGRAM_API_URL, or unset it to use api.telegram.org',
};

/**
 * The one table from a delivery result to an exit code and a log line. Every
 * message is fixed text; the fields hold only counts and formatError output.
 * Exit 2 means a setting to fix; exit 4 means try again later (no setting is wrong).
 */
export function deliveryReport(result: DeliveryResult, context: { apiUrlOverride: boolean }): Report {
  const override = context.apiUrlOverride ? ' (TELEGRAM_API_URL is set: check it too)' : '';
  switch (result.kind) {
    case 'delivered':
      return { exit: 0, level: 'info', message: 'note delivered', fields: { source: 'telegram', parts_total: result.total } };
    case 'refused':
      return {
        exit: EXIT_USAGE,
        level: 'error',
        message: `the note was not delivered: ${REFUSAL_HINTS[result.reason]}${result.reason === 'redirect' ? '' : override}`,
        fields: { source: 'telegram', ...formatError(result.cause) },
      };
    case 'unavailable':
      return { exit: EXIT_DEPENDENCY, level: 'error', message: 'the note was not delivered: Telegram was unreachable or failing after 3 tries', fields: { source: 'telegram', ...formatError(result.cause) } };
    case 'partial':
      return {
        exit: EXIT_DEPENDENCY,
        level: 'error',
        message: `the note was partly delivered: ${result.sent} of ${result.total} parts went out before Telegram failed`,
        fields: { source: 'telegram', parts_sent: result.sent, parts_total: result.total, ...formatError(result.cause) },
      };
    case 'over-budget':
      return {
        exit: EXIT_DEPENDENCY,
        level: 'error',
        message: `the note was not fully delivered: the send ran out of time with ${result.sent} of ${result.total} parts sent`,
        fields: { source: 'telegram', parts_sent: result.sent, parts_total: result.total },
      };
  }
}

/**
 * A failed ping after delivery never fails the run (the note arrived, and a
 * scheduler retry would send it twice). A refusal means HEALTHCHECKS_PING_UUID
 * or the ping URL is wrong, so it is an error with a fix; an outage is a warning.
 */
export function pingReport(error: VendorHttpError, context: { pingUrlOverride: boolean }): { level: 'error' | 'warn'; message: string; fields: Record<string, Field> } {
  const fields = { source: 'healthchecks.io ping', ...formatError(error) };
  if (isTemporary(error)) return { level: 'warn', message: 'the note was delivered but the healthchecks.io ping failed', fields };
  const override = context.pingUrlOverride ? ' (HEALTHCHECKS_PING_URL_BASE is set: check it too)' : '';
  return {
    level: 'error',
    message: `the note was delivered but healthchecks.io refused the ping; fix: check HEALTHCHECKS_PING_UUID against the note check's ping URL${override}`,
    fields,
  };
}
