import { ConfigError } from '../config-error.ts';
import { getJson, VendorHttpError } from '../vendor-http.ts';

export const HEALTHCHECKS_DEFAULT_URL = 'https://healthchecks.io';

/** The statuses healthchecks.io documents. Anything else is never printed. */
const KNOWN_STATUSES = new Set(['new', 'up', 'grace', 'down', 'paused', 'started']);
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * The API base URL, from HEALTHCHECKS_API_URL for a self-hosted instance or a
 * test server. The key is sent there, so only https is accepted, or http to
 * this machine. Credentials in the URL are refused, because they would print.
 */
export function healthchecksBaseUrl(override: string | undefined): string {
  if (override === undefined || override === '') return HEALTHCHECKS_DEFAULT_URL;
  const refuse = () =>
    new ConfigError(
      'pulseops E_CONFIG_INVALID: HEALTHCHECKS_API_URL must be an https URL, or http to localhost, with no user or password; fix: correct it or unset it to use https://healthchecks.io',
    );
  let url: URL;
  try {
    url = new URL(override);
  } catch {
    throw refuse();
  }
  const secure = url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname));
  if (!secure || url.username !== '' || url.password !== '') throw refuse();
  return override.replace(/\/+$/, '');
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
    throw new VendorHttpError('E_VENDOR_BAD_JSON', `pulseops E_VENDOR_BAD_JSON: GET ${url} returned JSON without a checks list`);
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
