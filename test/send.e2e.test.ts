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
  writeFileSync(path, 'timezone: UTC\napps:\n  - name: app-1\n    monitor: "101"\n    checks:\n      - name: worker\n        slug: app-1-worker\n');
  return path;
}

/** One fake for all four vendors: healthchecks.io checks, Better Stack, Telegram sendMessage and the ping endpoint. */
async function fakeVendors(telegramStatus: number, pingStatus = 200, telegramReply?: string) {
  const calls = { checks: 0, telegram: [] as string[], pings: [] as string[] };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const url = req.url ?? '';
      if (url.startsWith('/api/v2/monitors/')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: { id: '101', type: 'monitor', attributes: { status: 'up' } } }));
      } else if (url.startsWith('/api/v3/incidents')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [], pagination: { next: null } }));
      } else if (url.startsWith('/api/v3/checks/')) {
        calls.checks += 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ checks: [{ slug: 'app-1-worker', status: 'up' }] }));
      } else if (url.includes('/sendMessage')) {
        calls.telegram.push(body);
        res.writeHead(telegramStatus, { 'content-type': 'application/json' });
        const chat = Number((JSON.parse(body) as { chat_id: string }).chat_id);
        const sent = JSON.stringify({ ok: true, result: { message_id: 7, chat: { id: chat } } });
        res.end(telegramReply ?? (telegramStatus === 200 ? sent : '{"ok":false,"description":"down"}'));
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
  return { token: `987654:${botSecret}`, botSecret, uuid: randomUUID(), key: fakeKey('hcr'), bst: fakeKey('bst') };
}

function env(vendors: string, s: ReturnType<typeof secrets>): Record<string, string> {
  return {
    HEALTHCHECKS_API_KEY: s.key,
    HEALTHCHECKS_API_URL: vendors,
    BETTERSTACK_API_TOKEN: s.bst,
    BETTERSTACK_API_URL: vendors,
    TELEGRAM_BOT_TOKEN: s.token,
    TELEGRAM_CHAT_ID: '-1001234567',
    TELEGRAM_API_URL: vendors,
    HEALTHCHECKS_PING_UUID: s.uuid,
    HEALTHCHECKS_PING_URL_BASE: vendors,
  };
}

