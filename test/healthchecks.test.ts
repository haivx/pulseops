import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import { createRedactor } from '../src/secrets.ts';
import { createLogger } from '../src/log.ts';
import { readChecks } from '../src/sources/healthchecks.ts';
import { VendorHttpError } from '../src/vendor-http.ts';
import { fakeKey, leakForms } from './helpers/leaky-server.ts';

async function serve(handler: (req: IncomingMessage) => { status: number; body: string }) {
  const server = createServer((req, res) => {
    const { status, body } = handler(req);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('server has no port');
  return { url: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

test('readChecks sends the key header to /api/v3/checks/ and maps each slug to its status', async () => {
  const key = fakeKey('hcr');
  let seen: { path?: string; key?: string } = {};
  const server = await serve((req) => {
    seen = { path: req.url, key: String(req.headers['x-api-key']) };
    return {
      status: 200,
      body: JSON.stringify({
        checks: [
          { name: 'Worker', slug: 'app-1-worker', status: 'up', unique_key: 'u1', n_pings: 5 },
          { name: 'No slug', slug: '', status: 'down' },
          { name: 'Cron', slug: 'app-1-cron', status: 'new' },
        ],
      }),
    };
  });
  try {
    const checks = await readChecks(key, createRedactor([{ name: 'HEALTHCHECKS_API_KEY', value: key }]), server.url);
    assert.deepEqual([...checks.entries()], [
      ['app-1-worker', 'up'],
      ['app-1-cron', 'new'],
    ]);
    assert.equal(seen.path, '/api/v3/checks/');
    assert.equal(seen.key, key);
  } finally {
    await server.close();
  }
});

test('a body that is not the expected shape fails as E_VENDOR_BAD_JSON instead of reading as no checks', async () => {
  const key = fakeKey('hcr');
  const server = await serve(() => ({ status: 200, body: JSON.stringify({ error: 'nope' }) }));
  try {
    await assert.rejects(
      readChecks(key, createRedactor([{ name: 'HEALTHCHECKS_API_KEY', value: key }]), server.url),
      (error: unknown) => error instanceof VendorHttpError && error.code === 'E_VENDOR_BAD_JSON',
    );
  } finally {
    await server.close();
  }
});

test('a 401 that echoes the key fails as E_VENDOR_HTTP and, logged, shows no form of the key', async () => {
  const key = fakeKey('hcr');
  const redact = createRedactor([{ name: 'HEALTHCHECKS_API_KEY', value: key }]);
  const lines: string[] = [];
  const log = createLogger(redact, (line) => lines.push(line));
  const server = await serve((req) => ({ status: 401, body: JSON.stringify({ error: 'bad key', got: req.headers['x-api-key'] }) }));
  try {
    await assert.rejects(readChecks(key, redact, server.url), (error: unknown) => {
      log.error('healthchecks.io read failed', { error });
      return error instanceof VendorHttpError && error.code === 'E_VENDOR_HTTP' && error.status === 401;
    });
  } finally {
    await server.close();
  }
  const output = lines.join('\n');
  assert.ok(output.includes('[REDACTED:HEALTHCHECKS_API_KEY]'));
  for (const form of leakForms(key)) assert.ok(!output.includes(form), 'a leak form reached the log');
});
