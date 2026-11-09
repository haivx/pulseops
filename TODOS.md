# TODOS

## Note

### Subscription price history

**What:** Record each price change for a subscription.

**Why:** v1 overwrites amounts, so history starts only on the day this ships, and monthly cost analysis depends on it.

**Context:** New table of name, amount, currency and effective date, appended by the subscriptions sync when an amount changes. Recorded as v2 by the owner.

**Effort:** S
**Priority:** P2
**Depends on:** v1 note running

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

**Context:** The current rate limit covers only unauthenticated requests. State how client IP is derived when adding this.

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

## Portfolio

### Public status wall

**What:** A public read-only view of the fleet.

**Why:** Makes the portfolio piece visible without running it.

**Context:** Deferred because it would publish the app names that the plan keeps out of git.

**Effort:** M
**Priority:** P4
**Depends on:** Detail page

## Completed
