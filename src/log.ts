import { safeStringify } from './serialize.ts';

export type Logger = {
  info: (msg: string, fields?: Record<string, unknown>) => void;
  warn: (msg: string, fields?: Record<string, unknown>) => void;
  error: (msg: string, fields?: Record<string, unknown>) => void;
};

/**
 * One JSON line per call. The whole line passes through `redact` after
 * serialization, so a key anywhere in the message, fields, error, cause, stack
 * or a byte array is caught in one place. Logging never throws: if the fields
 * cannot be serialized, they are all replaced by the reason, so the message
 * still lands.
 */
/** The reason a field could not be serialized, never throwing itself. */
function describe(error: unknown): string {
  try {
    return error instanceof Error ? String(error.message) : String(error);
  } catch {
    return 'unserializable field';
  }
}

export function createLogger(redact: (text: string) => string, sink: (line: string) => void): Logger {
  const write = (level: string, msg: string, fields: Record<string, unknown> = {}) => {
    let line: string;
    try {
      // level and msg last, so a field with the same name cannot replace them.
      line = safeStringify({ ...fields, level, msg });
    } catch (error) {
      line = JSON.stringify({ level, msg, serialization_error: describe(error) });
    }
    sink(redact(line));
  };
  return {
    info: (msg, fields) => write('info', msg, fields),
    warn: (msg, fields) => write('warn', msg, fields),
    error: (msg, fields) => write('error', msg, fields),
  };
}
