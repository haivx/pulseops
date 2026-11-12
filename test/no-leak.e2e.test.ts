import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fakeKey, leakForms, startLeakyServer } from './helpers/leaky-server.ts';

const fixture = fileURLToPath(new URL('./fixtures/fails-with-key.ts', import.meta.url));

function run(env: Record<string, string>): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [fixture], { env: { PATH: process.env.PATH ?? '', ...env } });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    child.on('close', (code) => resolve({ code, output }));
  });
}

test('a process failing with a real 401 exits non-zero and prints no form of the key', async () => {
  const key = fakeKey('hcr');
  const server = await startLeakyServer();
  try {
    const { code, output } = await run({ HEALTHCHECKS_API_KEY: key, VENDOR_URL: server.url });
    assert.equal(code, 1, 'unexpected failure exits 1');
    assert.ok(output.includes('E_VENDOR_HTTP'), `missing error code in: ${output.slice(0, 200)}`);
    assert.ok(output.includes('[REDACTED:HEALTHCHECKS_API_KEY]'));
    for (const form of leakForms(key)) assert.ok(!output.includes(form), 'a leak form reached stdout or stderr');
  } finally {
    await server.close();
  }
});

test('a process with the key missing exits 2 and names the variable', async () => {
  const { code, output } = await run({ VENDOR_URL: 'http://127.0.0.1:9' });
  assert.equal(code, 2);
  assert.ok(output.includes('E_CONFIG_MISSING'));
  assert.ok(output.includes('HEALTHCHECKS_API_KEY'));
});
