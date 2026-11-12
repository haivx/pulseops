import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRedactor } from '../src/secrets.ts';
import { createLogger } from '../src/log.ts';
import { formatError } from '../src/format-error.ts';
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
      getJson(`${server.url}/api/v3/checks/?api_key=${encodeURIComponent(key)}`, { 'X-Api-Key': key }, createRedactor(secrets)),
      (error: unknown) => {
        log.error('healthchecks.io read failed', { source: 'healthchecks.io', ...formatError(error) });
        return true;
      },
    );
  } finally {
    await server.close();
  }
  const output = lines.join('\n');
  assert.ok(output.includes('E_VENDOR_HTTP'), 'the failure is logged with its code');
  assert.ok(output.includes('401'), 'the status is logged');
  assert.ok(output.includes('[REDACTED:HEALTHCHECKS_API_KEY]'), 'the key position in the URL is marked');
  for (const form of leakForms(key)) assert.ok(!output.includes(form), 'a leak form reached the log');
});

test('logger writes one JSON line per call, level and msg first, then the fields', () => {
  const lines: string[] = [];
  createLogger(createRedactor([]), (line) => lines.push(line)).info('note sent', { app_count: 3, dry_run: true, source: 'healthchecks.io' });
  assert.equal(lines.length, 1);
  assert.equal(lines[0], '{"level":"info","msg":"note sent","app_count":3,"dry_run":true,"source":"healthchecks.io"}');
});

test('a key in the message or in a field is still redacted, as the second layer', () => {
  const key = fakeKey('gh');
  const lines: string[] = [];
  createLogger(createRedactor([{ name: 'GITHUB_TOKEN', value: key }]), (line) => lines.push(line)).warn(`retrying with ${key}`, { header: `Bearer ${key}` });
  assert.ok(!lines[0]!.includes(key));
  assert.equal(lines[0]!.split('[REDACTED:GITHUB_TOKEN]').length - 1, 2);
});

test('an object, Error or array that gets past the type is dropped, never serialized', () => {
  const key = fakeKey('gh');
  const lines: string[] = [];
  const log = createLogger(createRedactor([{ name: 'GITHUB_TOKEN', value: key }]), (line) => lines.push(line));
  const smuggled = { error: new Error(`token ${key}`), body: Buffer.from(key), list: [key], boxed: new String(key), count: 2 };
  log.error('failed', smuggled as unknown as Record<string, string>);
  assert.equal(
    lines[0],
    '{"level":"error","msg":"failed","error":"[dropped: object]","body":"[dropped: object]","list":"[dropped: object]","boxed":"[dropped: object]","count":2}',
  );
});

test('a field named level or msg is renamed, so it cannot replace the real ones', () => {
  const lines: string[] = [];
  createLogger(createRedactor([]), (line) => lines.push(line)).info('real', { level: 'error', msg: 'fake' });
  assert.equal(lines[0], '{"level":"info","msg":"real","field_level":"error","field_msg":"fake"}');
});

test('the type refuses an object or Error as a field', () => {
  const log = createLogger(createRedactor([]), () => {});
  // @ts-expect-error: fields are string | number | boolean only.
  log.info('x', { error: new Error('no') });
  // @ts-expect-error: fields are string | number | boolean only.
  log.info('x', { nested: { a: 1 } });
});
