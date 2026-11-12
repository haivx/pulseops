import { getJson, VendorHttpError } from '../vendor-http.ts';

export const HEALTHCHECKS_DEFAULT_URL = 'https://healthchecks.io';

/**
 * Lists the project's checks with a read-only key and returns each slug's
 * status, the only fields the note uses. Checks without a slug cannot be
 * matched to fleet.yaml and are skipped. A body of the wrong shape fails
 * instead of reading as "no checks", which would hide every worker.
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
    if (typeof slug === 'string' && slug !== '' && typeof status === 'string') statuses.set(slug, status);
  }
  return statuses;
}
