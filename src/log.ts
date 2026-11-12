/** A log field: text, a number or a flag. Objects and Errors are refused by the type. */
export type Field = string | number | boolean;

export type Logger = {
  info: (msg: string, fields?: Record<string, Field>) => void;
  warn: (msg: string, fields?: Record<string, Field>) => void;
  error: (msg: string, fields?: Record<string, Field>) => void;
};

const RESERVED = new Set(['level', 'msg']);

/**
 * One JSON line per call: `level`, `msg`, then the fields. Fields are
 * primitives only, so nothing has to guess how to turn an object into text;
 * an error becomes fields through `formatError`. A non-primitive value that
 * gets past the type (from JS or a cast) is written as "[dropped: object]".
 * The whole line then passes through `redact`, the second layer.
 */
export function createLogger(redact: (text: string) => string, sink: (line: string) => void): Logger {
  const write = (level: string, msg: string, fields: Record<string, Field> = {}) => {
    const entry: Record<string, Field> = { level, msg };
    for (const [key, value] of Object.entries(fields)) {
      const safe = typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? value : '[dropped: object]';
      entry[RESERVED.has(key) ? `field_${key}` : key] = safe;
    }
    sink(redact(JSON.stringify(entry)));
  };
  return {
    info: (msg, fields) => write('info', msg, fields),
    warn: (msg, fields) => write('warn', msg, fields),
    error: (msg, fields) => write('error', msg, fields),
  };
}
