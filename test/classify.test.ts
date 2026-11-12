import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../src/note/classify.ts';
import type { Fleet } from '../src/fleet.ts';

const fleet: Fleet = {
  timezone: 'UTC',
  apps: [
    { name: 'app-1', checks: [{ name: 'worker', slug: 's1' }, { name: 'cron', slug: 's2' }] },
    { name: 'app-2', checks: [{ name: 'job', slug: 's3' }] },
    { name: 'site', checks: [] },
  ],
};

const run = (statuses: Record<string, string>) => classify(fleet, new Map(Object.entries(statuses)));

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
  const result = classify(fleet, 'unavailable');
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
  const result = classify({ timezone: 'UTC', apps: [{ name: 'site', checks: [] }] }, new Map());
  assert.deepEqual(result.problems, ["workers: no checks in fleet.yaml. Add the app's checks"]);
});
