# PulseOps

One morning message for the health and costs of a small fleet of production apps.

PulseOps sends a daily note covering app health, deploys, LLM spend and subscriptions due in the next 7 days. Alerts for downtime and silent workers come from Better Stack and healthchecks.io, not from PulseOps, so a PulseOps bug cannot suppress an alert.

Status: design approved. Built so far: the API-key guard (see [the secrets rule](docs/rules/secrets.md)) and a note that reads Better Stack and healthchecks.io and is sent to Telegram. GitHub deploys and subscriptions are not read yet. See [the design](docs/designs/pulseops-daily-note.md) and [TODOS.md](TODOS.md).

## Run it

1. Copy `fleet.example.yaml` to `fleet.yaml` and list your apps: each one's Better Stack monitor ID (the digits in the monitor's URL, in quotes) and its healthchecks.io check slugs. If Better Stack cannot be read, add `sources: { betterstack: disabled }`; the note then says `Not checked: Better Stack` and never `all clear`.
2. Set these in the environment (never in a file in the repo):
   - `HEALTHCHECKS_API_KEY`: a read-only key for the healthchecks.io project.
   - `BETTERSTACK_API_TOKEN`: the team's Better Stack Uptime API token (not needed when the source is disabled). PulseOps only reads with it.
   - `TELEGRAM_BOT_TOKEN`: the token @BotFather gives your bot.
   - `TELEGRAM_CHAT_ID`: your chat id. Send the bot one message, then read `chat.id` from `https://api.telegram.org/bot<token>/getUpdates`.
   - `HEALTHCHECKS_PING_UUID`: the UUID of the healthchecks.io check for the note job itself (the part after `hc-ping.com/`).
3. `npm run pulseops -- note --dry-run` prints the note; `npm run pulseops -- note` sends it and pings the note job's check.
4. Schedule `note` once a day, with automatic restart off: a rerun sends a second note, since there is no once-per-day claim yet. Give the note job's healthchecks.io check a grace period of at least 3 minutes, so a run that is still retrying is not reported as missed.

A source that does not answer (healthchecks.io or Better Stack) is one `unknown: <source> unavailable` problem, and the rest of the note still goes out. With both sources read and no problems, the headline is `all clear`.

Exit codes:
- `0`: the note was sent. If the healthchecks.io ping fails afterwards, the run still exits 0: a refused ping (a wrong `HEALTHCHECKS_PING_UUID`) is logged as an error with a fix, an outage as a warning, and the missed ping raises its own alert.
- `2`: a setting to fix. Either something is missing or malformed, or Telegram refused the token (401/404), the chat (403) or the message (other 4xx). The log line names the setting.
- `4`: try again later; no setting is wrong. Telegram was unreachable or failing after 3 tries (5xx, 408, 429), failed after some parts had gone out ("k of n parts"), took a part without confirming it (the note may have arrived: check the chat), or the send ran out of its 90-second budget.

A whole run takes at most about 110 seconds (90 s to send, plus one request time each for the source reads, which run in parallel, and the ping), so a `timeout 120` watchdog will not cut it short.
