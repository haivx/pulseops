import type { Logger } from '../log.ts';
import { formatError } from '../format-error.ts';
import { getJson, vendorBaseUrl, VendorHttpError } from '../vendor-http.ts';

export const HEALTHCHECKS_DEFAULT_URL = 'https://healthchecks.io';

/** The statuses healthchecks.io documents. Anything else is never printed. */
const KNOWN_STATUSES = new Set(['new', 'up', 'grace', 'down', 'paused', 'started']);
/** The API base URL, from HEALTHCHECKS_API_URL for a self-hosted instance or a test server. */
export function healthchecksBaseUrl(override: string | undefined): string {
  return vendorBaseUrl('HEALTHCHECKS_API_URL', override, HEALTHCHECKS_DEFAULT_URL);
}

/**
 * Lists the project's checks with a read-only key and returns each slug's
 * status, the only fields the note uses. Checks without a slug cannot be
 * matched to fleet.yaml and are skipped. A slug that appears twice is
 * `ambiguous`, so one check can never hide another. A status outside the
 * documented set is `unexpected`, so vendor text never reaches the note. A
 * body of the wrong shape fails instead of reading as "no checks".
 */
export async function readChecks(key: string, redact: (text: string) => string, baseUrl = HEALTHCHECKS_DEFAULT_URL): Promise<Map<string, string>> {
  const url = `${baseUrl.replace(/\/+$/, '')}/api/v3/checks/`;
  const body = await getJson(url, { 'X-Api-Key': key }, redact);
  const checks = typeof body === 'object' && body !== null ? (body as { checks?: unknown }).checks : undefined;
  if (!Array.isArray(checks)) {
    const shown = redact(url);
    throw new VendorHttpError('E_VENDOR_BAD_JSON', `pulseops E_VENDOR_BAD_JSON: GET ${shown} returned JSON without a checks list`, { url: shown });
  }
  const statuses = new Map<string, string>();
  for (const check of checks) {
    if (typeof check !== 'object' || check === null) continue;
    const { slug, status } = check as { slug?: unknown; status?: unknown };
    if (typeof slug !== 'string' || slug === '') continue;
    const known = typeof status === 'string' && KNOWN_STATUSES.has(status) ? status : 'unexpected';
    statuses.set(slug, statuses.has(slug) ? 'ambiguous' : known);
  }
  return statuses;
}

/**
 * Runs a checks read for the note. A vendor failure is logged and becomes
 * `unavailable`, one problem in a note that still prints. Any other error is a
 * bug and is rethrown, so the run exits 1 instead of reading as an outage.
 */
export async function checksOrUnavailable(read: () => Promise<Map<string, string>>, log: Logger): Promise<Map<string, string> | 'unavailable'> {
  try {
    return await read();
  } catch (error) {
    if (!(error instanceof VendorHttpError)) throw error;
    log.error('healthchecks.io read failed', { source: 'healthchecks.io', ...formatError(error) });
    return 'unavailable';
  }
}
