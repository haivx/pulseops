import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import { randomBytes } from 'node:crypto';
import { createRedactor, SecretError } from '../src/secrets.ts';
import { createLogger } from '../src/log.ts';
import { formatError } from '../src/format-error.ts';
import { VendorHttpError } from '../src/vendor-http.ts';
import { readTelegramToken, telegramBotId, sendNote, splitMessage, withRetries, readPingUuid, deliveryReport, pingReport, SEND_BUDGET_MS, type DeliveryResult } from '../src/telegram.ts';
import { leakForms } from './helpers/leaky-server.ts';

const fakeToken = () => `${100000 + (randomBytes(2).readUInt16BE() % 900000)}:${randomBytes(24).toString('base64url').replace(/[^A-Za-z0-9_-]/g, 'x')}`;

/** Telegram's reply to a sent message: a message id and the chat it went to. */
const sentReply = (requestBody: string) =>
  JSON.stringify({ ok: true, result: { message_id: 7, chat: { id: Number((JSON.parse(requestBody) as { chat_id: string }).chat_id) } } });

/** A fake clock: sleep moves it forward instead of waiting. */
function clock() {
  let t = 0;
  const slept: number[] = [];
  return { now: () => t, sleep: async (ms: number) => { slept.push(ms); t += ms; }, slept };
}

function delivery(token: string, secret: string, baseUrl: string) {
  const c = clock();
  return { botId: token.split(':')[0]!, secret, chatId: '1', text: 'x', redact: (t: string) => t, baseUrl, sleep: c.sleep, now: c.now, budgetMs: SEND_BUDGET_MS };
}

