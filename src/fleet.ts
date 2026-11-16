import { readFileSync } from 'node:fs';
import { parseDocument } from 'yaml';
import { ConfigError } from './config-error.ts';

// The fleet registry (docs/designs/pulseops-daily-note.md, "App registry"). This
// slice reads what the healthchecks.io and Better Stack parts of the note need;
// later sources add their own fields, so unknown keys are allowed.

export type FleetCheck = { name: string; slug: string };
/** `monitor` is the app's Better Stack monitor ID; it is undefined only when that source is disabled. */
export type FleetApp = { name: string; monitor: string | undefined; checks: FleetCheck[] };
export type SourceState = 'enabled' | 'disabled';
export type Fleet = { timezone: string; sources: { betterstack: SourceState }; apps: FleetApp[] };

export class FleetError extends ConfigError {
  constructor(message: string) {
    super(message);
    this.name = 'FleetError';
  }
}

const APP_NAME = /^[a-z0-9-]{1,32}$/;
/** Digits only, so a monitor ID can go into a request path without escaping. */
const MONITOR_ID = /^\d{1,20}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const nonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';

function validTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/**
 * Parses and validates fleet.yaml text, reporting every problem at once. A
 * message names an entry only by its position (apps[1].checks[0]) and never
 * repeats a value or the file's path: the registry is read before any key, so
 * the redactor knows none yet, and a key pasted into the file must not reach the log.
 */
export function parseFleet(text: string): Fleet {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) {
    // The parser's own message can quote the file, so only its line and code are kept.
    const where = doc.errors.map((error) => `line ${error.linePos?.[0].line ?? '?'} (${error.code})`);
    throw new FleetError(`pulseops E_CONFIG_INVALID: the fleet file is not valid YAML (${where.join('; ')}); fix: correct the YAML at that line`);
  }
  const root: unknown = doc.toJS();
  const problems: string[] = [];
  const problem = (where: string, what: string, fix: string) => problems.push(`${where} ${what}; fix: ${fix}`);

  if (!isRecord(root)) {
    throw new FleetError('pulseops E_CONFIG_INVALID: the fleet file must be a mapping with timezone and apps; fix: start from fleet.example.yaml');
  }

  const timezone = root.timezone;
  if (!nonEmptyString(timezone) || !validTimezone(timezone)) {
    problem('timezone', 'is missing or not an IANA time zone', 'set it to a zone such as Asia/Saigon');
  }

  // A source is on unless the file turns it off: a missing value never drops a health source.
  let betterstack: SourceState = 'enabled';
  if (root.sources !== undefined && root.sources !== null) {
    const value = isRecord(root.sources) ? root.sources.betterstack : root.sources;
    if (!isRecord(root.sources) || (value !== undefined && value !== 'enabled' && value !== 'disabled')) {
      problem('sources.betterstack', 'must be enabled or disabled', 'write sources: { betterstack: disabled } only if the free tier cannot read it');
    } else if (value === 'disabled') {
      betterstack = 'disabled';
    }
  }

  const apps: FleetApp[] = [];
  const monitors = new Map<string, string>();
  const slugs = new Map<string, string>();
  const names = new Map<string, string>();
  if (!Array.isArray(root.apps) || root.apps.length === 0) {
    problem('apps', 'has no apps', 'list at least one app; an empty registry must never read as healthy');
  } else {
    root.apps.forEach((entry: unknown, i: number) => {
      const at = `apps[${i}]`;
      if (!isRecord(entry)) {
        problem(at, 'is not a mapping', 'give the app a name and checks');
        return;
      }
      const name = entry.name;
      if (typeof name !== 'string' || !APP_NAME.test(name)) {
        problem(`${at}.name`, 'must match ^[a-z0-9-]{1,32}$', 'use lowercase letters, digits and hyphens');
      } else if (names.has(name)) {
        problem(`${at}.name`, `repeats the name of ${names.get(name)}`, 'give each app its own name');
      } else {
        names.set(name, at);
      }
      let monitor: string | undefined;
      if (entry.monitor === undefined || entry.monitor === null) {
        if (betterstack === 'enabled') problem(`${at}.monitor`, 'is missing', "copy the app's monitor ID from Better Stack, in quotes");
      } else if (typeof entry.monitor !== 'string' || !MONITOR_ID.test(entry.monitor)) {
        problem(`${at}.monitor`, 'must be the numeric monitor ID', 'copy the digits from the monitor URL in Better Stack, in quotes');
      } else if (monitors.has(entry.monitor)) {
        problem(`${at}.monitor`, `repeats the monitor of ${monitors.get(entry.monitor)}`, 'give each app its own monitor');
      } else {
        monitors.set(entry.monitor, at);
        monitor = entry.monitor;
      }
      const checks: FleetCheck[] = [];
      if (entry.checks !== undefined && entry.checks !== null && !Array.isArray(entry.checks)) {
        problem(`${at}.checks`, 'is not a list', 'list each check with a name and slug');
      } else {
        ((entry.checks as unknown[] | undefined | null) ?? []).forEach((check: unknown, j: number) => {
          const cat = `${at}.checks[${j}]`;
          if (!isRecord(check)) {
            problem(cat, 'is not a mapping', 'give the check a name and slug');
            return;
          }
          if (!nonEmptyString(check.name)) problem(`${cat}.name`, 'is missing', 'name the worker, job or service');
          if (!nonEmptyString(check.slug)) {
            problem(`${cat}.slug`, typeof check.slug === 'string' || check.slug === undefined || check.slug === null ? 'is missing' : 'must be text', "copy the check's slug from healthchecks.io");
          } else if (slugs.has(check.slug)) {
            problem(`${cat}.slug`, `repeats the slug of ${slugs.get(check.slug)}`, 'give each check its own slug');
          } else {
            slugs.set(check.slug, cat);
          }
          if (nonEmptyString(check.name) && nonEmptyString(check.slug)) checks.push({ name: check.name, slug: check.slug });
        });
      }
      if (typeof name === 'string') apps.push({ name, monitor, checks });
    });
  }

  if (problems.length > 0) {
    throw new FleetError(`pulseops E_CONFIG_INVALID: the fleet file has ${problems.length} problem(s): ${problems.join(' | ')}`);
  }
  return { timezone: timezone as string, sources: { betterstack }, apps };
}

export function loadFleet(path: string): Fleet {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const reason = typeof code === 'string' && /^E[A-Z]{2,15}$/.test(code) ? code : 'unreadable';
    throw new FleetError(`pulseops E_CONFIG_INVALID: cannot read the fleet file (${reason}); fix: create fleet.yaml from fleet.example.yaml, or check the --fleet path`);
  }
  return parseFleet(text);
}
