import { ConfigError } from './config-error.ts';
import type { Field } from './log.ts';
import { SecretError } from './secrets.ts';
import { VendorHttpError } from './vendor-http.ts';

/**
 * Codes a network failure may carry, kept only when they match this list
 * exactly, so the log can tell a timeout from a refused connection or DNS
 * without writing any text a library produced.
 */
const CAUSE_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET',
  'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID',
  'TimeoutError', 'AbortError',
]);

/**
 * Every read of the error goes through here. The error may come from anywhere
 * (a library, a Proxy, an object with throwing getters), so each read stands
 * alone: one that throws gives `undefined` and takes no other field with it.
 */
function readField<T>(get: () => T): T | undefined {
  try {
    return get();
  } catch {
    return undefined;
  }
}

const isError = (value: unknown) => readField(() => value instanceof Error) === true;
const className = (value: unknown) => readField(() => (value as Error).constructor.name || 'Error') ?? 'unformattable';
const text = (get: () => unknown) => {
  const value = readField(get);
  return typeof value === 'string' ? value : undefined;
};

/** The first allowlisted code in the cause chain (3 levels), from `code` or a DOMException `name`. */
function causeCode(cause: unknown): string | undefined {
  for (let depth = 0; depth < 3 && isError(cause); depth += 1) {
    const code = text(() => (cause as { code?: unknown }).code);
    if (code !== undefined && CAUSE_CODES.has(code)) return code;
    const name = text(() => (cause as Error).name);
    if (name !== undefined && CAUSE_CODES.has(name)) return name;
    cause = readField(() => (cause as Error).cause);
  }
  return undefined;
}

/**
 * The only place an error becomes log fields. PulseOps errors give their class,
 * `E_*` code and our own message (its URL already redacted); a vendor error
 * also gives its status, redacted URL, a fixed redirect kind, and for an
 * unreachable vendor the cause's class and an allowlisted code. Anything else,
 * including any error a library throws, gives only its class: never a
 * third-party message, stack or vendor body. It never throws.
 */
export function formatError(error: unknown): Record<string, Field> {
  if (!isError(error)) {
    const kind = readField(() => (error === null ? 'null' : typeof error));
    return { error_class: readField(() => error instanceof Error) === undefined ? 'unformattable' : (kind ?? 'unformattable') };
  }
  const fields: Record<string, Field> = { error_class: className(error) };
  const set = (name: string, value: Field | undefined) => {
    if (value !== undefined) fields[name] = value;
  };
  const vendor = readField(() => error instanceof VendorHttpError) === true;
  const own = vendor || readField(() => error instanceof SecretError || error instanceof ConfigError) === true;
  if (own) {
    const known = error as VendorHttpError | SecretError | ConfigError;
    set('error_code', text(() => known.code));
    set('error_message', text(() => known.message));
  }
  if (vendor) {
    const http = error as VendorHttpError;
    set('error_status', readField(() => (typeof http.status === 'number' ? http.status : undefined)));
    set('error_url', text(() => http.url));
    set('error_redirect', text(() => http.redirect));
    const cause = readField(() => http.cause);
    if (isError(cause)) {
      set('error_cause_class', className(cause));
      set('error_cause_code', causeCode(cause));
    }
  }
  return fields;
}