/** Text that goes in exactly `n` parts: four 999-character lines fit one part, five do not. */
const longNote = (n: number) => Array.from({ length: 4 * n }, () => 'x'.repeat(999)).join('\n');

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
  const ok = await serve((_req, body) => ({ status: 200, body: sentReply(body) }));
  try {
    const result = await sendNote({ ...delivery(token, secret.value, ok.url), chatId: '-1001234', text: 'PulseOps, Thu 12 Nov: 1 problem', redact });
    assert.deepEqual(result, { kind: 'delivered', total: 1 });
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
    const result = await sendNote({ ...delivery(token, secret.value, denied.url), text: 'x', redact });
    assert.equal(result.kind, 'refused');
    assert.ok(result.kind === 'refused' && result.reason === 'token' && result.cause.status === 401);
    const report = deliveryReport(result, { apiUrlOverride: false });
    log.error(report.message, report.fields);
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
  const server = await serve((_req, body) => ({ status: 200, body: sentReply(body) }));
  const text = Array.from({ length: 90 }, (_, i) => `line ${i} ${'x'.repeat(90)}`).join('\n');
  try {
    await sendNote({ ...delivery(token, secret, server.url), text });
    const sent = server.calls.map((call) => String((JSON.parse(call.body) as { text: string }).text));
    assert.ok(sent.length > 1);
    sent.forEach((part, i) => {
      assert.ok(part.length <= 4096, `part ${i + 1} is ${part.length} characters`);
      assert.ok(part.endsWith(`(${i + 1}/${sent.length})`), `part ${i + 1} has no marker`);
    });
    server.calls.length = 0;
    await sendNote({ ...delivery(token, secret, server.url), text: 'short' });
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

test('each Telegram answer becomes one result: token, chat and request refusals, temporary errors retried', async () => {
  const token = fakeToken();
  const secret = token.split(':')[1]!;
  const cases: { status: number; expected: Partial<{ kind: string; reason: string }>; calls: number }[] = [
    { status: 401, expected: { kind: 'refused', reason: 'token' }, calls: 1 },
    { status: 404, expected: { kind: 'refused', reason: 'token' }, calls: 1 },
    { status: 403, expected: { kind: 'refused', reason: 'chat' }, calls: 1 },
    { status: 400, expected: { kind: 'refused', reason: 'request' }, calls: 1 },
    { status: 413, expected: { kind: 'refused', reason: 'request' }, calls: 1 },
    { status: 302, expected: { kind: 'refused', reason: 'redirect' }, calls: 1 },
    { status: 408, expected: { kind: 'unavailable' }, calls: 3 },
    { status: 429, expected: { kind: 'unavailable' }, calls: 3 },
    { status: 503, expected: { kind: 'unavailable' }, calls: 3 },
  ];
  for (const { status, expected, calls } of cases) {
    const server = await serve(() => ({ status, body: '{"ok":false}', headers: status === 302 ? { location: '/elsewhere' } : undefined }));
    try {
      const result = await sendNote(delivery(token, secret, server.url));
      assert.equal(result.kind, expected.kind, `status ${status}`);
      if (expected.reason !== undefined) assert.equal((result as { reason?: string }).reason, expected.reason, `status ${status}`);
      assert.equal(server.calls.length, calls, `status ${status}`);
    } finally {
      await server.close();
    }
  }
});

test('a failure after some parts went out is partial (k of n); a refusal keeps its reason and hint, an outage does not', async () => {
  const token = fakeToken();
  const secret = token.split(':')[1]!;
  const cases: [number, string | undefined, number, string | undefined][] = [
    [400, 'request', 2, 'refused the message'],
    [403, 'chat', 2, 'TELEGRAM_CHAT_ID'],
    [503, undefined, 4, undefined],
  ];
  for (const [failing, reason, exit, hint] of cases) {
    let call = 0;
    const server = await serve((_req, body) => (++call === 1 ? { status: 200, body: sentReply(body) } : { status: failing, body: '{"ok":false}' }));
    try {
      const result = await sendNote({ ...delivery(token, secret, server.url), text: longNote(3) });
      assert.equal(result.kind, 'partial', `status ${failing}`);
      assert.ok(result.kind === 'partial' && result.sent === 1 && result.total === 3);
      assert.equal(result.reason, reason, `status ${failing}`);
      const report = deliveryReport(result, { apiUrlOverride: false });
      assert.equal(report.exit, exit, `status ${failing}`);
      assert.ok(report.message.includes('1 of 3'), report.message);
      assert.ok(report.message.includes('rerun'), 'it warns that a rerun resends the parts already delivered');
      if (hint !== undefined) assert.ok(report.message.includes(hint) && report.message.includes('fix:'), report.message);
      else assert.ok(!report.message.includes('fix:'), report.message);
    } finally {
      await server.close();
    }
  }
});

test('a 2xx that does not confirm the message counts as sent and is never retried', async () => {
  const token = fakeToken();
  const secret = token.split(':')[1]!;
  const unconfirmed: [string, (body: string) => string][] = [
    ['cut-off JSON', () => '{"ok":tru'],
    ['empty body', () => ''],
    ['ok without a result', () => '{"ok":true}'],
    ['a message id that is not a whole number', () => '{"ok":true,"result":{"message_id":"7","chat":{"id":1}}}'],
    ['another chat', () => '{"ok":true,"result":{"message_id":7,"chat":{"id":2}}}'],
    ['ok false', () => '{"ok":false}'],
  ];
  for (const [label, reply] of unconfirmed) {
    const server = await serve((_req, body) => ({ status: 200, body: reply(body) }));
    try {
      const result = await sendNote(delivery(token, secret, server.url));
      assert.deepEqual(result, { kind: 'unconfirmed', sent: 1, unconfirmed: 1, total: 1 }, label);
      assert.equal(server.calls.length, 1, `${label}: retried after a 2xx`);
    } finally {
      await server.close();
    }
  }
  // In a 3-part note an unconfirmed part 2 is not resent, and part 3 still goes out.
  let call = 0;
  const server = await serve((_req, body) => ({ status: 200, body: ++call === 2 ? '' : sentReply(body) }));
  try {
    const result = await sendNote({ ...delivery(token, secret, server.url), text: longNote(3) });
    assert.deepEqual(result, { kind: 'unconfirmed', sent: 3, unconfirmed: 1, total: 3 });
    assert.equal(server.calls.length, 3);
    const report = deliveryReport(result, { apiUrlOverride: true });
    assert.equal(report.exit, 4);
    assert.ok(report.message.includes('check the chat') && report.message.includes('TELEGRAM_API_URL'), report.message);
  } finally {
    await server.close();
  }
});

test('sending stops within the time budget: no try or wait runs past it, and the result says how far it got', async () => {
  const token = fakeToken();
  const secret = token.split(':')[1]!;
  const server = await serve(() => ({ status: 429, body: '{"ok":false,"parameters":{"retry_after":30}}' }));
  try {
    const c = clock();
    const result = await sendNote({ ...delivery(token, secret, server.url), text: longNote(2), sleep: c.sleep, now: c.now, budgetMs: 50_000 });
    // Try 1 at 0 s, wait 30 s, try 2 at 30 s; a second 30 s wait plus a 10 s try would end at 70 s.
    assert.deepEqual(result, { kind: 'over-budget', sent: 0, total: 2 });
    assert.equal(server.calls.length, 2);
    assert.ok(c.now() + 10_000 <= 50_000, 'no try starts without a full request timeout left');
    assert.equal(deliveryReport(result, { apiUrlOverride: false }).exit, 4);
  } finally {
    await server.close();
  }
  assert.ok(SEND_BUDGET_MS + 2 * 10_000 <= 120_000, 'send, the checks read and the ping fit a 120 s watchdog');
});

test('one table maps every result to an exit code and a fixed message', () => {
  const cause = new VendorHttpError('E_VENDOR_HTTP', 'pulseops E_VENDOR_HTTP: m', { status: 401 });
  const rows: [DeliveryResult, number, string][] = [
    [{ kind: 'delivered', total: 2 }, 0, 'note delivered'],
    [{ kind: 'refused', reason: 'token', cause }, 2, 'TELEGRAM_BOT_TOKEN'],
    [{ kind: 'refused', reason: 'chat', cause }, 2, 'TELEGRAM_CHAT_ID'],
    [{ kind: 'refused', reason: 'request', cause }, 2, 'refused the message'],
    [{ kind: 'refused', reason: 'redirect', cause }, 2, 'TELEGRAM_API_URL'],
    [{ kind: 'unavailable', cause }, 4, 'not delivered'],
    [{ kind: 'partial', sent: 1, total: 3, cause }, 4, '1 of 3'],
    [{ kind: 'partial', sent: 1, total: 3, cause, reason: 'token' }, 2, 'TELEGRAM_BOT_TOKEN'],
    [{ kind: 'unconfirmed', sent: 2, unconfirmed: 1, total: 2 }, 4, 'check the chat'],
    [{ kind: 'over-budget', sent: 0, total: 2 }, 4, 'time'],
  ];
  for (const [result, exit, phrase] of rows) {
    const report = deliveryReport(result, { apiUrlOverride: false });
    assert.equal(report.exit, exit, result.kind);
    assert.ok(report.message.includes(phrase), `${result.kind}: ${report.message}`);
  }
  const overridden = deliveryReport({ kind: 'refused', reason: 'token', cause }, { apiUrlOverride: true });
  assert.ok(overridden.message.includes('TELEGRAM_API_URL'), 'a set override is named in the hint');
});

test('a ping refusal is an error with the UUID hint, a ping outage only a warning; neither fails the run', () => {
  const refused = pingReport(new VendorHttpError('E_VENDOR_HTTP', 'pulseops E_VENDOR_HTTP: m', { status: 404 }), { pingUrlOverride: false });
  assert.equal(refused.level, 'error');
  assert.ok(refused.message.includes('HEALTHCHECKS_PING_UUID') && refused.message.includes('fix:'));
  const down = pingReport(new VendorHttpError('E_VENDOR_HTTP', 'pulseops E_VENDOR_HTTP: m', { status: 502 }), { pingUrlOverride: false });
  assert.equal(down.level, 'warn');
  const unreachable = pingReport(new VendorHttpError('E_VENDOR_UNREACHABLE', 'pulseops E_VENDOR_UNREACHABLE: m'), { pingUrlOverride: true });
  assert.equal(unreachable.level, 'warn');
  const overridden = pingReport(new VendorHttpError('E_VENDOR_HTTP', 'pulseops E_VENDOR_HTTP: m', { status: 404 }), { pingUrlOverride: true });
  assert.ok(overridden.message.includes('HEALTHCHECKS_PING_URL_BASE'));
});

test('splitMessage cuts only between visible characters, keeps blank lines, and refuses a limit below 2', () => {
  const family = '\u{1F469}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}';
  const text = `${'a'.repeat(4078)}${family}b`;
  const parts = splitMessage(text, 4080);
  assert.ok(parts.every((part) => part.length <= 4080));
  assert.ok(parts.some((part) => part.includes(family)), 'the family emoji was split');
  assert.equal(parts.join(''), text);
  const blanks = '\n\nA\n\n\nB';
  assert.equal(splitMessage(blanks, 3).join('\n'), blanks);
  assert.equal(splitMessage(blanks).join('\n'), blanks);
  assert.throws(() => splitMessage('\u{1F600}', 1), RangeError);
});
