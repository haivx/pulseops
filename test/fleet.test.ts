import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { parseFleet, loadFleet, FleetError } from '../src/fleet.ts';

const valid = `
timezone: Asia/Saigon
apps:
  - name: app-1
    monitor: "101"
    checks:
      - name: worker
        slug: app-1-worker
  - name: site
    monitor: "102"
`;

test('a valid fleet file gives the timezone, apps with their Better Stack monitor, and their checks', () => {
  const fleet = parseFleet(valid);
  assert.equal(fleet.timezone, 'Asia/Saigon');
  assert.deepEqual(fleet.sources, { betterstack: 'enabled' });
  assert.deepEqual(fleet.apps, [
    { name: 'app-1', monitor: '101', checks: [{ name: 'worker', slug: 'app-1-worker' }] },
    { name: 'site', monitor: '102', checks: [] },
  ]);
});

test('every problem in the file is reported together, each with where and a fix', () => {
  const bad = `
timezone: Not/AZone
apps:
  - name: App_1
    checks:
      - name: worker
  - name: app-2
    checks: nope
`;
  assert.throws(
    () => parseFleet(bad),
    (error: unknown) => {
      if (!(error instanceof FleetError) || error.code !== 'E_CONFIG_INVALID') return false;
      for (const where of ['timezone', 'apps[0].name', 'apps[0].checks[0].slug', 'apps[1].checks']) {
        assert.ok(error.message.includes(where), `missing problem at ${where}: ${error.message}`);
      }
      return error.message.includes('fix:');
    },
  );
});

test('a fleet file with no apps is refused', () => {
  assert.throws(() => parseFleet('timezone: UTC\napps: []\n'), (error: unknown) => error instanceof FleetError && error.message.includes('no apps'));
});

test('YAML that does not parse is reported with its line and the parser code, never the parser text', () => {
  assert.throws(
    () => parseFleet('timezone: UTC\napps:\n  - name: [unclosed\n'),
    (error: unknown) => error instanceof FleetError && /line \d+ \([A-Z_]+\)/.test(error.message) && !/flow|sequence|expected/i.test(error.message),
  );
});

test('the same slug used twice is refused, because each check must map to one fleet entry', () => {
  const dup = 'timezone: UTC\napps:\n  - name: a\n    checks:\n      - { name: w, slug: s }\n  - name: b\n    checks:\n      - { name: w, slug: s }\n';
  assert.throws(() => parseFleet(dup), (error: unknown) => error instanceof FleetError && error.message.includes('slug s'));
});

test('fleet.example.yaml, the file new owners copy, is itself a valid fleet', () => {
  const example = loadFleet(fileURLToPath(new URL('../fleet.example.yaml', import.meta.url)));
  assert.ok(example.apps.length > 0);
});

test('the same app name twice is refused', () => {
  assert.throws(() => parseFleet('timezone: UTC\napps:\n  - name: a\n  - name: a\n'), (error: unknown) => error instanceof FleetError && error.message.includes('apps[1].name') && error.message.includes('repeats'));
});

test('a fleet file that cannot be read says why, and a non-text slug says so', () => {
  assert.throws(() => loadFleet('/nonexistent/pulseops/fleet.yaml'), (error: unknown) => error instanceof FleetError && error.message.includes('(ENOENT)'));
  assert.throws(() => parseFleet('timezone: UTC\napps:\n  - name: a\n    checks:\n      - { name: w, slug: 123 }\n'), (error: unknown) => error instanceof FleetError && error.message.includes('slug must be text'));
});

test('an empty or null slug is reported as missing, not as "must be text"', () => {
  for (const slug of ["''", 'null', "'   '"]) {
    assert.throws(
      () => parseFleet(`timezone: UTC\napps:\n  - name: a\n    checks:\n      - { name: w, slug: ${slug} }\n`),
      (error: unknown) => error instanceof FleetError && error.message.includes('slug is missing'),
      slug,
    );
  }
});

test('each app needs its Better Stack monitor ID: digits only, one app per monitor', () => {
  const cases: [string, string][] = [
    ['timezone: UTC\napps:\n  - name: a\n', 'apps[0].monitor is missing'],
    ['timezone: UTC\napps:\n  - name: a\n    monitor: "12/../34"\n', 'apps[0].monitor must be the numeric monitor ID'],
    ['timezone: UTC\napps:\n  - name: a\n    monitor: 123\n', 'apps[0].monitor must be the numeric monitor ID'],
    ['timezone: UTC\napps:\n  - name: a\n    monitor: "7"\n  - name: b\n    monitor: "7"\n', 'apps[1].monitor repeats monitor 7 from apps[0]'],
  ];
  for (const [text, expected] of cases) {
    assert.throws(
      () => parseFleet(text),
      (error: unknown) => error instanceof FleetError && error.message.includes(expected) && error.message.includes('fix:'),
      expected,
    );
  }
});

test('sources.betterstack: disabled makes the monitor ID optional; any other value is refused', () => {
  const off = parseFleet('timezone: UTC\nsources:\n  betterstack: disabled\napps:\n  - name: a\n');
  assert.deepEqual(off.sources, { betterstack: 'disabled' });
  assert.deepEqual(off.apps, [{ name: 'a', monitor: undefined, checks: [] }]);
  assert.equal(parseFleet('timezone: UTC\nsources:\n  betterstack: enabled\napps:\n  - name: a\n    monitor: "1"\n').sources.betterstack, 'enabled');
  for (const bad of ['sources: nope', 'sources:\n  betterstack: off', 'sources:\n  betterstack: false']) {
    assert.throws(
      () => parseFleet(`timezone: UTC\n${bad}\napps:\n  - name: a\n    monitor: "1"\n`),
      (error: unknown) => error instanceof FleetError && error.message.includes('sources') && error.message.includes('enabled or disabled'),
      bad,
    );
  }
});
