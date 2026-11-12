// One JSON serializer for everything that is checked for keys: log lines and
// the text assertNoSecrets inspects. Plain JSON.stringify hides or garbles the
// values a key is most likely to sit in, so redaction would never see it:
// Errors become {}, Map and Set become {}, and bytes become a list of numbers.

/** Deeper values are written as "[Depth]", so a hostile body cannot overflow the stack. */
const MAX_DEPTH = 100;

/** A plain object with no prototype, so an own `__proto__` key is kept as data. */
function record(): Record<string, unknown> {
  return Object.create(null) as Record<string, unknown>;
}

/**
 * Turns any value into plain JSON-ready data, reading each property once:
 * Errors with every property plus message, stack, cause and AggregateError
 * errors; Maps, Sets and byte arrays as their contents; BigInts as strings.
 * Only a true cycle (a value inside itself) is "[Circular]"; the same object in
 * two places is written in full both times. It throws only if a getter or
 * toJSON throws, and callers decide whether that fails open or closed.
 */
function toPlain(value: unknown, ancestors: object[]): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value === null || typeof value !== 'object') return value;
  if (ancestors.includes(value)) return '[Circular]';
  if (ancestors.length >= MAX_DEPTH) return '[Depth]';
  const inner = [...ancestors, value];
  const walk = (child: unknown) => toPlain(child, inner);

  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('utf8');
  if (value instanceof ArrayBuffer) return Buffer.from(value).toString('utf8');
  if (value instanceof Map) return [...value.entries()].map(([k, v]) => [walk(k), walk(v)]);
  if (value instanceof Set) return [...value.values()].map(walk);
  if (Array.isArray(value)) return value.map(walk);
  if (value instanceof Error) {
    const out = record();
    out.name = value.name;
    out.message = value.message;
    for (const [key, child] of Object.entries(value)) out[key] = walk(child);
    if (value.stack !== undefined) out.stack = value.stack;
    if (value.cause !== undefined) out.cause = walk(value.cause);
    if (value instanceof AggregateError) out.errors = walk(value.errors);
    return out;
  }
  const toJSON = (value as { toJSON?: unknown }).toJSON;
  if (typeof toJSON === 'function') return walk(toJSON.call(value));
  const out = record();
  for (const [key, child] of Object.entries(value)) out[key] = walk(child);
  return out;
}

export function safeStringify(value: unknown): string {
  return JSON.stringify(toPlain(value, [])) ?? '';
}
