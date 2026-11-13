export type Redirect = 'same-origin' | 'cross-origin';

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
  }
}

const TIMEOUT_MS = 10_000;

/**
 * For a 3xx, only whether the Location points to the same origin or another
 * one: a fixed value, never Location text, which the vendor controls and
 * could encode a key into (case, percent-encoding, fullwidth characters).
 */
function redirectKind(response: Response, url: string): Redirect | undefined {
  if (response.status < 300 || response.status > 399) return undefined;
  const location = response.headers.get('location');
  if (location === null) return undefined;
  try {
    return new URL(location, url).origin === new URL(url).origin ? 'same-origin' : 'cross-origin';
  } catch {
    return undefined;
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
