# Rule: API keys

PulseOps holds vendor API keys (healthchecks.io, Better Stack, GitHub, and later the collector's app tokens). This rule applies to all of them.

1. **Read keys only from the environment.** Use `readSecret(env, NAME)` from `src/secrets.ts`. Never read a key from a file in the repo, a command-line argument, or the database. A missing key fails with `E_CONFIG_MISSING` and exit code 2, naming the variable and never inventing a value. A key shorter than 16 characters, or with characters other than `A-Z a-z 0-9 . _ -`, fails with `E_CONFIG_INVALID`. Each other character is escaped by some common encoder (.NET JSON writes `+` as `\u002B`, some JSON writers write `/` as `\/`, `URLSearchParams` writes `~` as `%7E`), and an escaped key is a form redaction does not recognize.
2. **Never write a key to a log.** All output goes through the logger from `createLogger`, which redacts the whole line after serialization: message, fields, errors, causes and stacks. Commands start through `runMain`, which also redacts uncaught errors and then exits 1, even if a socket or timer is still open. Do not use `console.log` or `process.stdout` for anything that might hold a request, a response or an error. Vendor calls go through `getJson(url, headers, redact)`, which redacts a response body before cutting it to 500 characters, so a cut never leaves part of a key behind. It never follows redirects: on a cross-origin redirect `fetch` drops only `Authorization`, so a header such as `X-Api-Key` would reach the new host. A 3xx fails as `E_VENDOR_HTTP`. A vendor base URL taken from the environment, such as `HEALTHCHECKS_API_URL` for a self-hosted healthchecks.io or a test server, must be https, or http only to `localhost`, `127.0.0.1` or `[::1]`, with no user or password in it. Anything else fails with `E_CONFIG_INVALID` before a key is sent.
3. **Never store a key in a database in plain text.** Call `assertNoSecrets(row, secrets, '<table> row')` before writing a row that holds request or error data. It throws `E_SECRET_IN_OUTPUT` instead of redacting, because a stored key cannot be taken back. App tokens are stored only as hashes, as the plan says.
4. **Never put a key in an LLM prompt.** Call `assertNoSecrets(prompt, secrets, 'LLM prompt')` before sending any prompt built from logs, errors or vendor responses.

## What counts as the key

The raw value, its URL-encoded forms (`encodeURIComponent` and `URLSearchParams`, upper or lower case), the form with `/` written as `\/`, the JSON-escaped version of each, its base64 form, and any base64 value that decodes to text containing it, such as an HTTP Basic auth header, even when glued to a path or other text. Errors (every property, cause, stack and AggregateError errors), Maps, Sets and byte arrays are written out as text by `safeStringify` in `src/serialize.ts` before they are checked, in the logger and in `assertNoSecrets`. Keys shorter than 16 characters are rejected, because redacting them could match ordinary text.

## How it is tested

`test/no-leak.e2e.test.ts` starts a local server that rejects every request with 401 and echoes the key back in the body, the way some real APIs do. A real child process reads a random fake key from the environment, calls that server, and fails. The test checks the exit code, that the error code and redaction marks are printed, and that no form of the key appears in stdout or stderr. Removing redaction from the logger makes this test fail, along with the logger tests in `test/log.test.ts` and the other e2e tests. A second fixture fails from a timer and from a rejected command while a handle is still open, and the test checks that the process exits 1 within 5 seconds with the key redacted. `test/vendor-http.test.ts` checks that a key echoed across the 500-character cut leaves no prefix of 8 or more characters, and that a body that is not JSON is not quoted.

## Not covered yet

- There is no database or LLM call in the code yet. `assertNoSecrets` is ready and tested for both, and must be called at those boundaries when they are added.
- Redaction only knows keys passed to it. A key the process never read cannot be recognized.
- Errors thrown while a command module loads, before `runMain` starts, and Node's own warnings are not redacted.
- Response bodies have no size cap yet; only the 10-second timeout bounds them.
