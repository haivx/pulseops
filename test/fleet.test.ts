import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { parseFleet, loadFleet, FleetError } from '../src/fleet.ts';

const valid = `
timezone: Asia/Saigon
apps:
  - name: app-1
    checks:
      - name: worker
        slug: app-1-worker
  - name: site
`;

test('a valid fleet file gives the timezone, apps and their checks', () => {
  const fleet = parseFleet(valid);
  assert.equal(fleet.timezone, 'Asia/Saigon');
  assert.deepEqual(fleet.apps, [
    { name: 'app-1', checks: [{ name: 'worker', slug: 'app-1-worker' }] },
    { name: 'site', checks: [] },
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

test('YAML that does not parse is reported with its line', () => {
  assert.throws(() => parseFleet('timezone: UTC\napps:\n  - name: [unclosed\n'), (error: unknown) => error instanceof FleetError && /line \d+/.test(error.message));
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
