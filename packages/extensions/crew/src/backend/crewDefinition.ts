/**
 * Crew member definition files: `nimbalyst-local/crew/<slug>.md`.
 *
 * The frontmatter holds one `crew:` object whose keys map 1:1 onto
 * `CrewMemberDefinition` (`avatar` <-> `avatarPath`); the markdown body is
 * the directive. The slug comes from the filename.
 *
 * `validateCrewFrontmatter` is the single place defaults are applied. It is
 * pure and returns typed errors instead of throwing, so one malformed file
 * shows up as one member in an error state instead of breaking the roster.
 * Keys this version does not understand (`triggers`, anything newer) are kept
 * when the file is rewritten.
 */

import * as path from 'node:path';
import * as yaml from 'js-yaml';
import type {
  CrewBudget,
  CrewLevel,
  CrewMemberDefinition,
  CrewMemberDraft,
  CrewScheduleSpec,
  CrewWeekday,
} from '../shared/types';
import { CREW_WEEKDAYS, parseLocalTime, parseQuietHours } from './crewTime';

export const CREW_DIR = path.join('nimbalyst-local', 'crew');

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function isValidCrewSlug(slug: string): boolean {
  return SLUG_RE.test(slug);
}

/** A valid slug derived from a display name ("Ada L." -> "ada-l"), or null if nothing usable is left. */
export function slugFromName(name: string): string | null {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return isValidCrewSlug(slug) ? slug : null;
}

export function crewDir(workspacePath: string): string {
  return path.join(workspacePath, CREW_DIR);
}

export function crewDefinitionPath(workspacePath: string, slug: string): string {
  assertSlug(slug);
  return path.join(crewDir(workspacePath), `${slug}.md`);
}

export function crewMemoryDir(workspacePath: string, slug: string): string {
  assertSlug(slug);
  return path.join(crewDir(workspacePath), slug);
}

export function assertSlug(slug: string): void {
  if (!isValidCrewSlug(slug)) {
    throw new Error(`Invalid crew member slug "${slug}": use lowercase letters, digits, and dashes`);
  }
}

export const CREW_DEFAULTS = {
  color: '#7c6cf2',
  provider: 'claude-code',
  maxLevel: 'flag' as CrewLevel,
  // All tokens, cache reads and writes included. A real read-only standup
  // shift held ~125k context; counting cache reads on every turn, a shift is
  // a few million tokens. 60M/week (20M/day) covers two such shifts a day with
  // room for a heavy one. Budgets are a runaway guard, not a tight limit.
  budget: { tokensPerWeek: 60_000_000, shiftsPerDay: 6 } satisfies CrewBudget,
} as const;

const DEFAULT_MODEL_BY_PROVIDER: Record<string, string> = {
  'claude-code': 'sonnet',
  'openai-codex': 'gpt-6.1-sol',
};

/**
 * Keys the first build wrote that this version ignores on read and drops on
 * rewrite. `autonomy` was a second permission system; members now run under
 * the project's permission mode like every other session.
 */
const RETIRED_KEYS = ['autonomy'] as const;

const LEVELS: readonly CrewLevel[] = ['note', 'flag', 'page', 'ask'];
const MIN_INTERVAL_MINUTES = 15;

export interface CrewDefinitionError {
  /** Dotted frontmatter path, e.g. `crew.schedule[1].daily`. */
  path: string;
  message: string;
}

export type CrewDefinitionResult =
  | { ok: true; definition: CrewMemberDefinition }
  | { ok: false; errors: CrewDefinitionError[] };

type Raw = Record<string, unknown>;

