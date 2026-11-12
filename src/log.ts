/** A log field: text, a number or a flag. Objects and Errors are refused by the type. */
export type Field = string | number | boolean;

export type Logger = {
  info: (msg: string, fields?: Record<string, Field>) => void;
  warn: (msg: string, fields?: Record<string, Field>) => void;
  error: (msg: string, fields?: Record<string, Field>) => void;
};

/** What a value that is not a Field becomes: its type, never its content. */
const dropped = (value: unknown) => `[dropped: ${value === null ? 'null' : typeof value}]`;

/**
 * One JSON line per call: `level`, `msg`, then the fields. Fields are
 * primitives only, so nothing has to guess how to turn an object into text;
 * an error becomes fields through `formatError`. A non-primitive value that
 * gets past the type (from JS or a cast) is written as "[dropped: <type>]".
 * The whole line then passes through `redact`, the second layer.
 */
export function createLogger(redact: (text: string) => string, sink: (line: string) => void): Logger {
  const write = (level: string, msg: string, fields: Record<string, Field> = {}) => {
    // No prototype, so an own `__proto__` field is kept as data.
    const entry = Object.create(null) as Record<string, Field>;
    entry.level = level;
    entry.msg = typeof msg === 'string' ? msg : dropped(msg);
    for (const [key, value] of Object.entries(fields)) {
      // A reserved or taken name is prefixed until free, so no field is ever overwritten.
      let name = key;
      while (name in entry) name = `field_${name}`;
      entry[name] = typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? value : dropped(value);
    }
    sink(redact(JSON.stringify(entry)));
  };
  return {
    info: (msg, fields) => write('info', msg, fields),
    warn: (msg, fields) => write('warn', msg, fields),
    error: (msg, fields) => write('error', msg, fields),
  };
}
