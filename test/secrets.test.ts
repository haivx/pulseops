import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSecret, createRedactor, assertNoSecrets, SecretError } from '../src/secrets.ts';
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

test('assertNoSecrets blocks an LLM prompt that carries a key', () => {
  const key = fakeKey();
  const secrets = [{ name: 'BETTERSTACK_API_TOKEN', value: key }];
  const prompt = `Summarize this error: Authorization: Bearer ${key}`;
  assert.throws(() => assertNoSecrets(prompt, secrets, 'LLM prompt'), SecretError);
});
