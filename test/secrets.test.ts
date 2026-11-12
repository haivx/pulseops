import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSecret, createRedactor, assertNoSecrets, SecretError } from '../src/secrets.ts';
import { randomBytes } from 'node:crypto';
import { fakeKey, leakForms } from './helpers/leaky-server.ts';

test('readSecret returns the value of the named environment variable', () => {
  const key = fakeKey();
  assert.equal(readSecret({ HEALTHCHECKS_API_KEY: key }, 'HEALTHCHECKS_API_KEY').value, key);
});

test('readSecret names a missing variable without inventing a value', () => {
  assert.throws(
    () => readSecret({}, 'HEALTHCHECKS_API_KEY'),
    (error: unknown) =>
      error instanceof SecretError && error.code === 'E_CONFIG_MISSING' && error.message.includes('HEALTHCHECKS_API_KEY'),
  );
});

test('readSecret rejects a value too short to redact safely, without echoing it', () => {
  assert.throws(
    () => readSecret({ BETTERSTACK_API_TOKEN: 'short-value' }, 'BETTERSTACK_API_TOKEN'),
    (error: unknown) =>
      error instanceof SecretError && error.code === 'E_CONFIG_INVALID' && !error.message.includes('short-value'),
  );
});

test('redactor replaces raw, URL-encoded and base64 forms of every secret', () => {
  const a = fakeKey('hc');
  const b = fakeKey('gh');
  const redact = createRedactor([
    { name: 'HEALTHCHECKS_API_KEY', value: a },
    { name: 'GITHUB_TOKEN', value: b },
  ]);
  const text = [...leakForms(a), ...leakForms(b)].join(' | ');
  const out = redact(text);
  for (const form of [...leakForms(a), ...leakForms(b)]) assert.ok(!out.includes(form), 'a leak form survived');
  assert.ok(out.includes('[REDACTED:HEALTHCHECKS_API_KEY]'));
  assert.ok(out.includes('[REDACTED:GITHUB_TOKEN]'));
});

test('readSecret rejects characters that JSON or URL encoding would change, without echoing the value', () => {
  const value = `${fakeKey()}"x`;
  assert.throws(
    () => readSecret({ GITHUB_TOKEN: value }, 'GITHUB_TOKEN'),
    (error: unknown) => error instanceof SecretError && error.code === 'E_CONFIG_INVALID' && !error.message.includes(value),
  );
});

test('createRedactor refuses a secret too short to redact safely', () => {
  assert.throws(() => createRedactor([{ name: 'EMPTY', value: '' }]), SecretError);
});

test('redactor finds HTTP Basic credentials glued to a path or other text', () => {
  const key = fakeKey('bs');
  const redact = createRedactor([{ name: 'BETTERSTACK_API_TOKEN', value: key }]);
  const basic = Buffer.from(`user:${key}`).toString('base64');
  for (const text of [`GET /proxy/${basic}`, `ab${basic}`, `xyz${basic}`]) {
    assert.ok(redact(text).includes('[REDACTED:BETTERSTACK_API_TOKEN]'), 'a glued Basic credential was missed');
  }
});

test('redactor leaves text without secrets unchanged', () => {
  const redact = createRedactor([{ name: 'GITHUB_TOKEN', value: fakeKey() }]);
  assert.equal(redact('deploy failed for app-1'), 'deploy failed for app-1');
});

test('assertNoSecrets passes a clean database row', () => {
  const secrets = [{ name: 'GITHUB_TOKEN', value: fakeKey() }];
  assert.doesNotThrow(() => assertNoSecrets({ app: 'app-1', status: 'ok' }, secrets, 'note_runs row'));
});

test('assertNoSecrets blocks a database row that carries a key, and names it without the value', () => {
  const key = fakeKey();
  const secrets = [{ name: 'GITHUB_TOKEN', value: key }];
  const row = { app: 'app-1', last_error: { detail: `request to /repos?access_token=${encodeURIComponent(key)} failed` } };
  assert.throws(
    () => assertNoSecrets(row, secrets, 'note_runs row'),
    (error: unknown) =>
      error instanceof SecretError &&
      error.code === 'E_SECRET_IN_OUTPUT' &&
      error.message.includes('GITHUB_TOKEN') &&
      error.message.includes('note_runs row') &&
      !error.message.includes(key),
  );
});

test('assertNoSecrets blocks a key inside an Error, a Map, a Set or a Buffer', () => {
  const key = fakeKey();
  const secrets = [{ name: 'GITHUB_TOKEN', value: key }];
  const rows = [
    { last_error: new Error(`token ${key} rejected`) },
    { meta: new Map([['token', key]]) },
    { tags: new Set([key]) },
    { body: Buffer.from(key) },
  ];
  for (const row of rows) assert.throws(() => assertNoSecrets(row, secrets, 'note_runs row'), SecretError);
});

test('assertNoSecrets blocks a key in any Error property, an AggregateError, or a deep cause chain', () => {
  const key = fakeKey();
  const secrets = [{ name: 'GITHUB_TOKEN', value: key }];
  const withConfig = Object.assign(new Error('request failed'), { config: { headers: { 'X-Api-Key': key } } });
  const aggregate = new AggregateError([new Error(`token ${key} rejected`)], 'all requests failed');
  let deep = new Error(`token ${key} rejected`);
  for (let i = 0; i < 7; i++) deep = new Error(`wrapper ${i}`, { cause: deep });
  for (const error of [withConfig, aggregate, deep]) {
    assert.throws(() => assertNoSecrets({ last_error: error }, secrets, 'note_runs row'), SecretError);
  }
});

test('readSecret accepts + / = . ~ - and the redactor removes every escaped form of such a key', () => {
  const key = `${randomBytes(18).toString('base64')}.~-+/=`;
  assert.equal(readSecret({ K: key }, 'K').value, key);
  const lowerPercent = (text: string) => text.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase());
  const jsonSlash = key.replaceAll('/', '\\/');
  const searchParam = new URLSearchParams({ k: key }).toString().slice('k='.length);
  const forms = [
    key,
    encodeURIComponent(key),
    lowerPercent(encodeURIComponent(key)),
    jsonSlash,
    JSON.stringify(jsonSlash).slice(1, -1),
    searchParam,
    lowerPercent(searchParam),
  ];
  const out = createRedactor([{ name: 'K', value: key }])(forms.join(' | '));
  for (const form of forms) assert.ok(!out.includes(form), 'an escaped form of the key survived');
  assert.equal(out.split('[REDACTED:K]').length - 1, forms.length);
});

test('assertNoSecrets blocks an LLM prompt that carries a key', () => {
  const key = fakeKey();
  const secrets = [{ name: 'BETTERSTACK_API_TOKEN', value: key }];
  const prompt = `Summarize this error: Authorization: Bearer ${key}`;
  assert.throws(() => assertNoSecrets(prompt, secrets, 'LLM prompt'), SecretError);
});
