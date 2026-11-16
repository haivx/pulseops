import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeKey, leakForms } from './helpers/leaky-server.ts';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

const fleetYaml = `timezone: UTC
apps:
  - name: app-1
    monitor: "101"
    checks:
      - name: worker
        slug: app-1-worker
      - name: cron
        slug: app-1-cron
`;

function writeFleet(text = fleetYaml): string {
  const dir = mkdtempSync(join(tmpdir(), 'pulseops-fleet-'));
  const path = join(dir, 'fleet.yaml');
  writeFileSync(path, text);
  return path;
}

/** healthchecks.io answers `status`/`body`; Better Stack answers `monitor` for the monitor, or `bsStatus` for every Better Stack call. */
async function fakeHealthchecks(status: number, body: unknown, bs: { monitor?: string; bsStatus?: number } = {}) {
  const server = createServer((req, res) => {
    const url = req.url ?? '';
    if (url.startsWith('/api/v2/monitors/') || url.startsWith('/api/v3/incidents')) {
      res.writeHead(bs.bsStatus ?? 200, { 'content-type': 'application/json' });
      if (bs.bsStatus !== undefined) return void res.end(JSON.stringify({ errors: 'Unauthorized' }));
      return void res.end(
        JSON.stringify(url.startsWith('/api/v2/') ? { data: { id: '101', attributes: { status: bs.monitor ?? 'up' } } } : { data: [], pagination: { next: null } }),
      );
    }
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('server has no port');
  return { url: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

function run(args: string[], env: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { env: { PATH: process.env.PATH ?? '', ...env } });
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

test('note --dry-run prints a real note from healthchecks.io and exits 0', async () => {
  const key = fakeKey('hcr');
  const server = await fakeHealthchecks(200, { checks: [{ slug: 'app-1-worker', status: 'up' }, { slug: 'app-1-cron', status: 'new' }] });
  try {
    const { code, stdout, stderr } = await run(['note', '--dry-run', '--fleet', writeFleet()], { HEALTHCHECKS_API_KEY: key, HEALTHCHECKS_API_URL: server.url, BETTERSTACK_API_TOKEN: fakeKey('bst'), BETTERSTACK_API_URL: server.url });
    assert.equal(code, 0, stderr);
    assert.match(stdout, /^PulseOps, \w{3} \d{1,2} \w{3}: 1 problem\n/);
    assert.ok(stdout.includes('  app-1/cron: unknown (new). Ping it once, or fix its slug in fleet.yaml\n'));
    assert.ok(stdout.includes('  app-1  up, 0 incidents\n'));
    assert.ok(stdout.includes('  workers  1 of 2 reporting now\n'));
    assert.ok(stdout.includes('Not checked: GitHub deploys, subscriptions\n'));
    for (const form of leakForms(key)) assert.ok(!(stdout + stderr).includes(form), 'a leak form reached the output');
  } finally {
    await server.close();
  }
});

test('when healthchecks.io rejects the key, the note still prints with the source unknown, and the logged error is redacted', async () => {
  const key = fakeKey('hcr');
  const server = await fakeHealthchecks(401, { error: 'bad key', got: key });
  try {
    const { code, stdout, stderr } = await run(['note', '--dry-run', '--fleet', writeFleet()], { HEALTHCHECKS_API_KEY: key, HEALTHCHECKS_API_URL: server.url, BETTERSTACK_API_TOKEN: fakeKey('bst'), BETTERSTACK_API_URL: server.url });
    assert.equal(code, 0, stderr);
    assert.ok(stdout.includes(': 1 problem\n  unknown: healthchecks.io unavailable\n'));
    assert.ok(stderr.includes('E_VENDOR_HTTP'));
    assert.ok(stderr.includes('"error_status":401'), 'the status is logged; the vendor body that echoed the key is not');
    for (const form of leakForms(key)) assert.ok(!(stdout + stderr).includes(form), 'a leak form reached the output');
  } finally {
    await server.close();
  }
});

test('a missing key exits 2 and names the variable', async () => {
  const { code, stderr } = await run(['note', '--dry-run', '--fleet', writeFleet()], {});
  assert.equal(code, 2);
  assert.ok(stderr.includes('E_CONFIG_MISSING') && stderr.includes('HEALTHCHECKS_API_KEY'));
});

test('a bad fleet file exits 2 with the problem and its fix', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pulseops-fleet-'));
  const path = join(dir, 'fleet.yaml');
  writeFileSync(path, 'timezone: UTC\napps: []\n');
  const { code, stderr } = await run(['note', '--dry-run', '--fleet', path], { HEALTHCHECKS_API_KEY: fakeKey('hcr') });
  assert.equal(code, 2);
  assert.ok(stderr.includes('E_CONFIG_INVALID') && stderr.includes('no apps'));
});

test('an unknown flag, an unknown command or an extra argument exits 2 with the usage line', async () => {
  for (const args of [['note', '--dry-run', '--bogus'], ['notes', '--dry-run'], ['note', 'extra', '--dry-run']]) {
    const { code, stderr } = await run([...args, '--fleet', writeFleet()], { HEALTHCHECKS_API_KEY: fakeKey('hcr') });
    assert.equal(code, 2, args.join(' '));
    assert.ok(stderr.includes('E_USAGE') && stderr.includes('usage: pulseops note'), `${args.join(' ')}: ${stderr}`);
  }
});

test('an http base URL to another host exits 2 with E_CONFIG_INVALID, before any request', async () => {
  // The unit tests for healthchecksBaseUrl cover each refused shape; this checks the CLI stops with exit 2.
  const { code, stdout, stderr } = await run(['note', '--dry-run', '--fleet', writeFleet()], {
    HEALTHCHECKS_API_KEY: fakeKey('hcr'),
    BETTERSTACK_API_TOKEN: fakeKey('bst'),
    HEALTHCHECKS_API_URL: 'http://pulseops-test.invalid:9',
  });
  assert.equal(code, 2);
  assert.ok(stderr.includes('E_CONFIG_INVALID') && stderr.includes('HEALTHCHECKS_API_URL'));
  assert.equal(stdout, '', 'no note is printed');
});

test('an argument error writes none of the arguments, so a key passed as a flag never reaches the log', async () => {
  const key = fakeKey('hcr');
  const { code, stderr } = await run(['note', '--dry-run', `--${key}`, '--fleet', writeFleet()], { HEALTHCHECKS_API_KEY: key });
  assert.equal(code, 2);
  assert.ok(stderr.includes('E_USAGE') && stderr.includes('invalid arguments'));
  assert.ok(!stderr.includes('REDACTED'), 'argv text reached the log and needed redacting');
  for (const form of leakForms(key)) assert.ok(!stderr.includes(form), 'a leak form reached stderr');
});

test('with both sources read and nothing wrong, the dry run says "all clear"', async () => {
  const server = await fakeHealthchecks(200, { checks: [{ slug: 'app-1-worker', status: 'up' }, { slug: 'app-1-cron', status: 'grace' }] });
  try {
    const { code, stdout, stderr } = await run(['note', '--dry-run', '--fleet', writeFleet()], {
      HEALTHCHECKS_API_KEY: fakeKey('hcr'),
      HEALTHCHECKS_API_URL: server.url,
      BETTERSTACK_API_TOKEN: fakeKey('bst'),
      BETTERSTACK_API_URL: server.url,
    });
    assert.equal(code, 0, stderr);
    assert.match(stdout, /^PulseOps, \w{3} \d{1,2} \w{3}: all clear\n/);
  } finally {
    await server.close();
  }
});

test('when Better Stack rejects the token, the note still prints with that source unknown, and the token is never logged', async () => {
  const token = fakeKey('bst');
  const server = await fakeHealthchecks(200, { checks: [{ slug: 'app-1-worker', status: 'up' }, { slug: 'app-1-cron', status: 'up' }] }, { bsStatus: 401 });
  try {
    const { code, stdout, stderr } = await run(['note', '--dry-run', '--fleet', writeFleet()], {
      HEALTHCHECKS_API_KEY: fakeKey('hcr'),
      HEALTHCHECKS_API_URL: server.url,
      BETTERSTACK_API_TOKEN: token,
      BETTERSTACK_API_URL: server.url,
    });
    assert.equal(code, 0, stderr);
    assert.ok(stdout.includes(': 1 problem\n  unknown: Better Stack unavailable\n'));
    assert.ok(stdout.includes('  apps  unknown: Better Stack unavailable\n'));
    assert.ok(stderr.includes('"error_status":401'));
    for (const form of leakForms(token)) assert.ok(!(stdout + stderr).includes(form), 'a form of the token reached the output');
  } finally {
    await server.close();
  }
});

test('a missing Better Stack token exits 2 and names it; with the source disabled no token is read and the footer says Not checked', async () => {
  const missing = await run(['note', '--dry-run', '--fleet', writeFleet()], { HEALTHCHECKS_API_KEY: fakeKey('hcr') });
  assert.equal(missing.code, 2);
  assert.ok(missing.stderr.includes('E_CONFIG_MISSING') && missing.stderr.includes('BETTERSTACK_API_TOKEN'));
  const server = await fakeHealthchecks(200, { checks: [{ slug: 'app-1-worker', status: 'up' }] });
  try {
    const disabled = writeFleet('timezone: UTC\nsources:\n  betterstack: disabled\napps:\n  - name: app-1\n    checks:\n      - name: worker\n        slug: app-1-worker\n');
    const { code, stdout, stderr } = await run(['note', '--dry-run', '--fleet', disabled], { HEALTHCHECKS_API_KEY: fakeKey('hcr'), HEALTHCHECKS_API_URL: server.url });
    assert.equal(code, 0, stderr);
    assert.match(stdout, /: no problems found\n/);
    assert.ok(stdout.includes('Not checked: Better Stack, GitHub deploys, subscriptions\n'));
  } finally {
    await server.close();
  }
});

test('a monitor that is down is one problem in the note', async () => {
  const server = await fakeHealthchecks(200, { checks: [{ slug: 'app-1-worker', status: 'up' }, { slug: 'app-1-cron', status: 'up' }] }, { monitor: 'down' });
  try {
    const { code, stdout, stderr } = await run(['note', '--dry-run', '--fleet', writeFleet()], {
      HEALTHCHECKS_API_KEY: fakeKey('hcr'),
      HEALTHCHECKS_API_URL: server.url,
      BETTERSTACK_API_TOKEN: fakeKey('bst'),
      BETTERSTACK_API_URL: server.url,
    });
    assert.equal(code, 0, stderr);
    assert.ok(stdout.includes(': 1 problem\n  app-1: down. Check the app\n'));
    assert.ok(stdout.includes('  app-1  down, 0 incidents\n'));
  } finally {
    await server.close();
  }
});

test('an http BETTERSTACK_API_URL to another host exits 2 before any request, so the token never leaves', async () => {
  const token = fakeKey('bst');
  const { code, stdout, stderr } = await run(['note', '--dry-run', '--fleet', writeFleet()], {
    HEALTHCHECKS_API_KEY: fakeKey('hcr'),
    BETTERSTACK_API_TOKEN: token,
    BETTERSTACK_API_URL: 'http://pulseops-test.invalid:9',
  });
  assert.equal(code, 2);
  assert.ok(stderr.includes('E_CONFIG_INVALID') && stderr.includes('BETTERSTACK_API_URL'));
  assert.equal(stdout, '', 'no note is printed');
  for (const form of leakForms(token)) assert.ok(!stderr.includes(form), 'a form of the token reached stderr');
});

test('a key pasted into fleet.yaml as a repeated slug is never printed by the fleet error (exit 2)', async () => {
  // The registry is read before any key (it decides which keys are needed), so the redactor knows none yet.
  const key = fakeKey('hcr');
  const fleet = writeFleet(`timezone: UTC\napps:\n  - name: app-1\n    monitor: "101"\n    checks:\n      - { name: w, slug: ${key} }\n      - { name: x, slug: ${key} }\n`);
  const { code, stderr } = await run(['note', '--dry-run', '--fleet', fleet], { HEALTHCHECKS_API_KEY: key, BETTERSTACK_API_TOKEN: fakeKey('bst') });
  assert.equal(code, 2);
  assert.ok(stderr.includes('E_CONFIG_INVALID') && stderr.includes('repeats the slug of apps[0].checks[0]'), stderr);
  for (const form of leakForms(key)) assert.ok(!stderr.includes(form), 'a form of the key reached stderr');
});
