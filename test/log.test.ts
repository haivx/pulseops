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
      getJson(`${server.url}/api/v3/checks/?api_key=${encodeURIComponent(key)}`, { 'X-Api-Key': key }, createRedactor(secrets)),
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

test('logger redacts a key held in a Buffer or Uint8Array field', () => {
  const key = fakeKey('gh');
  const lines: string[] = [];
  const log = createLogger(createRedactor([{ name: 'GITHUB_TOKEN', value: key }]), (line) => lines.push(line));
  log.error('request failed', { body: Buffer.from(`token=${key}`), raw: new TextEncoder().encode(key) });
  const output = lines.join('\n');
  assert.ok(!output.includes(key));
  assert.ok(!output.includes([...Buffer.from(key)].join(',')), 'the key leaked as a byte array');
  assert.equal(output.split('[REDACTED:GITHUB_TOKEN]').length - 1, 2);
});

test('logger keeps the original error when its cause is circular, and never throws', () => {
  const lines: string[] = [];
  const log = createLogger(createRedactor([]), (line) => lines.push(line));
  const cause: Record<string, unknown> = { step: 'fetch' };
  cause.self = cause;
  assert.doesNotThrow(() => log.error('failed', { error: new Error('vendor failed', { cause }), count: 10n }));
  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]!) as { error: { message: string }; count: string };
  assert.equal(entry.error.message, 'vendor failed');
  assert.equal(entry.count, '10');
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

test('an object referenced twice is written in full both times; only a true cycle is [Circular]', () => {
  const lines: string[] = [];
  const log = createLogger(createRedactor([]), (line) => lines.push(line));
  const shared = { app: 'app-1' };
  const cycle: Record<string, unknown> = { step: 'fetch' };
  cycle.self = cycle;
  log.info('x', { a: shared, b: shared, cycle });
  const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
  assert.deepEqual(entry.a, shared);
  assert.deepEqual(entry.b, shared);
  assert.deepEqual(entry.cycle, { step: 'fetch', self: '[Circular]' });
});

test('a field named level or msg cannot overwrite the real ones', () => {
  const lines: string[] = [];
  createLogger(createRedactor([]), (line) => lines.push(line)).info('real', { level: 'error', msg: 'fake' });
  const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
  assert.equal(entry.level, 'info');
  assert.equal(entry.msg, 'real');
});

test('logger never throws when a field cannot be serialized, even if the error is hostile', () => {
  const lines: string[] = [];
  const log = createLogger(createRedactor([]), (line) => lines.push(line));
  assert.doesNotThrow(() => log.error('failed', { bad: { toJSON() { throw new Error('boom'); } } }));
  assert.deepEqual(JSON.parse(lines[0]!), { level: 'error', msg: 'failed', serialization_error: 'boom' });
  const hostile = { toJSON() { throw { get message(): string { throw new Error('nested'); } }; } };
  assert.doesNotThrow(() => log.error('failed again', { hostile }));
  assert.equal((JSON.parse(lines[1]!) as Record<string, unknown>).msg, 'failed again');
});

test('a deeply nested value is cut, not lost: the other fields still land', () => {
  const lines: string[] = [];
  const log = createLogger(createRedactor([]), (line) => lines.push(line));
  log.info('ok', { body: JSON.parse(`${'['.repeat(6000)}${']'.repeat(6000)}`), app: 'app-1' });
  const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
  assert.equal(entry.app, 'app-1');
  assert.ok(lines[0]!.includes('[Depth]'));
  assert.equal(entry.serialization_error, undefined);
});
