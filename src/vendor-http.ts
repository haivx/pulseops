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
 * GET a vendor JSON endpoint. Errors keep the URL and the start of the body,
 * because they explain the failure. The body is redacted before it is cut:
 * cutting first could leave part of a key that redaction no longer recognizes.
 * The URL may still hold the key, so errors must only be printed through the
 * redacting logger.
 */
export async function getJson(url: string, headers: Record<string, string>, redact: (text: string) => string): Promise<unknown> {
  let response: Response;
  try {
    // Never follow redirects: on a cross-origin redirect fetch drops only
    // Authorization, and custom key headers such as X-Api-Key would go to the
    // new host. A 3xx is not ok, so it fails below as E_VENDOR_HTTP.
    response = await fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (cause) {
    throw new VendorHttpError('E_VENDOR_UNREACHABLE', `pulseops E_VENDOR_UNREACHABLE: GET ${url} failed before a response`, { cause });
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new VendorHttpError('E_VENDOR_HTTP', `pulseops E_VENDOR_HTTP: GET ${url} returned ${response.status}`, {
      status: response.status,
      detail: redact(body).slice(0, DETAIL_LIMIT),
    });
  }
  let body: string;
  try {
    body = await response.text();
  } catch (cause) {
    throw new VendorHttpError('E_VENDOR_UNREACHABLE', `pulseops E_VENDOR_UNREACHABLE: GET ${url} failed while reading the body`, {
      status: response.status,
      cause,
    });
  }
  try {
    return JSON.parse(body);
  } catch {
    // JSON.parse quotes part of the body in its message, so the cause is dropped.
    throw new VendorHttpError('E_VENDOR_BAD_JSON', `pulseops E_VENDOR_BAD_JSON: GET ${url} returned ${response.status} with a body that is not JSON`, {
      status: response.status,
    });
  }
}