function isRecord(value: unknown): value is Raw {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateSchedule(raw: unknown, at: string, errors: CrewDefinitionError[]): CrewScheduleSpec | null {
  if (!isRecord(raw)) {
    errors.push({ path: at, message: 'must be an object' });
    return null;
  }
  if (!nonEmptyString(raw.prompt)) {
    errors.push({ path: `${at}.prompt`, message: 'is required' });
  }
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') {
    errors.push({ path: `${at}.enabled`, message: 'must be true or false' });
  }
  const forms = ['daily', 'weekly', 'interval', 'at'].filter((key) => raw[key] !== undefined);
  if (forms.length !== 1) {
    errors.push({ path: at, message: 'needs exactly one of daily, weekly, interval, or at' });
    return null;
  }
  if (raw.createdBy !== undefined && raw.createdBy !== 'user' && raw.createdBy !== 'member') {
    errors.push({ path: `${at}.createdBy`, message: 'must be user or member' });
  }
  const prompt = typeof raw.prompt === 'string' ? raw.prompt.trim() : '';
  const base = {
    prompt,
    ...(typeof raw.enabled === 'boolean' ? { enabled: raw.enabled } : {}),
    ...(raw.createdBy === 'member' ? { createdBy: 'member' as const } : {}),
  };
  const errorCount = errors.length;

  switch (forms[0]) {
    case 'daily': {
      if (typeof raw.daily !== 'string' || !parseLocalTime(raw.daily)) {
        errors.push({ path: `${at}.daily`, message: 'must be a quoted "HH:mm" time' });
        return null;
      }
      return errors.length === errorCount ? { ...base, daily: raw.daily.trim() } : null;
    }
    case 'weekly': {
      const weekly = raw.weekly;
      if (!isRecord(weekly)) {
        errors.push({ path: `${at}.weekly`, message: 'must be { days: [...], time: "HH:mm" }' });
        return null;
      }
      const days = Array.isArray(weekly.days) ? weekly.days.map((d) => String(d).toLowerCase()) : [];
      const badDay = days.find((d) => !CREW_WEEKDAYS.includes(d as CrewWeekday));
      if (days.length === 0 || badDay !== undefined) {
        errors.push({
          path: `${at}.weekly.days`,
          message: badDay !== undefined ? `"${badDay}" is not a weekday name` : 'needs at least one weekday',
        });
      }
      if (typeof weekly.time !== 'string' || !parseLocalTime(weekly.time)) {
        errors.push({ path: `${at}.weekly.time`, message: 'must be a quoted "HH:mm" time' });
      }
      if (errors.length !== errorCount) return null;
      return { ...base, weekly: { days: [...new Set(days)] as CrewWeekday[], time: String(weekly.time).trim() } };
    }
    case 'interval': {
      const minutes = isRecord(raw.interval) ? raw.interval.minutes : undefined;
      if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < MIN_INTERVAL_MINUTES) {
        errors.push({ path: `${at}.interval.minutes`, message: `must be a whole number of at least ${MIN_INTERVAL_MINUTES}` });
        return null;
      }
      return errors.length === errorCount ? { ...base, interval: { minutes } } : null;
    }
    default: {
      // js-yaml turns an unquoted ISO timestamp into a Date.
      const value = raw.at instanceof Date ? raw.at.toISOString() : raw.at;
      if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
        errors.push({ path: `${at}.at`, message: 'must be an ISO 8601 time' });
        return null;
      }
      return errors.length === errorCount ? { ...base, at: new Date(Date.parse(value)).toISOString() } : null;
    }
  }
}

/** Validates one schedule entry, e.g. from `crew_schedule_set` or the desk's schedule editor. */
export function validateScheduleSpec(
  raw: unknown,
): { ok: true; spec: CrewScheduleSpec } | { ok: false; errors: CrewDefinitionError[] } {
  const errors: CrewDefinitionError[] = [];
  const spec = validateSchedule(raw, 'schedule', errors);
  return spec && errors.length === 0 ? { ok: true, spec } : { ok: false, errors };
}

function positiveInteger(value: unknown, fallback: number, at: string, errors: CrewDefinitionError[]): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    errors.push({ path: at, message: 'must be a positive whole number' });
    return fallback;
  }
  return value;
}

/**
 * Validates the parsed frontmatter object (the whole document, containing a
 * `crew` key) and applies defaults. Pure: no file access.
 */
