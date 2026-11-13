# PulseOps

One morning message for the health and costs of a small fleet of production apps.

PulseOps sends a daily note covering app health, deploys, LLM spend and subscriptions due in the next 7 days. Alerts for downtime and silent workers come from Better Stack and healthchecks.io, not from PulseOps, so a PulseOps bug cannot suppress an alert.

Status: design approved. Built so far: the API-key guard (see [the secrets rule](docs/rules/secrets.md)) and a note that reads healthchecks.io and is sent to Telegram. Better Stack, GitHub deploys and subscriptions are not read yet. See [the design](docs/designs/pulseops-daily-note.md) and [TODOS.md](TODOS.md).

## Run it

1. Copy `fleet.example.yaml` to `fleet.yaml` and list your apps and their healthchecks.io check slugs.
2. Set these in the environment (never in a file in the repo):
   - `HEALTHCHECKS_API_KEY`: a read-only key for the healthchecks.io project.
   - `TELEGRAM_BOT_TOKEN`: the token @BotFather gives your bot.
   - `TELEGRAM_CHAT_ID`: your chat id. Send the bot one message, then read `chat.id` from `https://api.telegram.org/bot<token>/getUpdates`.
   - `HEALTHCHECKS_PING_UUID`: the UUID of the healthchecks.io check for the note job itself (the part after `hc-ping.com/`).
3. `npm run pulseops -- note --dry-run` prints the note; `npm run pulseops -- note` sends it and pings the note job's check.
4. Schedule `note` once a day, with automatic restart off: a rerun sends a second note, since there is no once-per-day claim yet. Give the note job's healthchecks.io check a grace period of at least 3 minutes, so a run that is still retrying is not reported as missed.

Exit codes: `0` sent (a failed ping after delivery is only a warning), `2` a config problem to fix (missing or malformed settings, or Telegram or healthchecks.io refused the token, chat id or ping UUID), `4` Telegram or healthchecks.io was unreachable or failing after the retries.
