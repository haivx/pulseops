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

const className = (error: Error) => error.constructor.name || 'Error';

/** The first allowlisted code in the cause chain (3 levels), from `code` or a DOMException `name`. */
function causeCode(cause: unknown): string | undefined {
  for (let depth = 0; depth < 3 && cause instanceof Error; depth += 1) {
    const code = (cause as { code?: unknown }).code;
    if (typeof code === 'string' && CAUSE_CODES.has(code)) return code;
    if (CAUSE_CODES.has(cause.name)) return cause.name;
    cause = cause.cause;
  }
  return undefined;
}

/**
 * The only place an error becomes log fields. PulseOps errors give their class,
 * `E_*` code and our own message (its URL already redacted); a vendor error
 * also gives its status, redacted URL, and for an unreachable vendor the
 * cause's class and an allowlisted code. Anything else, including any error a
 * library throws, gives only its class: never a third-party message, stack or
 * vendor body. It never throws, because it runs while a failing run exits.
 */
export function formatError(error: unknown): Record<string, Field> {
  try {
    if (!(error instanceof Error)) return { error_class: error === null ? 'null' : typeof error };
    const fields: Record<string, Field> = { error_class: className(error) };
    if (error instanceof VendorHttpError) {
      fields.error_code = error.code;
      fields.error_message = error.message;
      if (error.status !== undefined) fields.error_status = error.status;
      if (error.url !== undefined) fields.error_url = error.url;
      if (error.cause instanceof Error) {
        fields.error_cause_class = className(error.cause);
        const code = causeCode(error.cause);
        if (code !== undefined) fields.error_cause_code = code;
      }
    } else if (error instanceof SecretError || error instanceof ConfigError) {
      fields.error_code = error.code;
      fields.error_message = error.message;
    }
    return fields;
  } catch {
    return { error_class: 'unformattable' };
  }
}
