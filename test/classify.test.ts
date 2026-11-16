import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../src/note/classify.ts';
import type { MonitorReading } from '../src/sources/betterstack.ts';
import type { Fleet } from '../src/fleet.ts';

const fleet: Fleet = {
  timezone: 'UTC',
  sources: { betterstack: 'disabled' },
  apps: [
    { name: 'app-1', monitor: undefined, checks: [{ name: 'worker', slug: 's1' }, { name: 'cron', slug: 's2' }] },
    { name: 'app-2', monitor: undefined, checks: [{ name: 'job', slug: 's3' }] },
    { name: 'site', monitor: undefined, checks: [] },
  ],
};

const now = new Date('2026-11-12T01:00:00Z');
// The healthchecks.io rules alone: Better Stack is disabled in these fixtures.
const run = (statuses: Record<string, string>) => classify(fleet, new Map(Object.entries(statuses)), 'disabled', now);

test('up and grace count as reporting; no problems found', () => {
  const result = run({ s1: 'up', s2: 'grace', s3: 'up' });
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.workers, { reporting: 3, total: 3, failed: [] });
  assert.deepEqual(result.unknown, []);
});

test('down is a named failed worker and one problem', () => {
  const result = run({ s1: 'down', s2: 'up', s3: 'up' });
  assert.deepEqual(result.workers, { reporting: 2, total: 3, failed: ['app-1/worker'] });
  assert.deepEqual(result.problems, ['app-1/worker: down. Check the worker']);
});

test('every status outside the allow-list, and a missing slug, is unknown and one problem each', () => {
  for (const status of ['new', 'paused', 'started', 'something-new']) {
    const result = run({ s1: status, s2: 'up', s3: 'up' });
    assert.deepEqual(result.unknown, [{ check: 'app-1/worker', reason: status }], status);
    assert.equal(result.problems.length, 1, status);
    assert.deepEqual(result.workers, { reporting: 2, total: 3, failed: [] }, status);
  }
  const missing = run({ s1: 'up', s2: 'up' });
  assert.deepEqual(missing.unknown, [{ check: 'app-2/job', reason: 'missing' }]);
  assert.equal(missing.problems[0], 'app-2/job: unknown (missing). Check its slug in fleet.yaml or create the check');
});

test('a new check tells the owner to ping it once', () => {
  assert.equal(run({ s1: 'new', s2: 'up', s3: 'up' }).problems[0], 'app-1/worker: unknown (new). Ping it once, or fix its slug in fleet.yaml');
});

test('an unavailable source is one problem, however many checks it affects', () => {
  const result = classify(fleet, 'unavailable', 'disabled', now);
  assert.deepEqual(result.problems, ['unknown: healthchecks.io unavailable']);
  assert.equal(result.workers, 'unavailable');
});

test('each problem counts once, in fleet order', () => {
  const result = run({ s1: 'down', s2: 'paused', s3: 'down' });
  assert.equal(result.problems.length, 3);
  assert.deepEqual(result.workers, { reporting: 0, total: 3, failed: ['app-1/worker', 'app-2/job'] });
});

test('an ambiguous or unexpected status is unknown, with a fix for each', () => {
  const result = run({ s1: 'ambiguous', s2: 'unexpected', s3: 'up' });
  assert.deepEqual(result.problems, [
    'app-1/worker: unknown (ambiguous). Give each check its own slug in healthchecks.io',
    'app-1/cron: unknown (unexpected). Check it in healthchecks.io',
  ]);
});

test('a fleet with apps but no checks is a problem, never a healthy note', () => {
  const result = classify({ timezone: 'UTC', sources: { betterstack: 'disabled' }, apps: [{ name: 'site', monitor: undefined, checks: [] }] }, new Map(), 'disabled', now);
  assert.deepEqual(result.problems, ["workers: no checks in fleet.yaml. Add the app's checks"]);
});

const minutesAgo = (m: number) => now.getTime() - m * 60_000;
const bsFleet: Fleet = {
  timezone: 'UTC',
  sources: { betterstack: 'enabled' },
  apps: [
    { name: 'app-1', monitor: '1', checks: [{ name: 'worker', slug: 's1' }] },
    { name: 'site', monitor: '2', checks: [] },
  ],
};
const monitors = (readings: Record<string, MonitorReading>) => new Map(Object.entries(readings));
const up: MonitorReading = { status: 'up', incidents: [] };

