# PulseOps

One morning message for the health and costs of a small fleet of production apps.

PulseOps sends a daily note covering app health, deploys, LLM spend and subscriptions due in the next 7 days. Alerts for downtime and silent workers come from Better Stack and healthchecks.io, not from PulseOps, so a PulseOps bug cannot suppress an alert.

Status: design approved. The only code so far is the API-key guard (see [the secrets rule](docs/rules/secrets.md)); the note itself is not built yet. See [the design](docs/designs/pulseops-daily-note.md) and [TODOS.md](TODOS.md).
