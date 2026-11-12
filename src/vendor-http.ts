export class VendorHttpError extends Error {
  readonly code: 'E_VENDOR_HTTP' | 'E_VENDOR_UNREACHABLE';
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
 * because they explain the failure; they may hold the key, so they must only
 * ever be printed through the redacting logger.
 */
export async function getJson(url: string, headers: Record<string, string>): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (cause) {
    throw new VendorHttpError('E_VENDOR_UNREACHABLE', `pulseops E_VENDOR_UNREACHABLE: GET ${url} failed before a response`, { cause });
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new VendorHttpError('E_VENDOR_HTTP', `pulseops E_VENDOR_HTTP: GET ${url} returned ${response.status}`, {
      status: response.status,
      detail: body.slice(0, DETAIL_LIMIT),
    });
  }
  return response.json();
}
