# PulseOps

One morning message for the health and costs of a small fleet of production apps.

PulseOps sends a daily note covering app health, deploys, LLM spend and subscriptions due in the next 7 days. Alerts for downtime and silent workers come from Better Stack and healthchecks.io, not from PulseOps, so a PulseOps bug cannot suppress an alert.

Status: design approved. Built so far: the API-key guard (see [the secrets rule](docs/rules/secrets.md)) and a first note that reads healthchecks.io only and prints instead of sending. To try it, copy `fleet.example.yaml` to `fleet.yaml`, set `HEALTHCHECKS_API_KEY` and run `npm run pulseops -- note --dry-run`. See [the design](docs/designs/pulseops-daily-note.md) and [TODOS.md](TODOS.md).