export function validateCrewFrontmatter(
  frontmatter: unknown,
  identity: { slug: string; sourcePath: string; directive: string },
): CrewDefinitionResult {
  const errors: CrewDefinitionError[] = [];
  if (!isValidCrewSlug(identity.slug)) {
    errors.push({ path: 'filename', message: `"${identity.slug}" is not a valid slug (lowercase letters, digits, dashes)` });
  }
  const crew = isRecord(frontmatter) ? frontmatter.crew : undefined;
  if (!isRecord(crew)) {
    return { ok: false, errors: [...errors, { path: 'crew', message: 'frontmatter needs a `crew:` object' }] };
  }

  if (!nonEmptyString(crew.name)) errors.push({ path: 'crew.name', message: 'is required' });
  if (!nonEmptyString(crew.role)) errors.push({ path: 'crew.role', message: 'is required' });

  const color = crew.color === undefined ? CREW_DEFAULTS.color : crew.color;
  if (typeof color !== 'string' || !/^#[0-9a-fA-F]{3,8}$/.test(color)) {
    errors.push({ path: 'crew.color', message: 'must be a hex color like "#7c6cf2"' });
  }
  const provider = crew.provider === undefined ? CREW_DEFAULTS.provider : crew.provider;
  if (!nonEmptyString(provider)) errors.push({ path: 'crew.provider', message: 'must be a provider id' });
  const model = crew.model === undefined && typeof provider === 'string'
    ? DEFAULT_MODEL_BY_PROVIDER[provider.trim()]
    : crew.model;
  if (!nonEmptyString(model)) errors.push({ path: 'crew.model', message: 'is required for this provider' });
  if (crew.personality !== undefined && typeof crew.personality !== 'string') {
    errors.push({ path: 'crew.personality', message: 'must be text' });
  }
  if (crew.avatar !== undefined && typeof crew.avatar !== 'string') {
    errors.push({ path: 'crew.avatar', message: 'must be a path' });
  }

  const notifyRaw = crew.notify === undefined ? {} : crew.notify;
  let notify: CrewMemberDefinition['notify'] = { maxLevel: CREW_DEFAULTS.maxLevel };
  if (!isRecord(notifyRaw)) {
    errors.push({ path: 'crew.notify', message: 'must be an object' });
  } else {
    const maxLevel = notifyRaw.maxLevel === undefined ? CREW_DEFAULTS.maxLevel : notifyRaw.maxLevel;
    if (!LEVELS.includes(maxLevel as CrewLevel)) {
      errors.push({ path: 'crew.notify.maxLevel', message: `must be one of ${LEVELS.join(', ')}` });
    }
    if (notifyRaw.quietHours !== undefined
      && (typeof notifyRaw.quietHours !== 'string' || !parseQuietHours(notifyRaw.quietHours))) {
      errors.push({ path: 'crew.notify.quietHours', message: 'must look like "22:00-08:00"' });
    }
    notify = {
      maxLevel: maxLevel as CrewLevel,
      ...(typeof notifyRaw.quietHours === 'string' ? { quietHours: notifyRaw.quietHours.trim() } : {}),
    };
  }

  const budgetRaw = crew.budget === undefined ? {} : crew.budget;
  let budget: CrewBudget = { ...CREW_DEFAULTS.budget };
  if (!isRecord(budgetRaw)) {
    errors.push({ path: 'crew.budget', message: 'must be an object' });
  } else {
    budget = {
      tokensPerWeek: positiveInteger(budgetRaw.tokensPerWeek, CREW_DEFAULTS.budget.tokensPerWeek, 'crew.budget.tokensPerWeek', errors),
      shiftsPerDay: positiveInteger(budgetRaw.shiftsPerDay, CREW_DEFAULTS.budget.shiftsPerDay, 'crew.budget.shiftsPerDay', errors),
    };
  }

  const schedule: CrewScheduleSpec[] = [];
  if (crew.schedule !== undefined && crew.schedule !== null) {
    if (!Array.isArray(crew.schedule)) {
      errors.push({ path: 'crew.schedule', message: 'must be a list' });
    } else {
      crew.schedule.forEach((entry, index) => {
        const spec = validateSchedule(entry, `crew.schedule[${index}]`, errors);
        if (spec) schedule.push(spec);
      });
    }
  }
  if (crew.paused !== undefined && typeof crew.paused !== 'boolean') {
    errors.push({ path: 'crew.paused', message: 'must be true or false' });
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    definition: {
      slug: identity.slug,
      name: (crew.name as string).trim(),
      role: (crew.role as string).trim(),
      ...(typeof crew.avatar === 'string' ? { avatarPath: crew.avatar } : {}),
      color: color as string,
      provider: (provider as string).trim(),
      model: (model as string).trim(),
      personality: typeof crew.personality === 'string' ? crew.personality.trim() : '',
      directive: identity.directive,
      schedule,
      notify,
      budget,
      ...(crew.paused === true ? { paused: true } : {}),
      sourcePath: identity.sourcePath,
    },
  };
}

