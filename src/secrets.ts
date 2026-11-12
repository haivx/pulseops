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

/**
 * Characters no common encoder escapes: JSON writers (.NET writes `+` as
 * `\u002B`, some write `/` as `\/`), URL encoders (`~` becomes `%7E` in
 * URLSearchParams) and base64url all leave these alone. A key with any other
 * character could leak in an escaped form the redactor does not recognize.
 */
const SECRET_CHARS = /^[A-Za-z0-9._-]+$/;

function invalidSecret(name: string): SecretError {
  return new SecretError(
    'E_CONFIG_INVALID',
    `pulseops E_CONFIG_INVALID: ${name} is shorter than ${MIN_SECRET_LENGTH} characters or has characters other than A-Z a-z 0-9 . _ -; fix: copy the full key again`,
  );
}

export function readSecret(env: Record<string, string | undefined>, name: string): Secret {
  const value = env[name];
  if (value === undefined || value === '') {
    throw new SecretError(
      'E_CONFIG_MISSING',
      `pulseops E_CONFIG_MISSING: environment variable ${name} is not set; fix: set ${name} in the environment`,
    );
  }
  if (value.length < MIN_SECRET_LENGTH || !SECRET_CHARS.test(value)) throw invalidSecret(name);
  return { name, value };
}

const lowerPercent = (text: string) => text.replace(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase());

/**
 * The text forms a key commonly takes when it leaks: raw, URL-encoded (both
 * encoders, either case), with `/` escaped as `\/` the way some JSON writers
 * do, and base64. Each form is also listed JSON-escaped, because log lines are
 * redacted after JSON.stringify, which doubles the backslash in `\/`.
 */
function leakForms(value: string): string[] {
  const uri = encodeURIComponent(value);
  const searchParam = new URLSearchParams({ k: value }).toString().slice('k='.length);
  const forms = [
    value,
    uri,
    lowerPercent(uri),
    searchParam,
    lowerPercent(searchParam),
    value.replaceAll('/', '\\/'),
    Buffer.from(value).toString('base64'),
  ];
  return [...new Set(forms.flatMap((form) => [form, JSON.stringify(form).slice(1, -1)]))];
}

// Long enough to hold an encoded key, so short words are never decoded.
const BASE64_RUN = /[A-Za-z0-9+/]{20,}={0,2}/g;

/** Decodes a base64 run as if the encoded value started at offset 0, 1, 2 or 3. */
function decodedAlignments(run: string): string[] {
  return [0, 1, 2, 3].map((offset) => Buffer.from(run.slice(offset), 'base64').toString('utf8'));
}

export function createRedactor(secrets: Secret[]): (text: string) => string {
  // A Secret built by hand skips readSecret, so the same rule applies here: an
  // empty one would mark every character, and an escape-prone one could leak
  // in a form the redactor does not know.
  for (const secret of secrets) {
    if (secret.value.length < MIN_SECRET_LENGTH || !SECRET_CHARS.test(secret.value)) throw invalidSecret(secret.name);
  }
  const forms = secrets
    .flatMap((secret) => leakForms(secret.value).map((form) => ({ form, mark: `[REDACTED:${secret.name}]` })))
    .sort((a, b) => b.form.length - a.form.length);

  const containsSecret = (text: string) => secrets.find((secret) => text.includes(secret.value));

  return (text: string) => {
    if (secrets.length === 0) return text;
    // Credentials inside an encoded value, such as HTTP Basic auth, hide the
    // key behind base64 that does not line up with the key's own encoding.
    // The encoded value may start mid-run when glued to a path or other text,
    // so every 4-character alignment is tried.
    let out = text.replace(BASE64_RUN, (run) => {
      for (const decoded of decodedAlignments(run)) {
        const hit = containsSecret(decoded);
        if (hit !== undefined) return `[REDACTED:${hit.name}]`;
      }
      return run;
    });
    for (const { form, mark } of forms) out = out.split(form).join(mark);
    return out;
  };
}

/**
 * Guard for the final text about to be written to a database or sent in an
 * LLM prompt. It takes only that string, so what is checked is exactly what
 * leaves: the caller builds the text first. Throws instead of redacting,
 * because a stored or sent key cannot be taken back.
 */
export function assertNoSecrets(text: string, secrets: Secret[], label: string): void {
  if (typeof text !== 'string') throw new TypeError(`assertNoSecrets(${label}) needs the final string, not a ${typeof text}`);
  const redacted = createRedactor(secrets)(text);
  if (redacted === text) return;
  const names = secrets.filter((secret) => redacted.includes(`[REDACTED:${secret.name}]`)).map((secret) => secret.name);
  throw new SecretError(
    'E_SECRET_IN_OUTPUT',
    `pulseops E_SECRET_IN_OUTPUT: ${label} contains ${names.join(', ')}; fix: remove credentials before writing or sending it`,
  );
}
