import type { AppHealth, Classified } from './classify.ts';

// The note layout from docs/designs/pulseops-daily-note.md ("Daily note"),
// limited to what this slice reads. "all clear" needs no problems and both
// health sources read; with Better Stack disabled the headline stays
// "no problems found" and the footer names it.

/** Sources the note does not read yet. */
const NOT_BUILT = ['GitHub deploys', 'subscriptions'];

function day(now: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, weekday: 'short', day: 'numeric', month: 'short' }).formatToParts(now);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('weekday')} ${part('day')} ${part('month')}`;
}

function incidentsText({ count, minutes, ongoing }: AppHealth['incidents']): string {
  if (count === 0) return '0 incidents';
  return `${count} incident${count === 1 ? '' : 's'} (${ongoing ? 'ongoing' : `${minutes} min`})`;
}

function appLine(app: AppHealth): string {
  if (app.status === 'up' || app.status === 'down') return `  ${app.name}  ${app.status}, ${incidentsText(app.incidents)}`;
  const reason = app.status === 'too-many' ? 'more than 50 incidents' : app.status;
  return `  ${app.name}  unknown (${reason})`;
}

function workersLine(workers: Classified['workers']): string {
  if (workers === 'unavailable') return 'unknown: healthchecks.io unavailable';
  if (workers.total === 0) return 'no checks in fleet.yaml';
  const failed = workers.failed.length > 0 ? ` (failed: ${workers.failed.join(', ')})` : '';
  return `${workers.reporting} of ${workers.total} reporting now${failed}`;
}

export function renderNote(classified: Classified, now: Date, timezone: string): string {
  const count = classified.problems.length;
  const bothRead = classified.apps !== 'disabled';
  const headline = count > 0 ? `${count} problem${count === 1 ? '' : 's'}` : bothRead ? 'all clear' : 'no problems found';
  const lines = [`PulseOps, ${day(now, timezone)}: ${headline}`];
  for (const problem of classified.problems) lines.push(`  ${problem}`);
  lines.push('', 'Health (24h)');
  if (classified.apps === 'unavailable') lines.push('  apps  unknown: Better Stack unavailable');
  else if (classified.apps !== 'disabled') for (const app of classified.apps) lines.push(appLine(app));
  lines.push(`  workers  ${workersLine(classified.workers)}`);
  for (const { check, reason } of classified.unknown) lines.push(`  ${check}  unknown (${reason})`);
  const notChecked = [...(classified.apps === 'disabled' ? ['Better Stack'] : []), ...NOT_BUILT];
  lines.push('', 'LLM spend yesterday: not collected yet', '', `Not checked: ${notChecked.join(', ')}`, '');
  return lines.join('\n');
}
