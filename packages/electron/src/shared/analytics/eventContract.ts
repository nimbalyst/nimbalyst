/**
 * Generic property-contract primitives for product analytics events.
 *
 * These were originally private to `teamAnalytics.ts`. They are shared now
 * because the privacy guarantee they enforce -- no paths, no emails, no URLs,
 * no unbounded strings -- is not specific to Teams, and a second copy of
 * `PRIVACY_SHAPE` is a second thing to forget to update.
 *
 * The contract is deliberately mechanical rather than conventional: a property
 * that is not in the schema throws, and a value that looks like a filesystem
 * path or an address throws, so a well-meaning `...spread` of some richer
 * object cannot quietly ship a username to PostHog.
 *
 * NOTE: satisfying this contract does NOT mean your event will be collected.
 * PostHog project 234047 runs a server-side allow-list that drops any event
 * whose name is not on it, before ingestion -- silently, with no error and no
 * log. Adding an event means adding its name to `posthogIngestAllowList.ts`
 * AND to the `Cost control allow-list` transformation in PostHog. See that
 * file, and "A server-side allow-list drops unknown events" in
 * docs/POSTHOG_EVENTS.md.
 */

export const booleanRule = { type: 'boolean' } as const;
export const categoryRule = { type: 'category' } as const;
export const enumRule = <const T extends readonly string[]>(...values: T) => ({ type: 'enum', values } as const);

export type PropertyRule =
  | typeof booleanRule
  | typeof categoryRule
  | ReturnType<typeof enumRule<readonly string[]>>;

export type EventSchemaMap = Record<string, Record<string, PropertyRule>>;

export type InferRule<T extends PropertyRule> =
  T extends { type: 'boolean' }
    ? boolean
    : T extends { type: 'enum'; values: readonly (infer V extends string)[] }
      ? V
      : string;

export type PropertiesFor<M extends EventSchemaMap, E extends keyof M> = Partial<{
  [K in keyof M[E]]: M[E][K] extends PropertyRule ? InferRule<M[E][K]> : never;
}>;

/**
 * Values that must never reach an event payload. Matches URLs, `file://`,
 * email addresses, and absolute paths on either platform convention.
 */
const PRIVACY_SHAPE = /(?:https?:\/\/|file:\/\/|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|(?:^|[\\/])(?:Users|home|var|tmp|private|Volumes)(?:[\\/]|$))/i;
const STABLE_CATEGORY = /^[a-z0-9][a-z0-9._+-]{0,63}$/;

export function assertPropertyValue(event: string, key: string, rule: PropertyRule, value: unknown): void {
  if (rule.type === 'boolean') {
    if (typeof value !== 'boolean') throw new Error(`${event}.${key} must be boolean`);
    return;
  }
  if (typeof value !== 'string') throw new Error(`${event}.${key} must be a string category`);
  if (PRIVACY_SHAPE.test(value)) throw new Error(`${event}.${key} contains a forbidden identifying value`);
  if (rule.type === 'enum') {
    if (!rule.values.includes(value)) throw new Error(`${event}.${key} is not an allowlisted category`);
    return;
  }
  if (!STABLE_CATEGORY.test(value) || value.includes('..') || value.startsWith('/')) {
    throw new Error(`${event}.${key} must be a stable low-cardinality category`);
  }
}

/**
 * Coerce an arbitrary string into a low-cardinality category, or return
 * `fallback` when it cannot be made safe. Use this at the boundary where an
 * external value (a provider id, a mode name) enters a payload.
 */
export function toStableAnalyticsCategory(value: string | null | undefined, fallback = 'unknown'): string {
  const normalized = value?.trim().toLowerCase().replace(/[^a-z0-9._+-]+/g, '_') ?? '';
  if (!normalized || !STABLE_CATEGORY.test(normalized) || normalized.includes('..')) {
    return fallback;
  }
  return normalized;
}

/**
 * Validate `properties` against `schemas[event]`. Throws on an unknown event,
 * an unknown property, or a value that violates its rule. Returns the pair so
 * callers can inline it into a capture.
 */
export function validateAgainstSchemas<M extends EventSchemaMap, E extends keyof M & string>(
  schemas: M,
  event: E,
  properties: PropertiesFor<M, E>,
): { event: E; properties: PropertiesFor<M, E> } {
  const schema = schemas[event];
  if (!schema) throw new Error(`Unknown analytics event: ${String(event)}`);
  for (const [key, value] of Object.entries(properties)) {
    const rule = (schema as Record<string, PropertyRule>)[key];
    if (!rule) throw new Error(`${event}.${key} is not an allowlisted property`);
    if (value !== undefined) assertPropertyValue(event, key, rule, value);
  }
  return { event, properties };
}
