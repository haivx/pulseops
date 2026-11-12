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

### Logger takes typed fields, not objects

**What:** Replace "serialize anything, then redact" with a logger that cannot be handed an object:
- `log(level, msg, fields)` where each field is only `string | number | boolean` or an `E_*` code; the type rejects objects and Errors.
- One `formatError(err)` that writes the class, the `E_*` code, the status and the URL already redacted. It never writes a third-party library's message or stack.
- `assertNoSecrets` runs on the final string that is written or sent, never on an object.
- When done, delete the serializer branches nothing uses any more (Buffer, Map, Set, cycles, depth and node limits).

**Why:** Three review rounds kept finding new value shapes the serializer misread (bytes, boxed strings, shared graphs, getters). Typed fields remove the whole class instead of patching each shape. The owner decided on 2026-11-12 that the serializer gets no more patches after `chore/logger-hardening`.

**Context:** Supersedes most of "Logger follow-ups after hardening" and "Encodings and checks the redactor still misses" below; close those items that no longer apply when this lands.

**Effort:** M
**Priority:** P1
**Depends on:** `chore/logger-hardening` merged

### Logger follow-ups after hardening

**What:** Left open by the `chore/logger-hardening` review (the owner fixed only the leak regressions there):
1. An own `toJSON` on an Error replaces the whole serialized Error (`src/serialize.ts`, Error branch); drop function-valued children.
2. `stack` and `cause` getters are read twice in the Error branch.
3. The 3xx hint lowercases the host, so a key in a `Location` host escapes redaction; redact the raw `Location` first and omit the hint if it held a key (`src/vendor-http.ts` `redirectHint`).
4. Log lines put `level` and `msg` last since the override fix; put them first and rename colliding fields.
5. Overlapping `runMain` calls share one fail handler and its redactor; make a second call in one process throw.
6. Tests: the logger fallback with a thrown `Object.create(null)`, and a second `runMain` call.
7. Doc drift: `describe()` sits between `createLogger`'s JSDoc and the function; `docs/rules/secrets.md` "How it is tested" omits the floating and stall cases and the new vendor-http tests; the `runMain` docstring and this file's Completed note should state the Linux full-pipe exception; rename the fleet test that now covers a blank slug.
8. Deploy: on Linux a full stderr pipe blocks before the 2-second exit timer can run, so the scheduler must wrap the note job in a watchdog (for example `timeout 120 pulseops note`).

**Why:** None leaks a key in the current flow; most go away with the typed logger above.

**Effort:** S
**Priority:** P2 (item 8 is P1 at deploy time)
**Depends on:** None

### Encodings and checks the redactor still misses

**What:** The two points the `chore/logger-hardening` PR left open.

1. **Hex and double encodings are not recognized.** `util.inspect` prints Buffers as `<Buffer 6b 65 ...>` inside error messages. Hex, double URL-encoding and base64 of the URL-encoded key were all missed. Decide which encodings count as the key.
2. **`assertNoSecrets` can check something other than what is written.** It misses `toString` with private fields used through `${obj}`, symbol and non-enumerable properties, `SharedArrayBuffer`, and Errors from another realm (use `Error.isError`). The rule doc should say to assert on the final string that is written or sent.

**Why:** Neither leaks a key in today's flow (keys are `A-Z a-z 0-9 . _ -`, and nothing writes to a database or an LLM yet), but both matter once those writers exist.

**Context:** Found in the PR #2 review; the owner deferred them. Also noted there, with no decision yet: base64 wrapped across lines, keys stored as UTF-16 bytes, `Headers` or `URLSearchParams` objects passed to `assertNoSecrets`, and a size cap on vendor bodies.

**Effort:** S
**Priority:** P2
**Depends on:** None

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

### Logger and redactor hardening

**Completed:** `chore/logger-hardening` (2026-11-12). `createRedactor` applies the same character rule as `readSecret`; a failing run exits after 2 seconds even if stderr never drains (not on Linux, where a full pipe blocks first); `safeStringify` caps depth at 100 and nodes at 10,000, writes shared objects in full within that budget, unboxes boxed primitives, writes an Error message made of bytes as text and keeps an own `__proto__` as data; `assertNoSecrets` throws instead of passing a value past those limits; a field cannot replace `level` or `msg`, and the logger fallback never throws; `getJson` messages carry the URL redacted, and a 3xx names the origin it points to; the `uncaughtException` and `unhandledRejection` handlers are installed once; tests cover a floating rejection, a full stderr, a body that is not JSON (cause included) and base64 offset 1.
