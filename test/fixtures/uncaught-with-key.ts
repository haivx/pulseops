// A real process that fails while something still holds the event loop open,
// the way an unclosed socket would. FAIL_MODE picks how it fails:
//   timer:  an error thrown from a callback after the command returned
//   reject: the command itself rejects
import { runMain } from '../../src/run-main.ts';

await runMain(['HEALTHCHECKS_API_KEY'], async ({ secrets }) => {
  const key = secrets[0]!.value;
  setInterval(() => {}, 1000);
  if (process.env.FAIL_MODE === 'reject') throw new Error(`command failed for ${key}`);
  setTimeout(() => {
    throw new Error(`late failure for ${key}`);
  }, 10);
});
