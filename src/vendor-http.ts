import { ConfigError } from './config-error.ts';
import { readField, registerFields, safeClassName } from './error-fields.ts';

export type Redirect = 'same-origin' | 'cross-origin' | 'invalid';

/**
 * Codes a network failure may carry, kept only when they match this list
 * exactly, so the log can tell a timeout from a refused connection or DNS
 * without writing any text a library produced.
 */
const CAUSE_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET',
  'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID',
  'TimeoutError', 'AbortError',
]);

/** The first allowlisted code in a cause chain (3 levels), each property read once. */
function causeCode(cause: unknown): string | undefined {
  for (let depth = 0; depth < 3; depth += 1) {
    if (readField(() => cause instanceof Error) !== true) return undefined;
    const code = readField(() => (cause as { code?: unknown }).code);
    if (typeof code === 'string' && CAUSE_CODES.has(code)) return code;
    const name = readField(() => (cause as Error).name);
    if (typeof name === 'string' && CAUSE_CODES.has(name)) return name;
    cause = readField(() => (cause as Error).cause);
  }
  return undefined;
}

export class VendorHttpError extends Error {
  readonly code: 'E_VENDOR_HTTP' | 'E_VENDOR_UNREACHABLE' | 'E_VENDOR_BAD_JSON';
  readonly status: number | undefined;
  /** The request URL, already redacted. */
  readonly url: string | undefined;
  /** For a 3xx: where the Location points, as a fixed value. */
  readonly redirect: Redirect | undefined;
  /** For a 429: the seconds the vendor asked to wait, if it gave a number. */
  readonly retryAfter: number | undefined;
  constructor(
    code: VendorHttpError['code'],
    message: string,
    options: { status?: number; url?: string; redirect?: Redirect; retryAfter?: number; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'VendorHttpError';
    this.code = code;
    this.status = options.status;
    this.url = options.url;
    this.redirect = options.redirect;
    this.retryAfter = options.retryAfter;
    // The cause comes from a library: only its class and an allowlisted code are kept, read now.
    const hasCause = readField(() => options.cause instanceof Error) === true;
    registerFields(this, {
      error_class: new.target.name,
      error_code: code,
      error_message: message,
      error_status: options.status,
      error_url: options.url,
      error_redirect: options.redirect,
      error_cause_class: hasCause ? safeClassName(options.cause, 'unformattable') : undefined,
      error_cause_code: hasCause ? causeCode(options.cause) : undefined,
    });
  }
}

const TIMEOUT_MS = 10_000;

/**
 * For a 3xx, only whether the Location points to the same origin, another
 * one, or does not parse: a fixed value, never Location text, which the vendor controls and
 * could encode a key into (case, percent-encoding, fullwidth characters).
 */
function redirectKind(response: Response, url: string): Redirect | undefined {
  if (response.status < 300 || response.status > 399) return undefined;
  const location = response.headers.get('location');
  if (location === null) return undefined;
  try {
    return new URL(location, url).origin === new URL(url).origin ? 'same-origin' : 'cross-origin';
  } catch {
    return 'invalid';
  }
}

/** Seconds to wait from a 429: the Retry-After header, else Telegram's `parameters.retry_after`; a number only. */
function retryAfterSeconds(response: Response, body: string): number | undefined {
  const header = Number(response.headers.get('retry-after'));
  if (Number.isFinite(header) && header >= 0) return header;
  try {
    const value = (JSON.parse(body) as { parameters?: { retry_after?: unknown } }).parameters?.retry_after;
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * One request to a vendor, shared by every call. It never follows a
 * redirect: on a cross-origin redirect fetch drops only Authorization, and a
 * key in a custom header or in the URL would go to the new host. Errors keep
 * the redacted URL and the status, never the vendor's body. The cause of an
 * unreachable vendor is kept for code that inspects it, but `formatError`
 * writes only its class and an allowlisted code. On success it returns the
 * body text.
 */
async function send(method: 'GET' | 'POST', url: string, init: { headers?: Record<string, string>; body?: string }, redact: (text: string) => string): Promise<string> {
  // Messages carry the URL redacted, so a message saved or sent on later
  // holds no key even if it skips the logger.
  const shown = redact(url);
  let response: Response;
  try {
    response = await fetch(url, { method, headers: init.headers, body: init.body, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (cause) {
    throw new VendorHttpError('E_VENDOR_UNREACHABLE', `pulseops E_VENDOR_UNREACHABLE: ${method} ${shown} failed before a response`, { url: shown, cause });
  }
  if (!response.ok) {
    // The body is vendor text: read only to free the connection and, for a
    // 429, to take one number out of it. It is never kept.
    const body = await response.text().catch(() => '');
    throw new VendorHttpError('E_VENDOR_HTTP', `pulseops E_VENDOR_HTTP: ${method} ${shown} returned ${response.status}`, {
      status: response.status,
      url: shown,
      redirect: redirectKind(response, url),
      retryAfter: response.status === 429 ? retryAfterSeconds(response, body) : undefined,
    });
  }
  try {
    return await response.text();
  } catch (cause) {
    throw new VendorHttpError('E_VENDOR_UNREACHABLE', `pulseops E_VENDOR_UNREACHABLE: ${method} ${shown} failed while reading the body`, {
      status: response.status,
      url: shown,
      cause,
    });
  }
}

function parseJson(text: string, method: string, url: string, redact: (text: string) => string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // JSON.parse quotes part of the body in its message, so the cause is dropped.
    const shown = redact(url);
    throw new VendorHttpError('E_VENDOR_BAD_JSON', `pulseops E_VENDOR_BAD_JSON: ${method} ${shown} returned a body that is not JSON`, { url: shown });
  }
}

/** GET a vendor JSON endpoint. */
export async function getJson(url: string, headers: Record<string, string>, redact: (text: string) => string): Promise<unknown> {
  return parseJson(await send('GET', url, { headers }, redact), 'GET', url, redact);
}

/** POST JSON to a vendor endpoint and parse the JSON reply. */
export async function postJson(url: string, body: unknown, redact: (text: string) => string): Promise<unknown> {
  const text = await send('POST', url, { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, redact);
  return parseJson(text, 'POST', url, redact);
}

/** GET an endpoint whose reply body does not matter, such as a healthchecks.io ping. */
export async function getOk(url: string, redact: (text: string) => string): Promise<void> {
  await send('GET', url, {}, redact);
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * A vendor base URL, from an environment override for a self-hosted instance
 * or a test server. A key goes there, so only https is accepted, or http to
 * this machine, with no user, password, query or fragment.
 */
export function vendorBaseUrl(variable: string, override: string | undefined, fallback: string): string {
  if (override === undefined || override === '') return fallback;
  const refuse = () =>
    new ConfigError(
      `pulseops E_CONFIG_INVALID: ${variable} must be an https URL, or http to localhost, with no user, password, query or fragment; fix: correct it or unset it to use ${fallback}`,
    );
  let url: URL;
  try {
    url = new URL(override);
  } catch {
    throw refuse();
  }
  const secure = url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname));
  // A query, fragment or stray whitespace would send the request to a wrong
  // path, which reads as a daily outage instead of a config error.
  const clean = override.trim() === override && url.search === '' && url.hash === '';
  if (!secure || !clean || url.username !== '' || url.password !== '') throw refuse();
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}