// ─── Text <-> frontmatter ─────────────────────────────────────────────────

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

export interface SplitCrewFile {
  frontmatter: unknown;
  body: string;
}

/** Throws only on YAML syntax errors; callers turn that into a member error. */
export function splitCrewFile(text: string): SplitCrewFile {
  const match = FRONTMATTER_RE.exec(text.replace(/^﻿/, ''));
  if (!match) return { frontmatter: undefined, body: text };
  return {
    frontmatter: yaml.load(match[1]),
    body: text.replace(/^﻿/, '').slice(match[0].length),
  };
}

export function parseCrewMemberFile(slug: string, sourcePath: string, text: string): CrewDefinitionResult {
  let split: SplitCrewFile;
  try {
    split = splitCrewFile(text);
  } catch (error) {
    return {
      ok: false,
      errors: [{ path: 'frontmatter', message: `YAML error: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}` }],
    };
  }
  return validateCrewFrontmatter(split.frontmatter, { slug, sourcePath, directive: split.body.trim() });
}

/**
 * Serializes a definition. `previousCrew` is the existing file's raw `crew`
 * object, whose keys this version does not model (e.g. `triggers`) survive.
 */
export function serializeCrewMember(definition: CrewMemberDraft, previousCrew?: unknown): string {
  const preserved: Raw = isRecord(previousCrew) ? { ...previousCrew } : {};
  for (const key of ['name', 'role', 'avatar', 'color', 'provider', 'model', 'personality', 'schedule', 'notify', 'budget', 'paused', ...RETIRED_KEYS]) {
    delete preserved[key];
  }
  const crew: Raw = {
    name: definition.name,
    role: definition.role,
    ...(definition.avatarPath ? { avatar: definition.avatarPath } : {}),
    color: definition.color,
    provider: definition.provider,
    model: definition.model,
    personality: definition.personality,
    // Timing first so each entry reads "daily: 18:30 / prompt: ...".
    schedule: definition.schedule.map(({ prompt, enabled, createdBy, ...timing }) => ({
      ...timing,
      prompt,
      ...(enabled === undefined ? {} : { enabled }),
      ...(createdBy === 'member' ? { createdBy } : {}),
    })),
    notify: definition.notify,
    budget: definition.budget,
    ...(definition.paused ? { paused: true } : {}),
    ...preserved,
  };
  const frontmatter = yaml.dump({ crew }, { lineWidth: -1, noRefs: true, quotingType: '"' });
  const body = definition.directive.trim();
  return `---\n${frontmatter}---\n${body ? `${body}\n` : ''}`;
}

/** A placeholder definition for a member whose file does not validate. */
export function brokenMemberDefinition(slug: string, sourcePath: string): CrewMemberDefinition {
  return {
    slug,
    name: slug,
    role: '',
    color: CREW_DEFAULTS.color,
    provider: CREW_DEFAULTS.provider,
    model: DEFAULT_MODEL_BY_PROVIDER[CREW_DEFAULTS.provider],
    personality: '',
    directive: '',
    schedule: [],
    notify: { maxLevel: 'note' },
    budget: { ...CREW_DEFAULTS.budget },
    paused: true,
    sourcePath,
  };
}

/** `provider:model` as sessions store it; a model that already names its provider is kept. */
export function sessionModelId(definition: Pick<CrewMemberDefinition, 'provider' | 'model'>): string {
  return definition.model.includes(':') ? definition.model : `${definition.provider}:${definition.model}`;
}
