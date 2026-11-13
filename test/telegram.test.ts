import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import { randomBytes } from 'node:crypto';
import { createRedactor, SecretError } from '../src/secrets.ts';
import { createLogger } from '../src/log.ts';
import { formatError } from '../src/format-error.ts';
import { VendorHttpError } from '../src/vendor-http.ts';
import { readTelegramToken, telegramBotId, sendNote, splitMessage, withRetries, readPingUuid } from '../src/telegram.ts';
import { leakForms } from './helpers/leaky-server.ts';

const fakeToken = () => `${100000 + (randomBytes(2).readUInt16BE() % 900000)}:${randomBytes(24).toString('base64url').replace(/[^A-Za-z0-9_-]/g, 'x')}`;

async function serve(handler: (req: IncomingMessage, body: string) => { status: number; body: string; headers?: Record<string, string> }) {
  const calls: { url: string; body: string }[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      calls.push({ url: req.url ?? '', body });
      const out = handler(req, body);
      res.writeHead(out.status, { 'content-type': 'application/json', ...out.headers });
      res.end(out.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('server has no port');
  return { url: `http://127.0.0.1:${address.port}`, calls, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

test('the bot token is split: only the part after the colon is a secret, and the bot id is digits', () => {
  const token = fakeToken();
  const [id, secret] = token.split(':') as [string, string];
  assert.deepEqual(readTelegramToken({ TELEGRAM_BOT_TOKEN: token }), { name: 'TELEGRAM_BOT_TOKEN', value: secret });
  assert.equal(telegramBotId({ TELEGRAM_BOT_TOKEN: token }), id);
});

test('a malformed bot token is refused without echoing it', () => {
  for (const bad of ['abc:xyz', 'no-colon-at-all-here-xxxxxxxxxx', `12345:short`, `12a45:${'x'.repeat(30)}`, `12345:${'x'.repeat(30)}+`]) {
    assert.throws(
      () => readTelegramToken({ TELEGRAM_BOT_TOKEN: bad }),
      (error: unknown) => error instanceof SecretError && error.code === 'E_CONFIG_INVALID' && !error.message.includes(bad),
      bad,
    );
  }
  assert.throws(() => readTelegramToken({}), (error: unknown) => error instanceof SecretError && error.code === 'E_CONFIG_MISSING');
});

test('a long message is split at line breaks into parts of at most 4096 characters', () => {
  const line = 'x'.repeat(100);
  const text = Array.from({ length: 100 }, () => line).join('\n');
  const parts = splitMessage(text);
  assert.ok(parts.length > 1);
  for (const part of parts) assert.ok(part.length <= 4096);
  assert.equal(parts.join('\n'), text);
  const oneLong = 'y'.repeat(9000);
  assert.ok(splitMessage(oneLong).every((part) => part.length <= 4096));
  assert.equal(splitMessage(oneLong).join(''), oneLong);
});

test('sendNote posts plain text with no parse_mode to the bot URL, and an error writes no part of the token', async () => {
  const token = fakeToken();
  const secret = { name: 'TELEGRAM_BOT_TOKEN', value: token.split(':')[1]! };
  const redact = createRedactor([secret]);
  const ok = await serve(() => ({ status: 200, body: '{"ok":true,"result":{}}' }));
  try {
    await sendNote({ botId: token.split(':')[0]!, secret: secret.value, chatId: '-1001234', text: 'PulseOps, Thu 12 Nov: 1 problem', redact, baseUrl: ok.url, sleep: async () => {} });
    assert.equal(ok.calls.length, 1);
    assert.equal(ok.calls[0]!.url, `/bot${token}/sendMessage`);
    assert.deepEqual(JSON.parse(ok.calls[0]!.body), { chat_id: '-1001234', text: 'PulseOps, Thu 12 Nov: 1 problem', disable_web_page_preview: true });
  } finally {
    await ok.close();
  }
  const lines: string[] = [];
  const log = createLogger(redact, (line) => lines.push(line));
  const denied = await serve(() => ({ status: 401, body: `{"ok":false,"description":"Unauthorized ${token}"}` }));
  try {
    await assert.rejects(
      sendNote({ botId: token.split(':')[0]!, secret: secret.value, chatId: '1', text: 'x', redact, baseUrl: denied.url, sleep: async () => {} }),
      (error: unknown) => {
        log.error('telegram send failed', formatError(error));
        return error instanceof VendorHttpError && error.status === 401;
      },
    );
    assert.equal(denied.calls.length, 1, 'a 401 must not be retried');
  } finally {
    await denied.close();
  }
  for (const form of leakForms(secret.value)) assert.ok(!lines.join('\n').includes(form), 'a form of the token secret reached the log');
});

test('retries: 5xx and unreachable are retried up to 3 tries, 429 waits retry_after (capped), other 4xx is not', async () => {
  const waits: number[] = [];
  const sleep = async (ms: number) => {
    waits.push(ms);
  };
  let calls = 0;
  const fail = (code: VendorHttpError['code'], status?: number, retryAfter?: number) =>
    new VendorHttpError(code, `pulseops ${code}: m`, { status, retryAfter });

  calls = 0;
  await withRetries(async () => {
    calls += 1;
    if (calls < 3) throw fail('E_VENDOR_HTTP', 502);
  }, sleep);
  assert.equal(calls, 3);

  calls = 0;
  waits.length = 0;
  await withRetries(async () => {
    calls += 1;
    if (calls === 1) throw fail('E_VENDOR_HTTP', 429, 120);
  }, sleep);
  assert.equal(calls, 2);
  assert.deepEqual(waits, [30_000], 'retry_after is capped at 30 seconds');

  calls = 0;
  await assert.rejects(
    withRetries(async () => {
      calls += 1;
      throw fail('E_VENDOR_UNREACHABLE');
    }, sleep),
  );
  assert.equal(calls, 3);

  calls = 0;
  await assert.rejects(
    withRetries(async () => {
      calls += 1;
      throw fail('E_VENDOR_HTTP', 400);
    }, sleep),
  );
  assert.equal(calls, 1);
});

test('splitMessage never cuts an emoji (a surrogate pair) in half', () => {
  const text = `${'a'.repeat(4095)}😀b`;
  const parts = splitMessage(text);
  const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  assert.ok(parts.every((part) => !loneSurrogate.test(part) && part.length <= 4096));
  assert.equal(parts.join(''), text);
});

test('a note sent in several parts marks each part (i/n), and every part stays within 4096 characters', async () => {
  const token = fakeToken();
  const secret = token.split(':')[1]!;
  const server = await serve(() => ({ status: 200, body: '{"ok":true,"result":{}}' }));
  const text = Array.from({ length: 90 }, (_, i) => `line ${i} ${'x'.repeat(90)}`).join('\n');
  try {
    await sendNote({ botId: token.split(':')[0]!, secret, chatId: '1', text, redact: (t) => t, baseUrl: server.url, sleep: async () => {} });
    const sent = server.calls.map((call) => String((JSON.parse(call.body) as { text: string }).text));
    assert.ok(sent.length > 1);
    sent.forEach((part, i) => {
      assert.ok(part.length <= 4096, `part ${i + 1} is ${part.length} characters`);
      assert.ok(part.endsWith(`(${i + 1}/${sent.length})`), `part ${i + 1} has no marker`);
    });
    server.calls.length = 0;
    await sendNote({ botId: token.split(':')[0]!, secret, chatId: '1', text: 'short', redact: (t) => t, baseUrl: server.url, sleep: async () => {} });
    assert.equal((JSON.parse(server.calls[0]!.body) as { text: string }).text, 'short', 'a single part has no marker');
  } finally {
    await server.close();
  }
});

test('the ping UUID must look like a UUID, and is refused without echoing it', () => {
  const uuid = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
  assert.deepEqual(readPingUuid({ HEALTHCHECKS_PING_UUID: uuid }), { name: 'HEALTHCHECKS_PING_UUID', value: uuid });
  for (const bad of ['app-1-worker-slug-not-a-uuid', '3f2504e0-4f89-11d3-9a0c-0305e82c330', `${uuid}x`]) {
    assert.throws(
      () => readPingUuid({ HEALTHCHECKS_PING_UUID: bad }),
      (error: unknown) => error instanceof SecretError && error.code === 'E_CONFIG_INVALID' && !error.message.includes(bad),
      bad,
    );
  }
});
