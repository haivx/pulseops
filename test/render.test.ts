import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderNote } from '../src/note/render.ts';
import type { Classified } from '../src/note/classify.ts';

// 12 Nov 2026 01:00 UTC is Thu 12 Nov in Asia/Saigon (UTC+7) and Wed 11 Nov in America/Los_Angeles.
const now = new Date('2026-11-12T01:00:00Z');

test('a note with problems lists them under the headline, then Health, LLM and the Not checked footer', () => {
  const classified: Classified = {
    problems: ['app-1/worker: down. Check the worker', 'app-2/cron: unknown (new). Ping it once, or fix its slug in fleet.yaml'],
    workers: { reporting: 1, total: 3, failed: ['app-1/worker'] },
    unknown: [{ check: 'app-2/cron', reason: 'new' }],
  };
  assert.equal(
    renderNote(classified, now, 'Asia/Saigon'),
    [
      'PulseOps, Thu 12 Nov: 2 problems',
      '  app-1/worker: down. Check the worker',
      '  app-2/cron: unknown (new). Ping it once, or fix its slug in fleet.yaml',
      '',
      'Health (24h)',
      '  workers  1 of 3 reporting now (failed: app-1/worker)',
      '  app-2/cron  unknown (new)',
      '',
      'LLM spend yesterday: not collected yet',
      '',
      'Not checked: Better Stack, GitHub deploys, subscriptions',
      '',
    ].join('\n'),
  );
});

test('with no problems the headline is "no problems found", never "all clear", while Better Stack is not checked', () => {
  const note = renderNote({ problems: [], workers: { reporting: 2, total: 2, failed: [] }, unknown: [] }, now, 'America/Los_Angeles');
  assert.ok(note.startsWith('PulseOps, Wed 11 Nov: no problems found\n\nHealth (24h)\n  workers  2 of 2 reporting now\n'));
  assert.ok(!note.includes('all clear'));
});

test('one problem is singular, and an unavailable source shows on the workers line', () => {
  const note = renderNote({ problems: ['unknown: healthchecks.io unavailable'], workers: 'unavailable', unknown: [] }, now, 'UTC');
  assert.ok(note.startsWith('PulseOps, Thu 12 Nov: 1 problem\n'));
  assert.ok(note.includes('  workers  unknown: healthchecks.io unavailable\n'));
});

test('a fleet with no checks says so instead of "0 of 0"', () => {
  const note = renderNote({ problems: [], workers: { reporting: 0, total: 0, failed: [] }, unknown: [] }, now, 'UTC');
  assert.ok(note.includes('  workers  no checks in fleet.yaml\n'));
});
