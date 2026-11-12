export class VendorHttpError extends Error {
  readonly code: 'E_VENDOR_HTTP' | 'E_VENDOR_UNREACHABLE' | 'E_VENDOR_BAD_JSON';
  readonly status: number | undefined;
  readonly detail: string | undefined;
  constructor(code: VendorHttpError['code'], message: string, options: { status?: number; detail?: string; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = 'VendorHttpError';
    this.code = code;
    this.status = options.status;
    this.detail = options.detail;
  }
}

const TIMEOUT_MS = 10_000;
const DETAIL_LIMIT = 500;

/**
 * For a 3xx, where it points: the origin only, since the path or query may
 * hold a token. A vendor that moved its API then says where it went.
 */
function redirectHint(response: Response, url: string, redact: (text: string) => string): string {
  if (response.status < 300 || response.status > 399) return '';
  const location = response.headers.get('location');
  if (location === null) return '';
  try {
    return ` (redirects to ${redact(new URL(location, url).origin)})`;
  } catch {
    return '';
  }
}

/**
 * GET a vendor JSON endpoint. Errors keep the URL and the start of the body,
 * because they explain the failure. The body is redacted before it is cut:
 * cutting first could leave part of a key that redaction no longer recognizes.
 * The URL in each message is redacted too. The cause of an unreachable vendor
 * is kept as is, so errors are still printed only through the redacting logger.
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
    throw new VendorHttpError('E_VENDOR_UNREACHABLE', `pulseops E_VENDOR_UNREACHABLE: GET ${shown} failed before a response`, { cause });
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new VendorHttpError('E_VENDOR_HTTP', `pulseops E_VENDOR_HTTP: GET ${shown} returned ${response.status}${redirectHint(response, url, redact)}`, {
      status: response.status,
      detail: redact(body).slice(0, DETAIL_LIMIT),
    });
  }
  let body: string;
  try {
    body = await response.text();
  } catch (cause) {
    throw new VendorHttpError('E_VENDOR_UNREACHABLE', `pulseops E_VENDOR_UNREACHABLE: GET ${shown} failed while reading the body`, {
      status: response.status,
      cause,
    });
  }
  try {
    return JSON.parse(body);
  } catch {
    // JSON.parse quotes part of the body in its message, so the cause is dropped.
    throw new VendorHttpError('E_VENDOR_BAD_JSON', `pulseops E_VENDOR_BAD_JSON: GET ${shown} returned ${response.status} with a body that is not JSON`, {
      status: response.status,
    });
  }
}
