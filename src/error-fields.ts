import type { Field } from './log.ts';

// The log fields of PulseOps errors, captured as primitives when each error
// is built. formatError reads only this registry, never the error object, so
// a getter, a Proxy, a subclass or a later change to the object cannot alter
// what is logged. Only the constructors in this repo write to it.
const registry = new WeakMap<object, Readonly<Record<string, Field>>>();

/** Runs one read of an object we did not build; a read that throws gives `undefined`. */
export function readField<T>(get: () => T): T | undefined {
  try {
    return get();
  } catch {
    return undefined;
  }
}

/** A class name that is a short identifier, or `fallback`; read once. */
export function safeClassName(value: unknown, fallback: string): string {
  const name = readField(() => (value as { constructor?: { name?: unknown } }).constructor?.name);
  return typeof name === 'string' && /^[A-Za-z_$][\w$]{0,63}$/.test(name) ? name : fallback;
}

/** Records an error's fields; called once, from its own constructor. Undefined values are left out. */
export function registerFields(error: object, fields: Record<string, Field | undefined>): void {
  const kept: Record<string, Field> = {};
  for (const [name, value] of Object.entries(fields)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') kept[name] = value;
  }
  registry.set(error, Object.freeze(kept));
}

/** The fields an error was built with, or undefined if no PulseOps constructor built it. */
export function registeredFields(error: unknown): Readonly<Record<string, Field>> | undefined {
  // WeakMap.get never runs a Proxy trap or a getter; a primitive simply misses.
  return typeof error === 'object' && error !== null ? registry.get(error) : undefined;
}
