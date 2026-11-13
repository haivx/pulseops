// Sends the note to the owner's Telegram chat (open question 1, decided
// 2026-11-12). See docs/rules/secrets.md for how the bot token is a secret.
import { ConfigError } from './config-error.ts';
import { checkSecretValue, SecretError, type Secret } from './secrets.ts';
import { postJson, VendorHttpError } from './vendor-http.ts';

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

/** Splits text into parts Telegram accepts, at line breaks where it can. */
export function splitMessage(text: string): string[] {
  const parts: string[] = [];
  let current = '';
  for (const line of text.split('\n')) {
    const candidate = current === '' ? line : `${current}\n${line}`;
    if (candidate.length <= MAX_MESSAGE) {
      current = candidate;
      continue;
    }
    if (current !== '') parts.push(current);
    // A single line longer than the limit is cut into pieces.
    let rest = line;
    while (rest.length > MAX_MESSAGE) {
      parts.push(rest.slice(0, MAX_MESSAGE));
      rest = rest.slice(MAX_MESSAGE);
    }
    current = rest;
  }
  if (current !== '' || parts.length === 0) parts.push(current);
  return parts;
}

const MAX_TRIES = 3;
const BACKOFF_MS = [1000, 2000];
const MAX_RETRY_AFTER_S = 30;

/**
 * Delivery retries from the design ("Run once per day", step 2): up to 3 tries,
 * on an unreachable vendor, a 5xx or a 429 (waiting its retry_after, capped at
 * 30 seconds). Any other 4xx, such as a bad token or chat id, is not retried.
 */
export async function withRetries(attempt: () => Promise<void>, sleep: (ms: number) => Promise<void>): Promise<void> {
  for (let tryNumber = 1; ; tryNumber += 1) {
    try {
      await attempt();
      return;
    } catch (error) {
      if (!(error instanceof VendorHttpError) || tryNumber >= MAX_TRIES) throw error;
      const status = error.status;
      const retryable = error.code === 'E_VENDOR_UNREACHABLE' || status === 429 || (status !== undefined && status >= 500);
      if (!retryable) throw error;
      const wait = status === 429 && error.retryAfter !== undefined ? Math.min(error.retryAfter, MAX_RETRY_AFTER_S) * 1000 : BACKOFF_MS[tryNumber - 1]!;
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
};

/**
 * Sends the note as plain text (no parse_mode), so nothing in it can become
 * markup. Each part is retried on its own.
 */
export async function sendNote(delivery: NoteDelivery): Promise<void> {
  const url = `${delivery.baseUrl}/bot${delivery.botId}:${delivery.secret}/sendMessage`;
  for (const part of splitMessage(delivery.text)) {
    await withRetries(async () => {
      const reply = await postJson(url, { chat_id: delivery.chatId, text: part, disable_web_page_preview: true }, delivery.redact);
      if (typeof reply !== 'object' || reply === null || (reply as { ok?: unknown }).ok !== true) {
        const shown = delivery.redact(url);
        throw new VendorHttpError('E_VENDOR_BAD_JSON', `pulseops E_VENDOR_BAD_JSON: POST ${shown} did not confirm the message`, { url: shown });
      }
    }, delivery.sleep);
  }
}
