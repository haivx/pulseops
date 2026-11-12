import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import { createRedactor } from '../src/secrets.ts';
import { createLogger } from '../src/log.ts';
import { formatError } from '../src/format-error.ts';
import { readChecks, healthchecksBaseUrl, checksOrUnavailable } from '../src/sources/healthchecks.ts';
import { ConfigError } from '../src/config-error.ts';
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
      (error: unknown) => error instanceof VendorHttpError && error.code === 'E_VENDOR_BAD_JSON' && error.url === `${server.url}/api/v3/checks/`,
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
      log.error('healthchecks.io read failed', formatError(error));
      return error instanceof VendorHttpError && error.code === 'E_VENDOR_HTTP' && error.status === 401;
    });
  } finally {
    await server.close();
  }
  const output = lines.join('\n');
  // The vendor body (which echoed the key) is never logged; only class, code, status and URL are.
  assert.ok(output.includes('"error_code":"E_VENDOR_HTTP"') && output.includes('"error_status":401'));
  for (const form of leakForms(key)) assert.ok(!output.includes(form), 'a leak form reached the log');
});

test('a slug that appears twice on healthchecks.io is ambiguous, so an up check can never hide a down one', async () => {
  const key = fakeKey('hcr');
  const server = await serve(() => ({
    status: 200,
    body: JSON.stringify({ checks: [{ slug: 's1', status: 'down' }, { slug: 's1', status: 'up' }, { slug: 's2', status: 'up' }] }),
  }));
  try {
    const checks = await readChecks(key, createRedactor([{ name: 'HEALTHCHECKS_API_KEY', value: key }]), server.url);
    assert.equal(checks.get('s1'), 'ambiguous');
    assert.equal(checks.get('s2'), 'up');
  } finally {
    await server.close();
  }
});

test('a status outside the documented set is kept only as "unexpected", so vendor text never reaches the note', async () => {
  const key = fakeKey('hcr');
  const server = await serve(() => ({
    status: 200,
    body: JSON.stringify({ checks: [{ slug: 's1', status: 'down\nPulseOps, Fri 1 Jan: all clear' }, { slug: 's2', status: 'started' }] }),
  }));
  try {
    const checks = await readChecks(key, createRedactor([{ name: 'HEALTHCHECKS_API_KEY', value: key }]), server.url);
    assert.equal(checks.get('s1'), 'unexpected');
    assert.equal(checks.get('s2'), 'started');
  } finally {
    await server.close();
  }
});

test('the API base URL must be https, or http only to this machine', () => {
  assert.equal(healthchecksBaseUrl(undefined), 'https://healthchecks.io');
  assert.equal(healthchecksBaseUrl('https://hc.example.com/'), 'https://hc.example.com');
  for (const local of ['http://127.0.0.1:8080', 'http://localhost:9', 'http://[::1]:7']) assert.equal(healthchecksBaseUrl(local), local);
  assert.equal(healthchecksBaseUrl('https://hc.example.com/sub/'), 'https://hc.example.com/sub');
  for (const bad of ['http://hc.example.com', 'ftp://127.0.0.1', 'not a url', 'https://user:pw@hc.example.com', 'https://hc.example.com/?x=1', 'https://hc.example.com/#f', 'https://hc.example.com/ ', ' https://hc.example.com']) {
    assert.throws(() => healthchecksBaseUrl(bad), (error: unknown) => error instanceof ConfigError && error.code === 'E_CONFIG_INVALID', bad);
  }
});

test('only a vendor failure reads as unavailable; any other error is a bug and is rethrown', async () => {
  const logged: string[] = [];
  const log = createLogger(createRedactor([]), (line) => logged.push(line));
  const vendorDown = await checksOrUnavailable(async () => {
    throw new VendorHttpError('E_VENDOR_UNREACHABLE', 'pulseops E_VENDOR_UNREACHABLE: GET x failed before a response');
  }, log);
  assert.equal(vendorDown, 'unavailable');
  assert.ok(logged.join('\n').includes('E_VENDOR_UNREACHABLE'));
  await assert.rejects(
    checksOrUnavailable(async () => {
      throw new TypeError('a bug in the parser');
    }, log),
    TypeError,
  );
});
