import { registeredFields, safeClassName } from './error-fields.ts';
import type { Field } from './log.ts';

/**
 * The only place an error becomes log fields. A PulseOps error gives the
 * fields its constructor captured (class, `E_*` code, our own message, and for
 * a vendor error status, redacted URL, redirect kind and the cause's class and
 * allowlisted code); nothing is read from the object at log time, so a getter,
 * Proxy or later change cannot alter them. Anything else, including any error
 * a library throws or an object that only looks like ours, gives only its
 * class: never a message, stack or vendor body. It never throws.
 */
export function formatError(error: unknown): Record<string, Field> {
  const known = registeredFields(error);
  if (known !== undefined) return { ...known };
  if (error === null) return { error_class: 'null' };
  if (typeof error !== 'object' && typeof error !== 'function') return { error_class: typeof error };
  let isError: boolean;
  try {
    isError = error instanceof Error;
  } catch {
    // A revoked Proxy throws on any prototype read.
    return { error_class: 'unformattable' };
  }
  return { error_class: isError ? safeClassName(error, 'Error') : typeof error };
}
