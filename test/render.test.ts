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
    apps: 'disabled',
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
  const note = renderNote({ problems: [], workers: { reporting: 2, total: 2, failed: [] }, unknown: [], apps: 'disabled' }, now, 'America/Los_Angeles');
  assert.ok(note.startsWith('PulseOps, Wed 11 Nov: no problems found\n\nHealth (24h)\n  workers  2 of 2 reporting now\n'));
  assert.ok(!note.includes('all clear'));
});

test('one problem is singular, and an unavailable source shows on the workers line', () => {
  const note = renderNote({ problems: ['unknown: healthchecks.io unavailable'], workers: 'unavailable', unknown: [], apps: 'disabled' }, now, 'UTC');
  assert.ok(note.startsWith('PulseOps, Thu 12 Nov: 1 problem\n'));
  assert.ok(note.includes('  workers  unknown: healthchecks.io unavailable\n'));
});

test('a fleet with no checks says so instead of "0 of 0"', () => {
  const note = renderNote({ problems: [], workers: { reporting: 0, total: 0, failed: [] }, unknown: [], apps: 'disabled' }, now, 'UTC');
  assert.ok(note.includes('  workers  no checks in fleet.yaml\n'));
});

const none = { count: 0, minutes: 0, ongoing: false };

test('with Better Stack read and no problems, the headline is "all clear" and each app has its line', () => {
  const note = renderNote(
    {
      problems: [],
      workers: { reporting: 1, total: 1, failed: [] },
      unknown: [],
      apps: [
        { name: 'app-1', status: 'up', incidents: { count: 1, minutes: 4, ongoing: false } },
        { name: 'site', status: 'up', incidents: none },
      ],
    },
    now,
    'UTC',
  );
  assert.equal(
    note,
    [
      'PulseOps, Thu 12 Nov: all clear',
      '',
      'Health (24h)',
      '  app-1  up, 1 incident (4 min)',
      '  site  up, 0 incidents',
      '  workers  1 of 1 reporting now',
      '',
      'LLM spend yesterday: not collected yet',
      '',
      'Not checked: GitHub deploys, subscriptions',
      '',
    ].join('\n'),
  );
});

test('app lines show down, ongoing incidents and unknown reasons; problems still count', () => {
  const note = renderNote(
    {
      problems: ['app-1: down. Check the app', 'site: unknown (paused). Resume the monitor in Better Stack'],
      workers: { reporting: 0, total: 0, failed: [] },
      unknown: [],
      apps: [
        { name: 'app-1', status: 'down', incidents: { count: 2, minutes: 40, ongoing: true } },
        { name: 'site', status: 'paused', incidents: none },
        { name: 'api', status: 'too-many', incidents: none },
      ],
    },
    now,
    'UTC',
  );
  assert.ok(note.startsWith('PulseOps, Thu 12 Nov: 2 problems\n'));
  assert.ok(note.includes('  app-1  down, 2 incidents (ongoing)\n'));
  assert.ok(note.includes('  site  unknown (paused)\n'));
  assert.ok(note.includes('  api  unknown (more than 50 incidents)\n'));
  assert.ok(!note.includes('all clear'));
});

test('Better Stack unavailable shows one apps line and never "all clear"; disabled says Not checked', () => {
  const unavailable = renderNote({ problems: ['unknown: Better Stack unavailable'], workers: { reporting: 1, total: 1, failed: [] }, unknown: [], apps: 'unavailable' }, now, 'UTC');
  assert.ok(unavailable.includes('  apps  unknown: Better Stack unavailable\n'));
  const disabled = renderNote({ problems: [], workers: { reporting: 1, total: 1, failed: [] }, unknown: [], apps: 'disabled' }, now, 'UTC');
  assert.ok(disabled.startsWith('PulseOps, Thu 12 Nov: no problems found\n'));
  assert.ok(disabled.includes('Not checked: Better Stack, GitHub deploys, subscriptions\n'));
});

test('incident time of an hour or more is shown in hours and minutes', () => {
  const note = renderNote(
    {
      problems: [],
      workers: { reporting: 0, total: 0, failed: [] },
      unknown: [],
      apps: [
        { name: 'a', status: 'up', incidents: { count: 1, minutes: 23 * 60, ongoing: false } },
        { name: 'b', status: 'up', incidents: { count: 2, minutes: 95, ongoing: false } },
      ],
    },
    now,
    'UTC',
  );
  assert.ok(note.includes('  a  up, 1 incident (23 h)\n'));
  assert.ok(note.includes('  b  up, 2 incidents (1 h 35 min)\n'));
});
