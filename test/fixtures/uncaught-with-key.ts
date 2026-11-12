// A real process that fails while something still holds the event loop open,
// the way an unclosed socket would. FAIL_MODE picks how it fails:
//   timer:  an error thrown from a callback after the command returned
//   reject: the command itself rejects
//   floating: a promise the command never awaits rejects
//   stall: stderr is already full when it fails (the parent never reads it)
import { runMain } from '../../src/run-main.ts';

await runMain(['HEALTHCHECKS_API_KEY'], async ({ secrets }) => {
  const key = secrets[0]!.value;
  setInterval(() => {}, 1000);
  if (process.env.FAIL_MODE === 'reject') throw new Error(`command failed for ${key}`);
  if (process.env.FAIL_MODE === 'floating') {
    void Promise.reject(new Error(`floating failure for ${key}`));
    return;
  }
  if (process.env.FAIL_MODE === 'stall') process.stderr.write('x'.repeat(4 * 1024 * 1024));
  setTimeout(() => {
    throw new Error(`late failure for ${key}`);
  }, 10);
});