test('Better Stack: an up monitor is no problem; down is one problem with its next action', () => {
  const ok = classify(bsFleet, new Map([['s1', 'up']]), monitors({ 'app-1': up, site: up }), now);
  assert.deepEqual(ok.problems, []);
  assert.deepEqual(ok.apps, [
    { name: 'app-1', status: 'up', incidents: { count: 0, minutes: 0, ongoing: false } },
    { name: 'site', status: 'up', incidents: { count: 0, minutes: 0, ongoing: false } },
  ]);
  const down = classify(bsFleet, new Map([['s1', 'up']]), monitors({ 'app-1': { status: 'down', incidents: [{ startedAt: minutesAgo(30), resolvedAt: undefined }] }, site: up }), now);
  assert.deepEqual(down.problems, ['app-1: down. Check the app']);
  assert.deepEqual((down.apps as { incidents: unknown }[])[0]!.incidents, { count: 1, minutes: 30, ongoing: true });
});

test('Better Stack: every status outside up and down, a missing monitor and too many incidents are unknown with a fix', () => {
  const cases: [string, string][] = [
    ['paused', 'app-1: unknown (paused). Resume the monitor in Better Stack'],
    ['missing', 'app-1: unknown (missing). Check its monitor ID in fleet.yaml'],
    ['too-many', 'app-1: unknown (more than 50 incidents). Check it in Better Stack'],
    ['validating', 'app-1: unknown (validating). Check it in Better Stack'],
    ['maintenance', 'app-1: unknown (maintenance). Check it in Better Stack'],
    ['unexpected', 'app-1: unknown (unexpected). Check it in Better Stack'],
  ];
  for (const [status, problem] of cases) {
    const result = classify(bsFleet, new Map([['s1', 'up']]), monitors({ 'app-1': { status, incidents: [] }, site: up }), now);
    assert.deepEqual(result.problems, [problem], status);
  }
  // A reading the source never returned (an app missing from the map) is unknown too, never up.
  assert.deepEqual(classify(bsFleet, new Map([['s1', 'up']]), monitors({ site: up }), now).problems, ['app-1: unknown (missing). Check its monitor ID in fleet.yaml']);
});

test('Better Stack: every incident that overlaps the last 24 hours counts, its minutes clipped to the window; resolved ones are not problems', () => {
  const incidents = [
    // Inside the window: 4 min.
    { startedAt: minutesAgo(24 * 60 - 1), resolvedAt: minutesAgo(24 * 60 - 5) },
    // Started before the window, resolved inside it: only the 10 min inside count.
    { startedAt: minutesAgo(24 * 60 + 1), resolvedAt: minutesAgo(24 * 60 - 10) },
    // Before midnight UTC and still inside the window: 8 min.
    { startedAt: Date.parse('2026-11-11T23:50:00Z'), resolvedAt: Date.parse('2026-11-11T23:58:00Z') },
    // Resolved before the window: not counted.
    { startedAt: minutesAgo(30 * 60), resolvedAt: minutesAgo(25 * 60) },
    // Starts after now (not counted here; clock skew is a deferred follow-up).
    { startedAt: now.getTime() + 60_000, resolvedAt: undefined },
  ];
  const result = classify(bsFleet, new Map([['s1', 'up']]), monitors({ 'app-1': { status: 'up', incidents }, site: up }), now);
  assert.deepEqual(result.problems, []);
  assert.deepEqual((result.apps as { incidents: unknown }[])[0]!.incidents, { count: 3, minutes: 22, ongoing: false });
});

test('Better Stack: a 23-hour outage that began 25 hours ago and ended an hour ago is in the note, never "0 incidents"', () => {
  const result = classify(bsFleet, new Map([['s1', 'up']]), monitors({ 'app-1': { status: 'up', incidents: [{ startedAt: minutesAgo(25 * 60), resolvedAt: minutesAgo(60) }] }, site: up }), now);
  assert.deepEqual((result.apps as { incidents: unknown }[])[0]!.incidents, { count: 1, minutes: 23 * 60, ongoing: false });
  const open = classify(bsFleet, new Map([['s1', 'up']]), monitors({ 'app-1': { status: 'down', incidents: [{ startedAt: minutesAgo(30 * 60), resolvedAt: undefined }] }, site: up }), now);
  assert.deepEqual((open.apps as { incidents: unknown }[])[0]!.incidents, { count: 1, minutes: 24 * 60, ongoing: true });
});

test('Better Stack unavailable is one problem however many apps it covers, listed before the workers', () => {
  const result = classify(bsFleet, new Map([['s1', 'down']]), 'unavailable', now);
  assert.deepEqual(result.problems, ['unknown: Better Stack unavailable', 'app-1/worker: down. Check the worker']);
  assert.equal(result.apps, 'unavailable');
});
