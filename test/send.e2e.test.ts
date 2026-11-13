import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeKey, leakForms } from './helpers/leaky-server.ts';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

function writeFleet(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pulseops-fleet-'));
  const path = join(dir, 'fleet.yaml');
  writeFileSync(path, 'timezone: UTC\napps:\n  - name: app-1\n    checks:\n      - name: worker\n        slug: app-1-worker\n');
  return path;
}

/** One fake for all three vendors: healthchecks.io checks, Telegram sendMessage and the ping endpoint. */
async function fakeVendors(telegramStatus: number, pingStatus = 200) {
  const calls = { checks: 0, telegram: [] as string[], pings: [] as string[] };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const url = req.url ?? '';
      if (url.startsWith('/api/v3/checks/')) {
        calls.checks += 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ checks: [{ slug: 'app-1-worker', status: 'up' }] }));
      } else if (url.includes('/sendMessage')) {
        calls.telegram.push(body);
        res.writeHead(telegramStatus, { 'content-type': 'application/json' });
        res.end(telegramStatus === 200 ? '{"ok":true,"result":{}}' : '{"ok":false,"description":"down"}');
      } else {
        calls.pings.push(url);
        res.writeHead(pingStatus);
        res.end('OK');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('server has no port');
  return { url: `http://127.0.0.1:${address.port}`, calls, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

function run(args: string[], env: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { env: { PATH: process.env.PATH ?? '', ...env } });
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
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

function secrets() {
  const botSecret = randomBytes(24).toString('hex');
  return { token: `987654:${botSecret}`, botSecret, uuid: randomUUID(), key: fakeKey('hcr') };
}

function env(vendors: string, s: ReturnType<typeof secrets>): Record<string, string> {
  return {
    HEALTHCHECKS_API_KEY: s.key,
    HEALTHCHECKS_API_URL: vendors,
    TELEGRAM_BOT_TOKEN: s.token,
    TELEGRAM_CHAT_ID: '-1001234567',
    TELEGRAM_API_URL: vendors,
    HEALTHCHECKS_PING_UUID: s.uuid,
    HEALTHCHECKS_PING_URL_BASE: vendors,
  };
}

function assertNoLeak(output: string, s: ReturnType<typeof secrets>) {
  for (const value of [s.key, s.botSecret, s.uuid]) {
    for (const form of leakForms(value)) assert.ok(!output.includes(form), 'a form of a secret reached the output');
  }
}

test('note sends one Telegram message, then pings the note check once, and exits 0', async () => {
  const s = secrets();
  const vendors = await fakeVendors(200);
  try {
    const { code, stdout, stderr } = await run(['note', '--fleet', writeFleet()], env(vendors.url, s));
    assert.equal(code, 0, stderr);
    assert.equal(vendors.calls.telegram.length, 1);
    const sent = JSON.parse(vendors.calls.telegram[0]!) as Record<string, unknown>;
    assert.equal(sent.chat_id, '-1001234567');
    assert.match(String(sent.text), /^PulseOps, .*: no problems found\n/);
    assert.equal(sent.parse_mode, undefined);
    assert.deepEqual(vendors.calls.pings, [`/${s.uuid}`]);
    assertNoLeak(stdout + stderr, s);
  } finally {
    await vendors.close();
  }
});

test('when Telegram stays down, note exits 4 after 3 tries, does not ping, and prints no secret', async () => {
  const s = secrets();
  const vendors = await fakeVendors(503);
  try {
    const { code, stdout, stderr } = await run(['note', '--fleet', writeFleet()], env(vendors.url, s));
    assert.equal(code, 4, stderr);
    assert.equal(vendors.calls.telegram.length, 3);
    assert.deepEqual(vendors.calls.pings, []);
    assert.ok(stderr.includes('"error_status":503'));
    assertNoLeak(stdout + stderr, s);
  } finally {
    await vendors.close();
  }
});

test('when the ping fails after delivery, note warns and still exits 0', async () => {
  const s = secrets();
  const vendors = await fakeVendors(200, 500);
  try {
    const { code, stdout, stderr } = await run(['note', '--fleet', writeFleet()], env(vendors.url, s));
    assert.equal(code, 0, stderr);
    assert.equal(vendors.calls.telegram.length, 1);
    assert.ok(stderr.includes('"level":"warn"') && stderr.includes('ping'));
    assertNoLeak(stdout + stderr, s);
  } finally {
    await vendors.close();
  }
});

test('note --dry-run sends nothing and needs only the healthchecks.io key', async () => {
  const s = secrets();
  const vendors = await fakeVendors(200);
  try {
    const { code, stderr } = await run(['note', '--dry-run', '--fleet', writeFleet()], { HEALTHCHECKS_API_KEY: s.key, HEALTHCHECKS_API_URL: vendors.url });
    assert.equal(code, 0, stderr);
    assert.equal(vendors.calls.telegram.length, 0);
    assert.deepEqual(vendors.calls.pings, []);
  } finally {
    await vendors.close();
  }
});

test('note without the Telegram settings exits 2 and names what is missing', async () => {
  const { code, stderr } = await run(['note', '--fleet', writeFleet()], { HEALTHCHECKS_API_KEY: fakeKey('hcr') });
  assert.equal(code, 2);
  assert.ok(stderr.includes('E_CONFIG_MISSING') && stderr.includes('TELEGRAM_BOT_TOKEN'));
});

test('a chat id that is not a number exits 2 before anything is sent', async () => {
  const s = secrets();
  const vendors = await fakeVendors(200);
  try {
    const { code, stderr } = await run(['note', '--fleet', writeFleet()], { ...env(vendors.url, s), TELEGRAM_CHAT_ID: '@my_channel' });
    assert.equal(code, 2);
    assert.ok(stderr.includes('E_CONFIG_INVALID') && stderr.includes('TELEGRAM_CHAT_ID'));
    assert.equal(vendors.calls.telegram.length, 0);
  } finally {
    await vendors.close();
  }
});

test('a Telegram 4xx (bad token, wrong chat, bot blocked) is a config error: exit 2 with a fix, one try, no ping', async () => {
  const s = secrets();
  const vendors = await fakeVendors(401);
  try {
    const { code, stdout, stderr } = await run(['note', '--fleet', writeFleet()], env(vendors.url, s));
    assert.equal(code, 2, stderr);
    assert.equal(vendors.calls.telegram.length, 1);
    assert.deepEqual(vendors.calls.pings, []);
    assert.ok(stderr.includes('TELEGRAM_BOT_TOKEN') && stderr.includes('TELEGRAM_CHAT_ID') && stderr.includes('fix:'));
    assertNoLeak(stdout + stderr, s);
  } finally {
    await vendors.close();
  }
});

test('a ping UUID that is not a UUID exits 2 before anything is sent', async () => {
  const s = secrets();
  const vendors = await fakeVendors(200);
  try {
    const { code, stderr } = await run(['note', '--fleet', writeFleet()], { ...env(vendors.url, s), HEALTHCHECKS_PING_UUID: 'app-1-worker-check-slug' });
    assert.equal(code, 2);
    assert.ok(stderr.includes('E_CONFIG_INVALID') && stderr.includes('HEALTHCHECKS_PING_UUID'));
    assert.equal(vendors.calls.telegram.length, 0);
  } finally {
    await vendors.close();
  }
});

test('a ping answered with 404 (an unknown check) exits 2 with a fix, after the note was delivered', async () => {
  const s = secrets();
  const vendors = await fakeVendors(200, 404);
  try {
    const { code, stdout, stderr } = await run(['note', '--fleet', writeFleet()], env(vendors.url, s));
    assert.equal(code, 2, stderr);
    assert.equal(vendors.calls.telegram.length, 1);
    assert.ok(stderr.includes('HEALTHCHECKS_PING_UUID') && stderr.includes('fix:'));
    assertNoLeak(stdout + stderr, s);
  } finally {
    await vendors.close();
  }
});

test('an unknown command says so, without asking for the Telegram settings', async () => {
  const { code, stderr } = await run(['notes', '--fleet', writeFleet()], { HEALTHCHECKS_API_KEY: fakeKey('hcr') });
  assert.equal(code, 2);
  assert.ok(stderr.includes('unknown command'));
  assert.ok(!stderr.includes('TELEGRAM_BOT_TOKEN'), 'it asked for Telegram settings first');
});
