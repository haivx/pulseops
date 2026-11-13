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
  constructor(
    code: VendorHttpError['code'],
    message: string,
    options: { status?: number; url?: string; redirect?: Redirect; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'VendorHttpError';
    this.code = code;
    this.status = options.status;
    this.url = options.url;
    this.redirect = options.redirect;
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

/**
 * GET a vendor JSON endpoint. Errors keep the redacted URL and the status,
 * which explain the failure, and never the vendor's body. The cause of an
 * unreachable vendor is kept for code that inspects it, but `formatError`
 * never writes it.
 */
export async function getJson(url: string, headers: Record<string, string>, redact: (text: string) => string): Promise<unknown> {
  // Messages carry the URL redacted, so a message saved or sent on later
  // holds no key even if it skips the logger.
  const shown = redact(url);
  let response: Response;
  try {
    // Never follow redirects: on a cross-origin redirect fetch drops only
    // Authorization, and custom key headers such as X-Api-Key would go to the
    // new host. A 3xx is not ok, so it fails below as E_VENDOR_HTTP.
    response = await fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (cause) {
    throw new VendorHttpError('E_VENDOR_UNREACHABLE', `pulseops E_VENDOR_UNREACHABLE: GET ${shown} failed before a response`, { url: shown, cause });
  }
  if (!response.ok) {
    // The body is vendor text: it is read only to free the connection, never kept.
    await response.text().catch(() => '');
    throw new VendorHttpError('E_VENDOR_HTTP', `pulseops E_VENDOR_HTTP: GET ${shown} returned ${response.status}`, {
      status: response.status,
      url: shown,
      redirect: redirectKind(response, url),
    });
  }
  let body: string;
  try {
    body = await response.text();
  } catch (cause) {
    throw new VendorHttpError('E_VENDOR_UNREACHABLE', `pulseops E_VENDOR_UNREACHABLE: GET ${shown} failed while reading the body`, {
      status: response.status,
      url: shown,
      cause,
    });
  }
  try {
    return JSON.parse(body);
  } catch {
    // JSON.parse quotes part of the body in its message, so the cause is dropped.
    throw new VendorHttpError('E_VENDOR_BAD_JSON', `pulseops E_VENDOR_BAD_JSON: GET ${shown} returned ${response.status} with a body that is not JSON`, {
      status: response.status,
      url: shown,
    });
  }
}
