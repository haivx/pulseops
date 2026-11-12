// A real process that reads a key from the environment, calls a vendor that
// rejects it, and lets the failure reach the top-level handler.
import { readSecret } from '../../src/secrets.ts';
import { getJson } from '../../src/vendor-http.ts';
import { runMain } from '../../src/run-main.ts';

await runMain(['HEALTHCHECKS_API_KEY'], async ({ secrets, redact }) => {
  const key = readSecret(process.env, 'HEALTHCHECKS_API_KEY').value;
  const base = process.env.VENDOR_URL;
  if (base === undefined) throw new Error('VENDOR_URL not set');
  console.log(`calling vendor for ${secrets.length} configured key(s)`);
  await getJson(`${base}/api/v3/checks/?api_key=${encodeURIComponent(key)}`, { 'X-Api-Key': key }, redact);
});
