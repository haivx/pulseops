// One JSON serializer for everything that is checked for keys: log lines and
// the text assertNoSecrets inspects. Plain JSON.stringify hides or garbles the
// values a key is most likely to sit in, so redaction would never see it:
// Errors become {}, Map and Set become {}, and bytes become a list of numbers.

/**
 * Every property an Error carries, so a key in `config.headers`, `url` or an
 * AggregateError's `errors` is checked too. There is no depth limit on causes:
 * cycles are cut by the `seen` set in safeStringify.
 */
function serializeError(error: Error): Record<string, unknown> {
  const out: Record<string, unknown> = { name: error.name, message: error.message };
  for (const [key, value] of Object.entries(error)) out[key] = value;
  if (error.stack !== undefined) out.stack = error.stack;
  if (error.cause !== undefined) out.cause = error.cause;
  if (error instanceof AggregateError) out.errors = error.errors;
  return out;
}

/**
 * JSON text for any value, with Errors (every property, plus message, stack,
 * cause and AggregateError errors), Maps, Sets and byte arrays written out as
 * text, BigInts as strings, and cycles as "[Circular]". It throws only if a getter or toJSON throws;
 * callers decide whether that fails open or closed.
 */
export function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  const text = JSON.stringify(value, function (this: Record<string, unknown>, key, current: unknown) {
    // Read the holder, not `current`: Buffer.toJSON has already run on `current`.
    const raw = this[key];
    if (typeof raw === 'bigint') return raw.toString();
    if (raw === null || typeof raw !== 'object') return current;
    if (seen.has(raw)) return '[Circular]';
    seen.add(raw);
    if (ArrayBuffer.isView(raw)) return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('utf8');
    if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString('utf8');
    if (raw instanceof Map) return [...raw.entries()];
    if (raw instanceof Set) return [...raw.values()];
    if (raw instanceof Error) return serializeError(raw);
    return current;
  }) as string | undefined;
  return text ?? '';
}
