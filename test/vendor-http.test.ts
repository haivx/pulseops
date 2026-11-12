import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRedactor } from '../src/secrets.ts';
import { createLogger } from '../src/log.ts';
import { getJson, VendorHttpError } from '../src/vendor-http.ts';
import { fakeKey, leakForms } from './helpers/leaky-server.ts';

/** A one-route server that answers every request with a fixed status and body. */
async function serve(status: number, body: string): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((_req, res) => {
    res.writeHead(status);
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('server has no port');
  return { url: `http://127.0.0.1:${address.port}`, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

/** Longest prefix of `key` found in `text`; 0 when none. */
function longestPrefix(text: string, key: string): number {
  for (let n = key.length; n > 0; n--) if (text.includes(key.slice(0, n))) return n;
  return 0;
}

test('a key echoed across the detail cut leaves no prefix of it in the log', async () => {
  const key = fakeKey('hc');
  const secrets = [{ name: 'HEALTHCHECKS_API_KEY', value: key }];
  const redact = createRedactor(secrets);
  const lines: string[] = [];
  const log = createLogger(redact, (line) => lines.push(line));
  // The 500-character cut lands 20 characters into the echoed key.
  const server = await serve(401, `${'x'.repeat(480)}${key}`);
  try {
    await assert.rejects(getJson(`${server.url}/api/v3/checks/`, {}, redact), (error: unknown) => {
      log.error('read failed', { error });
      return error instanceof VendorHttpError && error.code === 'E_VENDOR_HTTP';
    });
  } finally {
    await server.close();
  }
  assert.ok(longestPrefix(lines.join('\n'), key) < 8, 'a long prefix of the key reached the log');
});

test('a redirect to another origin fails with E_VENDOR_HTTP and the key header never reaches it', async () => {
  const key = fakeKey('hc');
  const redact = createRedactor([{ name: 'HEALTHCHECKS_API_KEY', value: key }]);
  const received: string[] = [];
  const other = createServer((req, res) => {
    received.push(String(req.headers['x-api-key'] ?? ''));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve));
  const otherAddress = other.address();
  if (otherAddress === null || typeof otherAddress === 'string') throw new Error('server has no port');
  // localhost and 127.0.0.1 are different origins.
  const redirecting = createServer((_req, res) => {
    res.writeHead(302, { location: `http://localhost:${otherAddress.port}/collect` });
    res.end();
  });
  await new Promise<void>((resolve) => redirecting.listen(0, '127.0.0.1', resolve));
  const address = redirecting.address();
  if (address === null || typeof address === 'string') throw new Error('server has no port');
  try {
    await assert.rejects(
      getJson(`http://127.0.0.1:${address.port}/api/v3/checks/`, { 'X-Api-Key': key }, redact),
      (error: unknown) => error instanceof VendorHttpError && error.code === 'E_VENDOR_HTTP' && error.status === 302,
    );
  } finally {
    await new Promise<void>((resolve) => redirecting.close(() => resolve()));
    await new Promise<void>((resolve) => other.close(() => resolve()));
  }
  assert.deepEqual(received, [], 'the redirect target received a request');
});

test('a 2xx body that is not JSON fails with E_VENDOR_BAD_JSON and quotes none of the body', async () => {
  const key = fakeKey('bs');
  const redact = createRedactor([{ name: 'BETTERSTACK_API_TOKEN', value: key }]);
  const server = await serve(200, `${key} is not JSON`);
  try {
    await assert.rejects(
      getJson(`${server.url}/api/v2/monitors`, {}, redact),
      (error: unknown) =>
        error instanceof VendorHttpError && error.code === 'E_VENDOR_BAD_JSON' && longestPrefix(error.message, key) < 8,
    );
  } finally {
    await server.close();
  }
});

// Value: protects=getJson returns a 2xx JSON body parsed; fails_when=the ok branch stops parsing, returns the raw text, or treats a 200 as an error;
// why_new=every other getJson test covers a failure path only; seam=none; no_claim=real vendor payloads (local server stands in for the vendor)
test('a 2xx JSON body is returned parsed', async () => {
  const payload = { checks: [{ name: 'app-1', status: 'up' }] };
  const server = await serve(200, JSON.stringify(payload));
  try {
    assert.deepEqual(await getJson(`${server.url}/api/v3/checks/`, {}, (text) => text), payload);
  } finally {
    await server.close();
  }
});

// Value: protects=a connection failure gives E_VENDOR_UNREACHABLE and, logged, shows no form of a key in the URL query; fails_when=the fetch catch is
// removed or recoded, or the error text escapes redaction; why_new=no test reaches the fetch catch; seam=none; no_claim=DNS or timeout failures (closed local port)
test('an unreachable vendor fails with E_VENDOR_UNREACHABLE and the logged error holds no form of the key', async () => {
  const key = fakeKey('hc');
  const secrets = [{ name: 'HEALTHCHECKS_API_KEY', value: key }];
  const redact = createRedactor(secrets);
  const lines: string[] = [];
  const log = createLogger(redact, (line) => lines.push(line));
  // A port that was just free and is now closed, so nothing answers on it.
  const server = await serve(200, '{}');
  const url = server.url;
  await server.close();
  await assert.rejects(getJson(`${url}/api/v3/checks/?api_key=${encodeURIComponent(key)}`, { 'X-Api-Key': key }, redact), (error: unknown) => {
    log.error('healthchecks.io read failed', { error });
    return error instanceof VendorHttpError && error.code === 'E_VENDOR_UNREACHABLE';
  });
  const output = lines.join('\n');
  assert.ok(output.includes('E_VENDOR_UNREACHABLE'), 'the failure is logged with its code');
  assert.ok(output.includes('[REDACTED:HEALTHCHECKS_API_KEY]'), 'the key position is marked');
  for (const form of leakForms(key)) assert.ok(!output.includes(form), 'a leak form reached the log');
});
