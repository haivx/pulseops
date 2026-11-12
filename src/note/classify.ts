import type { Fleet } from '../fleet.ts';

// Problem rules from docs/designs/pulseops-daily-note.md ("Sources" and
// "Headline"), for the healthchecks.io part of Health. Statuses use an
// allow-list: only up and grace count as reporting.

const REPORTING = new Set(['up', 'grace']);

export type Workers = { reporting: number; total: number; failed: string[] };
export type Classified = {
  problems: string[];
  workers: Workers | 'unavailable';
  unknown: { check: string; reason: string }[];
};

function unknownProblem(check: string, reason: string): string {
  if (reason === 'new') return `${check}: unknown (new). Ping it once, or fix its slug in fleet.yaml`;
  if (reason === 'missing') return `${check}: unknown (missing). Check its slug in fleet.yaml or create the check`;
  if (reason === 'paused') return `${check}: unknown (paused). Resume the check in healthchecks.io`;
  if (reason === 'ambiguous') return `${check}: unknown (ambiguous). Give each check its own slug in healthchecks.io`;
  return `${check}: unknown (${reason}). Check it in healthchecks.io`;
}

export function classify(fleet: Fleet, checks: Map<string, string> | 'unavailable'): Classified {
  if (checks === 'unavailable') {
    return { problems: ['unknown: healthchecks.io unavailable'], workers: 'unavailable', unknown: [] };
  }
  const problems: string[] = [];
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
  return { problems, workers, unknown };
}
