import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatError } from '../src/format-error.ts';
import { ConfigError } from '../src/config-error.ts';
import { SecretError } from '../src/secrets.ts';
import { VendorHttpError } from '../src/vendor-http.ts';

test('a vendor error gives its class, code, status, our own message and the redacted URL, and no vendor body', () => {
  const error = new VendorHttpError('E_VENDOR_HTTP', 'pulseops E_VENDOR_HTTP: GET https://hc.example.com/api/v3/checks/?k=[REDACTED:K] returned 401', {
    status: 401,
    url: 'https://hc.example.com/api/v3/checks/?k=[REDACTED:K]',
  });
  assert.deepEqual(formatError(error), {
    error_class: 'VendorHttpError',
    error_code: 'E_VENDOR_HTTP',
    error_message: 'pulseops E_VENDOR_HTTP: GET https://hc.example.com/api/v3/checks/?k=[REDACTED:K] returned 401',
    error_status: 401,
    error_url: 'https://hc.example.com/api/v3/checks/?k=[REDACTED:K]',
  });
});

test('a vendor error that was never answered has no status field', () => {
  const error = new VendorHttpError('E_VENDOR_UNREACHABLE', 'pulseops E_VENDOR_UNREACHABLE: GET https://x failed before a response', {
    url: 'https://x',
    cause: new TypeError('fetch failed: secret-ish library text'),
  });
  const fields = formatError(error);
  assert.equal(fields.error_status, undefined);
  assert.ok(!JSON.stringify(fields).includes('library text'), 'the cause from a library was written');
});

test('our own config and secret errors give class, code and message', () => {
  assert.deepEqual(formatError(new ConfigError('pulseops E_CONFIG_INVALID: bad; fix: x')), {
    error_class: 'ConfigError',
    error_code: 'E_CONFIG_INVALID',
    error_message: 'pulseops E_CONFIG_INVALID: bad; fix: x',
  });
  assert.equal(formatError(new SecretError('E_SECRET_IN_OUTPUT', 'pulseops E_SECRET_IN_OUTPUT: m')).error_code, 'E_SECRET_IN_OUTPUT');
});

test('an error from anywhere else gives only its class: no message, stack or cause', () => {
  const error = new TypeError('Cannot read properties of undefined (library internals)', { cause: new Error('deeper') });
  assert.deepEqual(formatError(error), { error_class: 'TypeError' });
});

test('a thrown value that is not an Error gives only its type', () => {
  assert.deepEqual(formatError('a thrown string with content'), { error_class: 'string' });
  assert.deepEqual(formatError({ token: 'x' }), { error_class: 'object' });
  assert.deepEqual(formatError(null), { error_class: 'null' });
  assert.deepEqual(formatError(undefined), { error_class: 'undefined' });
});
