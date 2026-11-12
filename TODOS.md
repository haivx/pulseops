# TODOS

## Setup

### Create a monitor and checks for every app

**What:** A Better Stack monitor for each app and for the collector, and a healthchecks.io check for each worker, job or service, with the worker ping wired in each app.

**Why:** The spike found one monitor and one never-pinged check. The note reads every registered monitor and check, so a missing or never-pinged one shows `unknown` and blocks `all clear`.

**Context:** Done at build time. Ping the first check once and confirm `n_pings`, `last_ping` and `status` change through the read-only API, which the spike did not get to. Use exact Railway environment names (`<project> / production`) for each app's GitHub deploy source. Put checks in one healthchecks.io project if possible, since read-only keys are per project. See `docs/vendor-spike.md`.

**Effort:** S
**Priority:** P1
**Depends on:** None

## Note

### Send the note to Telegram

**What:** `pulseops note` (without `--dry-run`) sends the rendered note as a Telegram bot message to the owner's chat.

**Why:** The owner chose Telegram as the delivery channel (open question 1, 2026-11-12). Until this lands the note only prints.

**Context:** Read the bot token and chat id with `readSecret`, call `assertNoSecrets(note, secrets, 'Telegram message')` before sending, and send through a redacting HTTP call (the bot token is part of Telegram's URL, so it must be one of the redactor's secrets). Retry delivery up to 3 times with backoff, as in "Run once per day" step 2, then ping healthchecks.io only after delivery.

**Effort:** S
**Priority:** P1
**Depends on:** `pulseops note --dry-run`

### Subscription price history

**What:** Record each price change for a subscription.

**Why:** v1 overwrites amounts, so history starts only on the day this ships, and monthly cost analysis depends on it.

**Context:** New table of name, amount, currency and effective date, appended by the subscriptions sync when an amount changes. Recorded as v2 by the owner.

**Effort:** S
**Priority:** P2
**Depends on:** v1 note running

### Monthly cost analysis and forecast

**What:** A monthly view of LLM and subscription costs, with a forecast once there is enough history.

**Why:** The note shows yesterday and the next 7 days, but not the trend or where costs are heading.

**Context:** Reads the kept events and subscriptions. Needs dated prices in the LLM price table, because v1 applies current prices only. The forecast needs some months of history first.

**Effort:** M
**Priority:** P3
**Depends on:** Subscription price history

### Mute a known problem

**What:** A `muted_until` and required `reason` per app or check, shown in the footer.

**Why:** A planned outage leaves a daily problem until the config changes, which erodes trust in the headline.

**Context:** Deferred because no recurring false problem has been seen yet. Add it the first time one appears.

**Effort:** S
**Priority:** P3
**Depends on:** v1 note running

### Gap and price overrides

**What:** Per-process `gap_after` and optional `price_overrides` in `fleet.yaml`.

**Why:** Sleeping apps and new models would otherwise need a code change to clear a daily problem.

**Context:** Depends on open question 3, app sleep. Deferred until the 3 mornings answer it.

**Effort:** S
**Priority:** P3
**Depends on:** Open question 3

## Client

### Queue backlog monitoring for BullMQ apps

**What:** Sample job counts per queue and report a growing backlog in the note.

**Why:** A worker can be alive and pinging while falling behind, which the v1 ping cannot see.

**Context:** One new event `kind` in schema `v: 2`, sampled on a timer by the same client, with queue names as a closed set in the registry.

**Effort:** M
**Priority:** P3
**Depends on:** Collector and client

### Client version header

**What:** Send `CLIENT_VERSION` in the `User-Agent` header and flag stale copies in `doctor`.

**Why:** Vendored copies drift with no visibility.

**Context:** The header stays outside the strict body allow-list. Deferred because there are only 2-4 copies.

**Effort:** S
**Priority:** P3
**Depends on:** None

## Collector

### Per-app ingest quota

**What:** A batches-per-minute limit per app token.

**Why:** A stolen token can fill Postgres and inflate spend, causing false ceiling problems.

**Context:** v1 has no ingest rate limit, since auth and size checks run first. State how client IP is derived if a per-IP limit is added too.

**Effort:** S
**Priority:** P3
**Depends on:** None

## Secrets guard

### Logger and redactor hardening

**What:** One PR, `chore/logger-hardening`, right after PR #2 merges. It covers the points the PR #2 review left open. Do (5) and (1) first, then (8), (9) and (10). Write each test first and watch it fail.

