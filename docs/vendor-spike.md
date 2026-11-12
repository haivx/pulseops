# Vendor spike

Read-only checks of the vendor APIs the plan depends on, run before any app code. Keys live in the git-ignored `.env.spike` (mode 600). App names are replaced with `app-1`, because the plan keeps them out of git.

Started 2026-11-12.

## Keys

| Vendor | Variable | Key type | Verified |
|---|---|---|---|
| healthchecks.io | `HEALTHCHECKS_API_KEY` | Project read-only key | 200 on list checks; responses omit `uuid` and `ping_url` and include `unique_key`, which confirms read-only |
| Better Stack | `BETTERSTACK_API_TOKEN` | Team-scoped token | 200 on list monitors. Whether it is read-only is unknown: the docs mention no read-only option, and testing would need a write |
| GitHub | `GITHUB_TOKEN` | Fine-grained PAT, Deployments: Read | 200 on deployments; GitHub reports `x-accepted-github-permissions: deployments=read`. Expires 2026-12-12, so production needs a new token |

## healthchecks.io

Docs: [Management API v3](https://healthchecks.io/docs/api/).

- A read-only key can call exactly four endpoints: list checks, get a check, list flips and list badges. List pings needs a read-write key.
- Keys are per project. Checks in several projects need one key each.
- Status values: `new`, `up`, `grace`, `down`, `paused`.

**Baseline before the first ping (2026-11-12T02:49:07Z):** one check, `status=new`, `n_pings=0`, `last_ping` absent, `next_ping` absent, `grace=3600`, `timeout=86400`, flips empty.

**After one ping:** not run before the spike closed. A recheck at 2026-11-12T02:49:42Z still showed `status=new`, `n_pings=0` and no flips. The owner has to run the ping, because a read-only key does not return `ping_url`.

## Better Stack

Docs: [list monitors](https://betterstack.com/docs/uptime/api/list-all-existing-monitors/), [list incidents](https://betterstack.com/docs/uptime/api/list-all-incidents/).

- Host is `incidents.betterstack.com`. Monitors are API v2, incidents are API v3.
- Monitor status values: `up`, `down`, `validating`, `paused`, `pending`, `maintenance`.
- Incident time filters `from` and `to` are dates (`YYYY-MM-DD`), not timestamps. A 24-hour window needs two days fetched and filtered on the start time in code.
- Observed: one monitor, `status=up`.

## GitHub deployments

Docs: [deployments](https://docs.github.com/en/rest/deployments/deployments), [statuses](https://docs.github.com/en/rest/deployments/statuses).

- Status `state` values: `error`, `failure`, `inactive`, `pending`, `success`, `queued`, `in_progress`. These match the plan's mapping.
- Statuses older than 90 days are deleted.

Observed on app-1 (hosted on Railway):

- Railway names the environment `<project> / production`, not `production`. Filtering on `production` returned 0 deployments; the full name returned 5. The plan's rule that a configured `github` app with no deployment shows `deploy unknown` catches this misconfiguration.
- Railway posts many statuses per deployment, flipping between `in_progress` and `failure`, and posts `failure` to an older deployment after a newer one exists. A `failure` here can mean a crash after deploy, not only a failed deploy.
- The latest deployment's latest status was `failure` (2026-11-08T14:00:11Z). The note would report a problem for app-1.
- The PulseOps repo has no deployments yet, as expected.

## Open findings for the plan

1. GitHub deletes statuses after 90 days, so an app with no deploy for 90 days would show a daily false `deploy unknown`.
2. Better Stack incidents filter by date only.
3. With Railway, "deploy failed" may mislead; `latest deploy: failure` is more accurate.

All three were applied to the plan on 2026-11-12.

## Summary

Closed 2026-11-12.

| Plan assumption | Result | Evidence |
|---|---|---|
| healthchecks.io read-only key can list checks and flips | Confirmed | Live 200; key returns `unique_key`, no `uuid` or `ping_url` |
| Read-only key returns `n_pings` and `last_ping` | Confirmed field present | Live response has `n_pings=0`; `last_ping` absent before any ping |
| `n_pings`, `last_ping` and `status` change after a ping | **Not verified** | Ping not run; check still `new` at close |
| Read-only key cannot list pings | Confirmed by docs | Docs list four read-only endpoints; not tested live |
| Better Stack token can read monitor status | Confirmed | Live 200, one monitor `up` |
| Better Stack token is read-only | **Unknown** | Docs mention no read-only option; not tested, since it needs a write |
| Better Stack incidents filter by hour | **Wrong** | Docs: `from` and `to` are dates; open finding 2 |
| GitHub token needs only Deployments: Read | Confirmed | Live `x-accepted-github-permissions: deployments=read` |
| GitHub environment is named `production` | **Wrong for Railway** | Live: Railway uses `<project> / production` |
| GitHub latest status shows deploy health | Partly | Live: Railway also posts `failure` after a crash and to older deployments; open finding 3 |
| No status means a misconfiguration | **Wrong after 90 days** | Docs: statuses older than 90 days are deleted; open finding 1 |
| Anthropic Console organization | Not checked | Manual check in open question 5; no key created |
| Free-tier limits | Not checked | Vendor pricing pages not read in this spike |

Carried forward: the ping check and the remaining monitors and checks move to the setup item in `TODOS.md`. The three open findings are applied to the plan.
