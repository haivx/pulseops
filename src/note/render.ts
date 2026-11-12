import type { Classified } from './classify.ts';

// The note layout from docs/designs/pulseops-daily-note.md ("Daily note"),
// limited to what this slice reads. Better Stack is not checked, so the
// headline never says "all clear": that needs both health sources enabled.

const NOT_CHECKED = 'Not checked: Better Stack, GitHub deploys, subscriptions';

function day(now: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, weekday: 'short', day: 'numeric', month: 'short' }).formatToParts(now);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('weekday')} ${part('day')} ${part('month')}`;
}

function workersLine(workers: Classified['workers']): string {
  if (workers === 'unavailable') return 'unknown: healthchecks.io unavailable';
  if (workers.total === 0) return 'no checks in fleet.yaml';
  const failed = workers.failed.length > 0 ? ` (failed: ${workers.failed.join(', ')})` : '';
  return `${workers.reporting} of ${workers.total} reporting now${failed}`;
}

export function renderNote(classified: Classified, now: Date, timezone: string): string {
  const count = classified.problems.length;
  const headline = count === 0 ? 'no problems found' : `${count} problem${count === 1 ? '' : 's'}`;
  const lines = [`PulseOps, ${day(now, timezone)}: ${headline}`];
  for (const problem of classified.problems) lines.push(`  ${problem}`);
  lines.push('', 'Health (24h)', `  workers  ${workersLine(classified.workers)}`);
  for (const { check, reason } of classified.unknown) lines.push(`  ${check}  unknown (${reason})`);
  lines.push('', 'LLM spend yesterday: not collected yet', '', NOT_CHECKED, '');
  return lines.join('\n');
}
