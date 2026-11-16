import type { Fleet } from '../fleet.ts';
import type { MonitorReading } from '../sources/betterstack.ts';

// Problem rules from docs/designs/pulseops-daily-note.md ("Sources" and
// "Headline"), for the Better Stack and healthchecks.io parts of Health.
// Statuses use an allow-list: a check reports only when up or grace, and a
// monitor is up only on its explicit up status.

const REPORTING = new Set(['up', 'grace']);
const WINDOW_MS = 86_400_000;

export type Workers = { reporting: number; total: number; failed: string[] };
/** Incidents that started in the last 24 hours: how many, their total minutes, and whether one is still open. */
export type Incidents = { count: number; minutes: number; ongoing: boolean };
export type AppHealth = { name: string; status: string; incidents: Incidents };
export type Classified = {
  problems: string[];
  /** Better Stack per app, or the whole source `unavailable`, or `disabled` in fleet.yaml. */
  apps: AppHealth[] | 'unavailable' | 'disabled';
  workers: Workers | 'unavailable';
  unknown: { check: string; reason: string }[];
};

function appProblem(app: string, status: string): string | undefined {
  if (status === 'up') return undefined;
  if (status === 'down') return `${app}: down. Check the app`;
  if (status === 'missing') return `${app}: unknown (missing). Check its monitor ID in fleet.yaml`;
  if (status === 'too-many') return `${app}: unknown (more than 50 incidents). Check it in Better Stack`;
  if (status === 'paused') return `${app}: unknown (paused). Resume the monitor in Better Stack`;
  return `${app}: unknown (${status}). Check it in Better Stack`;
}

/**
 * Every incident that overlaps the last 24 hours: still open, or resolved after
 * the window began. Its minutes are clipped to the window, so an outage that
 * began yesterday and ended this morning shows, never "0 incidents".
 */
function recentIncidents(reading: MonitorReading, now: Date): Incidents {
  const end = now.getTime();
  const start = end - WINDOW_MS;
  const result: Incidents = { count: 0, minutes: 0, ongoing: false };
  for (const { startedAt, resolvedAt } of reading.incidents) {
    const until = Math.min(resolvedAt ?? end, end);
    if (startedAt > end || until < start) continue;
    result.count += 1;
    if (resolvedAt === undefined) result.ongoing = true;
    result.minutes += Math.round((until - Math.max(startedAt, start)) / 60_000);
  }
  return result;
}

function classifyApps(fleet: Fleet, monitors: Map<string, MonitorReading> | 'unavailable' | 'disabled', now: Date, problems: string[]): Classified['apps'] {
  if (monitors === 'disabled' || monitors === 'unavailable') {
    if (monitors === 'unavailable') problems.push('unknown: Better Stack unavailable');
    return monitors;
  }
  return fleet.apps.map((app) => {
    // An app the source returned nothing for is unknown, never up.
    const reading = monitors.get(app.name) ?? { status: 'missing', incidents: [] };
    const problem = appProblem(app.name, reading.status);
    if (problem !== undefined) problems.push(problem);
    return { name: app.name, status: reading.status, incidents: recentIncidents(reading, now) };
  });
}

function unknownProblem(check: string, reason: string): string {
  if (reason === 'new') return `${check}: unknown (new). Ping it once, or fix its slug in fleet.yaml`;
  if (reason === 'missing') return `${check}: unknown (missing). Check its slug in fleet.yaml or create the check`;
  if (reason === 'paused') return `${check}: unknown (paused). Resume the check in healthchecks.io`;
  if (reason === 'ambiguous') return `${check}: unknown (ambiguous). Give each check its own slug in healthchecks.io`;
  return `${check}: unknown (${reason}). Check it in healthchecks.io`;
}

export function classify(
  fleet: Fleet,
  checks: Map<string, string> | 'unavailable',
  monitors: Map<string, MonitorReading> | 'unavailable' | 'disabled',
  now: Date,
): Classified {
  const problems: string[] = [];
  const apps = classifyApps(fleet, monitors, now, problems);
  if (checks === 'unavailable') {
    problems.push('unknown: healthchecks.io unavailable');
    return { problems, apps, workers: 'unavailable', unknown: [] };
  }
  const unknown: Classified['unknown'] = [];
  const workers: Workers = { reporting: 0, total: 0, failed: [] };
  for (const app of fleet.apps) {
    for (const check of app.checks) {
      const label = `${app.name}/${check.name}`;
      const status = checks.get(check.slug);
      workers.total += 1;
      if (status !== undefined && REPORTING.has(status)) {
        workers.reporting += 1;
      } else if (status === 'down') {
        workers.failed.push(label);
        problems.push(`${label}: down. Check the worker`);
      } else {
        const reason = status ?? 'missing';
        unknown.push({ check: label, reason });
        problems.push(unknownProblem(label, reason));
      }
    }
  }
  // An empty registry must never read as healthy.
  if (workers.total === 0) problems.push("workers: no checks in fleet.yaml. Add the app's checks");
  return { problems, apps, workers, unknown };
}
