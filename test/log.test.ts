import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRedactor } from '../src/secrets.ts';
import { createLogger } from '../src/log.ts';
import { getJson } from '../src/vendor-http.ts';
import { fakeKey, leakForms, startLeakyServer } from './helpers/leaky-server.ts';

test('a real 401 from a vendor that echoes the key never reaches the log', async () => {
  const key = fakeKey('hc');
  const secrets = [{ name: 'HEALTHCHECKS_API_KEY', value: key }];
  const lines: string[] = [];
  const log = createLogger(createRedactor(secrets), (line) => lines.push(line));
  const server = await startLeakyServer();
  try {
    await assert.rejects(
      getJson(`${server.url}/api/v3/checks/?api_key=${encodeURIComponent(key)}`, { 'X-Api-Key': key }),
      (error: unknown) => {
        log.error('healthchecks.io read failed', { source: 'healthchecks.io', error });
        return true;
      },
    );
  } finally {
    await server.close();
  }
  const output = lines.join('\n');
  assert.ok(output.includes('E_VENDOR_HTTP'), 'the failure is logged with its code');
  assert.ok(output.includes('401'), 'the status is logged');
  assert.ok(output.includes('[REDACTED:HEALTHCHECKS_API_KEY]'), 'the key position is marked');
  for (const form of leakForms(key)) assert.ok(!output.includes(form), 'a leak form reached the log');
});

test('logger redacts the message, nested fields, and an error cause and stack', () => {
  const key = fakeKey('gh');
  const lines: string[] = [];
  const log = createLogger(createRedactor([{ name: 'GITHUB_TOKEN', value: key }]), (line) => lines.push(line));
  const cause = new Error(`token ${key} rejected`);
  log.warn(`retrying with ${key}`, { request: { headers: { authorization: `Bearer ${key}` } }, error: new Error('outer', { cause }) });
  const output = lines.join('\n');
  assert.ok(!output.includes(key));
  assert.ok(output.includes('outer'));
  assert.ok(output.includes('rejected'));
});

test('logger writes one JSON line per call with level and message', () => {
  const lines: string[] = [];
  const log = createLogger(createRedactor([]), (line) => lines.push(line));
  log.info('note sent', { app_count: 3 });
  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
  assert.equal(entry.level, 'info');
  assert.equal(entry.msg, 'note sent');
  assert.equal(entry.app_count, 3);
});