function assertNoLeak(output: string, s: ReturnType<typeof secrets>) {
  for (const value of [s.key, s.bst, s.botSecret, s.uuid]) {
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
    // Both health sources are read and nothing is wrong, so the headline is "all clear".
    assert.match(String(sent.text), /^PulseOps, .*: all clear\n/);
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

test('note --dry-run sends nothing and needs only the two read keys (healthchecks.io and Better Stack)', async () => {
  const s = secrets();
  const vendors = await fakeVendors(200);
  try {
    const { code, stderr } = await run(['note', '--dry-run', '--fleet', writeFleet()], { HEALTHCHECKS_API_KEY: s.key, HEALTHCHECKS_API_URL: vendors.url, BETTERSTACK_API_TOKEN: s.bst, BETTERSTACK_API_URL: vendors.url });
    assert.equal(code, 0, stderr);
    assert.equal(vendors.calls.telegram.length, 0);
    assert.deepEqual(vendors.calls.pings, []);
  } finally {
    await vendors.close();
  }
});

test('note without the Telegram settings exits 2 and names what is missing', async () => {
  const { code, stderr } = await run(['note', '--fleet', writeFleet()], { HEALTHCHECKS_API_KEY: fakeKey('hcr'), BETTERSTACK_API_TOKEN: fakeKey('bst') });
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

test('a Telegram 401 (bad token) exits 2 naming the token, after one try, with no ping', async () => {
  const s = secrets();
  const vendors = await fakeVendors(401);
  try {
    const { code, stdout, stderr } = await run(['note', '--fleet', writeFleet()], env(vendors.url, s));
    assert.equal(code, 2, stderr);
    assert.equal(vendors.calls.telegram.length, 1);
    assert.deepEqual(vendors.calls.pings, []);
    assert.ok(stderr.includes('TELEGRAM_BOT_TOKEN') && stderr.includes('fix:'));
    assertNoLeak(stdout + stderr, s);
  } finally {
    await vendors.close();
  }
});

test('a Telegram 403 (bot blocked or not in the chat) exits 2 naming the chat id', async () => {
  const s = secrets();
  const vendors = await fakeVendors(403);
  try {
    const { code, stdout, stderr } = await run(['note', '--fleet', writeFleet()], env(vendors.url, s));
    assert.equal(code, 2, stderr);
    assert.equal(vendors.calls.telegram.length, 1);
    assert.ok(stderr.includes('TELEGRAM_CHAT_ID') && stderr.includes('fix:'));
    assertNoLeak(stdout + stderr, s);
  } finally {
    await vendors.close();
  }
});

test('a Telegram 408 is temporary: retried 3 times, then exit 4, not a config error', async () => {
  const s = secrets();
  const vendors = await fakeVendors(408);
  try {
    const { code, stderr } = await run(['note', '--fleet', writeFleet()], env(vendors.url, s));
    assert.equal(code, 4, stderr);
    assert.equal(vendors.calls.telegram.length, 3);
    assert.ok(!stderr.includes('fix:'));
  } finally {
    await vendors.close();
  }
});

test('a 200 that does not confirm the message (a wrong TELEGRAM_API_URL) is not resent and not pinged: exit 4', async () => {
  const s = secrets();
  const vendors = await fakeVendors(200, 200, '{"ok":true}');
  try {
    const { code, stdout, stderr } = await run(['note', '--fleet', writeFleet()], env(vendors.url, s));
    assert.equal(code, 4, stderr);
    assert.equal(vendors.calls.telegram.length, 1);
    assert.deepEqual(vendors.calls.pings, [], 'a ping would hide a note that never arrived');
    assert.ok(stderr.includes('check the chat') && stderr.includes('TELEGRAM_API_URL'));
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

test('a ping answered with 404 (an unknown check) logs an error with a fix but exits 0, since the note arrived', async () => {
  const s = secrets();
  const vendors = await fakeVendors(200, 404);
  try {
    const { code, stdout, stderr } = await run(['note', '--fleet', writeFleet()], env(vendors.url, s));
    assert.equal(code, 0, stderr);
    assert.equal(vendors.calls.telegram.length, 1);
    assert.equal(vendors.calls.pings.length, 1, 'one ping, not retried');
    assert.ok(stderr.includes('"level":"error"') && stderr.includes('HEALTHCHECKS_PING_UUID') && stderr.includes('fix:'));
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

// Value: protects=an insecure TELEGRAM_API_URL or HEALTHCHECKS_PING_URL_BASE (http to another host) exits 2 before any request, so the token and UUID never leave;
// fails_when=cli.ts reads either override without vendorBaseUrl, or checks it only after the send; why_new=the CLI refusal test covers HEALTHCHECKS_API_URL only;
// seam=none; no_claim=each refused URL shape (vendorBaseUrl unit tests own those; a local server catches any request)
test('an insecure Telegram or ping base URL exits 2 before any request, so no key leaves', async () => {
  for (const variable of ['TELEGRAM_API_URL', 'HEALTHCHECKS_PING_URL_BASE']) {
    const s = secrets();
    const vendors = await fakeVendors(200);
    try {
      const { code, stdout, stderr } = await run(['note', '--fleet', writeFleet()], { ...env(vendors.url, s), [variable]: 'http://example.com' });
      assert.equal(code, 2, `${variable}: ${stderr}`);
      assert.ok(stderr.includes('E_CONFIG_INVALID') && stderr.includes(variable), stderr);
      assert.equal(vendors.calls.checks, 0, `${variable}: healthchecks.io was read`);
      assert.equal(vendors.calls.telegram.length, 0, `${variable}: a message was sent`);
      assert.deepEqual(vendors.calls.pings, [], `${variable}: a ping was sent`);
      assertNoLeak(stdout + stderr, s);
    } finally {
      await vendors.close();
    }
  }
});

// Value: protects=a note whose text holds a key (here a fleet check name) is never posted to Telegram: exit 1, no send, no ping, no key in the log;
// fails_when=the assertNoSecrets call before sendNote is removed or moved after it; why_new=secrets.test covers assertNoSecrets alone, never the send path;
// seam=none; no_claim=how a key could reach a real note (a fleet name stands in for any source of note text)
test('a note that carries a key is never sent: exit 1, no Telegram call, no ping', async () => {
  const s = secrets();
  const dir = mkdtempSync(join(tmpdir(), 'pulseops-fleet-'));
  const fleet = join(dir, 'fleet.yaml');
  // A check missing from healthchecks.io is a problem, and a problem line names the check.
  writeFileSync(fleet, `timezone: UTC\napps:\n  - name: app-1\n    monitor: "101"\n    checks:\n      - name: worker\n        slug: app-1-worker\n      - name: ${s.botSecret}\n        slug: app-1-ghost\n`);
  const vendors = await fakeVendors(200);
  try {
    const { code, stdout, stderr } = await run(['note', '--fleet', fleet], env(vendors.url, s));
    assert.equal(code, 1, stderr);
    assert.ok(stderr.includes('E_SECRET_IN_OUTPUT') && stderr.includes('TELEGRAM_BOT_TOKEN'), stderr);
    assert.equal(vendors.calls.telegram.length, 0, 'the note was sent');
    assert.deepEqual(vendors.calls.pings, []);
    assertNoLeak(stdout + stderr, s);
  } finally {
    await vendors.close();
  }
});
