# PulseOps

Plan: `docs/designs/pulseops-daily-note.md`. Deferred work: `TODOS.md`.

## Rules

- API keys: read only from the environment, never in logs, database rows or LLM prompts. See `docs/rules/secrets.md` before touching any code that reads keys, logs, writes rows or builds prompts.

## Testing

- `npm run check` runs the type check and all tests.
- Node 24 runs the TypeScript files directly; there is no build step.
- Tests use random fake keys generated at run time. Never commit a key-shaped string.