1. **Redactor accepts escape-prone hand-built secrets.** `src/secrets.ts:77` `createRedactor` checks only the length of a `Secret` built by hand, not `SECRET_CHARS` (now `A-Z a-z 0-9 . _ -`). If such a value contains `+ / = ~ " \`, it can leak in an escaped form the redactor does not know, such as `\u002B` from .NET JSON or `%7E` from `URLSearchParams`. `runMain` is safe because it only uses `readSecret`. Rewrite `test/secrets.test.ts:121` ("redactor removes every escaped form of a hand-built secret with + / = . ~ -"), which currently asserts the old behavior, into a rejection test. Any app token PulseOps generates itself, such as the collector's, must use only these characters (hex or base64url without padding). Fix: `if (secret.value.length < MIN_SECRET_LENGTH || !SECRET_CHARS.test(secret.value)) throw invalidSecret(secret.name);`. Test:
   ```ts
   test('createRedactor refuses a hand-built secret with escape-prone characters', () => {
     const value = `${randomBytes(12).toString('hex')}"`;
     assert.throws(() => createRedactor([{ name: 'K', value }]), { code: 'E_CONFIG_INVALID' });
   });
   ```
2. **Repeated references are logged as `[Circular]`.** `src/serialize.ts:33` `seen` is never cleared, so an object referenced twice, such as one error in two fields, shows `"[Circular]"` the second time. Fix: track only the current ancestor path, for example by walking the value before `JSON.stringify`. Test:
   ```ts
   test('safeStringify writes a shared non-circular object in full each time', () => {
     const shared = { app: 'app-1' };
     assert.deepEqual(JSON.parse(safeStringify({ a: shared, b: shared })), { a: shared, b: shared });
   });
   ```
3. **A field can overwrite `level` or `msg`.** `src/log.ts:20` builds `{ level, msg, ...fields }`, so a field named `level` or `msg` replaces the real one. Fix: `{ ...fields, level, msg }`. Test: `log.info('real', { level: 'error', msg: 'fake' })` gives `level: 'info'` and `msg: 'real'`.
4. **The logger fallback can still throw.** `src/log.ts:21-22`: the fallback calls `error.message` or `String(error)`, which can throw on a hostile getter or `toString`. Wrap the fallback in its own try that writes a constant `serialization_error`. Test:
   ```ts
   test('logger never throws when a field cannot be serialized', () => {
     const lines: string[] = [];
     const log = createLogger(createRedactor([]), (l) => lines.push(l));
     assert.doesNotThrow(() => log.error('failed', { bad: { toJSON() { throw new Error('boom'); } } }));
     const entry = JSON.parse(lines[0]!);
     assert.equal(entry.msg, 'failed');
     assert.equal(entry.serialization_error, 'boom');
   });
   ```
5. **Exit depends on the stderr callback.** `src/run-main.ts:43` exits only in the `process.stderr.write('', cb)` callback. If stderr stalls or is destroyed while a handle is open, the process still hangs. Fix: add `setTimeout(() => process.exit(EXIT_FAILURE), 2000).unref()` next to it. Test: an e2e fixture that fails with an open handle while the parent never reads stderr, then asserts exit 1 within 5 seconds.
6. **The BAD_JSON test does not guard the cause.** `test/vendor-http.test.ts:78` checks only `error.message`. If `{ cause }` is put back on the `E_VENDOR_BAD_JSON` throw (`src/vendor-http.ts:54`), the SyntaxError would quote about 10 characters of the body and the test would still pass. Fix: log the rejected error through `createLogger` and assert `longestPrefix(line, key) < 8`.
7. **Base64 offset 1 is untested.** `test/secrets.test.ts:67` covers offsets 2 and 3 (and 0 elsewhere). Add a one-character prefix case: `` `a${basic}` ``.

Found by the pass-3 review:

8. **Deep nesting overflows `safeStringify`.** `src/serialize.ts:28`: the replacer roughly halves how deep `JSON.stringify` can go. A 12 KB vendor body of `[`×6000 then `]`×6000 parses in `getJson`. Logging it then drops every field, leaving only `serialization_error: "Maximum call stack size exceeded"`. On a thrown error, `fail` logs no error at all. `assertNoSecrets` throws a `RangeError` (it fails closed). Fix: track depth in the replacer and write `"[Depth]"` past a cap, or catch per field in the logger. Test: log `{ body: JSON.parse('['.repeat(6000) + ']'.repeat(6000)), app: 'app-1' }` and assert `app` is kept.
9. **Raw URL in `getJson` error messages.** `src/vendor-http.ts:32, 36, 45, 54` put `${url}` in `error.message` even though `redact` is in scope. The logger redacts it, but a command that saves `error.message` to a row or a prompt depends on `assertNoSecrets`. Fix: use `redact(url)` in every message. Test: a URL with `?api_key=<key>` gives a message without the key.
10. **The `unhandledRejection` handler is untested.** `src/run-main.ts:46`: deleting it leaves all 32 tests passing, and Node's default handler would print the key unredacted. Test: in `test/fixtures/uncaught-with-key.ts`, add `if (process.env.FAIL_MODE === 'floating') { void Promise.reject(new Error(`floating failure for ${key}`)); return; }`, and add `'floating'` to the mode loop in `test/no-leak.e2e.test.ts`.
11. **Resolved in PR #2 for keys read through `readSecret`.** Keys with `~` leaked in base64url or URL-encoded base64. `readSecret` now accepts only `A-Z a-z 0-9 . _ -`, whose base64 never contains `+` or `/`, so `BASE64_RUN` (`src/secrets.ts:70`) needs no base64url or `%2B %2F %3D` handling. The hand-built case is item 1.
12. **Hex and double encodings are not recognized.** `util.inspect` prints Buffers as `<Buffer 6b 65 ...>` inside error messages. Hex, double URL-encoding and base64 of the URL-encoded key were all missed. Decide which encodings count as the key.
13. **`assertNoSecrets` can check something other than what is written.** `src/serialize.ts`: it misses `toString` with private fields used through `${obj}`, symbol and non-enumerable properties, `SharedArrayBuffer`, and cross-realm Errors (use `Error.isError`). An own enumerable `__proto__` property on an Error sets the prototype in `serializeError` (`src/serialize.ts:13`) instead of copying it; use `Object.defineProperty` or a null-prototype object. A getter is read twice (`src/serialize.ts:30`). The rule doc should also say to assert on the final string that is written or sent.
14. **A 3xx error does not say where it points.** `src/vendor-http.ts:30-39`: with `redirect: 'manual'`, a moved vendor URL breaks every run with only `returned 301`. Add the redacted, origin-only `Location` to the error.
15. **Handlers pile up across `runMain` calls.** `src/run-main.ts:45-46` registers `uncaughtException` and `unhandledRejection` on every call and never removes them, so later calls keep stale redactors. Register once, or remove them when the command finishes.

**Why:** None of these leaks a key in the current `runMain` flow, but (1) and (5) break promises the rule doc makes: hand-built secrets are safe, and a run never hangs. The rest are wrong log data or test gaps.

**Context:** Found by the pass-2 review of PR #2. The owner chose to keep PR #2 from growing. Also noted there, with no decision yet: base64 wrapped across lines, keys stored as UTF-16 bytes, `Headers` or `URLSearchParams` objects passed to `assertNoSecrets`, and a size cap on vendor bodies (skipped in PR #2's review).

**Effort:** M
**Priority:** P1 for (5), (1), (8), (9) and (10); P2 for the rest
**Depends on:** PR #2 merged

## Docs

### Error catalogue

**What:** `docs/errors.md` with one anchor per `E_*` code.

**Why:** Gives agents and future-you a stable place to look up an error.

**Context:** Deferred in favour of a short quickstart section. Revisit when codes settle.

**Effort:** S
**Priority:** P4
**Depends on:** v1 commands

### Config schema

**What:** A JSON Schema for `fleet.yaml` for editor checking.

**Why:** Catches mistakes before the sync runs.

**Context:** The sync already validates everything, so this is a convenience.

**Effort:** S
**Priority:** P4
**Depends on:** None

## Later

### Local demo mode

**What:** `pulseops note --dry-run --fixtures demo`, rendering each note state from fixtures.

**Why:** Lets anyone run the project and see every state without any accounts.

**Context:** Deferred at the final gate because the one-day note is the first working thing either way.

**Effort:** S
**Priority:** P3
**Depends on:** Note job

### Public status wall

**What:** A public read-only view of the fleet.

**Why:** Shows fleet health without running the project.

**Context:** Deferred because it would publish the app names that the plan keeps out of git.

**Effort:** M
**Priority:** P4
**Depends on:** Detail page

## Completed
