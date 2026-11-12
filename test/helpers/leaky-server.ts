import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';

/** A random fake key, generated at run time so no key-shaped string is committed. */
export function fakeKey(prefix = 'fake'): string {
  return `${prefix}_${randomBytes(20).toString('hex')}`;
}

/**
 * A local vendor stand-in that rejects every request with 401 and, like some
 * real APIs, echoes the credentials and URL it received back in the body.
 */
export async function startLeakyServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        error: 'invalid credentials',
        received_url: req.url,
        received_headers: {
          authorization: req.headers['authorization'] ?? null,
          'x-api-key': req.headers['x-api-key'] ?? null,
        },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('server has no port');
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Every form a key commonly leaks in: raw, URL-encoded and inside HTTP Basic auth. */
export function leakForms(key: string): string[] {
  return [key, encodeURIComponent(key), Buffer.from(`user:${key}`).toString('base64'), Buffer.from(key).toString('base64')];
}
