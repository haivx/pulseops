// Domain rule: API keys are read only from the environment, and never reach a
// log, a database row in plain text, or an LLM prompt. See docs/rules/secrets.md.

export type Secret = { name: string; value: string };

export class SecretError extends Error {
  readonly code: 'E_CONFIG_MISSING' | 'E_CONFIG_INVALID' | 'E_SECRET_IN_OUTPUT';
  constructor(code: SecretError['code'], message: string) {
    super(message);
    this.name = 'SecretError';
    this.code = code;
  }
}

/** Shorter values could match ordinary text, so redaction would be unsafe. */
const MIN_SECRET_LENGTH = 16;

export function readSecret(env: Record<string, string | undefined>, name: string): Secret {
  const value = env[name];
  if (value === undefined || value === '') {
    throw new SecretError(
      'E_CONFIG_MISSING',
      `pulseops E_CONFIG_MISSING: environment variable ${name} is not set; fix: set ${name} in the environment`,
    );
  }
  if (value.length < MIN_SECRET_LENGTH || value.trim() !== value) {
    throw new SecretError(
      'E_CONFIG_INVALID',
      `pulseops E_CONFIG_INVALID: ${name} is shorter than ${MIN_SECRET_LENGTH} characters or has surrounding spaces; fix: copy the full key again`,
    );
  }
  return { name, value };
}

/** The text forms a key commonly takes when it leaks. */
function leakForms(value: string): string[] {
  return [value, encodeURIComponent(value), Buffer.from(value).toString('base64')];
}

// Long enough to hold an encoded key, so short words are never decoded.
const BASE64_RUN = /[A-Za-z0-9+/]{20,}={0,2}/g;

export function createRedactor(secrets: Secret[]): (text: string) => string {
  const forms = secrets
    .flatMap((secret) => leakForms(secret.value).map((form) => ({ form, mark: `[REDACTED:${secret.name}]` })))
    .sort((a, b) => b.form.length - a.form.length);

  const containsSecret = (text: string) => secrets.find((secret) => text.includes(secret.value));

  return (text: string) => {
    if (secrets.length === 0) return text;
    // Credentials inside an encoded value, such as HTTP Basic auth, hide the
    // key behind base64 that does not line up with the key's own encoding.
    let out = text.replace(BASE64_RUN, (run) => {
      const decoded = Buffer.from(run, 'base64').toString('utf8');
      const hit = containsSecret(decoded);
      return hit === undefined ? run : `[REDACTED:${hit.name}]`;
    });
    for (const { form, mark } of forms) out = out.split(form).join(mark);
    return out;
  };
}

/**
 * Guard for anything about to be written to a database or sent in an LLM
 * prompt. Throws instead of redacting, because a stored or sent key cannot be
 * taken back.
 */
export function assertNoSecrets(value: unknown, secrets: Secret[], label: string): void {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
  const redacted = createRedactor(secrets)(text);
  if (redacted === text) return;
  const names = secrets.filter((secret) => redacted.includes(`[REDACTED:${secret.name}]`)).map((secret) => secret.name);
  throw new SecretError(
    'E_SECRET_IN_OUTPUT',
    `pulseops E_SECRET_IN_OUTPUT: ${label} contains ${names.join(', ')}; fix: remove credentials before writing or sending it`,
  );
}
