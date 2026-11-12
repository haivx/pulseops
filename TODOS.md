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

### Logger follow-ups after hardening

**What:** Left open by the `chore/logger-hardening` review and not covered by the typed logger:
1. Overlapping `runMain` calls share one fail handler and its redactor; make a second call in one process throw, with a test.
2. Doc drift: the `runMain` docstring should state the Linux full-pipe exception; rename the fleet test that now covers a blank slug.
3. Deploy: on Linux a full stderr pipe blocks before the 2-second exit timer can run, so the scheduler must wrap the note job in a watchdog (for example `timeout 120 pulseops note`).

**Why:** None leaks a key in the current flow.

**Effort:** S
**Priority:** P2 (item 3 is P1 at deploy time)
**Depends on:** None

### Encodings the redactor still misses

**What:** Hex and double encodings are not recognized: hex, double URL-encoding and base64 of the URL-encoded key were all missed. With typed fields, a Buffer can no longer reach a log line, so the `<Buffer 6b 65 ...>` case is gone; the rest needs a decision on which encodings count as the key.

**Why:** No current path writes a key in these encodings (keys are `A-Z a-z 0-9 . _ -` and are never put in a field on purpose), but a vendor could echo one into the URL.

**Context:** Also noted in the PR #2 review, with no decision yet: base64 wrapped across lines.

**Effort:** S
**Priority:** P3
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

### Logger takes typed fields, not objects

**Completed:** `feat/typed-logger` (2026-11-12). Log fields are `string | number | boolean` only, an error becomes fields only through `formatError` (class, `E_*` code, status, redacted URL; never a library's message or stack, never a vendor body), `assertNoSecrets` takes only the final string, and `src/serialize.ts` is deleted.
