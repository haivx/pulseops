import { ConfigError } from './config-error.ts';
import type { Field } from './log.ts';
import { SecretError } from './secrets.ts';
import { VendorHttpError } from './vendor-http.ts';

/**
 * The only place an error becomes log fields. PulseOps errors give their class,
 * `E_*` code and our own message (its URL already redacted); a vendor error
 * also gives its status and redacted URL. Anything else, including any error a
 * library throws, gives only its class: never a third-party message, stack,
 * cause or vendor body, because those are text we did not write and cannot vet.
 */
export function formatError(error: unknown): Record<string, Field> {
  if (!(error instanceof Error)) return { error_class: error === null ? 'null' : typeof error };
  const fields: Record<string, Field> = { error_class: error.constructor.name };
  if (error instanceof VendorHttpError) {
    fields.error_code = error.code;
    fields.error_message = error.message;
    if (error.status !== undefined) fields.error_status = error.status;
    if (error.url !== undefined) fields.error_url = error.url;
  } else if (error instanceof SecretError || error instanceof ConfigError) {
    fields.error_code = error.code;
    fields.error_message = error.message;
  }
  return fields;
}
