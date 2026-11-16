import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import { createRedactor } from '../src/secrets.ts';
import { createLogger } from '../src/log.ts';
import { readMonitor, monitorsOrUnavailable, betterstackBaseUrl, BETTERSTACK_DEFAULT_URL } from '../src/sources/betterstack.ts';
import { ConfigError } from '../src/config-error.ts';
import type { Fleet } from '../src/fleet.ts';
import { fakeKey, leakForms } from './helpers/leaky-server.ts';

const now = new Date('2026-11-12T01:00:00Z');
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString();

type Reply = { status: number; body: unknown; headers?: Record<string, string> };

async function serve(handler: (req: IncomingMessage, url: URL) => Reply) {
  const seen: { path: string; auth: string | undefined }[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    seen.push({ path: req.url ?? '', auth: req.headers.authorization });
    const out = handler(req, url);
    res.writeHead(out.status, { 'content-type': 'application/json', ...out.headers });
    res.end(typeof out.body === 'string' ? out.body : JSON.stringify(out.body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('server has no port');
  return { url: `http://127.0.0.1:${address.port}`, seen, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

const monitorReply = (status: string): Reply => ({ status: 200, body: { data: { id: '7', type: 'monitor', attributes: { status, url: 'https://app.example' } } } });
const incident = (id: string, monitor: string, startedAt: string | null, resolvedAt: string | null) => ({
  id,
  type: 'incident',
  attributes: { started_at: startedAt, resolved_at: resolvedAt, cause: 'Timeout' },
  relationships: { monitor: { data: { id: monitor, type: 'monitor' } } },
});
const incidentsReply = (data: unknown[], next: string | null = null): Reply => ({ status: 200, body: { data, pagination: { first: 'x', last: 'x', prev: null, next } } });

function vendor(monitor: Reply, incidents: Reply) {
  return (_req: IncomingMessage, url: URL): Reply => (url.pathname.startsWith('/api/v2/monitors/') ? monitor : url.pathname === '/api/v3/incidents' ? incidents : { status: 404, body: {} });
}

test('readMonitor sends the token as a Bearer header to the monitor and its incidents, filtered by monitor and a date window', async () => {
  const token = fakeKey('bst');
  const server = await serve(vendor(monitorReply('up'), incidentsReply([])));
  try {
    const reading = await readMonitor(token, '7', (t) => t, server.url, now);
    assert.deepEqual(reading, { status: 'up', incidents: [] });
    assert.equal(server.seen.length, 2);
    assert.ok(server.seen.every((s) => s.auth === `Bearer ${token}`));
    assert.ok(server.seen.some((s) => s.path === '/api/v2/monitors/7'));
    const list = new URL(server.seen.find((s) => s.path.startsWith('/api/v3/incidents'))!.path, 'http://x');
    // now - 48 h to now + 24 h in UTC dates, so any time zone the filter uses covers the last 24 hours.
    assert.deepEqual(Object.fromEntries(list.searchParams), { monitor_id: '7', from: '2026-11-10', to: '2026-11-13', per_page: '50', page: '1' });
    assert.ok(!server.seen.some((s) => s.path.includes(token)), 'the token never goes into a URL');
  } finally {
    await server.close();
  }
});

test('incidents keep their start and end, skip unconfirmed ones and any for another monitor', async () => {
  const server = await serve(
    vendor(
      monitorReply('down'),
      incidentsReply([
        incident('1', '7', hoursAgo(2), null),
        incident('2', '7', hoursAgo(30), hoursAgo(29)),
        incident('3', '7', null, null),
        incident('4', '8', hoursAgo(1), null),
        { id: '5', type: 'incident', attributes: { started_at: 'not a date', resolved_at: null }, relationships: { monitor: { data: { id: '7' } } } },
      ]),
    ),
  );
  try {
    const reading = await readMonitor(fakeKey('bst'), '7', (t) => t, server.url, now);
    assert.deepEqual(reading, {
      status: 'down',
      incidents: [
        { startedAt: Date.parse(hoursAgo(2)), resolvedAt: undefined },
        { startedAt: Date.parse(hoursAgo(30)), resolvedAt: Date.parse(hoursAgo(29)) },
      ],
    });
  } finally {
    await server.close();
  }
});

test('a status outside the documented set is "unexpected", so vendor text never reaches the note', async () => {
  for (const status of ['validating', 'paused', 'pending', 'maintenance']) {
    const server = await serve(vendor(monitorReply(status), incidentsReply([])));
    try {
      assert.equal((await readMonitor(fakeKey('bst'), '7', (t) => t, server.url, now)).status, status);
    } finally {
      await server.close();
    }
  }
  const odd = await serve(vendor(monitorReply('Up <b>now</b>'), incidentsReply([])));
  try {
    assert.equal((await readMonitor(fakeKey('bst'), '7', (t) => t, odd.url, now)).status, 'unexpected');
  } finally {
    await odd.close();
  }
});

test('a 404 on the monitor is "missing", not a source outage', async () => {
  const server = await serve(vendor({ status: 404, body: { errors: 'Resource with provided ID was not found' } }, incidentsReply([])));
  try {
    assert.deepEqual(await readMonitor(fakeKey('bst'), '7', (t) => t, server.url, now), { status: 'missing', incidents: [] });
  } finally {
    await server.close();
  }
});

test('a second page of incidents is never fetched: the vendor next URL is ignored and the app reads "too-many"', async () => {
  const server = await serve(vendor(monitorReply('up'), incidentsReply([incident('1', '7', hoursAgo(1), hoursAgo(1))], 'http://127.0.0.1:1/api/v3/incidents?page=2')));
  try {
    assert.deepEqual(await readMonitor(fakeKey('bst'), '7', (t) => t, server.url, now), { status: 'too-many', incidents: [] });
    assert.equal(server.seen.length, 2, 'only the two URLs PulseOps built were requested');
  } finally {
    await server.close();
  }
});

test('a body of the wrong shape fails instead of reading as up or as no incidents', async () => {
  for (const [monitor, incidents] of [
    [{ status: 200, body: { data: [] } }, incidentsReply([])],
    [monitorReply('up'), { status: 200, body: { data: 'nope' } }],
  ] as [Reply, Reply][]) {
    const server = await serve(vendor(monitor, incidents));
    try {
      await assert.rejects(readMonitor(fakeKey('bst'), '7', (t) => t, server.url, now), (error: unknown) => error instanceof Error && (error as { code?: string }).code === 'E_VENDOR_BAD_JSON');
    } finally {
      await server.close();
    }
  }
});

const fleet: Fleet = {
  timezone: 'UTC',
  sources: { betterstack: 'enabled' },
  apps: [
    { name: 'app-1', monitor: '7', checks: [] },
    { name: 'site', monitor: '8', checks: [] },
  ],
};

test('monitorsOrUnavailable reads every app; a rejected token or an outage makes the whole source unavailable, logged without the token', async () => {
  const token = fakeKey('bst');
  const redact = createRedactor([{ name: 'BETTERSTACK_API_TOKEN', value: token }]);
  const ok = await serve(vendor(monitorReply('up'), incidentsReply([])));
  try {
    const lines: string[] = [];
    const result = await monitorsOrUnavailable(fleet, token, redact, ok.url, now, createLogger(redact, (l) => lines.push(l)));
    assert.ok(result instanceof Map);
    assert.deepEqual([...(result as Map<string, unknown>).keys()], ['app-1', 'site']);
  } finally {
    await ok.close();
  }
  for (const status of [401, 403, 503]) {
    const lines: string[] = [];
    const bad = await serve(() => ({ status, body: { errors: `bad token ${token}` } }));
    try {
      const result = await monitorsOrUnavailable(fleet, token, redact, bad.url, now, createLogger(redact, (l) => lines.push(l)));
      assert.equal(result, 'unavailable', `status ${status}`);
      assert.equal(lines.length, 1, 'one log line for the source, not one per app');
      assert.ok(lines[0]!.includes('Better Stack') && lines[0]!.includes(`"error_status":${status}`));
      for (const form of leakForms(token)) assert.ok(!lines.join('\n').includes(form), 'a form of the token reached the log');
    } finally {
      await bad.close();
    }
  }
});

test('a redirect is never followed, so the token cannot reach another host', async () => {
  const token = fakeKey('bst');
  let elsewhere = 0;
  const other = await serve(() => {
    elsewhere += 1;
    return { status: 200, body: {} };
  });
  const server = await serve(() => ({ status: 302, body: '', headers: { location: `${other.url}/steal` } }));
  try {
    const result = await monitorsOrUnavailable(fleet, token, (t) => t, server.url, now, createLogger((t) => t, () => {}));
    assert.equal(result, 'unavailable');
    assert.equal(elsewhere, 0);
  } finally {
    await server.close();
    await other.close();
  }
});

test('the base URL is https by default; an override must be https, or http to loopback', () => {
  assert.equal(betterstackBaseUrl(undefined), BETTERSTACK_DEFAULT_URL);
  assert.equal(BETTERSTACK_DEFAULT_URL, 'https://incidents.betterstack.com');
  assert.equal(betterstackBaseUrl('http://127.0.0.1:4000'), 'http://127.0.0.1:4000');
  assert.throws(() => betterstackBaseUrl('http://example.com'), (error: unknown) => error instanceof ConfigError && error.message.includes('BETTERSTACK_API_URL'));
});
