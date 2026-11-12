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
export function createLogger(redact: (text: string) => string, sink: (line: string) => void): Logger {
  const write = (level: string, msg: string, fields: Record<string, unknown> = {}) => {
    let line: string;
    try {
      line = safeStringify({ level, msg, ...fields });
    } catch (error) {
      line = JSON.stringify({ level, msg, serialization_error: error instanceof Error ? error.message : String(error) });
    }
    sink(redact(line));
  };
  return {
    info: (msg, fields) => write('info', msg, fields),
    warn: (msg, fields) => write('warn', msg, fields),
    error: (msg, fields) => write('error', msg, fields),
  };
}
