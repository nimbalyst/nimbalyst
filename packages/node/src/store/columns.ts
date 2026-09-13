/**
 * Column conversions between the SQLite schema and the runtime's types.
 *
 * The schema stores timestamps as ISO-8601 TEXT, booleans as INTEGER 0/1 and
 * every JSON-typed column as TEXT. The runtime expects `Date`/epoch millis,
 * `boolean` and parsed objects respectively, so both directions are converted
 * here rather than at each call site.
 *
 * The JSON direction is the one with a history. Under PGLite a JSONB read comes
 * back parsed; under SQLite it comes back as a string. A caller that spreads an
 * unparsed string (`{ ...session.metadata }`) gets char-by-char numeric keys,
 * re-serializes them and writes them back, growing the row roughly 9x per cycle
 * -- one session's metadata reached 216 MB that way. See DATABASE.md.
 */

/** ISO-8601 with milliseconds and a `Z`, matching the schema's own default. */
export function toIsoText(value: Date | number | string): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number') return new Date(value).toISOString();
  return value;
}

export function toMillis(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'number') return value;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

export function toBool(value: unknown): boolean {
  return value === 1 || value === true || value === '1';
}

export function fromBool(value: boolean | undefined | null): number {
  return value ? 1 : 0;
}

/** Parse a JSON TEXT column, tolerating an already-parsed value. */
export function parseJsonColumn(value: unknown): unknown {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'string') return value;
  if (value.length === 0) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/** Same, but guarantees a plain object so callers can spread the result. */
export function parseJsonObjectColumn(value: unknown): Record<string, unknown> {
  const parsed = parseJsonColumn(value);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  return {};
}

/** Serialize a value destined for a JSON TEXT column. */
export function toJsonColumn(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}
