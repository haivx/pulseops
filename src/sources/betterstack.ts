import type { Fleet } from '../fleet.ts';
import type { Logger } from '../log.ts';
import { formatError } from '../format-error.ts';
import { getJson, vendorBaseUrl, VendorHttpError } from '../vendor-http.ts';

// Better Stack Uptime (docs/designs/pulseops-daily-note.md, "Sources"; API facts
// in docs/vendor-spike.md). PulseOps only ever sends GET requests: whether the
// team token is read-only is unknown, so the code never offers it a write.

export const BETTERSTACK_DEFAULT_URL = 'https://incidents.betterstack.com';

/** The monitor statuses Better Stack documents. Anything else is never printed. */
const KNOWN_STATUSES = new Set(['up', 'down', 'validating', 'paused', 'pending', 'maintenance']);
/** One page of incidents. A monitor with more in three days reads `too-many`, never a partial count. */
const PER_PAGE = 50;
const DAY_MS = 86_400_000;

export type Incident = { startedAt: number; resolvedAt: number | undefined };
/** `status` is a documented status, `unexpected`, `missing` (no such monitor) or `too-many` (more than one page of incidents). */
export type MonitorReading = { status: string; incidents: Incident[] };

/** The API base URL, from BETTERSTACK_API_URL for a test server. */
export function betterstackBaseUrl(override: string | undefined): string {
  return vendorBaseUrl('BETTERSTACK_API_URL', override, BETTERSTACK_DEFAULT_URL);
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const utcDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function badShape(url: string, redact: (text: string) => string, what: string): VendorHttpError {
  const shown = redact(url);
  return new VendorHttpError('E_VENDOR_BAD_JSON', `pulseops E_VENDOR_BAD_JSON: GET ${shown} returned JSON without ${what}`, { url: shown });
}

function parseTime(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * Reads one monitor's status and its incidents around the last 24 hours. The
 * API filters incidents by date only, so the window asked for is now - 48 h to
 * now + 24 h in UTC dates, wide enough for any time zone the filter uses; the
 * note keeps those that started in the last 24 hours. Only URLs built here are
 * requested: the vendor's `pagination.next` is never followed, so the token
 * never goes to an address PulseOps did not choose.
 */
export async function readMonitor(token: string, id: string, redact: (text: string) => string, baseUrl: string, now: Date): Promise<MonitorReading> {
  if (!/^\d{1,20}$/.test(id)) throw new Error('readMonitor: the monitor ID must be digits');
  const base = baseUrl.replace(/\/+$/, '');
  const headers = { Authorization: `Bearer ${token}` };
  const monitorUrl = `${base}/api/v2/monitors/${id}`;
  const query = new URLSearchParams({
    monitor_id: id,
    from: utcDate(now.getTime() - 2 * DAY_MS),
    to: utcDate(now.getTime() + DAY_MS),
    per_page: String(PER_PAGE),
    page: '1',
  });
  const incidentsUrl = `${base}/api/v3/incidents?${query}`;
  const [monitor, incidents] = await Promise.allSettled([getJson(monitorUrl, headers, redact), getJson(incidentsUrl, headers, redact)]);

  if (monitor.status === 'rejected') {
    const error: unknown = monitor.reason;
    if (error instanceof VendorHttpError && error.status === 404) return { status: 'missing', incidents: [] };
    throw error;
  }
  if (incidents.status === 'rejected') throw incidents.reason;

  const data = isRecord(monitor.value) ? monitor.value.data : undefined;
  const attributes = isRecord(data) ? data.attributes : undefined;
  if (!isRecord(attributes)) throw badShape(monitorUrl, redact, 'a monitor');
  const status = typeof attributes.status === 'string' && KNOWN_STATUSES.has(attributes.status) ? attributes.status : 'unexpected';

  const page = isRecord(incidents.value) ? incidents.value : undefined;
  if (page === undefined || !Array.isArray(page.data)) throw badShape(incidentsUrl, redact, 'an incidents list');
  const pagination = isRecord(page.pagination) ? page.pagination : undefined;
  if (pagination !== undefined && pagination.next !== null && pagination.next !== undefined) return { status: 'too-many', incidents: [] };

  const kept: Incident[] = [];
  for (const item of page.data) {
    if (!isRecord(item) || !isRecord(item.attributes)) continue;
    // Keep only this monitor's incidents, so an ignored filter cannot give one app another's history.
    const rel = isRecord(item.relationships) && isRecord(item.relationships.monitor) ? item.relationships.monitor.data : undefined;
    if (!isRecord(rel) || String(rel.id) !== id) continue;
    // An unconfirmed incident has no start yet and is not counted.
    const startedAt = parseTime(item.attributes.started_at);
    if (startedAt === undefined) continue;
    kept.push({ startedAt, resolvedAt: parseTime(item.attributes.resolved_at) });
  }
  return { status, incidents: kept };
}

/**
 * Reads every app's monitor in parallel, so the source takes about one request
 * timeout. A vendor failure (rejected token, outage, redirect) is logged once and
 * makes the whole source `unavailable`, one problem in a note that still prints.
 * Any other error is a bug and is rethrown, so the run exits 1.
 */
export async function monitorsOrUnavailable(
  fleet: Fleet,
  token: string,
  redact: (text: string) => string,
  baseUrl: string,
  now: Date,
  log: Logger,
): Promise<Map<string, MonitorReading> | 'unavailable'> {
  const apps = fleet.apps.filter((app): app is typeof app & { monitor: string } => app.monitor !== undefined);
  const results = await Promise.allSettled(apps.map((app) => readMonitor(token, app.monitor, redact, baseUrl, now)));
  const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failed !== undefined) {
    if (!(failed.reason instanceof VendorHttpError)) throw failed.reason;
    log.error('Better Stack read failed', { source: 'Better Stack', ...formatError(failed.reason) });
    return 'unavailable';
  }
  const readings = new Map<string, MonitorReading>();
  apps.forEach((app, i) => readings.set(app.name, (results[i] as PromiseFulfilledResult<MonitorReading>).value));
  return readings;
}
