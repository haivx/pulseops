export type Logger = {
  info: (msg: string, fields?: Record<string, unknown>) => void;
  warn: (msg: string, fields?: Record<string, unknown>) => void;
  error: (msg: string, fields?: Record<string, unknown>) => void;
};

/** Errors are plain objects to JSON.stringify, so copy out the fields worth keeping. */
function serializeError(error: Error, depth = 0): Record<string, unknown> {
  const out: Record<string, unknown> = { name: error.name, message: error.message };
  for (const key of ['code', 'status', 'detail'] as const) {
    const value = (error as unknown as Record<string, unknown>)[key];
    if (value !== undefined) out[key] = value;
  }
  if (error.stack !== undefined) out.stack = error.stack;
  if (error.cause !== undefined && depth < 5) {
    out.cause = error.cause instanceof Error ? serializeError(error.cause, depth + 1) : error.cause;
  }
  return out;
}

/**
 * One JSON line per call. The whole line passes through `redact` after
 * serialization, so a key anywhere in the message, fields, error, cause or
 * stack is caught in one place.
 */
export function createLogger(redact: (text: string) => string, sink: (line: string) => void): Logger {
  const write = (level: string, msg: string, fields: Record<string, unknown> = {}) => {
    const line = JSON.stringify({ level, msg, ...fields }, (_key, value: unknown) =>
      value instanceof Error ? serializeError(value) : value,
    );
    sink(redact(line));
  };
  return {
    info: (msg, fields) => write('info', msg, fields),
    warn: (msg, fields) => write('warn', msg, fields),
    error: (msg, fields) => write('error', msg, fields),
  };
}
