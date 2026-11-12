import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fakeKey, leakForms, startLeakyServer } from './helpers/leaky-server.ts';

const fixture = fileURLToPath(new URL('./fixtures/fails-with-key.ts', import.meta.url));
const uncaughtFixture = fileURLToPath(new URL('./fixtures/uncaught-with-key.ts', import.meta.url));

/** A process that has not exited by then is hung; it is killed and reports code null. */
const HANG_LIMIT_MS = 5000;

function run(env: Record<string, string>, script = fixture): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], { env: { PATH: process.env.PATH ?? '', ...env } });
    const timer = setTimeout(() => child.kill('SIGKILL'), HANG_LIMIT_MS);
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

for (const mode of ['timer', 'reject', 'floating']) {
  test(`a ${mode} failure with an open handle exits 1 promptly and prints no form of the key`, async () => {
    const key = fakeKey('hcu');
    const { code, output } = await run({ HEALTHCHECKS_API_KEY: key, FAIL_MODE: mode }, uncaughtFixture);
    assert.equal(code, 1, 'the process must exit 1, not hang');
    // A plain Error's message is never written, so the key in it cannot be either.
    assert.ok(output.includes('"msg":"unexpected failure"') && output.includes('"error_class":"Error"'));
    for (const form of leakForms(key)) assert.ok(!output.includes(form), 'a leak form reached stdout or stderr');
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

// On Linux a pipe write is synchronous, so a full pipe blocks the process
// before any timer can run; the 2-second fallback only helps where pipe
// writes are asynchronous (macOS, Windows).
test('a failure while stderr is full still exits 1 within 5 seconds', { skip: process.platform === 'linux' ? 'pipe writes block on Linux' : false }, async () => {
  const child = spawn(process.execPath, [uncaughtFixture], {
    env: { PATH: process.env.PATH ?? '', HEALTHCHECKS_API_KEY: fakeKey('hcs'), FAIL_MODE: 'stall' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), HANG_LIMIT_MS);
  const code = await new Promise<number | null>((resolve) => child.on('exit', (exitCode) => resolve(exitCode)));
  clearTimeout(timer);
  child.stderr?.destroy();
  assert.equal(code, 1, 'the process must exit 1, not hang on a full stderr');
});
