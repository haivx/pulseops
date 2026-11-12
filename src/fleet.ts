import { readFileSync } from 'node:fs';
import { parseDocument } from 'yaml';

// The fleet registry (docs/designs/pulseops-daily-note.md, "App registry"). This
// slice reads only what the healthchecks.io note needs; later sources add their
// own fields, so unknown keys are allowed.

export type FleetCheck = { name: string; slug: string };
export type FleetApp = { name: string; checks: FleetCheck[] };
export type Fleet = { timezone: string; apps: FleetApp[] };

export class FleetError extends Error {
  readonly code = 'E_CONFIG_INVALID';
  constructor(message: string) {
    super(message);
    this.name = 'FleetError';
  }
}

const APP_NAME = /^[a-z0-9-]{1,32}$/;

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

/** Parses and validates fleet.yaml text, reporting every problem at once. */
export function parseFleet(text: string, source = 'fleet.yaml'): Fleet {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) {
    const where = doc.errors.map((error) => `line ${error.linePos?.[0].line ?? '?'}: ${error.message.split('\n')[0]}`);
    throw new FleetError(`pulseops E_CONFIG_INVALID: ${source} is not valid YAML (${where.join('; ')}); fix: correct the YAML at that line`);
  }
  const root: unknown = doc.toJS();
  const problems: string[] = [];
  const problem = (where: string, what: string, fix: string) => problems.push(`${where} ${what}; fix: ${fix}`);

  if (!isRecord(root)) {
    throw new FleetError(`pulseops E_CONFIG_INVALID: ${source} must be a mapping with timezone and apps; fix: start from fleet.example.yaml`);
  }

  const timezone = root.timezone;
  if (!nonEmptyString(timezone) || !validTimezone(timezone)) {
    problem('timezone', 'is missing or not an IANA time zone', 'set it to a zone such as Asia/Saigon');
  }

  const apps: FleetApp[] = [];
  const slugs = new Map<string, string>();
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
            problem(`${cat}.slug`, 'is missing', "copy the check's slug from healthchecks.io");
          } else if (slugs.has(check.slug)) {
            problem(`${cat}.slug`, `repeats slug ${check.slug} from ${slugs.get(check.slug)}`, 'give each check its own slug');
          } else {
            slugs.set(check.slug, cat);
          }
          if (nonEmptyString(check.name) && nonEmptyString(check.slug)) checks.push({ name: check.name, slug: check.slug });
        });
      }
      if (typeof name === 'string') apps.push({ name, checks });
    });
  }

  if (problems.length > 0) {
    throw new FleetError(`pulseops E_CONFIG_INVALID: ${source} has ${problems.length} problem(s): ${problems.join(' | ')}`);
  }
  return { timezone: timezone as string, apps };
}

export function loadFleet(path: string): Fleet {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new FleetError(`pulseops E_CONFIG_INVALID: cannot read ${path}; fix: create it from fleet.example.yaml or pass --fleet <path>`);
  }
  return parseFleet(text, path);
}
