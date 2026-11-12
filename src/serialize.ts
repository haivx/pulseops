// One JSON serializer for everything that is checked for keys: log lines and
// the text assertNoSecrets inspects. Plain JSON.stringify hides or garbles the
// values a key is most likely to sit in, so redaction would never see it:
// Errors become {}, Map and Set become {}, and bytes become a list of numbers.

/** Deeper values are written as "[Depth]", so a hostile body cannot overflow the stack. */
const MAX_DEPTH = 100;
/** More nodes than this are written as "[Truncated]", so shared objects cannot expand exponentially. */
const MAX_NODES = 10_000;

/** Thrown in strict mode when a value is too deep or too large to check in full. */
export class SerializeLimitError extends Error {
  constructor(limit: 'depth' | 'size') {
    super(`pulseops E_SECRET_IN_OUTPUT: value is too ${limit === 'depth' ? 'deep' : 'large'} to check for keys in full; fix: write a smaller value`);
    this.name = 'SerializeLimitError';
  }
}

/** A plain object with no prototype, so an own `__proto__` key is kept as data. */
function record(): Record<string, unknown> {
  return Object.create(null) as Record<string, unknown>;
}

/**
 * Turns any value into plain JSON-ready data: Errors with every property plus
 * message, stack, cause and AggregateError errors; Maps, Sets and byte arrays
 * as their contents; boxed primitives unboxed; BigInts as strings. Only a true
 * cycle is "[Circular]"; the same object in two places is written in full both
 * times, up to the node budget. In strict mode (assertNoSecrets) hitting the
 * depth or node limit throws instead, so a check never passes a value it did
 * not see. It also throws if a getter or toJSON throws.
 */
function makeWalker(strict: boolean) {
  const ancestors = new Set<object>();
  let nodes = 0;
  const limit = (kind: 'depth' | 'size', mark: string) => {
    if (strict) throw new SerializeLimitError(kind);
    return mark;
  };
  const walk = (value: unknown): unknown => {
    if (typeof value === 'bigint') return value.toString();
    if (value === null || typeof value !== 'object') return value;
    if (ancestors.has(value)) return '[Circular]';
    if (ancestors.size >= MAX_DEPTH) return limit('depth', '[Depth]');
    if (++nodes > MAX_NODES) return limit('size', '[Truncated]');
    ancestors.add(value);
    try {
      return plain(value);
    } finally {
      ancestors.delete(value);
    }
  };
  const plain = (value: object): unknown => {
    if (value instanceof String || value instanceof Number || value instanceof Boolean) return value.valueOf();
    if (value instanceof BigInt) return value.toString();
    if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('utf8');
    if (value instanceof ArrayBuffer) return Buffer.from(value).toString('utf8');
    if (value instanceof Map) return [...value.entries()].map(([k, v]) => [walk(k), walk(v)]);
    if (value instanceof Set) return [...value.values()].map(walk);
    if (Array.isArray(value)) return value.map(walk);
    if (value instanceof Error) {
      const out = record();
      // Walked like any other value: a message or stack made of bytes must reach redaction as text.
      out.name = walk(value.name);
      out.message = walk(value.message);
      for (const [key, child] of Object.entries(value)) out[key] = walk(child);
      if (value.stack !== undefined) out.stack = walk(value.stack);
      if (value.cause !== undefined) out.cause = walk(value.cause);
      if (value instanceof AggregateError) out.errors = walk(value.errors);
      return out;
    }
    const toJSON = (value as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === 'function') return walk(toJSON.call(value));
    const out = record();
    for (const [key, child] of Object.entries(value)) out[key] = walk(child);
    return out;
  };
  return walk;
}

/** JSON text for logging: values past the depth or node limit are marked. */
export function safeStringify(value: unknown): string {
  return JSON.stringify(makeWalker(false)(value)) ?? '';
}

/** JSON text for checking: throws SerializeLimitError instead of marking, so nothing is skipped. */
export function strictStringify(value: unknown): string {
  return JSON.stringify(makeWalker(true)(value)) ?? '';
}
